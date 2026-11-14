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
    "while(S&&!S.over&&S.turn!==0&&!setupOpen&&!quitOpen&&S.kind!=='online') await botPlay(S.turn);")
# 2) sin reacciones ni respuestas automáticas de bots en el chat online
rep("function react(ev,p,x={}){\n  if(!S||S.n<2||chatOff()) return;",
    "function react(ev,p,x={}){\n  if(!S||S.n<2||chatOff()||S.kind==='online') return;")
rep("function botReply(kind,text){", "function botReply(kind,text){ if(S&&S.kind==='online') return;")
# 3) botón para jugar con un amigo en el lobby
rep('<button class="lbig lbot" data-act="vsbot"><span class="lplus">🤖</span><b>Jugar contra la máquina</b></button></div>',
    '<button class="lbig lbot" data-act="vsbot"><span class="lplus">🤖</span><b>Jugar contra la máquina</b></button>\n    <button class="lbig lfriend" data-act="netcreate"><span class="lplus">👥</span><b>Jugar con un amigo</b><small>Mandale un link y juegan online</small></button></div>')
# 4) módulo online al final
rep("</body>", open(net, encoding='utf-8').read() + "\n</body>")
open(out, 'w', encoding='utf-8').write(h)
print("ok", len(h))
