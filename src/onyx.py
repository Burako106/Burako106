"""Genera el modo de color Onyx (oscuro) a partir de las reglas de Glass.

Toma cada regla CSS que aplica a Glass, le agrega .onyx al selector y convierte
sus colores a la versión oscura: los grises/blancos/negros se invierten, los
colores vivos (rojo, azul, etc.) se mantienen, y las sombras se oscurecen.
Así cualquier cambio futuro en Glass pasa solo a Onyx.
"""
import re, colorsys, sys

NAMED = {'white': (255, 255, 255, 1.0), 'black': (0, 0, 0, 1.0)}


def parse_hex(h):
    h = h[1:]
    if len(h) in (3, 4):
        h = ''.join(c * 2 for c in h)
    r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
    a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
    return r, g, b, a


def fmt(r, g, b, a):
    r, g, b = (max(0, min(255, round(x))) for x in (r, g, b))
    if a >= 0.999:
        return '#%02x%02x%02x' % (r, g, b)
    return 'rgba(%d,%d,%d,%s)' % (r, g, b, ('%.3f' % a).rstrip('0').rstrip('.'))


def to_dark(r, g, b, a, shadow=False):
    h, l, s = colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
    if shadow:
        if l > 0.6:  # brillo/relieve blanco: casi invisible en oscuro
            return fmt(255, 255, 255, a * 0.10)
        return fmt(0, 0, 0, min(0.7, a * 2.6 + 0.08))
    neutral = s < 0.22 or l > 0.93 or l < 0.06
    if neutral:
        nl = 0.075 + (1 - l) * 0.85  # blanco -> casi negro azulado; negro -> casi blanco
        ns = min(s, 0.18)
        nr, ng, nb = colorsys.hls_to_rgb(h if s > 0.02 else 0.64, nl, ns if s > 0.02 else 0.10)
        return fmt(nr * 255, ng * 255, nb * 255, a)
    if l < 0.30:  # color vivo muy oscuro (ej. bordó) -> aclarar para que se lea
        nr, ng, nb = colorsys.hls_to_rgb(h, 1 - l, s)
        return fmt(nr * 255, ng * 255, nb * 255, a)
    return fmt(r, g, b, a)


COLOR_RE = re.compile(r'#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3,4}\b|rgba?\([^)]*\)|\b(?:white|black)\b')


def conv_color(tok, shadow=False):
    t = tok.lower()
    if t in NAMED:
        r, g, b, a = NAMED[t]
    elif t.startswith('#'):
        r, g, b, a = parse_hex(t)
    else:
        nums = re.findall(r'[\d.]+%?', t)
        if len(nums) < 3:
            return tok
        try:
            r, g, b = (float(n.rstrip('%')) * (2.55 if n.endswith('%') else 1) for n in nums[:3])
            a = float(nums[3].rstrip('%')) / (100 if nums[3].endswith('%') else 1) if len(nums) > 3 else 1.0
        except ValueError:
            return tok
    return to_dark(r, g, b, a, shadow)


SKIP_PROPS = ('content', 'font', 'font-family', 'mask', '-webkit-mask', 'grid-template-areas')


def conv_decls(body):
    out = []
    for decl in split_decls(body):
        if ':' not in decl:
            continue
        prop, val = decl.split(':', 1)
        p = prop.strip().lower()
        if p.startswith('--'):
            pass  # variables: se convierten (sombras si el nombre lo indica)
        elif p in SKIP_PROPS or 'url(' in val:
            continue
        if not COLOR_RE.search(val) and 'color-scheme' not in p:
            continue
        if p == 'color-scheme':
            out.append('color-scheme:dark')
            continue
        shadow = 'shadow' in p or p.startswith('--gsh') or 'drop-shadow' in val
        if p == 'filter' and 'drop-shadow' not in val:
            continue
        nv = COLOR_RE.sub(lambda m: conv_color(m.group(0), shadow), val)
        out.append(prop.strip() + ':' + nv.strip())
    return ';'.join(out)


def split_decls(body):
    parts, depth, cur = [], 0, ''
    for ch in body:
        if ch == '(':
            depth += 1
        elif ch == ')':
            depth -= 1
        if ch == ';' and depth == 0:
            parts.append(cur); cur = ''
        else:
            cur += ch
    if cur.strip():
        parts.append(cur)
    return parts


GLASS_SEL = re.compile(r'body\.glass(?![\w-])')


def conv_selector(sel):
    keep = []
    for s in split_top(sel, ','):
        s = s.strip()
        if GLASS_SEL.search(s):
            keep.append(GLASS_SEL.sub('body.glass.onyx', s, count=1))
    return ','.join(keep)


def split_top(s, sep):
    parts, depth, cur = [], 0, ''
    for ch in s:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == sep and depth == 0:
            parts.append(cur); cur = ''
        else:
            cur += ch
    parts.append(cur)
    return parts


def walk(css):
    """Recorre el CSS (con @media anidados) y devuelve las reglas Onyx."""
    out, i, n = [], 0, len(css)
    css = re.sub(r'/\*.*?\*/', '', css, flags=re.S)
    n = len(css)
    while i < n:
        j = css.find('{', i)
        if j < 0:
            break
        head = css[i:j].strip()
        # bloque hasta su llave de cierre
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == '{':
                depth += 1
            elif css[k] == '}':
                depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        if head.startswith('@media') or head.startswith('@supports'):
            inner = walk(body)
            if inner:
                out.append(head + '{' + inner + '}')
        elif head.startswith('@'):
            pass  # keyframes, font-face: igual en los dos modos
        else:
            sel = conv_selector(head)
            if sel:
                decls = conv_decls(body)
                if decls:
                    out.append(sel + '{' + decls + '}')
        i = k
    return ''.join(out)


def build(html):
    css = ''.join(re.findall(r'<style[^>]*>(.*?)</style>', html, re.S))
    onyx = walk(css)
    return onyx


if __name__ == '__main__':
    path = sys.argv[1]
    extra = sys.argv[2] if len(sys.argv) > 2 else None
    html = open(path).read()
    html = re.sub(r'<style id="onyx-auto">.*?</style>', '', html, flags=re.S)
    onyx = build(html)
    manual = open(extra).read() if extra else ''
    tag = '<style id="onyx-auto">' + onyx + '\n' + manual + '</style>'
    i = html.rindex('</body>')
    html = html[:i] + tag + html[i:]
    open(path, 'w').write(html)
    print('onyx rules', onyx.count('{'), 'bytes', len(onyx))
