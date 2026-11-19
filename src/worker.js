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
  const iss = clerkFapi(env);
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
    });
  }
  row(id) { return this.ctx.storage.sql.exec("SELECT * FROM players WHERE id=?", id).toArray()[0] || null; }
  out(r) {
    let data = {}; try { data = JSON.parse(r.data || "{}"); } catch (e) {}
    return { id: r.id, email: r.email, name: r.name, nameCustom: !!r.name_custom, imageUrl: r.image_url, avatar: r.avatar, photo: r.photo, provider: r.provider, created: r.created, data };
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
        clip(acc.email || r.email, 200), clip(acc.imageUrl, 500), clip(acc.provider || r.provider, 20), verified ? 1 : r.verified, now, clip(acc.name || r.name, 18), id);
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
  async count() { return this.ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM players").one().n; }
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
  let me = await st.sync(id, acc, !!official);
  if (request.method === "POST" && (b.name !== undefined || b.avatar !== undefined || b.data)) me = await st.edit(id, b);
  return Response.json(me, { headers: { "cache-control": "no-store" } });
}

export default {
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
