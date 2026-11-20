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
rep(".seat.human .lvlrow{display:none!important}","body.netgame .seat.human .lvlrow{visibility:hidden!important}")
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
    '<div class="lp-head"><span class="lp-avw" data-act="pickme"><button class="lav big lp-av" data-act="pickme" aria-label="Cambiar tu personaje" title="Cambiar tu personaje">${lbAv(null,true)}</button><i class="lp-edit" aria-hidden="true"><svg viewBox="0 0 24 24" width="14" height="14"><path fill="currentColor" d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25zm17.7-10.2a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg></i></span>')
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
    "let theme='glass'; try{ if(!localStorage.getItem('burako-theme-v2')){ localStorage.setItem('burako-theme','glass'); localStorage.setItem('burako-theme-v2','1'); } const t0=localStorage.getItem('burako-theme'); theme=(t0==='onyx'||t0==='classic')?'onyx':'glass'; localStorage.setItem('burako-theme',theme); }catch(e){}")
# logo de Facebook en el ingreso: dibujado, no una letra estirada
rep('<button class="el-btn el-fb" data-eco="login" data-v="facebook"><span class="el-ic">f</span>',
    '<button class="el-btn el-fb" data-eco="login" data-v="facebook"><span class="el-ic"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="12" fill="#fff"/><path fill="#1877f2" d="M13.4 24v-8.4h2.8l.42-3.26H13.4v-2.08c0-.94.26-1.59 1.62-1.59h1.73V5.75a23 23 0 0 0-2.53-.13c-2.5 0-4.22 1.53-4.22 4.34v2.4H7.18v3.26H10V24z"/></svg></span>')
rep(".el-fb .el-ic{background:#fff;color:#1877f2;border-radius:50%;font-size:18px;padding-top:4px}",".el-fb .el-ic{background:none;border-radius:50%;padding:0;overflow:hidden}.el-fb .el-ic svg{width:24px;height:24px;display:block}")
# chat del club: ya hay personas
rep("'¡Bienvenido al club! Por ahora juegan robots, pronto llegan las personas.',","'¡Bienvenidos al club! 👋',")
# mesas de la casa: al llenarse, confirmación con «Jugar» (en vez de la cuenta 4-3-2-1)
rep("    if(i<0){ t.cd=4; t.revealAt=Date.now();","    if(i<0){ if(window.BURAKO_NET&&BURAKO_NET.houseReady){ BURAKO_NET.houseReady(t); return; } t.cd=4; t.revealAt=Date.now();")
# de a tres: cuando se acaba el mazo, pasa UN muerto por vez (no todos juntos)
rep("""  const all=[].concat(...S.muertos); S.muertos=S.muertos.map(()=>[]);
  for(let i=all.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [all[i],all[j]]=[all[j],all[i]]; }
  S.mazo=all; S.muertoMazo=true;
  const src=[...document.querySelectorAll('.muertos-col .stack.neu')].map(e=>e.getBoundingClientRect());
  requestAnimationFrame(()=>requestAnimationFrame(()=>muertoToMazo(src)));
  setTimeout(()=>{ say('Se acabó el mazo: los muertos que quedaban pasan a ser el mazo.',false); toast('Se acabó el mazo: los muertos pasan al mazo'); },50);""",
"""  const idx=S.muertos.map((m,i)=>m.length?i:-1).filter(i=>i>=0), k=idx[Math.floor(Math.random()*idx.length)], els=[...document.querySelectorAll('.muertos-col .stack.neu')];
  const e=els[idx.indexOf(k)]||els[k], src=e?[e.getBoundingClientRect()]:[];
  S.mazo=S.muertos[k]; S.muertos[k]=[]; S.muertoMazo=true;
  const left=idx.length-1;
  requestAnimationFrame(()=>requestAnimationFrame(()=>muertoToMazo(src)));
  setTimeout(()=>{ const msg=left?'Se acabó el mazo: un muerto pasa a ser el mazo'+(left===1?' (queda 1 muerto).':' (quedan '+left+' muertos).'):'Se acabó el mazo: el último muerto pasa a ser el mazo.'; say(msg,false); toast(msg.replace('Se acabó el mazo: ','')); },50);""")
# logo: BURAKO + 1·0·6 en fichitas
rep('function lbLogo(){ return `<div class="llogo" aria-label="Burako 106"><span class="ll-w">Burako</span><span class="ll-t">106</span></div>`; }',
    'function lbLogo(){ return `<div class="llogo" aria-label="Burako 106"><span class="ll-w">BURAKO</span><span class="ll-t" aria-hidden="true"><i class="lt1">1</i><i class="lt0">0</i><i class="lt6">6</i></span></div>`; }')
# los mensajes escritos sobre los jugadores duran 2 segundos más
rep("  setTimeout(()=>b.remove(),3600);\n}","  setTimeout(()=>b.remove(),5600);\n}")
# «Abandonar»: texto blanco sobre el rojo para que se lea bien
rep('data-act="quityes" style="background:var(--op);border-color:var(--op);color:#3d0d08"','data-act="quityes" style="background:var(--op);border-color:var(--op);color:#fff"')
# avisos: duran según el largo del texto (mínimo 3,2 s)
rep("  document.body.appendChild(t); setTimeout(()=>t.remove(),2300);\n  tone([330,262],'square');","  document.body.appendChild(t); setTimeout(()=>{ t.classList.add('out'); setTimeout(()=>t.remove(),260); },Math.max(3200,String(msg).length*65));\n  tone([330,262],'square');")
# de a tres: «Jimmy contra Graciela contra Gladys»
rep("<span class=\"lm-side r\"${d(2000)}>${nm(o[0])}</span><span class=\"lm-vs\"${d(2200)}>${LL('y','&')}</span><span class=\"lm-side y\"","<span class=\"lm-side r\"${d(2000)}>${nm(o[0])}</span><span class=\"lm-vs\"${d(2200)}>${LL('contra','vs')}</span><span class=\"lm-side y\"")
# orden de diseños en el menú: Glass, Classic, Fun
rep("['fun','classic','glass'].map","['glass','onyx'].map",2)
rep("""data-v="fun" aria-selected="${theme==='fun'}">Fun</button><button role="tab" data-act="theme" data-v="classic" aria-selected="${theme==='classic'}">Classic</button><button role="tab" data-act="theme" data-v="glass" aria-selected="${theme==='glass'}">Glass</button>""","""data-v="glass" aria-selected="${theme==='glass'}">Glass</button><button role="tab" data-act="theme" data-v="onyx" aria-selected="${theme==='onyx'}">Onyx</button>""",2)
# saludo del lobby: saludo con nombre y después un mensaje según el momento
rep('<h1 class="lgreet">¡Hola, <span>${esc(lbMyName())}</span>!</h1>','<h1 class="lgreet">${window.lgH?lgH():\'¡Hola, <span>\'+esc(lbMyName())+\'</span>!\'}</h1>')
rep('<small class="set-note">Así te ven en las mesas.</small>','<small class="set-note">Así te ven en las mesas.</small>${window.lgBdayH?lgBdayH():\'\'}')
# chat: el último emoji es un "+" que abre todos los emojis
rep("""${EMOJIS.map(e=>`<button data-act="emoji" data-v="${e}" aria-label="Mandar ${e}">${e}</button>`).join('')}""","""${EMOJIS.slice(0,-1).map(e=>`<button data-act="emoji" data-v="${e}" aria-label="Mandar ${e}">${e}</button>`).join('')}<button type="button" class="emo-more" aria-label="Más emojis" aria-expanded="false">+</button>""",2)
# mesas compactas: cada regla en un solo renglón
rep("""<span class="hb-rules">${lbRules(t).join(' · ')}</span>""","""<span class="hb-rules">${lbRules(t).map(r=>'<span class="hb-r">'+r+'</span>').join(' · ')}</span>""")
# jugar con un amigo: primero se eligen las reglas
rep("""setupKind==='create'?'Crear mesa':setupKind==='bot'""","""setupKind==='create'?(window.NETFRIEND?'Jugar con un amigo':'Crear mesa'):setupKind==='bot'""")
rep("""setupKind==='create'?'<button class="btn primary go-btn" data-act="createtable">Crear mesa</button>':""","""setupKind==='create'?'<button class="btn primary go-btn" data-act="createtable">'+(window.NETFRIEND?'Crear mesa e invitar':'Crear mesa')+'</button>':""")
# todos contra todos: vs entre los tres
rep("""<span class="ppl">${dot('b')}${dot('r')}${dot('y')}</span>`)}""","""<span class="ppl">${dot('b')}<em>vs</em>${dot('r')}<em>vs</em>${dot('y')}</span>`)}""")
# legal: sección en Configuración y enlaces en la pantalla de entrada
rep("""<button class="btn" data-act="lcfgout">Cerrar sesión</button></div>
  </div></div>`; }""","""<button class="btn" data-act="lcfgout">Cerrar sesión</button></div>
  <div class="lcfg-row lcfg-legal"><span><b>Legal</b><small>Términos, privacidad y cómo borrar tus datos.</small></span><span class="lcfg-links"><a href="/terms?lang=${LANG}" target="_blank" rel="noopener">Términos</a><a href="/privacy?lang=${LANG}" target="_blank" rel="noopener">Privacidad</a><a href="/data-deletion?lang=${LANG}" target="_blank" rel="noopener">Eliminar datos</a></span></div>
  </div></div>`; }""")
rep("""<p class="el-test">Modo prueba: todavía no se conecta con Facebook ni Google. Cualquier botón te deja entrar.</p>""","""<p class="el-test">Modo prueba: todavía no se conecta con Facebook ni Google. Cualquier botón te deja entrar.</p>
    <p class="el-legal">Al continuar aceptás los <a href="/terms?lang=${LANG}" target="_blank" rel="noopener">Términos</a> y la <a href="/privacy?lang=${LANG}" target="_blank" rel="noopener">Política de privacidad</a>.</p>""")
# inicio de sesión real con Clerk: el email lo maneja la ventana de Clerk; fuera el aviso de "modo prueba"
rep("""<label class="el-field"><span>Email</span><input type="email" placeholder="tu@email.com" autocomplete="email"></label>
    <label class="el-field"><span>Contraseña</span><input type="password" placeholder="••••••••" autocomplete="current-password"></label>
    <button class="el-btn el-mail" data-eco="login" data-v="email">Entrar con email</button>
    <p class="el-foot">¿No tenés cuenta? <a href="#" data-eco="login" data-v="email">Creala acá</a></p>""","""<button class="el-btn el-mail" data-eco="login" data-v="email">Continuar con email</button>
    <p class="el-foot">¿No tenés cuenta? La creás en el mismo paso.</p>""")
rep("""<p class="el-test">Modo prueba: todavía no se conecta con Facebook ni Google. Cualquier botón te deja entrar.</p>""","""<p class="el-test" id="elstatus" hidden></p>
    <button class="el-guest" data-eco="login" data-v="guest">Entrar sin cuenta (prueba)</button>""")
rep("""E.account.provider==='google'?'Google':'Facebook'):''} · modo prueba</small>""","""E.account.provider==='google'?'Google':E.account.provider==='guest'?'Invitado (sin cuenta)':'Facebook'):''}${E.account&&E.account.email?' · '+esc(E.account.email):''}</small>""")
# pantalla de entrada: mismo logo que el lobby (BURAKO + fichitas 106)
rep("""<div class="el-brand">Bura<i>ko</i> <small>CLUB</small></div>""","""<div class="el-brand el-logo">${lbLogo()}</div>""")
# pantalla de carga al volver de iniciar sesión: se activa antes de que se dibuje nada (sin parpadeos)
rep("<head>","""<head>
<script>(function(){try{var q=/[?&]sso=/.test(location.search),t=+sessionStorage.getItem('burako-authwait')||0;if(!(q||Date.now()-t<120000))return;var th=localStorage.getItem('burako-theme-v2')?(localStorage.getItem('burako-theme')||'glass'):'glass';var d=document.documentElement;d.classList.add('auth-wait','aw-'+th);if(localStorage.getItem('burako-lang')==='en')d.classList.add('aw-en');setTimeout(function(){d.classList.remove('auth-wait')},12000);}catch(e){}})();</script>
<style>
html.auth-wait body{visibility:hidden}
html.auth-wait{background:linear-gradient(160deg,#e3e7fb,#f3e9f0) fixed!important;min-height:100%}
html.auth-wait.aw-fun{background:#ffe9a8!important}
html.auth-wait.aw-onyx{background:linear-gradient(160deg,#1a1c22,#121318) fixed!important}
html.auth-wait.aw-onyx::before{border-color:rgba(255,255,255,.18);border-top-color:#f2f3f7}
html.auth-wait.aw-onyx::after{color:#f2f3f7}
html.auth-wait.aw-classic{background:radial-gradient(circle at 50% 40%,#4a1f22,#1e0d0f) fixed!important}
html.auth-wait::before{content:"";position:fixed;left:50%;top:calc(50% - 28px);width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:3px solid rgba(20,20,30,.15);border-top-color:#1b1c21;animation:awSpin .8s linear infinite;z-index:2147483647}
html.auth-wait.aw-fun::before{border-color:rgba(20,20,20,.18);border-top-color:#141414}
html.auth-wait.aw-classic::before{border-color:rgba(255,255,255,.18);border-top-color:#e6b63f}
html.auth-wait::after{content:"Entrando…";position:fixed;left:0;right:0;top:calc(50% + 6px);text-align:center;font:700 16px/1.2 system-ui,-apple-system,"Segoe UI",sans-serif;letter-spacing:.02em;color:#1b1c21;opacity:.75;z-index:2147483647}
html.auth-wait.aw-en::after{content:"Signing in…"}
html.auth-wait.aw-classic::after{color:#f6efe2}
html.aw-out body{animation:awIn .35s ease both}
@keyframes awSpin{to{transform:rotate(360deg)}}
@keyframes awIn{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){html.auth-wait::before{animation-duration:2s}html.aw-out body{animation:none}}
</style>""")
# Ajustes: eliminar cuenta (solo cuentas reales, no invitados)
rep("""data-act="lcfgout">Cerrar sesión</button></div>""","""data-act="lcfgout">Cerrar sesión</button></div>${E.account&&E.account.provider!=='guest'?`<div class="lcfg-row lcfg-del"><span><b>Eliminar cuenta</b><small>Borra tu cuenta y tus datos. No se puede deshacer.</small></span><button class="btn lcfg-delbtn" data-act="lcfgdel">Eliminar</button></div>`:''}""")
# precios en pesos argentinos (sin dólares)
rep("""const ecoMoney=n=>'ARS '+Math.round(n).toLocaleString('es-AR');""","""const ecoMoney=n=>'$ '+Math.round(n).toLocaleString('es-AR');""")
rep("""<span class="eco-price">${ecoMoney(p.ars)} <small>${ecoUsd(p.usd)}</small></span>""","""<span class="eco-price">${ecoMoney(p.ars)} <small>ARS</small></span>""")
rep("""<small>${p.id==='anual'?'/año':'/mes'} · ${ecoUsd(p.usd)}</small>""","""<small>${p.id==='anual'?'/año':'/mes'}</small>""")
rep("""<p class="eco-test">Modo prueba: los botones simulan la compra. No se cobra nada.</p>""","""<p class="eco-test">Modo prueba: se paga con Mercado Pago en modo de prueba (no se cobra de verdad).</p>""")
# Google AdSense: verificación del sitio (sin mostrar anuncios)
rep('<head>','<head>\n<script>(window.adsbygoogle=window.adsbygoogle||[]).pauseAdRequests=1;</script>\n<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9099367835712483" crossorigin="anonymous"></script>')
# suscripciones reales: textos de la tienda
rep("""<a href="#" data-eco="unsub">Cancelar (prueba)</a>""","""${E.sub.cancelled?'No se renueva (cancelada).':'Se renueva sola. <a href="#" data-eco="unsub">Cancelar suscripción</a>'}""")
rep("""${sub&&E.sub.plan===p.id?'Extender':'Suscribirme'}""","""${sub&&E.sub.plan===p.id?(E.sub.cancelled?'Volver a suscribirme':'Tu plan actual'):'Suscribirme'}""")
# modos de color: solo Glass (claro) y Onyx (oscuro, generado desde Glass)
rep("th={fun:'Fun',classic:'Classic',glass:'Glass'}","th={glass:'Glass',onyx:'Onyx'}")
rep("theme=['classic','glass'].includes(el.dataset.v)?el.dataset.v:'fun';","theme=el.dataset.v==='onyx'?'onyx':'glass';")
rep("function applyTheme(){ document.body.classList.toggle('fun',theme==='fun'); document.body.classList.toggle('glass',theme==='glass');",
    "function applyTheme(){ document.body.classList.remove('fun'); document.body.classList.add('glass'); document.body.classList.toggle('onyx',theme==='onyx'); document.documentElement.classList.toggle('onyx',theme==='onyx');")
rep('''<span class="label">Diseño</span><div class="lang-tabs" role="tablist" aria-label="Diseño">''','''<span class="label">Modo de color</span><div class="lang-tabs" role="tablist" aria-label="Modo de color">''',2)
rep("it('diseno','lnavx','Diseño'","it('diseno','lnavx','Color'")
rep('aria-label="Diseño"','aria-label="Modo de color"',3)
# Onyx: paños oscuros propios (los de Glass son claros)
rep("let FELTS=FELTS_C, felt='bordo';","const FELTS_O=[['noche','Noche','rgba(255,255,255,.06)'],['azul','Azul noche','rgba(70,110,220,.22)'],['vino','Vino','rgba(200,60,90,.20)'],['verde','Verde paño','rgba(40,170,120,.18)'],['humo','Humo','rgba(0,0,0,.28)']];\nlet FELTS=FELTS_C, felt='bordo';")
rep("const feltKey=()=>theme==='fun'?'burako-felt-fun':theme==='glass'?'burako-felt-glass':'burako-felt';","const feltKey=()=>theme==='onyx'?'burako-felt-onyx':theme==='fun'?'burako-felt-fun':theme==='glass'?'burako-felt-glass':'burako-felt';")
rep("FELTS=theme==='fun'?FELTS_F:theme==='glass'?FELTS_G:FELTS_C;","FELTS=theme==='onyx'?FELTS_O:theme==='fun'?FELTS_F:theme==='glass'?FELTS_G:FELTS_C;")
# Color: toggle con círculo blanco (Glass) y negro (Onyx), como el de idioma
rep('      <div class="lni-grp${lnavX===\'diseno\'?\' open\':\'\'}">${it(\'diseno\',\'lnavx\',\'Color\',`<span class="lni-v">${th[theme]}</span><svg class="lni-car" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`)}\n        <div class="lni-sub" role="tablist" aria-label="Modo de color">${[\'glass\',\'onyx\'].map(v=>`<button role="tab" data-act="theme" data-v="${v}" aria-selected="${theme===v}" class="th-${v}"><i></i>${th[v]}</button>`).join(\'\')}</div></div>',
    '      <div class="lni-b lni-row" data-nav="diseno">${LNAV_IC.diseno}<span class="lni-l">Color</span><span class="lni-seg lni-col" role="tablist" aria-label="Modo de color">${[\'glass\',\'onyx\'].map(v=>`<button role="tab" data-act="theme" data-v="${v}" aria-selected="${theme===v}" aria-label="${th[v]}" title="${th[v]}"><i class="cdot cd-${v}"></i></button>`).join(\'\')}</span></div>')
rep('      <div class="lns-x${lnavX===\'diseno\'?\' open\':\'\'}"><button class="lni-b" data-act="lnavx" data-x="diseno" data-nav="diseno" aria-label="Modo de color" aria-expanded="${lnavX===\'diseno\'}">${LNAV_IC.diseno}</button>\n        <span class="lns-fly lni-sub" role="tablist" aria-label="Modo de color">${[\'glass\',\'onyx\'].map(v=>`<button role="tab" data-act="theme" data-v="${v}" aria-selected="${theme===v}" class="th-${v}"><i></i>${th[v]}</button>`).join(\'\')}</span></div>',
    '      <div class="lns-x${lnavX===\'diseno\'?\' open\':\'\'}"><button class="lni-b" data-act="lnavx" data-x="diseno" data-nav="diseno" aria-label="Modo de color" aria-expanded="${lnavX===\'diseno\'}">${LNAV_IC.diseno}</button>\n        <span class="lns-fly lni-seg lni-col" role="tablist" aria-label="Modo de color">${[\'glass\',\'onyx\'].map(v=>`<button role="tab" data-act="theme" data-v="${v}" aria-selected="${theme===v}" aria-label="${th[v]}" title="${th[v]}"><i class="cdot cd-${v}"></i></button>`).join(\'\')}</span></div>')
# 5) módulo online al final
import time
rep("</body>", "<script>window.BURAKO_BUILD='"+str(int(time.time()))+"';</script>\n" + open(net, encoding='utf-8').read() + "\n</body>")
open(out, 'w', encoding='utf-8').write(h)
print("ok", len(h))

# 6) modo Onyx (oscuro) generado desde Glass
import subprocess as _sp, os as _os
_sp.run(['python3', _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),'onyx.py'), sys.argv[3], _os.path.join(_os.path.dirname(_os.path.abspath(__file__)),'onyx-manual.css')], check=True)
