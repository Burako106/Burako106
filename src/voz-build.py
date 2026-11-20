"""Arma la lista de frases que se graban con ElevenLabs (una vez por voz).
Salidas: tools/voz.html (datos para el juego) y burako106/src/voz-lines.js (para el servidor)."""
import re, json
SRC='/home/claude/burako/index.original.html'
VOICES={  # slot: (voice_id de ElevenLabs, género, descripción)
 'f0':('WtRYgQbAJ4i0AckgdVbq','f','mujer venezolana'),
 'f1':('h60rOzgfLmYsntfqgGu2','f','Sofía, argentina'),
 'f2':('9oPKasc15pfAbMr7N6Gs','f','Valeria, argentina'),
 'f3':('pN4aFdNIp2mvGfTwy1Oj','f','mujer española'),
 'f4':('VmejBeYhbrcTPwDniox7','f','Lina, colombiana'),
 'm0':('64iVJ7QB471BXdqed0KJ','m','hombre caribeño'),
 'm1':('nYm4p0R8BhHFRBH8wGHm','m','José Manuel, venezolano'),
 'm2':('Rt1JHkPO27QCUX6Nd5bV','m','Jorge, mexicano'),
 'm3':('0bu1GUsOfNJYyXbmSTxD','m','Fran, argentino'),
 'm4':('QK4xDwo9ESPHA4JNUpX3','m','Tomás, argentino'),
}
EXTRA=['Hola, ¿jugamos un burako?','Hola, ¿jugamos un burako? Dale, que te toca.']
# Frases con risas o sonidos: se graban con el modelo eleven_v3, que actúa las indicaciones
# entre corchetes ([laughs], [sighs]...) en vez de leerlas. Cada una lleva una clave nueva
# (termina en "b") para que el juego no use la grabación vieja guardada.
FIX={
 'Jaja, sí':'[laughs] ¡Sí, sí!',
 'Jajaja':'[laughs heartily]',
 'Jaja, no fue a propósito':'[laughs] No fue a propósito.',
 'Jaja, dale':'[laughs] ¡Dale!',
 'Jaja, fue sin querer':'[laughs] Fue sin querer.',
 'Jaja, ya vamos a ver':'[laughs] Ya vamos a ver...',
 'Jeje, lo siento':'[chuckles] Lo siento.',
 'Hmm.':'[thoughtful] Hmm...',
 'Hmm. Veremos.':'[thoughtful] Hmm... Veremos.',
 'Hmm. Anotado.':'[thoughtful] Hmm... Anotado.',
 'Mmm, no me gusta nada':'[doubtful] Mmm... no me gusta nada.',
 'Mmm, no sé':'[doubtful] Mmm... no sé.',
 'Mmm, puede ser':'[thoughtful] Mmm... puede ser.',
 'Mmm, riquísimo':'[delighted] Mmm... ¡riquísimo!',
 'Uff… me mataste':'[sighs] Uff... me mataste.',
 'Ajá':'[amused] Ajá.',
 'Bah, cualquiera':'[dismissive] Bah... cualquiera.',
}
EMO=re.compile('[\U0001F300-\U0001FAFF☀-➿️‍]')
def norm(s): return re.sub(r'\s+',' ',EMO.sub('',s)).strip()
def fnv(s):
    h=2166136261
    b=s.encode('utf-16-le')
    for i in range(0,len(b),2):
        h^=b[i]|(b[i+1]<<8); h=(h*16777619)&0xffffffff
    d='0123456789abcdefghijklmnopqrstuvwxyz'; o=''
    while True:
        o=d[h%36]+o; h//=36
        if not h: break
    return o
h=open(SRC,encoding='utf-8').read()
i=h.find('const LINES={'); j=h.find('\n};',i); block=h[i:j]
keys=set(re.findall(r"(\w+):\[",block))
strs=[s.replace("\\'","'") for s in re.findall(r"'((?:[^'\\]|\\.)*)'",block)]
k=h.find("PRESETS=["); pre=re.findall(r"'([^']*)'",h[k:h.find('];',k)])
lines={}
for s in strs+pre+EXTRA:
    n=norm(s)
    if not n or n in keys or len(n)<2: continue
    lines.setdefault(fnv(n),n)
alias={}; model={}
for orig,new in FIX.items():
    o=fnv(norm(orig)); assert o in lines, orig
    nid=o+'b'; del lines[o]; lines[nid]=new; alias[o]=nid; model[nid]='eleven_v3'
ids=sorted(lines)
chars=sum(len(t) for t in lines.values())
print('frases',len(lines),'caracteres por voz',chars,'total',chars*len(VOICES))
data={'v':{k:v[1] for k,v in VOICES.items()},'ids':','.join(ids),'alias':alias}
open('/home/claude/tools/voz.html','w').write('<script id="voz-data">window.BURAKO_VOZ='+json.dumps(data,ensure_ascii=False)+';</script>\n')
js='// Generado por tools/voz.py: frases que se graban con ElevenLabs y las voces elegidas.\n'
js+='export const VOZ_VOICES = '+json.dumps({k:{'id':v[0],'g':v[1],'d':v[2]} for k,v in VOICES.items()},ensure_ascii=False,indent=1)+';\n'
js+='export const VOZ_LINES = '+json.dumps([[i,lines[i]]+([model[i]] if i in model else []) for i in ids],ensure_ascii=False,indent=0)+';\n'
open('/home/claude/burako106/src/voz-lines.js','w').write(js)
