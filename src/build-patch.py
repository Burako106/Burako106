import sys
src, net, out = sys.argv[1], sys.argv[2], sys.argv[3]
h = open(src, encoding='utf-8').read()
def rep(old, new, count=1):
    global h
    n = h.count(old)
    assert n == count, f"esperaba {count} ocurrencias, hay {n}: {old[:80]}"
    h = h.replace(old, new)
# 1) en una mesa online el rival es una persona: nunca juega la máquina por él
rep("while(S&&!S.over&&S.turn!==0&&!setupOpen&&!quitOpen) await botPlay(S.turn);",
    "while(S&&!S.over&&S.turn!==0&&!setupOpen&&!quitOpen&&(S.kind!=='online'||!!(window.BURAKO_NET&&BURAKO_NET.botTurn()))) await botPlay(S.turn);")
# 2) sin reacciones ni respuestas automáticas de bots en el chat online
# 3) botón para jugar con un amigo en el lobby
rep('<button class="lbig lbot" data-act="vsbot"><span class="lplus">🤖</span><b>Jugar contra la máquina</b></button></div>',
    '<button class="lbig lbot" data-act="vsbot"><span class="lplus">🤖</span><b>Jugar contra la máquina</b></button>\n    <button class="lbig lfriend" data-act="netcreate"><span class="lplus">👥</span><b>Jugar con un amigo</b></button></div>')
# 4) mesas reales: sin robot ni nivel para personas, "Gratis" y "Sin tiempo"
rep('<i class="lcoin tk">${TKI}</i>${ecoN(t.bet)}', "${t.bet?`<i class=\"lcoin tk\">${TKI}</i>${ecoN(t.bet)}`:'Gratis'}", 2)
rep("t.timer+' s'", "(t.timer?t.timer+' s':'Sin tiempo')")
# personas vs máquina en mesas online (la máquina muestra el robot)
rep("function seatKind(p){ return !S||S.kind!=='mesa'?'':isGone(p)?' robo-seat':' human'; }",
    "function seatKind(p){ return !S||(S.kind!=='mesa'&&S.kind!=='online')?'':(isGone(p)||(S.kind==='online'&&!charOf(p).real))?' robo-seat':' human'; }")
# compañero / rival solo al pasar el mouse
rep('data-seat="${p}">${avH(p)}\n    <div class="seat-info"><b>${nm(p)}</b><span>${role}</span>',
    'data-seat="${p}" title="${esc(nm(p))} · ${role}">${avH(p)}\n    <div class="seat-info"><b>${nm(p)}</b>')
# personas: misma forma de ficha que la máquina (sin nivel ni robot, pero ocupando su lugar)
rep(".seat.human .lvlrow{display:none!important}",".seat.human .lvlrow{visibility:hidden!important}")
# cortar en seco las jugadas en curso de la máquina cuando dejo una mesa online
rep("const think=async(a,b)=>{ await sleep(a+Math.random()*(b-a)); await waitPause(); };",
    "const think=async(a,b)=>{ const g=window.__burakoGen|0; await sleep(a+Math.random()*(b-a)); await waitPause(); if((window.__burakoGen|0)!==g) throw new Error('mesa abandonada'); };")
# sin pausa con otras personas
rep("const canPause=!!(S&&!S.over&&!setupOpen);","const canPause=!!(S&&!S.over&&!setupOpen&&S.kind!=='online');")
# botón del video
rep("+${ECO.VIDEO}</button>","Ganá +${ECO.VIDEO} ${TKI}</button>")
rep("${me?'':'<i class=\"lbot\" title=\"Robot\">🤖</i>'}", "${me||s.real?'':'<i class=\"lbot\" title=\"Robot\">🤖</i>'}")
rep("${x==='me'?'':'<i class=\"hbot\">🤖</i>'}", "${x==='me'||x.real?'':'<i class=\"hbot\">🤖</i>'}")
# 5) módulo online al final
import time
rep("</body>", "<script>window.BURAKO_BUILD='"+str(int(time.time()))+"';</script>\n" + open(net, encoding='utf-8').read() + "\n</body>")
open(out, 'w', encoding='utf-8').write(h)
print("ok", len(h))
