// Burako 106 — servidor de mesas online.
// Cada mesa es un "Durable Object": una salita en Cloudflare que conecta a los
// jugadores, les pasa los movimientos y guarda el último estado de la partida
// (así, si alguien recarga la página, vuelve a la misma mano).
import { DurableObject } from "cloudflare:workers";

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const ROLES = ["host", "guest"];
const ROOM_TTL = 3 * 24 * 60 * 60 * 1000; // una mesa sin uso se borra a los 3 días
const LOBBY_TTL = 60 * 1000; // una mesa abierta sin señales del anfitrión desaparece del lobby al minuto
const lobby = (env) => env.LOBBY.get(env.LOBBY.idFromName("lobby"));

// Lista de mesas abiertas que se ven en el lobby.
export class Lobby extends DurableObject {
  // Avisa al instante a todos los que están mirando el lobby
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("se espera websocket", { status: 426 });
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    try { pair[1].send(JSON.stringify({ t: "tables", list: await this.list() })); } catch (e) {}
    try { pair[1].send(JSON.stringify({ t: "chathist", list: (await this.ctx.storage.get("chat")) || [] })); } catch (e) {}
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
  async webSocketMessage(ws, raw) {
    if (raw === "ping") { try { ws.send("pong"); } catch (e) {} return; }
    if (raw === "list") { try { ws.send(JSON.stringify({ t: "tables", list: await this.list() })); } catch (e) {} return; }
    if (typeof raw !== "string" || raw.length > 600000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const clean = (s, n) => String(s || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n);
    if (m.t === "chat" && m.m) {
      // Chat del club: se reparte a todos y se guardan los últimos mensajes
      const c = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), who: clean(m.m.who, 18) || "Jugador", cav: Number.isInteger(m.m.cav) ? m.m.cav : 0,
        pid: clean(m.m.pid, 40), kind: ["text", "emoji", "voice"].includes(m.m.kind) ? m.m.kind : "text", txt: clean(m.m.txt, 120), at: Date.now() };
      if (!c.txt) return;
      const hist = ((await this.ctx.storage.get("chat")) || []).filter((x) => Date.now() - x.at < 86400000);
      hist.push(c); while (hist.length > 40) hist.shift();
      await this.ctx.storage.put("chat", hist);
      const data = JSON.stringify({ t: "chat", m: c });
      for (const w of this.ctx.getWebSockets()) { try { w.send(data); } catch (e) {} }
      return;
    }
    if (m.t === "vn" && typeof m.data === "string" && m.data.length < 460000) {
      // Nota de voz del club: solo en vivo, no se guarda
      const data = JSON.stringify({ t: "vn", who: clean(m.who, 18) || "Jugador", cav: Number.isInteger(m.cav) ? m.cav : 0, pid: clean(m.pid, 40), mime: clean(m.mime, 40), data: m.data, dur: Math.min(60, +m.dur || 1) });
      for (const w of this.ctx.getWebSockets()) { if (w !== ws) { try { w.send(data); } catch (e) {} } }
    }
  }
  async webSocketClose() {}
  async webSocketError() {}
  async push() {
    const socks = this.ctx.getWebSockets(); if (!socks.length) return;
    const data = JSON.stringify({ t: "tables", list: await this.list(true) });
    for (const w of socks) { try { w.send(data); } catch (e) {} }
  }
  async list(quiet) {
    const all = (await this.ctx.storage.get("tables")) || {};
    const now = Date.now();
    let changed = false;
    for (const [code, t] of Object.entries(all)) {
      if (now - t.seen > LOBBY_TTL) { delete all[code]; changed = true; }
    }
    if (changed) { await this.ctx.storage.put("tables", all); if (!quiet) this.push().catch(() => {}); }
    return Object.values(all).sort((a, b) => b.created - a.created);
  }
  async upsert(t) {
    const all = (await this.ctx.storage.get("tables")) || {};
    const old = all[t.code];
    const same = old && JSON.stringify({ ...old, created: 0, seen: 0 }) === JSON.stringify({ ...t, created: 0, seen: 0 });
    all[t.code] = { ...t, created: old ? old.created : Date.now(), seen: Date.now() };
    await this.ctx.storage.put("tables", all);
    if (!same) await this.push();
  }
  async remove(code) {
    const all = (await this.ctx.storage.get("tables")) || {};
    if (all[code]) { delete all[code]; await this.ctx.storage.put("tables", all); await this.push(); }
  }
}

const clean = (s, n) => String(s || "").replace(/[<>]/g, "").slice(0, n);
function tableFrom(b, code) {
  const r = b.rules || {};
  return {
    code,
    name: clean(b.name, 30) || "Mesa",
    host: { name: clean(b.host && b.host.name, 18) || "Jugador", cav: Number.isInteger(b.host && b.host.cav) ? b.host.cav : 0 },
    n: [2, 3, 4].includes(b.n) ? b.n : 2,
    seats: Array.isArray(b.seats) ? b.seats.slice(0, 4).map((s) => (s ? { name: clean(s.name, 18) || "Jugador", cav: Number.isInteger(s.cav) ? s.cav : 0, bot: !!s.bot } : null)) : null,
    goal: [0, 1500, 2500, 3000, 5000, 10000].includes(b.goal) ? b.goal : 3000,
    bet: [100, 500, 1000].includes(b.bet) ? b.bet : 100,
    timer: [30, 60, 120].includes(b.timer) ? b.timer : 60,
    rules: { legs: r.legs !== false, impura: r.impura !== false, chat: r.chat !== false },
  };
}

export class Room extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get("role");
    if (!ROLES.includes(role)) return new Response("rol inválido", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("se espera websocket", { status: 426 });
    const code = url.searchParams.get("mesa");
    if (code) await this.ctx.storage.put("code", code.toUpperCase());
    const pair = new WebSocketPair();
    // Hasta que no se presenta (mensaje "hello"), la conexión no ve nada de la partida.
    this.ctx.acceptWebSocket(pair[1], [role]);
    pair[1].serializeAttachment({ ok: false });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  info(ws) {
    try { return ws.deserializeAttachment() || {}; } catch (e) { return {}; }
  }
  okSockets() {
    return this.ctx.getWebSockets().filter((w) => this.info(w).ok);
  }
  onlinePids() {
    return [...new Set(this.okSockets().map((w) => this.info(w).pid))];
  }
  broadcast(from, msg) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const ws of this.okSockets()) {
      if (ws === from) continue;
      try { ws.send(data); } catch (e) {}
    }
  }
  reject(ws) {
    try { ws.send('{"t":"full"}'); } catch (e) {}
    try { ws.close(4001, "mesa llena"); } catch (e) {}
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 600000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const tagRole = this.ctx.getTags(ws)[0];
    if (m.t === "ping") { ws.send('{"t":"pong"}'); return; }

    if (m.t === "hello") {
      const role = tagRole;
      const who = m.who || {};
      const pid = typeof who.pid === "string" ? who.pid.slice(0, 40) : "";
      if (!pid) { this.reject(ws); return; }
      const room = (await this.ctx.storage.get("room")) || {};
      room.guests = room.guests || {};
      if (role === "host") {
        if (room.host && room.host.pid !== pid) { this.reject(ws); return; }
        room.host = who;
        if (typeof m.pw === "string") room.pw = m.pw.replace(/\s+/g, "").toUpperCase().slice(0, 8);
        if (Number.isInteger(who.cap) && who.cap >= 1 && who.cap <= 3) room.cap = who.cap;
      } else {
        const known = !!room.guests[pid];
        // Mesa con clave: quien no estaba sentado tiene que traer la clave correcta.
        if (!known && room.pw) {
          const pw = typeof m.pw === "string" ? m.pw.replace(/\s+/g, "").toUpperCase().slice(0, 8) : "";
          if (pw !== room.pw) {
            try { ws.send(JSON.stringify({ t: "needpw", bad: !!pw })); } catch (e) {}
            try { ws.close(4002, "clave"); } catch (e) {}
            return;
          }
        }
        const count = Object.keys(room.guests).length;
        // Mesa llena, o la partida ya empezó sin esta persona.
        if (!known && (room.state || count >= (room.cap || 1))) { this.reject(ws); return; }
        room.guests[pid] = who;
      }
      // La misma persona en otra pestaña o dispositivo: queda la conexión nueva.
      for (const old of this.okSockets()) {
        if (old !== ws && this.info(old).pid === pid) { try { old.close(4000, "reemplazado"); } catch (e) {} }
      }
      ws.serializeAttachment({ ok: true, pid, role });
      await this.ctx.storage.put("room", room);
      ws.send(JSON.stringify({ t: "sync", room, online: this.onlinePids() }));
      this.broadcast(ws, { t: "presence", role, pid, on: true });
      m.from = role;
      this.broadcast(ws, m);
      return;
    }

    const me = this.info(ws);
    if (!me.ok) return;
    const role = me.role || tagRole;

    if (m.t === "setpw") {
      if (role !== "host") return;
      const room = (await this.ctx.storage.get("room")) || {};
      room.pw = typeof m.pw === "string" ? m.pw.replace(/\s+/g, "").toUpperCase().slice(0, 8) : "";
      await this.ctx.storage.put("room", room);
      return;
    }

    if (m.t === "kick") {
      // Solo el anfitrión libera lugares (alguien se fue antes de empezar, o no había lugar).
      if (role !== "host" || typeof m.pid !== "string") return;
      const room = (await this.ctx.storage.get("room")) || {};
      if (room.guests && room.guests[m.pid] && !room.state) {
        delete room.guests[m.pid];
        await this.ctx.storage.put("room", room);
      }
      if (!m.soft) for (const w of this.okSockets()) if (this.info(w).pid === m.pid) this.reject(w);
      return;
    }
    if (m.t === "reset") {
      // Terminó la partida y se arma la revancha: la mesa vuelve a esperar jugadores.
      if (role !== "host") return;
      const room = (await this.ctx.storage.get("room")) || {};
      room.state = null; room.wait = true;
      await this.ctx.storage.put("room", room);
      return;
    }
    if (m.t === "claim") {
      // El anfitrión ya no está: la mesa pasa a quien pide la revancha.
      const room = (await this.ctx.storage.get("room")) || {};
      const hostPid = room.host && room.host.pid;
      if (hostPid && this.okSockets().some((w) => this.info(w).pid === hostPid)) return;
      room.guests = room.guests || {};
      room.host = room.guests[me.pid] || { pid: me.pid };
      delete room.guests[me.pid];
      await this.ctx.storage.put("room", room);
      ws.serializeAttachment(Object.assign({}, me, { role: "host" }));
      const msg = { t: "newhost", pid: me.pid };
      try { ws.send(JSON.stringify(msg)); } catch (e) {}
      this.broadcast(ws, msg);
      return;
    }
    if (m.t === "handoff") {
      // El anfitrión no confirmó: la mesa pasa a otro jugador que sí confirmó.
      if (role !== "host" || typeof m.pid !== "string") return;
      const room = (await this.ctx.storage.get("room")) || {};
      if (room.state) return;
      room.guests = room.guests || {};
      room.host = room.guests[m.pid] || { pid: m.pid };
      delete room.guests[m.pid];
      await this.ctx.storage.put("room", room);
    }
    if (m.t === "seats") {
      if (role !== "host") return;
      const room = (await this.ctx.storage.get("room")) || {};
      room.seats = m.seats;
      if ([2, 3, 4].includes(m.n)) room.n = m.n;
      if ([100, 500, 1000].includes(m.bet)) room.bet = m.bet;
      await this.ctx.storage.put("room", room);
    }
    if (m.t === "state") {
      const room = (await this.ctx.storage.get("room")) || {};
      // Se guarda solo si es más nuevo que lo que ya hay.
      if (room.wait && role !== "host") return;
      if (typeof m.v !== "number" || (room.v && m.v <= room.v)) return;
      room.wait = false;
      room.state = m.s;
      room.v = m.v;
      await this.ctx.storage.put("room", room);
    }
    m.from = role;
    this.broadcast(ws, m);
  }

  async webSocketClose(ws) {
    const me = this.info(ws);
    if (!me.ok) return;
    // Avisar solo si no quedó otra conexión de la misma persona.
    const still = this.okSockets().some((x) => x !== ws && this.info(x).pid === me.pid);
    if (!still) this.broadcast(ws, { t: "presence", role: me.role, pid: me.pid, on: false });
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}


// ---------------------------------------------------------------------------
// Jugadores con cuenta (Clerk). Un solo Durable Object guarda a todos en SQLite,
// para poder armar después el panel de administración.
// ---------------------------------------------------------------------------
const CLERK_PK_DEFAULT = "pk_test_ZmFpci1lc2NhcmdvdC0zMTE3LmNsZXJrLmFjY291bnRzLmRldiQ";
const players = (env) => env.PLAYERS.get(env.PLAYERS.idFromName("all"));
const clerkFapi = (env) => {
  const pk = env.CLERK_PUBLISHABLE_KEY || CLERK_PK_DEFAULT;
  try { return "https://" + atob(pk.split("_").slice(2).join("_")).replace(/\$$/, ""); } catch (e) { return ""; }
};
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let JWKS = { at: 0, keys: [] };
async function verifyClerk(request, env) {
  const h = request.headers.get("authorization") || "";
  const tok = h.startsWith("Bearer ") ? h.slice(7) : "";
  const parts = tok.split(".");
  if (parts.length !== 3) return null;
  let head, body;
  try { head = JSON.parse(new TextDecoder().decode(b64u(parts[0]))); body = JSON.parse(new TextDecoder().decode(b64u(parts[1]))); } catch (e) { return null; }
  const iss = env.TEST_ISSUER || clerkFapi(env); // TEST_ISSUER: solo para pruebas locales
  if (!iss || body.iss !== iss) return null;
  const now = Math.floor(Date.now() / 1000);
  if (!body.sub || (body.exp && body.exp < now - 5) || (body.nbf && body.nbf > now + 5)) return null;
  if (Date.now() - JWKS.at > 3600e3 || !JWKS.keys.some((k) => k.kid === head.kid)) {
    try { const r = await fetch(iss + "/.well-known/jwks.json"); const j = await r.json(); JWKS = { at: Date.now(), keys: j.keys || [] }; } catch (e) {}
  }
  const jwk = JWKS.keys.find((k) => k.kid === head.kid);
  if (!jwk) return null;
  try {
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64u(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
    return ok ? body : null;
  } catch (e) { return null; }
}
// Datos oficiales de la cuenta (solo si está guardada la Secret key en Cloudflare)
async function clerkUser(env, id) {
  if (!env.CLERK_SECRET_KEY) return null;
  try {
    const r = await fetch("https://api.clerk.com/v1/users/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + env.CLERK_SECRET_KEY } });
    if (!r.ok) return null;
    const u = await r.json();
    const em = (u.email_addresses || []).find((e) => e.id === u.primary_email_address_id) || (u.email_addresses || [])[0];
    const ext = (u.external_accounts || [])[0];
    return {
      email: em ? em.email_address : "",
      name: [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || "",
      imageUrl: u.has_image ? u.image_url : "",
      provider: ext ? String(ext.provider || "").replace(/^oauth_/, "") : "email",
    };
  } catch (e) { return null; }
}
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

export class Players extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS players (
        id TEXT PRIMARY KEY, email TEXT, name TEXT, name_custom INTEGER DEFAULT 0,
        image_url TEXT, avatar TEXT DEFAULT '', photo TEXT DEFAULT '', provider TEXT,
        verified INTEGER DEFAULT 0, created INTEGER, last_seen INTEGER, data TEXT DEFAULT '{}')`);
      try { this.ctx.storage.sql.exec("ALTER TABLE players ADD COLUMN pending INTEGER DEFAULT 0"); } catch (e) {}
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY, user_id TEXT, pack TEXT, tickets INTEGER, amount REAL, status TEXT,
        payment_id TEXT, created INTEGER, paid INTEGER)`);
      for (const col of ["bal INTEGER DEFAULT 0", "wallet INTEGER DEFAULT 0"]) { try { this.ctx.storage.sql.exec("ALTER TABLE players ADD COLUMN " + col); } catch (e) {} }
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS tx (
        id TEXT PRIMARY KEY, user_id TEXT, delta INTEGER, kind TEXT, meta TEXT, bal INTEGER, at INTEGER)`);
      this.ctx.storage.sql.exec("CREATE INDEX IF NOT EXISTS tx_user ON tx(user_id, at)");
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS subs (
        id TEXT PRIMARY KEY, user_id TEXT, plan TEXT, status TEXT, amount REAL, next_payment INTEGER,
        paid_until INTEGER DEFAULT 0, created INTEGER, updated INTEGER)`);
      this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY, user_id TEXT, entry INTEGER, settled INTEGER DEFAULT 0, pm INTEGER DEFAULT 0, at INTEGER)`);
    });
  }
  row(id) { return this.ctx.storage.sql.exec("SELECT * FROM players WHERE id=?", id).toArray()[0] || null; }
  out(r) {
    let data = {}; try { data = JSON.parse(r.data || "{}"); } catch (e) {}
    return { id: r.id, email: r.email, name: r.name, nameCustom: !!r.name_custom, imageUrl: r.image_url, avatar: r.avatar, photo: r.photo, provider: r.provider, created: r.created, pending: r.pending || 0, bal: r.bal || 0, wallet: !!r.wallet, data };
  }
  // Primera vez: crea al jugador. Después: actualiza los datos de la cuenta (sin pisar lo que él cambió en el juego).
  async sync(id, acc, verified) {
    const now = Date.now();
    const r = this.row(id);
    if (!r) {
      this.ctx.storage.sql.exec("INSERT INTO players (id,email,name,image_url,provider,verified,created,last_seen) VALUES (?,?,?,?,?,?,?,?)",
        id, clip(acc.email, 200), clip(acc.name || "Jugador", 18), clip(acc.imageUrl, 500), clip(acc.provider, 20), verified ? 1 : 0, now, now);
    } else {
      this.ctx.storage.sql.exec("UPDATE players SET email=?, image_url=?, provider=?, verified=?, last_seen=?, name=CASE WHEN name_custom=1 THEN name ELSE ? END WHERE id=?",
        clip(acc.email || r.email, 200), clip(acc.imageUrl || r.image_url, 500), clip(acc.provider || r.provider, 20), verified ? 1 : r.verified, now, clip(acc.name || r.name, 18), id);
    }
    return this.out(this.row(id));
  }
  // Cambios hechos en el juego: nombre, personaje o foto, y un resumen de su partida
  async edit(id, b) {
    const r = this.row(id); if (!r) return null;
    if (typeof b.name === "string" && b.name.trim()) this.ctx.storage.sql.exec("UPDATE players SET name=?, name_custom=1 WHERE id=?", clip(b.name.trim(), 18), id);
    if (typeof b.avatar === "string") {
      const ph = b.avatar === "photo" && typeof b.photo === "string" && b.photo.startsWith("data:image/") && b.photo.length < 200000 ? b.photo : "";
      this.ctx.storage.sql.exec("UPDATE players SET avatar=?, photo=? WHERE id=?", clip(b.avatar === "photo" && !ph ? "" : b.avatar, 20), ph, id);
    }
    if (b.data && typeof b.data === "object") {
      let d = {}; try { d = JSON.parse(r.data || "{}"); } catch (e) {}
      Object.assign(d, b.data); const js = JSON.stringify(d);
      if (js.length < 20000) this.ctx.storage.sql.exec("UPDATE players SET data=? WHERE id=?", js, id);
    }
    this.ctx.storage.sql.exec("UPDATE players SET last_seen=? WHERE id=?", Date.now(), id);
    return this.out(this.row(id));
  }
  async remove(id) { this.ctx.storage.sql.exec("DELETE FROM players WHERE id=?", id); return true; }
  // compras: la orden se crea antes de ir a Mercado Pago; se acredita una sola vez, cuando MP confirma el pago
  async get(id) { const r = this.row(id); return r ? this.out(r) : null; }
  async ensure(id) {
    if (!this.row(id)) { const now = Date.now(); this.ctx.storage.sql.exec("INSERT INTO players (id,name,created,last_seen) VALUES (?,?,?,?)", id, "Jugador", now, now); }
    return true;
  }
  async newOrder(o) {
    this.ctx.storage.sql.exec("INSERT INTO orders (id,user_id,pack,tickets,amount,status,created) VALUES (?,?,?,?,?,'created',?)", o.id, o.user, o.pack, o.tickets, o.amount, Date.now());
    return true;
  }
  async order(id) { return this.ctx.storage.sql.exec("SELECT * FROM orders WHERE id=?", id).toArray()[0] || null; }
  async creditOrder(orderId, paymentId) {
    const o = this.ctx.storage.sql.exec("SELECT * FROM orders WHERE id=?", orderId).toArray()[0];
    if (!o) return { ok: false, why: "no-order" };
    if (o.status === "paid") return { ok: true, already: true, tickets: o.tickets };
    const paidOther = this.ctx.storage.sql.exec("SELECT id FROM orders WHERE payment_id=?", String(paymentId)).toArray()[0];
    if (paidOther) return { ok: true, already: true };
    this.ctx.storage.sql.exec("UPDATE orders SET status='paid', payment_id=?, paid=? WHERE id=?", String(paymentId), Date.now(), orderId);
    this.ctx.storage.sql.exec("UPDATE players SET pending=COALESCE(pending,0)+? WHERE id=?", o.tickets, o.user_id);
    return { ok: true, tickets: o.tickets, user: o.user_id };
  }
  async markOrder(orderId, status, paymentId) {
    this.ctx.storage.sql.exec("UPDATE orders SET status=?, payment_id=COALESCE(payment_id,?) WHERE id=? AND status!='paid'", status, String(paymentId || ""), orderId);
  }
  // el juego retira los tickets acreditados (una sola vez)
  async claim(id) {
    const r = this.row(id); const n = (r && r.pending) || 0;
    if (n > 0) {
      this.ctx.storage.sql.exec("UPDATE players SET pending=0, bal=COALESCE(bal,0)+? WHERE id=?", n, id);
      const b = this.row(id).bal;
      this.ctx.storage.sql.exec("INSERT INTO tx (id,user_id,delta,kind,meta,bal,at) VALUES (?,?,?,?,?,?,?)", "buy-" + crypto.randomUUID(), id, n, "purchase", "{}", b, Date.now());
    }
    return n;
  }
  // ===== Saldo de tickets: vive acá. El juego pide movimientos y el servidor decide si valen. =====
  wallet(id) { const r = this.row(id); return { bal: (r && r.bal) || 0, ready: !!(r && r.wallet) }; }
  // Primera vez con saldo en el servidor: se pasa el saldo que el jugador tenía en su dispositivo (con tope), o se dan los 500 de bienvenida
  async walletInit(id, init) {
    await this.ensure(id);
    const r = this.row(id);
    if (r.wallet) return { ...this.wallet(id), gift: 0 };
    let bal = 0, gift = 0, kind = "migrate";
    if (init && init.mine && Number.isFinite(+init.bal)) bal = Math.max(0, Math.min(20000, Math.round(+init.bal)));
    if (!(init && init.mine && init.signupGiven)) { gift = 500; bal += gift; kind = "signup"; }
    this.ctx.storage.sql.exec("UPDATE players SET bal=?, wallet=1 WHERE id=?", bal, id);
    this.ctx.storage.sql.exec("INSERT INTO tx (id,user_id,delta,kind,meta,bal,at) VALUES (?,?,?,?,?,?,?)", "init-" + id, id, bal, kind, JSON.stringify({ local: init && init.bal, gift }), bal, Date.now());
    return { ...this.wallet(id), gift };
  }
  // Un movimiento pedido por el juego. Reglas: gastar siempre se puede (si alcanza); ganar solo lo que corresponde.
  async applyTx(id, t) {
    const sql = this.ctx.storage.sql, now = Date.now();
    const r = this.row(id); if (!r || !r.wallet) return { ok: false, why: "sin-saldo" };
    const txid = String(t.id || "").slice(0, 64); if (!txid) return { ok: false, why: "id" };
    if (sql.exec("SELECT id FROM tx WHERE id=?", txid).toArray()[0]) return { ok: true, dup: true };
    const kind = String(t.kind || ""), delta = Math.round(+t.delta || 0), meta = t.meta && typeof t.meta === "object" ? t.meta : {};
    let bal = r.bal || 0, ok = false, why = "";
    const game = meta.game ? sql.exec("SELECT * FROM games WHERE id=? AND user_id=?", String(meta.game), id).toArray()[0] : null;
    const dayStart = (() => { const d = new Date(now - 3 * 3600e3); d.setUTCHours(0, 0, 0, 0); return d.getTime() + 3 * 3600e3; })(); // día de Argentina
    if (kind === "entry") {
      const amt = -delta;
      if (![100, 500, 1000].includes(amt)) why = "monto";
      else if (bal < amt) why = "saldo";
      else { ok = true; sql.exec("INSERT OR IGNORE INTO games (id,user_id,entry,at) VALUES (?,?,?,?)", txid, id, amt, now); }
    } else if (kind === "penalty") {
      ok = delta < 0 && -delta <= 1000; if (!ok) why = "monto";
    } else if (kind === "prize" || kind === "refund") {
      const max = game ? (kind === "prize" ? Math.round(game.entry * 2 * 0.9) : game.entry) : 0;
      if (!game || game.settled) why = "partida";
      else if (delta <= 0 || delta > max) why = "monto";
      else { ok = true; sql.exec("UPDATE games SET settled=1 WHERE id=?", game.id); }
    } else if (kind === "puramadre") {
      if (!game) why = "partida";
      else if (delta !== 50 || game.pm >= 3) why = "monto";
      else { ok = true; sql.exec("UPDATE games SET pm=pm+1 WHERE id=?", game.id); }
    } else if (kind === "video") {
      const vids = sql.exec("SELECT at FROM tx WHERE user_id=? AND kind='video' AND at>=? ORDER BY at DESC", id, dayStart).toArray();
      const live = this.env && this.env.MP_LIVE === "1";
      if (delta !== 100) why = "monto";
      else if (!live) ok = true; // modo prueba: videos libres para los que prueban
      else if (vids.length >= 2) why = "limite";
      else if (vids[0] && now - vids[0].at < 3 * 3600e3 - 60e3) why = "espera";
      else ok = true;
    } else why = "tipo";
    if (!ok) return { ok: false, why, bal };
    bal = Math.max(0, bal + delta);
    sql.exec("UPDATE players SET bal=? WHERE id=?", bal, id);
    sql.exec("INSERT INTO tx (id,user_id,delta,kind,meta,bal,at) VALUES (?,?,?,?,?,?,?)", txid, id, delta, kind, JSON.stringify(meta).slice(0, 500), bal, now);
    return { ok: true, bal };
  }
  async applyMany(id, list) {
    const res = [];
    for (const t of (list || []).slice(0, 30)) res.push({ id: t.id, ...(await this.applyTx(id, t)) });
    return { results: res, ...this.wallet(id) };
  }
  // ===== Suscripciones (Mercado Pago cobra solo; acá guardamos el estado) =====
  async subSave(x) {
    const sql = this.ctx.storage.sql, now = Date.now();
    const r = sql.exec("SELECT * FROM subs WHERE id=?", x.id).toArray()[0];
    let paid = (r && r.paid_until) || 0;
    if (x.status === "authorized" && x.next_payment) paid = Math.max(paid, x.next_payment + 3 * 864e5); // 3 días de margen por si el cobro se demora
    if (!r) sql.exec("INSERT INTO subs (id,user_id,plan,status,amount,next_payment,paid_until,created,updated) VALUES (?,?,?,?,?,?,?,?,?)", x.id, x.user, x.plan, x.status, x.amount, x.next_payment || null, paid, now, now);
    else sql.exec("UPDATE subs SET status=?, next_payment=?, paid_until=?, updated=? WHERE id=?", x.status, x.next_payment || null, paid, now, x.id);
    return this.subOf(x.user);
  }
  subOf(user) {
    const now = Date.now();
    const rows = this.ctx.storage.sql.exec("SELECT * FROM subs WHERE user_id=? ORDER BY updated DESC", user).toArray();
    const act = rows.find((r) => r.paid_until > now && ["authorized", "cancelled", "paused"].includes(r.status));
    const pend = rows.find((r) => r.status === "pending" && now - r.created < 864e5);
    if (act) return { id: act.id, plan: act.plan, status: act.status, until: act.paid_until, cancelled: act.status !== "authorized" };
    if (pend) return { id: pend.id, plan: pend.plan, status: "pending", until: 0, cancelled: false };
    return null;
  }
  async subGet(user) { return this.subOf(user); }
  async subEnd(id) { this.ctx.storage.sql.exec("UPDATE subs SET status='cancelled', paid_until=?, updated=? WHERE id=?", Date.now() - 1000, Date.now(), id); return true; }
  async subRow(id) { return this.ctx.storage.sql.exec("SELECT * FROM subs WHERE id=?", id).toArray()[0] || null; }
  async subsToRefresh() { return this.ctx.storage.sql.exec("SELECT id FROM subs WHERE status IN ('authorized','pending','paused') OR paid_until>?", Date.now()).toArray().map((r) => r.id); }
  // Copia de seguridad: todo lo importante, sin las fotos (que pesan mucho)
  async exportAll() {
    const sql = this.ctx.storage.sql;
    return {
      players: sql.exec("SELECT id,email,name,name_custom,image_url,avatar,provider,verified,created,last_seen,pending,bal,wallet,data FROM players").toArray(),
      orders: sql.exec("SELECT * FROM orders").toArray(),
      subs: sql.exec("SELECT * FROM subs").toArray(),
      tx: sql.exec("SELECT * FROM tx WHERE at>=?", Date.now() - 90 * 864e5).toArray(),
    };
  }
  async count() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM players").one().n; }
}

// ---------------------------------------------------------------------------
// Mercado Pago (Checkout Pro). Los precios viven acá, en el servidor: el navegador no los puede cambiar.
// ---------------------------------------------------------------------------
const MP_PACKS = {
  chico: { title: "Burako 106 · 1.000 tickets", tickets: 1000, ars: 1190 },
  grande: { title: "Burako 106 · 3.000 tickets", tickets: 3000, ars: 2990 },
};
const mpApi = (env, path, opt = {}) => fetch((env.TEST_MP_BASE || "https://api.mercadopago.com") + path, {
  ...opt, headers: { authorization: "Bearer " + env.MP_ACCESS_TOKEN, "content-type": "application/json", ...(opt.headers || {}) } });
const rid = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => x.toString(16).padStart(2, "0")).join("");

// Seguro de "modo prueba": mientras no exista MP_LIVE=1, solo se aceptan credenciales de una cuenta de prueba de MP
let MPWHO = null;
async function mpIsTest(env) {
  if (env.MP_LIVE === "1") return true;
  if (!MPWHO) { try { const r = await mpApi(env, "/users/me"); const j = await r.json(); MPWHO = { test: Array.isArray(j.tags) && j.tags.includes("test_user") }; } catch (e) { return false; } }
  return MPWHO.test;
}
async function mpCheckout(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  if (!env.MP_ACCESS_TOKEN) return Response.json({ error: "falta MP_ACCESS_TOKEN" }, { status: 500 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const pk = MP_PACKS[b.pack]; if (!pk) return Response.json({ error: "paquete" }, { status: 400 });
  if (!(await mpIsTest(env))) return Response.json({ error: "no-test" }, { status: 409 });
  const u0 = new URL(request.url);
  const origin = /^(localhost|127\.)/.test(u0.hostname) ? u0.origin : "https://" + u0.host; // Mercado Pago exige https
  const st = players(env);
  await st.ensure(claims.sub);
  const order = rid();
  await st.newOrder({ id: order, user: claims.sub, pack: b.pack, tickets: pk.tickets, amount: pk.ars });
  const body = {
    items: [{ id: b.pack, title: pk.title, quantity: 1, unit_price: pk.ars, currency_id: "ARS" }],
    external_reference: order,
    back_urls: { success: origin + "/?mp=ok", failure: origin + "/?mp=fail", pending: origin + "/?mp=pend" },
    auto_return: "approved",
    notification_url: origin + "/api/mp/webhook",
    statement_descriptor: "BURAKO106",
    metadata: { order, user: claims.sub, pack: b.pack },
  };
  const r = await mpApi(env, "/checkout/preferences", { method: "POST", body: JSON.stringify(body), headers: { "x-idempotency-key": order } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.init_point) return Response.json({ error: "mp", detail: j.message || r.status }, { status: 502 });
  return Response.json({ url: j.init_point, order });
}

// Revisa el pago directamente con Mercado Pago y, si está aprobado y coincide, acredita (una sola vez)
async function mpSettle(env, paymentId) {
  if (!env.MP_ACCESS_TOKEN || !/^\d+$/.test(String(paymentId || ""))) return { ok: false, why: "id" };
  const r = await mpApi(env, "/v1/payments/" + paymentId);
  if (!r.ok) return { ok: false, why: "mp " + r.status };
  const p = await r.json();
  const order = p.external_reference; if (!order) return { ok: false, why: "ref" };
  const st = players(env);
  const o = await st.order(order); if (!o) return { ok: false, why: "no-order" };
  if (p.status !== "approved") { await st.markOrder(order, p.status || "unknown", paymentId); return { ok: false, status: p.status }; }
  if (p.currency_id !== "ARS" || Number(p.transaction_amount) + 0.001 < Number(o.amount)) return { ok: false, why: "monto" };
  const res = await st.creditOrder(order, paymentId);
  return { ...res, status: "approved", user: o.user_id };
}

// ---------------------------------------------------------------------------
// Suscripciones con Mercado Pago (cobro automático mensual o anual). Precios fijados acá.
// ---------------------------------------------------------------------------
const MP_SUBS = {
  mensual: { reason: "Burako 106 · Suscripción mensual", amount: 6260, months: 1 },
  anual: { reason: "Burako 106 · Suscripción anual", amount: 63852, months: 12 },
};
// Lee la suscripción en Mercado Pago (la fuente de verdad) y guarda su estado
async function mpSubRefresh(env, id) {
  if (!id || !/^[\w-]{6,64}$/.test(id)) return null;
  const r = await mpApi(env, "/preapproval/" + encodeURIComponent(id));
  if (!r.ok) return null;
  const p = await r.json();
  const [user, plan] = String(p.external_reference || "").split("|");
  const pl = MP_SUBS[plan]; if (!user || !pl) return null;
  const ar = p.auto_recurring || {};
  if (ar.currency_id !== "ARS" || Number(ar.transaction_amount) + 0.001 < pl.amount) return null; // monto o moneda no coinciden: no se activa
  const next = p.next_payment_date ? Date.parse(p.next_payment_date) : 0;
  return players(env).subSave({ id: p.id, user, plan, status: p.status, amount: Number(ar.transaction_amount), next_payment: next });
}
async function mpSubCreate(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  if (!env.MP_ACCESS_TOKEN) return Response.json({ error: "falta MP_ACCESS_TOKEN" }, { status: 500 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const pl = MP_SUBS[b.plan]; if (!pl) return Response.json({ error: "plan" }, { status: 400 });
  const email = String(b.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "email" }, { status: 400 });
  if (!(await mpIsTest(env))) return Response.json({ error: "no-test" }, { status: 409 });
  const st = players(env);
  await st.ensure(claims.sub);
  const cur = await st.subGet(claims.sub);
  if (cur && cur.status === "authorized") return Response.json({ error: "ya-activa" }, { status: 409 });
  const u0 = new URL(request.url);
  const origin = /^(localhost|127\.)/.test(u0.hostname) ? u0.origin : "https://" + u0.host;
  const body = {
    reason: pl.reason,
    external_reference: claims.sub + "|" + b.plan + "|" + rid(),
    payer_email: email,
    auto_recurring: { frequency: pl.months, frequency_type: "months", transaction_amount: pl.amount, currency_id: "ARS" },
    back_url: origin + "/?mp=sub",
    status: "pending",
  };
  const r = await mpApi(env, "/preapproval", { method: "POST", body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && /payer|email/i.test(String(j.message || ""))) return Response.json({ error: "email-mp", detail: j.message }, { status: 400 });
  if (!r.ok || !j.init_point) return Response.json({ error: "mp", detail: j.message || r.status }, { status: 502 });
  await st.subSave({ id: j.id, user: claims.sub, plan: b.plan, status: "pending", amount: pl.amount, next_payment: 0 });
  return Response.json({ url: j.init_point, id: j.id });
}
async function mpSubCheck(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const st = players(env);
  const id = b.id || ((await st.subGet(claims.sub)) || {}).id;
  if (id) { const row = await st.subRow(id); if (row && row.user_id === claims.sub) await mpSubRefresh(env, id); }
  return Response.json({ sub: await st.subGet(claims.sub) });
}
async function mpSubCancel(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  const st = players(env);
  const cur = await st.subGet(claims.sub);
  if (!cur) return Response.json({ sub: null });
  const live = env.MP_LIVE === "1";
  const r = cur.cancelled ? { ok: true } : await mpApi(env, "/preapproval/" + encodeURIComponent(cur.id), { method: "PUT", body: JSON.stringify({ status: "cancelled" }) });
  if (!r.ok && live) return Response.json({ error: "mp" }, { status: 502 });
  if (live) await mpSubRefresh(env, cur.id);
  else await st.subEnd(cur.id); // modo prueba: se corta en el momento, para poder volver a probar
  return Response.json({ sub: await st.subGet(claims.sub) });
}

async function mpSigOk(request, env, dataId) {
  if (!env.MP_WEBHOOK_SECRET) return true; // si no hay clave, igual consultamos el pago a MP antes de acreditar
  const sig = request.headers.get("x-signature") || "", reqId = request.headers.get("x-request-id") || "";
  const parts = Object.fromEntries(sig.split(",").map((x) => x.trim().split("=")));
  if (!parts.ts || !parts.v1) return false;
  let manifest = "";
  if (dataId) manifest += "id:" + String(dataId).toLowerCase() + ";";
  if (reqId) manifest += "request-id:" + reqId + ";";
  manifest += "ts:" + parts.ts + ";";
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.MP_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest)));
  const hex = Array.from(mac, (x) => x.toString(16).padStart(2, "0")).join("");
  return hex === parts.v1;
}

async function mpWebhook(request, env) {
  const url = new URL(request.url);
  let b = {}; try { b = await request.json(); } catch (e) {}
  const type = url.searchParams.get("type") || url.searchParams.get("topic") || b.type || b.topic || "";
  const id = url.searchParams.get("data.id") || (b.data && b.data.id) || url.searchParams.get("id") || "";
  if (!(await mpSigOk(request, env, url.searchParams.get("data.id") || (b.data && b.data.id) || ""))) return new Response("firma", { status: 401 });
  if (type.startsWith("payment") && id) { try { await mpSettle(env, id); } catch (e) {} }
  if (type === "subscription_preapproval" && id) { try { await mpSubRefresh(env, id); } catch (e) {} }
  if (type === "subscription_authorized_payment" && id) {
    try { const r = await mpApi(env, "/authorized_payments/" + encodeURIComponent(id)); if (r.ok) { const a = await r.json(); if (a.preapproval_id) await mpSubRefresh(env, a.preapproval_id); } } catch (e) {}
  }
  return new Response("ok");
}

// al volver de Mercado Pago, el juego pide revisar el pago (el servidor lo confirma con MP, no con el navegador)
async function mpCheck(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const res = await mpSettle(env, b.payment_id);
  if (res.user && res.user !== claims.sub) return Response.json({ ok: false });
  return Response.json({ ok: !!res.ok, status: res.status || null });
}

// ---------------------------------------------------------------------------
// Copias de seguridad: una por día, se guardan 30 días (aparte de la recuperación propia de Cloudflare).
// ---------------------------------------------------------------------------
export class Backups extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS snaps (day TEXT, part INTEGER, json TEXT, at INTEGER, PRIMARY KEY(day, part))");
    });
  }
  async save(day, data) {
    const js = JSON.stringify(data), size = 900000;
    this.ctx.storage.sql.exec("DELETE FROM snaps WHERE day=?", day);
    for (let i = 0, part = 0; i < js.length; i += size, part++)
      this.ctx.storage.sql.exec("INSERT INTO snaps (day,part,json,at) VALUES (?,?,?,?)", day, part, js.slice(i, i + size), Date.now());
    const old = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 10);
    this.ctx.storage.sql.exec("DELETE FROM snaps WHERE day<?", old);
    return { day, bytes: js.length, players: (data.players || []).length };
  }
  async list() { return this.ctx.storage.sql.exec("SELECT day, COUNT(*) AS parts, SUM(LENGTH(json)) AS bytes, MAX(at) AS at FROM snaps GROUP BY day ORDER BY day DESC").toArray(); }
  async get(day) { const rows = this.ctx.storage.sql.exec("SELECT json FROM snaps WHERE day=? ORDER BY part", day).toArray(); return rows.length ? rows.map((r) => r.json).join("") : null; }
}
async function runBackup(env) {
  const data = await players(env).exportAll();
  const day = new Date().toISOString().slice(0, 10);
  return env.BACKUPS.get(env.BACKUPS.idFromName("all")).save(day, { at: Date.now(), ...data });
}

async function apiWallet(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  let b = {}; try { b = await request.json(); } catch (e) {}
  const st = players(env);
  let out = {};
  if (b.init) out.init = await st.walletInit(claims.sub, b.init);
  if (Array.isArray(b.tx) && b.tx.length) Object.assign(out, await st.applyMany(claims.sub, b.tx));
  if (!out.results) Object.assign(out, await st.applyMany(claims.sub, []));
  return Response.json(out, { headers: { "cache-control": "no-store" } });
}

async function apiMe(request, env) {
  const claims = await verifyClerk(request, env);
  if (!claims) return Response.json({ error: "no autorizado" }, { status: 401 });
  const id = claims.sub;
  if (request.method === "DELETE") {
    // borrar la cuenta: el registro del jugador y, si está la Secret key, también la cuenta en Clerk
    await players(env).remove(id);
    let clerk = false;
    if (env.CLERK_SECRET_KEY) {
      try { const r = await fetch("https://api.clerk.com/v1/users/" + encodeURIComponent(id), { method: "DELETE", headers: { authorization: "Bearer " + env.CLERK_SECRET_KEY } }); clerk = r.ok; } catch (e) {}
    }
    return Response.json({ deleted: true, clerk });
  }
  let b = {};
  if (request.method === "POST") { try { b = await request.json(); } catch (e) {} }
  const st = players(env);
  const official = await clerkUser(env, id);
  const hint = b.account || {};
  const acc = official || { email: clip(hint.email, 200), name: clip(hint.name, 18), imageUrl: clip(hint.imageUrl, 500), provider: clip(hint.provider, 20) };
  let me;
  if (official || b.account) me = await st.sync(id, acc, !!official);
  else { await st.ensure(id); me = await st.get(id); } // pedidos sin datos de cuenta (cambios de nombre, tickets): no tocar el perfil
  if (request.method === "POST" && (b.name !== undefined || b.avatar !== undefined || b.data)) me = await st.edit(id, b);
  if (request.method === "POST" && b.claim) { me.claimed = await st.claim(id); me.pending = 0; }
  if (me) {
    me.sub = await st.subGet(id);
    if (me.sub && me.sub.status === "pending") { try { await mpSubRefresh(env, me.sub.id); me.sub = await st.subGet(id); } catch (e) {} }
    me.live = env.MP_LIVE === "1";
  }
  return Response.json(me, { headers: { "cache-control": "no-store" } });
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { for (const id of await players(env).subsToRefresh()) await mpSubRefresh(env, id); } catch (e) {}
      await runBackup(env);
    })());
  },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/tables") {
      const lb = lobby(env);
      if (request.method === "GET") {
        return Response.json(await lb.list(), { headers: { "cache-control": "no-store" } });
      }
      const code = (url.searchParams.get("mesa") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("mesa inválida", { status: 400 });
      if (request.method === "POST") {
        let b = {};
        try { b = await request.json(); } catch (e) {}
        await lb.upsert(tableFrom(b, code));
        return new Response("ok");
      }
      if (request.method === "DELETE") { await lb.remove(code); return new Response("ok"); }
      return new Response("método no permitido", { status: 405 });
    }
    if (url.pathname === "/api/me") return apiMe(request, env);
    if (url.pathname === "/api/wallet" && request.method === "POST") return apiWallet(request, env);
    if (url.pathname === "/api/_test/backups" && env.TEST_ISSUER) return Response.json(await env.BACKUPS.get(env.BACKUPS.idFromName("all")).list()); // solo pruebas locales
    if (url.pathname === "/api/mp/checkout" && request.method === "POST") return mpCheckout(request, env);
    if (url.pathname === "/api/mp/check" && request.method === "POST") return mpCheck(request, env);
    if (url.pathname === "/api/mp/webhook") return mpWebhook(request, env);
    if (url.pathname === "/api/mp/sub" && request.method === "POST") return mpSubCreate(request, env);
    if (url.pathname === "/api/mp/sub/check" && request.method === "POST") return mpSubCheck(request, env);
    if (url.pathname === "/api/mp/sub/cancel" && request.method === "POST") return mpSubCancel(request, env);
    if (url.pathname === "/ws/lobby") return lobby(env).fetch(request);
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("mesa") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("mesa inválida", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
