// PokeRogue Soul Link – Server
// Keine Abhängigkeiten nötig: läuft mit purem Node.js (>= 18).
// Start: node server.js   (Port über PORT, Speicherort über DATA_FILE)

"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT) || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "rooms.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const ONLINE_MS = 20_000;
const MAX_BODY = 1024 * 1024;

const DEFAULT_SETTINGS = {
  forceNickname: true, // nach dem Fangen muss ein Spitzname vergeben werden
  blockCatchAfterFirst: true, // nach dem ersten Fang im Abschnitt ist das Ball-Menü gesperrt
  biomeDupeClause: true, // in einem Biom, in dem man schon gefangen hat, darf man später nicht mehr fangen
  waitAtBosses: true, // vor Biom-Boss, Rivale, Top 4 & Champ auf den Partner warten
  releaseOnPartnerDeath: true, // Partner-Pokémon stirbt -> eigenes wird freigelassen
  releaseOnPartnerGone: true, // Partner hat sein Pokémon freigelassen/verloren -> eigenes auch
  releaseIfPartnerMissed: true, // Partner hat im Abschnitt nichts gefangen -> eigenes Pokémon geht
  releaseOwnDead: true, // eigene tote Pokémon (KO = tot) werden freigelassen
  releaseDuplicates: false, // Zweitfänge im selben Abschnitt automatisch freilassen
};

const BIOMES = {
  0: "Stadt", 1: "Ebene", 2: "Wiese", 3: "Hohes Gras", 4: "Metropole", 5: "Wald", 6: "Meer",
  7: "Sumpf", 8: "Strand", 9: "See", 10: "Meeresgrund", 11: "Berg", 12: "Ödland", 13: "Höhle",
  14: "Wüste", 15: "Eishöhle", 16: "Blumenwiese", 17: "Kraftwerk", 18: "Vulkan", 19: "Friedhof",
  20: "Dojo", 21: "Fabrik", 22: "Ruinen", 23: "Wüstenei", 24: "Abgrund", 25: "Weltraum",
  26: "Baustelle", 27: "Dschungel", 28: "Feenhöhle", 29: "Tempel", 30: "Slum",
  31: "Verschneiter Wald", 40: "Insel", 41: "Labor", 50: "Ende",
};
const biomeName = (id) => (id === undefined || id === null || id < 0 ? "Start" : BIOMES[id] || `Biom ${id}`);

// ---------------------------------------------------------------- Speicher
let db = { rooms: {} };
try {
  db = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  if (!db.rooms) db = { rooms: {} };
} catch {
  /* erste Ausführung */
}
let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE + ".tmp", JSON.stringify(db));
      fs.renameSync(DATA_FILE + ".tmp", DATA_FILE);
    } catch (e) {
      console.error("Speichern fehlgeschlagen:", e.message);
    }
  }, 1500);
}

const hash = (room, secret) => crypto.createHash("sha256").update(`${room}::${secret}`).digest("hex");
const cleanId = (s, max = 32) =>
  String(s || "")
    .trim()
    .slice(0, max)
    .replace(/[^\p{L}\p{N} _-]/gu, "");

function getRoom(id) {
  return db.rooms[id.toLowerCase()];
}

function pushEvent(room, player, type, text) {
  room.events.push({ ts: Date.now(), player, type, text });
  if (room.events.length > 300) room.events.splice(0, room.events.length - 300);
}

// ---------------------------------------------------------------- Soul-Link-Logik
function slotKey(m) {
  if (m.metWave == null || m.metWave <= 0) return `S${(m.starterIndex ?? 0) + 1}`;
  return `W${Math.ceil(m.metWave / 10)}`;
}
function keyOrder(k) {
  const n = Number(k.slice(1));
  return k[0] === "S" ? n : 1000 + n;
}
function keyLabel(k) {
  const n = Number(k.slice(1));
  if (k[0] === "S") return { title: `Starter ${n}`, sub: "Startteam" };
  return { title: `Abschnitt ${n}`, sub: `Wellen ${(n - 1) * 10 + 1}–${n * 10}` };
}

/** Gruppiert die Pokémon eines Spielers nach Abschnitt; erster Fang zählt, Rest sind Duplikate. */
function groupRun(run) {
  const groups = new Map();
  for (const m of run?.mons || []) {
    const k = slotKey(m);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const list of groups.values()) list.sort((a, b) => (a.firstSeen || 0) - (b.firstSeen || 0) || a.id - b.id);
  return groups;
}

function computeLinks(room) {
  const names = room.order.filter((n) => room.players[n]);
  const groups = names.map((n) => groupRun(room.players[n].run));
  const keys = new Set();
  groups.forEach((g) => g.forEach((_, k) => keys.add(k)));
  const sorted = [...keys].sort((a, b) => keyOrder(a) - keyOrder(b));

  const pairs = sorted.map((k) => {
    const slots = names.map((name, i) => {
      const run = room.players[name].run;
      const list = groups[i].get(k) || [];
      const mon = list[0] || null;
      let status;
      if (mon) status = mon.status; // alive | dead | gone
      else {
        const segEnd = k[0] === "S" ? 0 : Number(k.slice(1)) * 10;
        const wave = run?.wave || 0;
        status = wave > segEnd && wave > 0 ? "missed" : "pending";
      }
      return { player: name, mon, status, duplicates: list.slice(1) };
    });
    while (slots.length < 2) slots.push({ player: null, mon: null, status: "pending", duplicates: [] });
    const st = slots.map((s) => s.status);
    let state = "alive";
    if (st.includes("dead")) state = "dead";
    else if (st.includes("gone") || st.includes("missed")) state = "broken";
    else if (st.includes("pending")) state = "waiting";
    return { key: k, ...keyLabel(k), slots, state };
  });
  return { names, pairs };
}

function releaseOrders(room, playerName, links) {
  const s = { ...DEFAULT_SETTINGS, ...room.settings };
  const orders = [];
  const warnings = [];
  if (links.names.length < 2) return { orders, warnings };
  for (const p of links.pairs) {
    const mine = p.slots.find((x) => x.player === playerName);
    const other = p.slots.find((x) => x.player !== playerName);
    if (!mine) continue;
    if (mine.mon && mine.mon.status === "alive" && mine.mon.inParty && other) {
      const om = other.mon;
      const oname = om ? om.nick || om.name : "–";
      if (other.status === "dead" && s.releaseOnPartnerDeath)
        orders.push({ monId: mine.mon.id, reason: `${other.player}s ${oname} ist gestorben` });
      else if (other.status === "gone" && s.releaseOnPartnerGone)
        orders.push({ monId: mine.mon.id, reason: `${other.player}s ${oname} ist weg` });
      else if (other.status === "missed" && s.releaseIfPartnerMissed)
        orders.push({ monId: mine.mon.id, reason: `${other.player} hat in ${p.title} nichts gefangen` });
    }
    if (mine.mon && mine.mon.status === "dead" && mine.mon.inParty && s.releaseOwnDead)
      orders.push({ monId: mine.mon.id, reason: "KO heißt tot (Nuzlocke)" });
    for (const d of mine.duplicates || []) {
      if (d.status !== "alive" || !d.inParty) continue;
      if (s.releaseDuplicates) orders.push({ monId: d.id, reason: `Zweitfang in ${p.title}` });
      else warnings.push({ monId: d.id, text: `${d.nick || d.name} ist ein Zweitfang in ${p.title} und zählt nicht` });
    }
  }
  return { orders, warnings };
}

// ---------------------------------------------------------------- Run-Abgleich
function sanitizeRun(run) {
  if (!run || typeof run !== "object") return null;
  const mons = Array.isArray(run.mons) ? run.mons.slice(0, 400) : [];
  return {
    runId: String(run.runId || "").slice(0, 64),
    wave: Number(run.wave) || 0,
    biome: Number.isFinite(run.biome) ? run.biome : -1,
    biomeName: biomeName(run.biome),
    phase: String(run.phase || "").slice(0, 40),
    gameMode: String(run.gameMode || "").slice(0, 30),
    over: !!run.over,
    startedAt: Number(run.startedAt) || Date.now(),
    readyWave: Number(run.readyWave) || 0,
    waiting:
      run.waiting && typeof run.waiting === "object"
        ? { wave: Number(run.waiting.wave) || 0, label: String(run.waiting.label || "").slice(0, 60), since: Number(run.waiting.since) || Date.now() }
        : null,
    catchBlocked: run.catchBlocked ? String(run.catchBlocked).slice(0, 120) : null,
    mons: mons.map((m) => ({
      id: Number(m.id),
      speciesId: Number(m.speciesId) || 0,
      formIndex: Number(m.formIndex) || 0,
      name: String(m.name || "?").slice(0, 40),
      nick: m.nick ? String(m.nick).slice(0, 40) : null,
      fusionName: m.fusionName ? String(m.fusionName).slice(0, 40) : null,
      level: Number(m.level) || 0,
      hp: Number(m.hp) || 0,
      maxHp: Number(m.maxHp) || 0,
      shiny: !!m.shiny,
      metWave: Number(m.metWave),
      metBiome: Number(m.metBiome),
      metBiomeName: biomeName(Number(m.metBiome)),
      starterIndex: m.starterIndex == null ? null : Number(m.starterIndex),
      status: ["alive", "dead", "gone"].includes(m.status) ? m.status : "alive",
      goneReason: m.goneReason ? String(m.goneReason).slice(0, 120) : null,
      inParty: !!m.inParty,
      firstSeen: Number(m.firstSeen) || 0,
      diedWave: m.diedWave == null ? null : Number(m.diedWave),
      diedBiome: m.diedBiome == null ? null : Number(m.diedBiome),
      diedBiomeName: m.diedBiome == null ? null : biomeName(Number(m.diedBiome)),
      diedAt: m.diedAt == null ? null : Number(m.diedAt),
    })),
  };
}

function diffEvents(room, player, prev, next) {
  const label = (m) => (m.nick && m.nick !== m.name ? `${m.nick} (${m.name})` : m.name);
  if (!prev || prev.runId !== next.runId) {
    if (prev && prev.mons?.length) {
      room.history.unshift({
        player,
        runId: prev.runId,
        endedAt: Date.now(),
        wave: prev.wave,
        biomeName: prev.biomeName,
        mons: prev.mons.map((m) => ({ name: m.name, nick: m.nick, speciesId: m.speciesId, status: m.status, level: m.level })),
      });
      if (room.history.length > 40) room.history.length = 40;
    }
    pushEvent(room, player, "run", `startet einen neuen Run`);
    for (const m of next.mons) if (m.metWave <= 0) pushEvent(room, player, "catch", `wählt ${label(m)} als Starter`);
    return;
  }
  const old = new Map(prev.mons.map((m) => [m.id, m]));
  for (const m of next.mons) {
    const o = old.get(m.id);
    if (!o) {
      if (m.metWave > 0)
        pushEvent(room, player, "catch", `fängt ${label(m)} (Welle ${m.metWave}, ${m.metBiomeName})`);
      continue;
    }
    if (o.status !== m.status) {
      if (m.status === "dead")
        pushEvent(room, player, "death", `💀 ${label(m)} ist gestorben (Welle ${m.diedWave ?? next.wave}, ${m.diedBiomeName ?? next.biomeName})`);
      else if (m.status === "gone")
        pushEvent(room, player, "gone", `🕊️ ${label(m)} wurde freigelassen${m.goneReason ? ` – ${m.goneReason}` : ""}`);
    }
    if (o.name !== m.name && o.speciesId !== m.speciesId && m.status === "alive")
      pushEvent(room, player, "evo", `✨ ${o.nick || o.name} hat sich zu ${m.name} entwickelt`);
  }
  if (!prev.over && next.over) pushEvent(room, player, "over", `☠️ Run vorbei auf Welle ${next.wave}`);
  if (!prev.waiting && next.waiting)
    pushEvent(room, player, "wait", `⏳ wartet vor „${next.waiting.label}“ (Welle ${next.waiting.wave})`);
  if (prev.waiting && !next.waiting && next.wave >= prev.waiting.wave)
    pushEvent(room, player, "go", `⚔️ startet „${prev.waiting.label}“ (Welle ${prev.waiting.wave})`);
}

// ---------------------------------------------------------------- Verlauf & Statistiken
function sanitizeHistory(list) {
  if (!Array.isArray(list)) return null;
  return list.slice(0, 30).map((r) => ({
    runId: String(r.runId || "").slice(0, 64),
    startedAt: Number(r.startedAt) || 0,
    endedAt: Number(r.endedAt) || 0,
    wave: Number(r.wave) || 0,
    over: !!r.over,
    mons: (Array.isArray(r.mons) ? r.mons.slice(0, 200) : []).map((m) => ({
      name: String(m.name || "?").slice(0, 40),
      nick: m.nick ? String(m.nick).slice(0, 40) : null,
      speciesId: Number(m.speciesId) || 0,
      shiny: !!m.shiny,
      level: Number(m.level) || 0,
      status: ["alive", "dead", "gone"].includes(m.status) ? m.status : "alive",
      metWave: Number(m.metWave),
      metBiome: Number(m.metBiome),
      diedWave: m.diedWave == null ? null : Number(m.diedWave),
      diedBiome: m.diedBiome == null ? null : Number(m.diedBiome),
    })),
  }));
}

function playerStats(p) {
  const all = new Map();
  for (const r of p.history || []) all.set(r.runId, r);
  if (p.run?.runId) all.set(p.run.runId, p.run);
  const runs = [...all.values()].filter((r) => r.mons?.length);
  const mons = runs.flatMap((r) => r.mons.map((m) => ({ ...m, runWave: r.wave })));
  const deaths = mons.filter((m) => m.status === "dead");
  const caught = mons.filter((m) => m.metWave > 0);

  const biomeCount = {};
  for (const m of deaths) if (m.diedBiome != null) biomeCount[m.diedBiome] = (biomeCount[m.diedBiome] || 0) + 1;
  const deadliest = Object.entries(biomeCount).sort((a, b) => b[1] - a[1])[0];

  let survivor = null;
  for (const m of mons) {
    const start = Math.max(1, m.metWave || 1);
    const end = m.status === "dead" ? m.diedWave ?? start : m.runWave;
    const span = Math.max(0, (end || start) - start);
    if (!survivor || span > survivor.waves) survivor = { name: m.nick || m.name, species: m.name, speciesId: m.speciesId, waves: span };
  }
  const top = mons.slice().sort((a, b) => b.level - a.level)[0];
  const waves = runs.map((r) => r.wave || 0);
  return {
    runs: runs.length,
    bestWave: waves.length ? Math.max(...waves) : 0,
    avgWave: waves.length ? Math.round(waves.reduce((a, b) => a + b, 0) / waves.length) : 0,
    catches: caught.length,
    deaths: deaths.length,
    shinies: mons.filter((m) => m.shiny).length,
    deathsPerRun: runs.length ? Math.round((deaths.length / runs.length) * 10) / 10 : 0,
    deadliestBiome: deadliest ? { name: biomeName(Number(deadliest[0])), count: deadliest[1] } : null,
    survivor,
    topLevel: top ? { name: top.nick || top.name, species: top.name, speciesId: top.speciesId, level: top.level } : null,
  };
}

// ---------------------------------------------------------------- HTTP
function send(res, code, body, type = "application/json; charset=utf-8") {
  res.writeHead(code, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Cache-Control": "no-store",
  });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("zu groß"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(new Error("kein gültiges JSON"));
      }
    });
    req.on("error", reject);
  });
}

function publicRoom(roomId, room) {
  const links = computeLinks(room);
  const now = Date.now();
  return {
    room: roomId,
    settings: { ...DEFAULT_SETTINGS, ...room.settings },
    players: links.names.map((n) => {
      const p = room.players[n];
      return { name: n, online: now - p.lastSeen < ONLINE_MS, lastSeen: p.lastSeen, run: p.run, stats: playerStats(p) };
    }),
    pairs: links.pairs,
    events: room.events.slice(-120).reverse(),
    history: links.names
      .flatMap((n) =>
        (room.players[n].history || []).map((h) => ({
          player: n,
          runId: h.runId,
          endedAt: h.endedAt,
          wave: h.wave,
          over: h.over,
          deaths: h.mons.filter((m) => m.status === "dead").length,
        })),
      )
      .sort((a, b) => b.endedAt - a.endedAt)
      .slice(0, 20),
  };
}

async function handleApi(req, res, url) {
  // POST /api/sync – vom Spiel-Script
  if (url.pathname === "/api/sync" && req.method === "POST") {
    const body = await readBody(req);
    const roomId = cleanId(body.room).toLowerCase();
    const player = cleanId(body.player, 20);
    const secret = String(body.secret || "");
    if (!roomId || !player || secret.length < 3)
      return send(res, 400, { error: "Raum, Spielername und Passwort (min. 3 Zeichen) nötig" });
    let room = db.rooms[roomId];
    if (!room) {
      room = db.rooms[roomId] = {
        secret: hash(roomId, secret),
        createdAt: Date.now(),
        settings: { ...DEFAULT_SETTINGS },
        players: {},
        order: [],
        events: [],
        history: [],
      };
      pushEvent(room, player, "room", `hat den Raum erstellt`);
    }
    if (room.secret !== hash(roomId, secret)) return send(res, 403, { error: "Falsches Raum-Passwort" });
    if (!room.players[player]) {
      if (room.order.length >= 2)
        return send(res, 409, { error: `Raum ist voll (${room.order.join(" & ")}). Nimm genau denselben Namen wie vorher.` });
      room.players[player] = { run: null, lastSeen: 0 };
      room.order.push(player);
      pushEvent(room, player, "join", `ist beigetreten`);
    }
    const p = room.players[player];
    const run = sanitizeRun(body.run);
    if (run && run.runId) {
      diffEvents(room, player, p.run, run);
      p.run = run;
    }
    const hist = sanitizeHistory(body.history);
    if (hist) p.history = hist;
    p.lastSeen = Date.now();
    save();

    const links = computeLinks(room);
    const { orders, warnings } = releaseOrders(room, player, links);
    const partnerName = links.names.find((n) => n !== player) || null;
    const partner = partnerName ? room.players[partnerName] : null;
    return send(res, 200, {
      ok: true,
      partner: partner
        ? {
            name: partnerName,
            online: Date.now() - partner.lastSeen < ONLINE_MS,
            wave: partner.run?.wave,
            biomeName: partner.run?.biomeName,
            over: partner.run?.over,
            readyWave: partner.run?.readyWave || 0,
            waiting: partner.run?.waiting || null,
          }
        : null,
      pairs: links.pairs.map((pr) => ({
        key: pr.key,
        title: pr.title,
        state: pr.state,
        mine: pr.slots.find((s) => s.player === player) || null,
        theirs: pr.slots.find((s) => s.player !== player) || null,
      })),
      release: orders,
      warnings,
      settings: { ...DEFAULT_SETTINGS, ...room.settings },
    });
  }

  // GET /api/room/:id – für die Website
  let m = url.pathname.match(/^\/api\/room\/([^/]+)$/);
  if (m && req.method === "GET") {
    const roomId = cleanId(decodeURIComponent(m[1])).toLowerCase();
    const room = db.rooms[roomId];
    if (!room) return send(res, 404, { error: "Raum gibt es noch nicht – er entsteht beim ersten Sync aus dem Spiel." });
    return send(res, 200, publicRoom(roomId, room));
  }

  // POST /api/room/:id/settings  {secret, settings}
  m = url.pathname.match(/^\/api\/room\/([^/]+)\/(settings|reset)$/);
  if (m && req.method === "POST") {
    const roomId = cleanId(decodeURIComponent(m[1])).toLowerCase();
    const room = db.rooms[roomId];
    if (!room) return send(res, 404, { error: "Raum nicht gefunden" });
    const body = await readBody(req);
    if (room.secret !== hash(roomId, String(body.secret || ""))) return send(res, 403, { error: "Falsches Passwort" });
    if (m[2] === "settings") {
      for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in (body.settings || {})) room.settings[k] = !!body.settings[k];
      pushEvent(room, null, "settings", "Regeln wurden geändert");
    } else {
      room.events = [];
      room.history = [];
      for (const n of room.order) room.players[n].run = null;
      pushEvent(room, null, "room", "Raum wurde zurückgesetzt");
    }
    save();
    return send(res, 200, { ok: true, settings: { ...DEFAULT_SETTINGS, ...room.settings } });
  }

  return send(res, 404, { error: "unbekannt" });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

function serveStatic(req, res, url) {
  let p = url.pathname;
  if (p === "/" || p.startsWith("/r/")) p = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, "nein", "text/plain");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Nicht gefunden", "text/plain; charset=utf-8");
    let out = buf;
    // Das Userscript bekommt die Server-Adresse automatisch eingetragen
    if (p.endsWith(".user.js")) {
      const proto = req.headers["x-forwarded-proto"] || "http";
      const origin = `${proto}://${req.headers["x-forwarded-host"] || req.headers.host}`;
      out = buf.toString("utf8").replaceAll("__SERVER_URL__", origin);
    }
    send(res, 200, out, MIME[path.extname(file)] || "application/octet-stream");
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "OPTIONS") return send(res, 204, "");
  try {
    if (url.pathname === "/health") return send(res, 200, { ok: true });
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (e) {
    return send(res, 400, { error: e.message || "Fehler" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Soul-Link-Server läuft auf http://localhost:${PORT}`));
}
module.exports = { server, computeLinks, releaseOrders, sanitizeRun };
