// Burako 106 — servidor de mesas online.
// Cada mesa es un "Durable Object": una salita en Cloudflare que conecta a los
// jugadores, les pasa los movimientos y guarda el último estado de la partida
// (así, si alguien recarga la página, vuelve a la misma mano).
import { DurableObject } from "cloudflare:workers";

const CODE_RE = /^[A-Z0-9]{4,12}$/;
const ROLES = ["host", "guest"];
const ROOM_TTL = 3 * 24 * 60 * 60 * 1000; // una mesa sin uso se borra a los 3 días

export class Room extends DurableObject {
  async fetch(request) {
    const role = new URL(request.url).searchParams.get("role");
    if (!ROLES.includes(role)) return new Response("rol inválido", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("se espera websocket", { status: 426 });

    // Un solo dispositivo por rol: si alguien vuelve a entrar, se corta la conexión vieja.
    for (const old of this.ctx.getWebSockets(role)) {
      try { old.close(4000, "reemplazado"); } catch (e) {}
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], [role]);
    const room = (await this.ctx.storage.get("room")) || {};
    pair[1].send(JSON.stringify({ t: "sync", room, online: this.onlineRoles() }));
    this.broadcast(pair[1], { t: "presence", role, on: true });
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  onlineRoles() {
    return ROLES.filter((r) => this.ctx.getWebSockets(r).length > 0);
  }

  broadcast(from, msg) {
    const data = typeof msg === "string" ? msg : JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === from) continue;
      try { ws.send(data); } catch (e) {}
    }
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > 400000) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const role = this.ctx.getTags(ws)[0];
    if (m.t === "ping") { ws.send('{"t":"pong"}'); return; }

    if (m.t === "hello" || m.t === "state") {
      const room = (await this.ctx.storage.get("room")) || {};
      if (m.t === "hello") room[role] = m.who;
      if (m.t === "state") {
        // Se guarda solo si es más nuevo que lo que ya hay.
        if (typeof m.v !== "number" || (room.v && m.v <= room.v)) return;
        room.state = m.s;
        room.v = m.v;
      }
      await this.ctx.storage.put("room", room);
    }
    m.from = role;
    this.broadcast(ws, m);
  }

  async webSocketClose(ws) {
    const role = this.ctx.getTags(ws)[0];
    // Avisar solo si no quedó otra conexión del mismo jugador.
    const still = this.ctx.getWebSockets(role).some((x) => x !== ws);
    if (!still) this.broadcast(ws, { t: "presence", role, on: false });
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
    if (url.pathname === "/ws") {
      const code = (url.searchParams.get("mesa") || "").toUpperCase();
      if (!CODE_RE.test(code)) return new Response("mesa inválida", { status: 400 });
      const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
      return stub.fetch(request);
    }
    return env.ASSETS.fetch(request);
  },
};
