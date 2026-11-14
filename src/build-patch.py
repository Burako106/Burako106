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
    "while(S&&!S.over&&S.turn!==0&&!setupOpen&&!quitOpen&&!abandoned&&(S.kind!=='online'||!!(window.BURAKO_NET&&BURAKO_NET.botTurn()))) await botPlay(S.turn);")
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
# voz: no perder el permiso del toque esperando las voces, y despertar el sintetizador
rep("    await waitVoices(); voiceCache=null;\n    const v=voiceFor(p);",
    "    if(!speechSynthesis.getVoices().length){ await waitVoices(); voiceCache=null; }\n    const v=voiceFor(p);")
rep("    if(speechSynthesis.pending) speechSynthesis.cancel();\n    speechSynthesis.speak(u);",
    "    if(speechSynthesis.pending) speechSynthesis.cancel();\n    try{ speechSynthesis.resume(); }catch(e){}\n    speechSynthesis.speak(u);")
# sin pausa con otras personas
rep("const canPause=!!(S&&!S.over&&!setupOpen);","const canPause=!!(S&&!S.over&&!setupOpen&&S.kind!=='online');")
# botón del video
rep("+${ECO.VIDEO}</button>","Ganá +${ECO.VIDEO} ${TKI}</button>")
rep("${me?'':'<i class=\"lbot\" title=\"Robot\">🤖</i>'}", "${me||s.real?'':'<i class=\"lbot\" title=\"Robot\">🤖</i>'}")
rep("${x==='me'?'':'<i class=\"hbot\">🤖</i>'}", "${x==='me'||x.real?'':'<i class=\"hbot\">🤖</i>'}")
# perfil: tocar tu imagen para elegir tu personaje
rep('<div class="lp-head"><span class="lav big">${lbAv(null,true)}</span>',
    '<div class="lp-head"><button class="lav big lp-av" data-act="pickme" aria-label="Cambiar tu personaje" title="Cambiar tu personaje">${lbAv(null,true)}<i class="lp-edit" aria-hidden="true">✎</i></button>')
# botón para volver a la partida contra la máquina: con 🤖
rep('<span class="lplus"><svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8c.6-.4.6-1.2 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z" fill="currentColor"/></svg></span><b>Volver a mi partida</b>',
    '<span class="lplus">${S.kind===\'online\'?\'<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M8 5.2v13.6c0 .8.9 1.3 1.6.8l10.2-6.8c.6-.4.6-1.2 0-1.6L9.6 4.4C8.9 3.9 8 4.4 8 5.2z" fill="currentColor"/></svg>\':\'🤖\'}</span><b>${S.kind===\'online\'?\'Volver a la mesa\':\'Seguir partida\'}</b>')
# sacar "Tocá + para sentarte · mismo color, misma pareja" (queda vacío para los avisos de mi mesa)
rep("<p class=\"lhint\">${t.n===4?LL('Tocá + para sentarte · mismo color, misma pareja','Tap + to sit · same color, same team'):LL('Tocá + para sentarte','Tap + to sit')}</p>",
    '<p class="lhint"></p>')
# al recargar: una partida "vacía" (nunca jugada) no cuenta como partida en curso
rep("  S=(data&&data.hands&&data.rack)?data:load();\n  if(!S){ newRound({}); abandoned=true; }",
    "  S=(data&&data.hands&&data.rack)?data:load();\n  if(!S){ newRound({}); abandoned=true; S.blank=true; }\n  else if(S.blank||S.quit||(S.kind!=='online'&&S.turn===0&&S.phase==='draw'&&(S.pozo||[]).length<=1&&S.hands&&S.hands[0]&&S.hands[0].length===11&&!(S.melds||[]).some(m=>m&&m.length)&&(S.round||1)===1)) abandoned=true;")
rep("  if(a==='quityes'){ if(inGame()) lbRecord('lose'); quitOpen=false; abandoned=true;",
    "  if(a==='quityes'){ if(inGame()) lbRecord('lose'); quitOpen=false; abandoned=true; if(S){ S.quit=true; try{ save(); }catch(e){} }")
# sin mesas de mentira al cargar (las mesas reales llegan del servidor)
rep("function lbInit(){ if(LT.length) return; const used=new Set();","function lbInit(){ return; if(LT.length) return; const used=new Set();")
# fin de la partida online: «Volver a las mesas»
rep("${o.done?'<button class=\"btn primary again-btn\" data-act=\"next\">Jugar otra partida</button><button class=\"btn\" data-act=\"newgame\">Cambiar modalidad</button>'",
    "${o.done?'<button class=\"btn primary again-btn\" data-act=\"next\">Jugar otra partida</button>'+(S.kind==='online'?'<button class=\"btn\" data-act=\"netexit\">Volver a las mesas</button>':'<button class=\"btn\" data-act=\"newgame\">Cambiar modalidad</button>')")
# bajar y tirar solo con clics: el texto de la zona lo cuenta
rep("Elegí fichas y arrastralas acá.","Elegí fichas y arrastralas, o tocá acá.",3)
rep("Select tiles and drag them here.","Select tiles and drag them here, or tap here.",2)
# Glass es el diseño inicial para todos (una vez se pasa a Glass a quien ya tenía otro guardado)
rep("let theme='fun'; try{ theme=localStorage.getItem('burako-theme')||'fun'; }catch(e){}",
    "let theme='glass'; try{ if(!localStorage.getItem('burako-theme-v2')){ localStorage.setItem('burako-theme','glass'); localStorage.setItem('burako-theme-v2','1'); } theme=localStorage.getItem('burako-theme')||'glass'; }catch(e){}")
# 5) módulo online al final
import time
rep("</body>", "<script>window.BURAKO_BUILD='"+str(int(time.time()))+"';</script>\n" + open(net, encoding='utf-8').read() + "\n</body>")
open(out, 'w', encoding='utf-8').write(h)
print("ok", len(h))
