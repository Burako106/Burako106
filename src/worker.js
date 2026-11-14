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
  async list() {
    const all = (await this.ctx.storage.get("tables")) || {};
    const now = Date.now();
    let changed = false;
    for (const [code, t] of Object.entries(all)) {
      if (now - t.seen > LOBBY_TTL) { delete all[code]; changed = true; }
    }
    if (changed) await this.ctx.storage.put("tables", all);
    return Object.values(all).sort((a, b) => b.created - a.created);
  }
  async upsert(t) {
    const all = (await this.ctx.storage.get("tables")) || {};
    const old = all[t.code];
    all[t.code] = { ...t, created: old ? old.created : Date.now(), seen: Date.now() };
    await this.ctx.storage.put("tables", all);
  }
  async remove(code) {
    const all = (await this.ctx.storage.get("tables")) || {};
    if (all[code]) { delete all[code]; await this.ctx.storage.put("tables", all); }
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
    seats: Array.isArray(b.seats) ? b.seats.slice(0, 4).map((s) => (s ? { name: clean(s.name, 18) || "Jugador", cav: Number.isInteger(s.cav) ? s.cav : 0 } : null)) : null,
    goal: [0, 1500, 2500, 3000, 5000, 10000].includes(b.goal) ? b.goal : 3000,
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
    if (typeof raw !== "string" || raw.length > 400000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const role = this.ctx.getTags(ws)[0];
    if (m.t === "ping") { ws.send('{"t":"pong"}'); return; }

    if (m.t === "hello") {
      const who = m.who || {};
      const pid = typeof who.pid === "string" ? who.pid.slice(0, 40) : "";
      if (!pid) { this.reject(ws); return; }
      const room = (await this.ctx.storage.get("room")) || {};
      room.guests = room.guests || {};
      if (role === "host") {
        if (room.host && room.host.pid !== pid) { this.reject(ws); return; }
        room.host = who;
        if (Number.isInteger(who.cap) && who.cap >= 1 && who.cap <= 3) room.cap = who.cap;
      } else {
        const known = !!room.guests[pid];
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
    if (m.t === "seats") {
      if (role !== "host") return;
      const room = (await this.ctx.storage.get("room")) || {};
      room.seats = m.seats;
      await this.ctx.storage.put("room", room);
    }
    if (m.t === "state") {
      const room = (await this.ctx.storage.get("room")) || {};
      // Se guarda solo si es más nuevo que lo que ya hay.
      if (typeof m.v !== "number" || (room.v && m.v <= room.v)) return;
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
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("mesa") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("mesa inválida", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
