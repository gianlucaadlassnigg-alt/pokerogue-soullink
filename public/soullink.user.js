// ==UserScript==
// @name         PokeRogue Soul Link
// @namespace    pokerogue-soullink
// @version      1.1.0
// @updateURL    __SERVER_URL__/soullink.user.js
// @downloadURL  __SERVER_URL__/soullink.user.js
// @description  Soul-Link-Nuzlocke für zwei Spieler: liest den Run aus, synchronisiert mit eurem Server, zeigt die Paare im Spiel und lässt verlinkte Pokémon automatisch frei.
// @match        https://pokerogue.net/*
// @match        https://www.pokerogue.net/*
// @run-at       document-start
// @sandbox      JavaScript
// @inject-into  page
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
  const DEFAULT_SERVER = "__SERVER_URL__".startsWith("__") ? "" : "__SERVER_URL__";
  const SYNC_MS = 2000;
  const TICK_MS = 700;
  const UI_MODE = { TITLE: 1, COMMAND: 2, BALL: 4, MODIFIER_SELECT: 6, STARTER_SELECT: 10, RENAME_POKEMON: 38 };
  const ENCOUNTER_PHASES = ["EncounterPhase", "NextEncounterPhase", "NewBiomeEncounterPhase"];
  const RULE_DEFAULTS = { forceNickname: true, blockCatchAfterFirst: true, biomeDupeClause: true, waitAtBosses: true };
  const rule = (k) => (lastResp?.settings && k in lastResp.settings ? !!lastResp.settings[k] : RULE_DEFAULTS[k]);
  const BIOMES = {
    0: "Stadt", 1: "Ebene", 2: "Wiese", 3: "Hohes Gras", 4: "Metropole", 5: "Wald", 6: "Meer", 7: "Sumpf", 8: "Strand",
    9: "See", 10: "Meeresgrund", 11: "Berg", 12: "Ödland", 13: "Höhle", 14: "Wüste", 15: "Eishöhle", 16: "Blumenwiese",
    17: "Kraftwerk", 18: "Vulkan", 19: "Friedhof", 20: "Dojo", 21: "Fabrik", 22: "Ruinen", 23: "Wüstenei", 24: "Abgrund",
    25: "Weltraum", 26: "Baustelle", 27: "Dschungel", 28: "Feenhöhle", 29: "Tempel", 30: "Slum", 31: "Verschneiter Wald",
    40: "Insel", 41: "Labor", 50: "Ende",
  };
  const biomeName = (id) => BIOMES[id] || `Biom ${id}`;

  // ------------------------------------------------------------ 1) Spiel-Instanz abgreifen
  // PokeRogue legt das Spiel nicht global ab. Phaser ruft beim Start aber
  // `this.boot.bind(this)` auf – darüber bekommen wir die Game-Instanz.
  let game = null;
  const FP = W.Function.prototype;
  const origBind = FP.bind;
  FP.bind = function (thisArg) {
    if (
      !game &&
      thisArg &&
      typeof thisArg === "object" &&
      "isBooted" in thisArg &&
      thisArg.scene &&
      thisArg.config &&
      thisArg.textures
    ) {
      game = thisArg;
      W.__soulLinkGame = thisArg;
      FP.bind = origBind;
    }
    return origBind.apply(this, arguments);
  };

  const getScene = () => {
    try {
      return game?.scene?.getScene?.("battle") || game?.scene?.keys?.battle || null;
    } catch {
      return null;
    }
  };

  // ------------------------------------------------------------ 2) Einstellungen & Speicher
  const gmGet = (k, d) => {
    try {
      return typeof GM_getValue === "function" ? GM_getValue(k, d) : JSON.parse(localStorage.getItem("sl_" + k)) ?? d;
    } catch {
      return d;
    }
  };
  const gmSet = (k, v) => {
    try {
      if (typeof GM_setValue === "function") GM_setValue(k, v);
      else localStorage.setItem("sl_" + k, JSON.stringify(v));
    } catch {
      /* egal */
    }
  };

  const cfg = Object.assign({ server: DEFAULT_SERVER, room: "", player: "", secret: "", collapsed: false }, gmGet("cfg", {}));
  if (!cfg.server && DEFAULT_SERVER) cfg.server = DEFAULT_SERVER;
  const saveCfg = () => gmSet("cfg", cfg);

  /** runs[runId] = { runId, startedAt, nextStarter, mons: { [id]: record } } */
  let runs = gmGet("runs", {});
  let saveRunsTimer = null;
  const saveRuns = () => {
    clearTimeout(saveRunsTimer);
    saveRunsTimer = setTimeout(() => {
      const ids = Object.keys(runs).sort((a, b) => (runs[b].lastSeen || 0) - (runs[a].lastSeen || 0));
      for (const id of ids.slice(30)) delete runs[id];
      gmSet("runs", runs);
    }, 500);
  };

  // ------------------------------------------------------------ 3) Run auslesen
  let currentRun = null;
  let lastResp = null;
  let lastError = "";
  let releasing = false;
  const blocked = new Map(); // monId -> Hinweistext

  function safe(fn, d) {
    try {
      return fn();
    } catch {
      return d;
    }
  }

  function readGame() {
    const s = getScene();
    if (!s) return null;
    installHooks(s);
    const mode = safe(() => s.ui.mode, -1);
    const party = safe(() => s.getPlayerParty(), []) || [];
    if (!s.currentBattle || !party.length || !s.seed || mode === UI_MODE.TITLE || mode === UI_MODE.STARTER_SELECT) return null;

    const runId = String(s.seed);
    const wave = safe(() => s.currentBattle.waveIndex, 0);
    const biome = safe(() => s.arena.biomeType, -1);
    const phase = safe(() => s.phaseManager.getCurrentPhase().phaseName, "");
    const now = Date.now();

    let run = runs[runId];
    if (!run) run = runs[runId] = { runId, startedAt: now, nextStarter: 0, mons: {} };
    run.lastSeen = now;

    const seen = new Set();
    for (const p of party) {
      const id = p.id;
      seen.add(id);
      let r = run.mons[id];
      if (!r) {
        const metWave = safe(() => p.metWave, -1);
        r = run.mons[id] = { id, firstSeen: now, status: "alive", starterIndex: metWave <= 0 ? run.nextStarter++ : null };
      }
      r.speciesId = safe(() => p.species.speciesId, 0);
      r.formIndex = safe(() => p.formIndex, 0);
      r.name = safe(() => p.name, "?");
      r.nick = safe(() => p.getNameToRender({ useIllusion: false }), r.name);
      r.fusionName = safe(() => p.fusionSpecies?.name || null, null);
      r.level = safe(() => p.level, 0);
      r.hp = safe(() => p.hp, 0);
      r.maxHp = safe(() => p.getMaxHp(), 0);
      r.shiny = safe(() => !!p.shiny, false);
      r.metWave = safe(() => p.metWave, -1);
      r.metBiome = safe(() => p.metBiome, -1);
      r.inParty = true;
      const fainted = safe(() => p.isFainted(), false);
      if (fainted && r.status === "alive") {
        r.status = "dead";
        r.diedWave = wave;
        r.diedBiome = biome;
        r.diedAt = now;
        toast(`💀 ${r.nick} ist gestorben.`, "death");
      }
    }
    for (const r of Object.values(run.mons)) {
      if (seen.has(r.id)) continue;
      if (r.inParty) {
        r.inParty = false;
        if (r.status === "alive") {
          r.status = "gone";
          r.goneReason = r.goneReason || "nicht mehr im Team";
        }
      }
    }
    const alive = party.filter((p) => !safe(() => p.isFainted(), false));
    const over = phase === "GameOverPhase" || alive.length === 0;
    run.wave = Math.max(run.wave || 0, wave);
    run.biome = biome;
    run.over = run.over || over;

    saveRuns();
    return {
      scene: s,
      party,
      phase,
      mode,
      data: {
        runId,
        wave,
        biome,
        phase,
        over,
        gameMode: safe(() => s.gameMode.getName?.() || String(s.gameMode.modeId), ""),
        startedAt: run.startedAt,
        readyWave: run.readyWave || 0,
        waiting: gate ? { wave: gate.wave, label: gate.label, since: gate.since } : null,
        catchBlocked: catchStatus(run, wave, biome).allowed ? null : catchStatus(run, wave, biome).reason,
        mons: Object.values(run.mons),
      },
      run,
    };
  }

  // ------------------------------------------------------------ 3b) Fang-Regeln
  /** Darf man hier noch fangen? Ein Fang pro 10er-Abschnitt und (Dupe-Klausel) pro Biom-Typ. */
  function catchStatus(run, wave, biome) {
    if (!run) return { allowed: true };
    const seg = Math.ceil(wave / 10);
    const caught = Object.values(run.mons).filter((m) => m.metWave > 0);
    if (rule("blockCatchAfterFirst")) {
      const same = caught.find((m) => Math.ceil(m.metWave / 10) === seg);
      if (same) return { allowed: false, reason: `In diesem Abschnitt hast du schon ${same.nick || same.name} gefangen.` };
    }
    if (rule("biomeDupeClause") && biome >= 0) {
      const same = caught.find((m) => m.metBiome === biome);
      if (same) return { allowed: false, reason: `Im Biom ${biomeName(biome)} hast du schon ${same.nick || same.name} gefangen.` };
    }
    return { allowed: true };
  }

  const isCheckpoint = (scene, wave) => wave > 0 && (wave % 10 === 0 || safe(() => !!scene.gameMode.isFixedBattle(wave), false));
  function checkpointLabel(scene, wave) {
    if (safe(() => scene.gameMode.isFixedBattle(wave), false)) {
      const t = safe(() => scene.currentBattle.trainer?.getName?.(), "");
      return t ? `Kampf gegen ${t}` : "Wichtiger Trainerkampf";
    }
    return "Boss am Ende des Bioms";
  }
  function partnerReady(wave) {
    const p = lastResp?.partner;
    if (!p) return true; // kein Partner im Raum -> nicht warten
    return (p.readyWave || 0) >= wave || (p.wave || 0) > wave || !!p.over;
  }

  // ------------------------------------------------------------ 3c) Eingriffe ins Spiel
  let gate = null; // { wave, label, since, resume }
  function installHooks(s) {
    // Ball-Menü sperren, wenn hier nicht mehr gefangen werden darf
    const ui = s.ui;
    if (ui && !ui.__soulLink) {
      ui.__soulLink = true;
      for (const fn of ["setModeWithoutClear", "setMode", "setOverlayMode"]) {
        const orig = ui[fn];
        if (typeof orig !== "function") continue;
        ui[fn] = function (mode, ...args) {
          if (mode === UI_MODE.BALL) {
            const run = runs[String(s.seed)];
            const st = catchStatus(run, safe(() => s.currentBattle.waveIndex, 0), safe(() => s.arena.biomeType, -1));
            if (!st.allowed) {
              toast(`🚫 Fangen gesperrt: ${st.reason}`, "death");
              return Promise.resolve();
            }
          }
          return orig.call(this, mode, ...args);
        };
      }
    }
    // Vor Boss / Rivale / Top 4 auf den Partner warten
    const pm = s.phaseManager;
    if (pm && !pm.__soulLink && typeof pm.startCurrentPhase === "function") {
      pm.__soulLink = true;
      const orig = pm.startCurrentPhase;
      pm.startCurrentPhase = function () {
        const name = safe(() => this.currentPhase.phaseName, "");
        if (ENCOUNTER_PHASES.includes(name)) {
          const wave = safe(() => s.currentBattle.waveIndex, 0);
          if (isCheckpoint(s, wave)) {
            const run = runs[String(s.seed)];
            if (run) {
              run.readyWave = Math.max(run.readyWave || 0, wave);
              saveRuns();
            }
            if (rule("waitAtBosses") && !partnerReady(wave)) {
              const self = this;
              const args = arguments;
              gate = { wave, label: checkpointLabel(s, wave), since: Date.now(), resume: () => orig.apply(self, args) };
              toast(`⏳ ${gate.label} – warte auf deinen Partner …`);
              syncNow();
              return;
            }
          }
        }
        return orig.apply(this, arguments);
      };
    }
  }

  function openGate() {
    if (!gate) return;
    const g = gate;
    gate = null;
    syncNow();
    try {
      g.resume();
    } catch (e) {
      console.warn("[SoulLink] Weiter nach Warten fehlgeschlagen", e);
    }
  }

  // ------------------------------------------------------------ 3d) Spitznamen-Pflicht
  let renaming = false;
  const decodeNick = (b64) => {
    try {
      return decodeURIComponent(escape(atob(b64)));
    } catch {
      return String(b64 || "");
    }
  };
  function needsNick(p) {
    const n = safe(() => p.nickname, "");
    if (!n) return true;
    const d = decodeNick(n).trim();
    return !d || d.toLowerCase() === String(safe(() => p.name, "")).toLowerCase();
  }
  function tryForceRename(state) {
    if (renaming || !rule("forceNickname")) return;
    const { scene, party, phase, mode, run } = state;
    const calm =
      (phase === "CommandPhase" && mode === UI_MODE.COMMAND) || (phase === "SelectModifierPhase" && mode === UI_MODE.MODIFIER_SELECT);
    if (!calm) return;
    const p = party.find((x) => {
      const r = run.mons[x.id];
      return r && r.metWave > 0 && r.status === "alive" && !r.nickDone && needsNick(x);
    });
    if (!p) return;
    const ui = scene.ui;
    renaming = true;
    toast(`✏️ Gib ${safe(() => p.name, "deinem Fang")} einen Spitznamen!`);
    const done = () => ui.revertMode().finally(() => (renaming = false));
    try {
      ui.setOverlayMode(
        UI_MODE.RENAME_POKEMON,
        {
          buttonActions: [
            (b64) => {
              const name = decodeNick(b64).trim();
              if (!name || name.toLowerCase() === String(p.name).toLowerCase()) {
                toast("Bitte einen echten Spitznamen eingeben, nicht den Pokémon-Namen.", "death");
                return done();
              }
              p.nickname = b64;
              safe(() => p.updateInfo());
              run.mons[p.id].nickDone = true;
              run.mons[p.id].nick = name;
              saveRuns();
              syncNow();
              return done();
            },
            () => {
              toast("Spitzname ist Pflicht! 😤", "death");
              return done();
            },
          ],
        },
        p,
      );
    } catch (e) {
      renaming = false;
      console.warn("[SoulLink] Umbenennen-Fenster ging nicht auf", e);
    }
  }

  // ------------------------------------------------------------ 3e) Verlauf für Statistiken
  function historyFor(currentId) {
    return Object.values(runs)
      .filter((r) => r.runId !== currentId && Object.keys(r.mons || {}).length)
      .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
      .slice(0, 30)
      .map((r) => ({
        runId: r.runId,
        startedAt: r.startedAt,
        endedAt: r.lastSeen,
        wave: r.wave || 0,
        over: !!r.over,
        mons: Object.values(r.mons).map((m) => ({
          name: m.name, nick: m.nick, speciesId: m.speciesId, shiny: m.shiny, level: m.level, status: m.status,
          metWave: m.metWave, metBiome: m.metBiome, diedWave: m.diedWave ?? null, diedBiome: m.diedBiome ?? null,
        })),
      }));
  }

  // ------------------------------------------------------------ 4) Automatisch freilassen
  async function tryRelease(state) {
    if (releasing || !lastResp?.release?.length) return;
    const { scene, party, phase, mode, run } = state;
    const safeMoment =
      (phase === "CommandPhase" && mode === UI_MODE.COMMAND) || (phase === "SelectModifierPhase" && mode === UI_MODE.MODIFIER_SELECT);

    for (const order of lastResp.release) {
      const rec = run.mons[order.monId];
      const idx = party.findIndex((p) => p.id === order.monId);
      if (idx < 0 || !rec || rec.status === "gone") continue;
      const name = rec.nick || rec.name;
      const battlers = safe(() => scene.currentBattle.getBattlerCount(), 1);

      if (party.length <= 1) {
        blocked.set(order.monId, `${name} müsste freigelassen werden (${order.reason}), ist aber dein letztes Pokémon – laut Regeln ist der Run vorbei.`);
        continue;
      }
      if (idx < battlers) {
        blocked.set(order.monId, `Wechsle ${name} aus – es wird danach freigelassen. Grund: ${order.reason}.`);
        continue;
      }
      if (!safeMoment) {
        blocked.set(order.monId, `${name} wird gleich freigelassen (sobald du wieder am Zug bist). Grund: ${order.reason}.`);
        continue;
      }

      releasing = true;
      try {
        const pokemon = party[idx];
        await scene.removePartyMemberModifiers(idx);
        const i2 = scene.getPlayerParty().indexOf(pokemon);
        if (i2 >= 0) scene.getPlayerParty().splice(i2, 1);
        safe(() => pokemon.destroy());
        safe(() => scene.updateModifiers(true));
        rec.status = rec.status === "dead" ? "dead" : "gone";
        rec.goneReason = `Soul Link – ${order.reason}`;
        rec.inParty = false;
        blocked.delete(order.monId);
        saveRuns();
        toast(`🕊️ ${name} wurde freigelassen – ${order.reason}`, "gone");
        syncNow();
      } catch (e) {
        blocked.set(order.monId, `Freilassen von ${name} fehlgeschlagen: ${e.message}. Bitte selbst freilassen.`);
      } finally {
        releasing = false;
      }
      return; // eins nach dem anderen
    }
  }

  // ------------------------------------------------------------ 5) Server-Sync
  let syncing = false;
  let lastSync = 0;
  function syncNow() {
    lastSync = 0;
  }

  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const done = (status, text) => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* */
        }
        if (status >= 200 && status < 300) resolve(json);
        else reject(new Error(json?.error || `HTTP ${status}`));
      };
      if (typeof GM_xmlhttpRequest === "function") {
        GM_xmlhttpRequest({
          method,
          url,
          data: body ? JSON.stringify(body) : undefined,
          headers: { "Content-Type": "application/json" },
          timeout: 10000,
          onload: (r) => done(r.status, r.responseText),
          onerror: () => reject(new Error("Server nicht erreichbar")),
          ontimeout: () => reject(new Error("Server antwortet nicht (schläft er noch?)")),
        });
      } else {
        fetch(url, { method, body: body ? JSON.stringify(body) : undefined, headers: { "Content-Type": "application/json" } })
          .then(async (r) => done(r.status, await r.text()))
          .catch(() => reject(new Error("Server nicht erreichbar")));
      }
    });
  }

  async function sync(state) {
    if (syncing || !cfg.server || !cfg.room || !cfg.player || !cfg.secret) return;
    if (Date.now() - lastSync < SYNC_MS) return;
    syncing = true;
    lastSync = Date.now();
    try {
      lastResp = await request("POST", cfg.server.replace(/\/+$/, "") + "/api/sync", {
        room: cfg.room,
        player: cfg.player,
        secret: cfg.secret,
        run: state ? state.data : null,
        history: historyFor(state?.data.runId),
      });
      lastError = "";
    } catch (e) {
      lastError = e.message;
    } finally {
      syncing = false;
    }
  }

  // ------------------------------------------------------------ 6) Overlay im Spiel
  let host, root;
  const spriteUrl = (m) =>
    m && m.speciesId > 0 && m.speciesId <= 1025
      ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${m.shiny ? "shiny/" : ""}${m.speciesId}.png`
      : "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    .panel { position: fixed; top: 10px; right: 10px; z-index: 2147483000; width: 300px; max-height: calc(100vh - 20px);
      display: flex; flex-direction: column; background: rgba(17,19,28,.92); color: #eef0f6; border: 1px solid #2c3145;
      border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12px; backdrop-filter: blur(6px); }
    .panel.collapsed { width: auto; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: default; user-select: none; }
    .title { font-weight: 800; letter-spacing: .02em; font-size: 13px; }
    .title b { color: #ff6b8a; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; flex: none; }
    .dot.ok { background: #3ddc84; } .dot.err { background: #ff5c5c; } .dot.wait { background: #f5b942; }
    .sub { color: #9aa1b8; font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #c9cee0; font-size: 13px; }
    button:hover { background: #262b3d; }
    .body { overflow-y: auto; padding: 0 8px 8px; }
    .collapsed .body { display: none; }
    .warn { background: #3a1820; border: 1px solid #6b2433; color: #ffd0d8; padding: 6px 8px; border-radius: 8px; margin: 4px 0; line-height: 1.35; }
    .hint { background: #2e2715; border-color: #5e4c1c; color: #ffe7a8; }
    .gate { background: #15253a; border-color: #2b4d78; color: #d6e8ff; font-size: 13px; }
    .skip { display: block; margin-top: 6px; font-size: 11px; color: #9fb7d8; text-decoration: underline; padding: 0; }
    .pill { margin: 4px 0; padding: 5px 8px; border-radius: 8px; font-size: 11px; line-height: 1.35; }
    .pill.yes { background: #14291f; color: #a6f0c6; } .pill.no { background: #2a1a1d; color: #ffb3bf; }
    .row { display: grid; grid-template-columns: 1fr 18px 1fr; align-items: center; gap: 4px; padding: 4px; border-radius: 8px; margin: 3px 0;
      background: #1b1f2d; border-left: 3px solid #3ddc84; }
    .row.dead { border-left-color: #ff5c5c; opacity: .75; } .row.broken { border-left-color: #8a8fa3; opacity: .7; }
    .row.waiting { border-left-color: #f5b942; }
    .lbl { grid-column: 1 / -1; font-size: 10px; color: #8a90a8; text-transform: uppercase; letter-spacing: .06em; }
    .mon { display: flex; align-items: center; gap: 4px; min-width: 0; }
    .mon.r { flex-direction: row-reverse; text-align: right; }
    .mon img { width: 30px; height: 30px; image-rendering: pixelated; flex: none; }
    .mon .n { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
    .mon .s { color: #9aa1b8; font-size: 10px; }
    .mon.dead .n { text-decoration: line-through; color: #ff9aa9; } .mon.gone .n { text-decoration: line-through; color: #9aa1b8; }
    .chain { text-align: center; color: #ff6b8a; font-size: 13px; }
    .empty { color: #6f7590; font-style: italic; }
    form { display: grid; gap: 6px; padding: 4px 2px 6px; }
    label { display: grid; gap: 2px; color: #9aa1b8; font-size: 11px; }
    input { all: unset; background: #10131d; border: 1px solid #2c3145; border-radius: 6px; padding: 5px 7px; color: #eef0f6; font-size: 12px; }
    input:focus { border-color: #ff6b8a; }
    .btn { background: #ff6b8a; color: #1a0d12; font-weight: 700; text-align: center; padding: 6px; border-radius: 8px; }
    .btn:hover { background: #ff8aa2; }
    a { color: #8ab4ff; }
    .toasts { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2147483001; display: grid; gap: 6px; pointer-events: none; }
    .toast { background: rgba(17,19,28,.95); color: #fff; padding: 8px 14px; border-radius: 10px; border: 1px solid #2c3145; font-size: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,.4); animation: in .25s ease-out; }
    .toast.death { border-color: #ff5c5c; } .toast.gone { border-color: #8ab4ff; }
    @keyframes in { from { opacity: 0; transform: translateY(8px); } }
  `;

  let showSettings = false;
  function mountUi() {
    if (host || !document.body) return;
    host = document.createElement("div");
    host.id = "soullink-overlay";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="panel"></div><div class="toasts"></div>`;
    // Tastatureingaben im Overlay nicht ans Spiel weitergeben
    for (const ev of ["keydown", "keyup", "keypress"]) host.addEventListener(ev, (e) => e.stopPropagation());
    for (const ev of ["mousedown", "pointerdown", "touchstart", "wheel"]) host.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(host);
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    if (!cfg.room || !cfg.player || !cfg.secret || !cfg.server) showSettings = true;
    render();
  }

  function toast(text, kind = "") {
    if (!root) return;
    const box = root.querySelector(".toasts");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    setTimeout(() => el.remove(), 6000);
  }

  function monHtml(slot, right) {
    const m = slot?.mon;
    if (!m) {
      const t = slot?.status === "missed" ? "nichts gefangen" : "wartet …";
      return `<div class="mon ${right ? "r" : ""}"><span class="empty">${t}</span></div>`;
    }
    const img = spriteUrl(m);
    const st = m.status === "dead" ? "💀" : m.status === "gone" ? "🕊️" : `Lv ${m.level}`;
    return `<div class="mon ${right ? "r" : ""} ${m.status}">
      ${img ? `<img src="${img}" alt="" onerror="this.style.display='none'">` : ""}
      <div style="min-width:0"><div class="n">${esc(m.nick || m.name)}</div><div class="s">${st}</div></div></div>`;
  }

  function render() {
    if (!root) return;
    const panel = root.querySelector(".panel");
    panel.classList.toggle("collapsed", !!cfg.collapsed);
    const connected = lastResp && !lastError;
    const dot = !cfg.server ? "" : lastError ? "err" : connected ? "ok" : "wait";
    const partner = lastResp?.partner;
    let sub = "";
    if (!game) sub = "Spiel nicht erkannt – Seite neu laden (F5)";
    else if (lastError) sub = lastError;
    else if (!currentRun) sub = "Warte auf einen Run …";
    else if (partner) sub = `${partner.name}${partner.online ? "" : " (offline)"} · W${partner.wave ?? "–"} ${partner.biomeName || ""}`;
    else sub = "Warte auf Partner …";

    let body = "";
    if (showSettings) {
      body = `<form>
        <label>Server-Adresse<input name="server" value="${esc(cfg.server)}" placeholder="https://dein-server.onrender.com"></label>
        <label>Raum-Name (bei beiden gleich)<input name="room" value="${esc(cfg.room)}" placeholder="z. B. gianluca-und-max"></label>
        <label>Dein Name<input name="player" value="${esc(cfg.player)}" maxlength="20"></label>
        <label>Raum-Passwort (bei beiden gleich)<input name="secret" type="password" value="${esc(cfg.secret)}"></label>
        <button class="btn" type="submit">Speichern & verbinden</button>
      </form>`;
    } else {
      for (const [id, text] of blocked) {
        if (lastResp?.release?.some((o) => o.monId === id)) body += `<div class="warn">${esc(text)}</div>`;
        else blocked.delete(id);
      }
      for (const w of lastResp?.warnings || []) body += `<div class="warn hint">⚠️ ${esc(w.text)}</div>`;
      if (currentRun?.data.over) body += `<div class="warn">☠️ Run vorbei.</div>`;
      if (gate) {
        const who = lastResp?.partner?.name || "deinen Partner";
        const where = lastResp?.partner?.wave ? ` (ist bei Welle ${lastResp.partner.wave})` : "";
        body += `<div class="warn gate">⏳ <b>${esc(gate.label)}</b> auf Welle ${gate.wave}<br>Warte auf ${esc(who)}${esc(where)} …
          <button class="skip" data-a="skipwait">Nicht warten, weiter</button></div>`;
      }
      if (currentRun) {
        const blockedCatch = currentRun.data.catchBlocked;
        body += blockedCatch
          ? `<div class="pill no">🚫 Fangen gesperrt – ${esc(blockedCatch)}</div>`
          : `<div class="pill yes">🎯 Hier darfst du noch fangen</div>`;
      }
      const pairs = (lastResp?.pairs || []).slice().reverse();
      for (const p of pairs) {
        body += `<div class="row ${p.state}"><div class="lbl">${esc(p.title)}</div>
          ${monHtml(p.mine, false)}<div class="chain">${p.state === "dead" ? "✖" : "⛓"}</div>${monHtml(p.theirs, true)}</div>`;
      }
      if (!pairs.length) body += `<div class="empty" style="padding:6px">Noch keine Paare.</div>`;
      if (cfg.server && cfg.room)
        body += `<div style="padding:6px 2px 0"><a href="${esc(cfg.server.replace(/\/+$/, ""))}/r/${encodeURIComponent(cfg.room)}" target="_blank" rel="noopener">Live-Tracker öffnen ↗</a></div>`;
    }

    panel.innerHTML = `<div class="head">
        <span class="dot ${dot}"></span><span class="title">Soul <b>Link</b></span>
        <span class="sub">${esc(sub)}</span>
        <button data-a="settings" title="Einstellungen">⚙</button>
        <button data-a="collapse" title="Ein-/Ausklappen">${cfg.collapsed ? "▾" : "▴"}</button>
      </div><div class="body">${body}</div>`;
  }

  function onClick(e) {
    const a = e.target.closest?.("[data-a]")?.dataset.a;
    if (a === "collapse") {
      cfg.collapsed = !cfg.collapsed;
      saveCfg();
      render();
    } else if (a === "settings") {
      showSettings = !showSettings;
      cfg.collapsed = false;
      render();
    } else if (a === "skipwait") {
      toast("Weiter ohne Partner.");
      openGate();
      render();
    }
  }

  function onSubmit(e) {
    e.preventDefault();
    const f = new FormData(e.target);
    cfg.server = String(f.get("server") || "").trim().replace(/\/+$/, "");
    cfg.room = String(f.get("room") || "").trim();
    cfg.player = String(f.get("player") || "").trim();
    cfg.secret = String(f.get("secret") || "");
    saveCfg();
    showSettings = false;
    lastResp = null;
    lastError = "";
    syncNow();
    render();
  }

  // ------------------------------------------------------------ 7) Hauptschleife
  let renderKey = "";
  async function tick() {
    mountUi();
    const state = safe(readGame, null);
    currentRun = state;
    await sync(state);
    if (gate && partnerReady(gate.wave)) {
      toast(`✅ ${lastResp?.partner?.name || "Partner"} ist da – los geht's!`);
      openGate();
    }
    if (state) await tryRelease(state);
    if (state) tryForceRename(state);
    const key = JSON.stringify([lastResp, lastError, !!game, !!state, state?.data.over, state?.data.catchBlocked, gate?.wave, [...blocked]]);
    const focused = root && root.activeElement && root.activeElement.tagName === "INPUT";
    if (key !== renderKey && !focused) {
      renderKey = key;
      render();
    }
  }
  setInterval(() => tick().catch((e) => console.warn("[SoulLink]", e)), TICK_MS);
  W.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.code === "KeyL") {
      cfg.collapsed = !cfg.collapsed;
      saveCfg();
      render();
    }
  });
})();
