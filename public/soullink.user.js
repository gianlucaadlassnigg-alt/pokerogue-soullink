// ==UserScript==
// @name         PokeRogue Soul Link
// @namespace    pokerogue-soullink
// @version      1.2.0
// @updateURL    __SERVER_URL__/soullink.user.js
// @downloadURL  __SERVER_URL__/soullink.user.js
// @description  Soul-Link-Nuzlocke für zwei Spieler: liest den Run aus, synchronisiert mit eurem Server, zeigt die Paare im Spiel und setzt die Regeln automatisch durch.
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
  const UI_MODE = { MESSAGE: 0, TITLE: 1, COMMAND: 2, FIGHT: 3, BALL: 4, MODIFIER_SELECT: 6, PARTY: 8, STARTER_SELECT: 10, RENAME_POKEMON: 38 };
  const PARTY_MODE = { SWITCH: 0, FAINT_SWITCH: 1, POST_BATTLE_SWITCH: 2, REVIVAL_BLESSING: 3, MODIFIER: 4, EVOLUTION_ITEM: 14, FORM_CHANGE_ITEM: 15 };
  const GUARDED_PARTY_MODES = Object.values(PARTY_MODE);
  const ENCOUNTER_PHASES = ["EncounterPhase", "NextEncounterPhase", "NewBiomeEncounterPhase"];
  /** Phasen, in denen ein KO sicher endgültig ist (Belebersamen wurde schon geprüft). */
  const SETTLED_PHASES = ["CommandPhase", "SelectModifierPhase", "GameOverPhase", "SwitchPhase", "BattleEndPhase", "NewBattlePhase", ...ENCOUNTER_PHASES];
  const RULE_DEFAULTS = {
    forceNickname: true,
    blockCatchAfterFirst: true,
    biomeDupeClause: true,
    waitAtBosses: true,
    endRunTogether: true,
    speciesClause: true,
    startTogether: true,
    shinyClause: true,
    forceSwitch: true,
  };
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
    if (!game && thisArg && typeof thisArg === "object" && "isBooted" in thisArg && thisArg.scene && thisArg.config && thisArg.textures) {
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

  const cfg = Object.assign({ server: DEFAULT_SERVER, room: "", player: "", secret: "", collapsed: false, box: null }, gmGet("cfg", {}));
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

  // ------------------------------------------------------------ 3) Hilfen
  let currentRun = null;
  let lastResp = null;
  let lastError = "";
  let busy = false; // es läuft gerade ein Eingriff (Freilassen, Wechsel, Game Over)
  const blocked = new Map(); // monId -> Hinweistext
  const confirmedDead = new Set(); // Pokémon-IDs, deren KO endgültig ist (kein Belebersamen)
  let gate = null; // angehaltener Kampfstart: { wave, label, since, noSkip, resume, check }

  function safe(fn, d) {
    try {
      return fn();
    } catch {
      return d;
    }
  }
  const curPhase = (s) => safe(() => s.phaseManager.getCurrentPhase(), null);
  const phaseName = (s) => safe(() => curPhase(s).phaseName, "");
  const slotKeyOf = (r) => r.slotKey || (r.metWave == null || r.metWave <= 0 ? `S${(r.starterIndex ?? 0) + 1}` : `W${Math.ceil(r.metWave / 10)}`);
  const rootOf = (p) => safe(() => p.species.getRootSpeciesId(), safe(() => p.species.speciesId, 0));
  const isOnField = (p) => safe(() => p.isOnField(), false);
  const runOf = (s) => runs[String(safe(() => s.seed, ""))];
  const monName = (r) => (r ? r.nick || r.name : "?");

  /** Ist dieses Pokémon für den Kampf gesperrt (tot oder muss wegen Soul Link gehen)? */
  function isBanned(id) {
    const run = currentRun?.run;
    const r = run?.mons?.[id];
    if (r && r.status === "dead") return true;
    return !!lastResp?.release?.some((o) => o.monId === id);
  }
  const banReason = (id) => {
    const o = lastResp?.release?.find((x) => x.monId === id);
    return o ? o.reason : "ist tot";
  };

  // ------------------------------------------------------------ 4) Run auslesen
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
    const phase = phaseName(s);
    const now = Date.now();

    let run = runs[runId];
    if (!run) run = runs[runId] = { runId, startedAt: now, nextStarter: 0, mons: {} };
    run.lastSeen = now;

    const seen = new Set();
    const fresh = [];
    for (const p of party) {
      const id = p.id;
      seen.add(id);
      patchPokemon(p);
      let r = run.mons[id];
      if (!r) {
        const metWave = safe(() => p.metWave, -1);
        r = run.mons[id] = { id, firstSeen: now, status: "alive", starterIndex: metWave <= 0 ? run.nextStarter++ : null };
        fresh.push(r);
      }
      r.speciesId = safe(() => p.species.speciesId, 0);
      r.rootId = rootOf(p);
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

      // KO = tot – aber erst, wenn kein Belebersamen mehr greifen kann
      const fainted = safe(() => p.isFainted(), false);
      if (fainted && r.status === "alive" && (confirmedDead.has(id) || SETTLED_PHASES.includes(phase))) markDead(r, wave, biome);
      if (!fainted && confirmedDead.has(id) && r.status === "alive") markDead(r, wave, biome);
    }

    // Neue Fänge einordnen: Shiny in einem schon belegten Abschnitt = Tausch-Kandidat
    for (const r of fresh) {
      if (r.metWave > 0 && r.shiny && rule("shinyClause")) {
        const taken = Object.values(run.mons).some(
          (o) => o.id !== r.id && !o.extra && o.status !== "swapped" && o.metWave > 0 && slotKeyOf(o) === slotKeyOf(r),
        );
        if (taken) {
          r.extra = true;
          toast(`✨ Shiny ${r.name} gefangen! Lass jetzt ein anderes Pokémon dafür frei.`, "gone");
        }
      }
    }

    // Verschwundene Pokémon
    const missing = Object.values(run.mons).filter((r) => !seen.has(r.id) && r.inParty);
    for (const r of missing) {
      r.inParty = false;
      if (r.status !== "alive") continue;
      const shiny = !r.extra && Object.values(run.mons).find((o) => o.extra && o.inParty && o.status === "alive");
      if (shiny) {
        swapIn(shiny, r);
      } else {
        r.status = "gone";
        r.goneReason = r.goneReason || (r.extra ? "Shiny wieder freigelassen" : "nicht mehr im Team");
      }
    }

    const cur = curPhase(s);
    if (phase === "GameOverPhase" && !run.over) {
      run.over = true;
      run.lost = !safe(() => cur.isVictory, false);
      run.overAt = now;
      syncNow();
    }
    run.wave = Math.max(run.wave || 0, wave);
    run.biome = biome;

    saveRuns();
    const cs = catchStatus(run, wave, biome, null);
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
        over: !!run.over,
        lost: !!run.lost,
        overAt: run.overAt || null,
        endReason: run.endReason || null,
        gameMode: safe(() => s.gameMode.getName?.() || String(s.gameMode.modeId), ""),
        startedAt: run.startedAt,
        readyWave: run.readyWave || 0,
        waiting: gate ? { wave: gate.wave, label: gate.label, since: gate.since } : null,
        catchBlocked: cs.allowed ? null : cs.reason,
        swapPending: !!pendingShiny(run),
        mons: Object.values(run.mons),
      },
      run,
    };
  }

  function markDead(r, wave, biome) {
    r.status = "dead";
    r.diedWave = wave;
    r.diedBiome = biome;
    r.diedAt = Date.now();
    toast(`💀 ${monName(r)} ist gestorben.`, "death");
    syncNow();
  }

  function swapIn(shiny, out) {
    shiny.slotKey = slotKeyOf(out);
    shiny.extra = false;
    out.status = "swapped";
    out.goneReason = `getauscht gegen Shiny ${monName(shiny)}`;
    toast(`✨ ${monName(shiny)} übernimmt den Platz von ${monName(out)}.`, "gone");
    syncNow();
  }

  const pendingShiny = (run) => run && Object.values(run.mons).find((m) => m.extra && m.inParty && m.status === "alive");

  /** Tote/verlinkte Pokémon gelten auch für das Spiel selbst als „nicht kampffähig“ (z. B. für die Game-Over-Prüfung). */
  function patchPokemon(p) {
    if (p.__soulLink) return;
    p.__soulLink = true;
    const proto = Object.getPrototypeOf(p);
    const orig = proto && proto.isAllowedInBattle;
    if (typeof orig !== "function") return;
    p.isAllowedInBattle = function () {
      if (isBanned(this.id) && !isOnField(this)) return false;
      return orig.call(this);
    };
  }

  // ------------------------------------------------------------ 5) Fang-Regeln
  /** Darf man hier (dieses Pokémon) fangen? */
  function catchStatus(run, wave, biome, enemy) {
    if (!run) return { allowed: true };
    if (enemy && safe(() => enemy.shiny, false) && rule("shinyClause")) return { allowed: true, shiny: true };
    const seg = Math.ceil(wave / 10);
    const caught = Object.values(run.mons).filter((m) => m.metWave > 0 && m.status !== "swapped" && !m.extra);
    if (rule("blockCatchAfterFirst")) {
      const same = caught.find((m) => Math.ceil(m.metWave / 10) === seg);
      if (same) return { allowed: false, reason: `In diesem Abschnitt hast du schon ${monName(same)} gefangen.` };
    }
    if (rule("biomeDupeClause") && biome >= 0) {
      const same = caught.find((m) => m.metBiome === biome);
      if (same) return { allowed: false, reason: `Im Biom ${biomeName(biome)} hast du schon ${monName(same)} gefangen.` };
    }
    if (enemy && rule("speciesClause")) {
      const root = rootOf(enemy);
      const ename = safe(() => enemy.name, "Dieses Pokémon");
      const partnerHas = lastResp?.partner?.roots?.includes(root);
      if (partnerHas) return { allowed: false, reason: `${lastResp.partner.name} hat ${ename} (oder seine Entwicklung) schon.` };
      const ownDead = Object.values(run.mons).some((m) => m.status === "dead" && m.rootId === root);
      if (ownDead || lastResp?.deadRoots?.includes(root)) return { allowed: false, reason: `${ename} ist schon gestorben – tote Pokémon darf man nicht neu fangen.` };
    }
    return { allowed: true };
  }

  const wildEnemies = (s) => (safe(() => s.getEnemyField(), []) || []).filter((e) => e && !safe(() => e.isFainted(), false));

  // ------------------------------------------------------------ 6) Kampfstart anhalten (Gate)
  const isBossWave = (s, wave) => wave > 0 && (wave % 10 === 0 || safe(() => !!s.gameMode.isFixedBattle(wave), false));
  function bossLabel(s, wave) {
    if (safe(() => s.gameMode.isFixedBattle(wave), false)) {
      const t = safe(() => s.currentBattle.trainer?.getName?.(), "");
      return t ? `Kampf gegen ${t}` : "Wichtiger Trainerkampf";
    }
    return "Boss am Ende des Bioms";
  }
  function partnerReady(wave) {
    const p = lastResp?.partner;
    if (!p) return true; // kein Partner im Raum -> nicht warten
    return (p.readyWave || 0) >= wave || (p.wave || 0) > wave || !!p.over;
  }

  /** Prüft, ob ein Kampf auf Welle `wave` starten darf. Gibt {ok} oder {ok:false,label,noSkip} zurück. */
  function gateCheck(s, wave) {
    const run = runOf(s);
    const shiny = pendingShiny(run);
    if (shiny) return { ok: false, noSkip: true, label: `✨ Shiny-Tausch: Wähle unten, wer für ${monName(shiny)} gehen muss` };

    if (wave === 1 && rule("startTogether") && run) {
      const mine = Object.values(run.mons).filter((m) => m.starterIndex != null && m.status !== "swapped");
      if (mine.length !== 3) return { ok: false, noSkip: true, label: `Ihr spielt mit genau 3 Startern – du hast ${mine.length}. Bitte neu starten.` };
      const p = lastResp?.partner;
      if (p) {
        const fresh = p.run && !p.run.over && (p.run.startedAt || 0) > run.startedAt - 30 * 60 * 1000;
        if (!fresh || (p.run.starters || []).length !== 3) return { ok: false, label: `Warte, bis ${p.name} 3 Starter gewählt und den Run gestartet hat …` };
        const theirs = new Set(p.run.starters.map((x) => x.rootId));
        const dup = mine.find((m) => theirs.has(m.rootId));
        if (dup && rule("speciesClause"))
          return { ok: false, noSkip: true, label: `Du und ${p.name} habt beide ${dup.name} als Starter – einer muss neu wählen.` };
      }
    }
    if (isBossWave(s, wave) && rule("waitAtBosses") && !partnerReady(wave)) {
      const p = lastResp?.partner;
      return { ok: false, label: `${bossLabel(s, wave)} – warte auf ${p?.name || "deinen Partner"}${p?.wave ? ` (ist bei Welle ${p.wave})` : ""} …` };
    }
    return { ok: true };
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

  // ------------------------------------------------------------ 7) Eingriffe ins Spiel (Hooks)
  function installHooks(s) {
    const ui = s.ui;
    if (ui && !ui.__soulLink) {
      ui.__soulLink = true;
      for (const fn of ["setModeWithoutClear", "setMode", "setOverlayMode"]) {
        const orig = ui[fn];
        if (typeof orig !== "function") continue;
        ui[fn] = function (mode, ...args) {
          // Kämpfen/Fangen verboten, solange ein totes Pokémon draußen steht
          if ((mode === UI_MODE.FIGHT || mode === UI_MODE.BALL) && rule("forceSwitch")) {
            const cp = curPhase(s);
            const mon = phaseName(s) === "CommandPhase" ? safe(() => cp.getPokemon(), null) : null;
            if (mon && isBanned(mon.id)) {
              toast(`🔁 ${safe(() => mon.name, "Dieses Pokémon")} muss ausgewechselt werden (${banReason(mon.id)}).`, "death");
              setTimeout(() => forceSwitchIfNeeded(s, true), 50);
              return Promise.resolve();
            }
          }
          // Ball-Menü sperren, wenn hier nicht gefangen werden darf
          if (mode === UI_MODE.BALL) {
            const run = runOf(s);
            const wave = safe(() => s.currentBattle.waveIndex, 0);
            const biome = safe(() => s.arena.biomeType, -1);
            const enemies = wildEnemies(s);
            const results = enemies.length ? enemies.map((e) => catchStatus(run, wave, biome, e)) : [catchStatus(run, wave, biome, null)];
            if (!results.some((r) => r.allowed)) {
              toast(`🚫 Fangen gesperrt: ${results[0].reason}`, "death");
              return Promise.resolve();
            }
          }
          // Tote / verlinkte Pokémon im Team-Menü sperren (Einwechseln, Beleber, Items …)
          if (mode === UI_MODE.PARTY && GUARDED_PARTY_MODES.includes(args[0])) {
            if (args.length < 2) args[1] = -1;
            if (args.length < 3) args[2] = undefined;
            const origFilter = typeof args[3] === "function" ? args[3] : null;
            args[3] = function (p, ...rest) {
              if (p && isBanned(p.id)) return `${safe(() => p.name, "Dieses Pokémon")} ist tot (Soul Link) und kann nicht mehr eingesetzt werden.`;
              return origFilter ? origFilter.call(this, p, ...rest) : null;
            };
          }
          return orig.call(this, mode, ...args);
        };
      }
    }

    const pm = s.phaseManager;
    if (pm && !pm.__soulLink && typeof pm.startCurrentPhase === "function") {
      pm.__soulLink = true;
      const orig = pm.startCurrentPhase;
      pm.startCurrentPhase = function () {
        const ph = this.currentPhase;
        const name = safe(() => ph.phaseName, "");

        // Belebersamen: Erst NACH der Ohnmacht-Phase wissen wir, ob das Pokémon wirklich tot ist.
        if (name === "FaintPhase") {
          const mon = safe(() => ph.getPokemon(), null);
          const isPlayer = safe(() => !!ph.player, false);
          const ret = orig.apply(this, arguments);
          if (isPlayer && mon && safe(() => mon.isFainted(), false)) confirmedDead.add(mon.id);
          return ret;
        }

        // Fangversuch auf ein verbotenes Pokémon (z. B. im Doppelkampf) abbrechen
        if (name === "AttemptCapturePhase") {
          const target = safe(() => ph.getPokemon(), null);
          const run = runOf(s);
          const st = catchStatus(run, safe(() => s.currentBattle.waveIndex, 0), safe(() => s.arena.biomeType, -1), target);
          if (target && !st.allowed) {
            toast(`🚫 Fangen gesperrt: ${st.reason}`, "death");
            return safe(() => ph.end());
          }
        }

        if (ENCOUNTER_PHASES.includes(name)) {
          const wave = safe(() => s.currentBattle.waveIndex, 0);
          if (!runOf(s)) currentRun = safe(readGame, currentRun); // Run sofort anlegen (Start-Prüfung braucht die Starter)
          const run = runOf(s);
          if (run && (isBossWave(s, wave) || wave === 1)) {
            run.readyWave = Math.max(run.readyWave || 0, wave);
            saveRuns();
          }
          const res = gateCheck(s, wave);
          if (!res.ok) {
            const self = this;
            const args = arguments;
            gate = { wave, label: res.label, noSkip: !!res.noSkip, since: Date.now(), resume: () => orig.apply(self, args) };
            toast(`⏳ ${res.label}`);
            syncNow();
            return;
          }
        }
        return orig.apply(this, arguments);
      };
    }
  }

  // ------------------------------------------------------------ 8) Automatisch freilassen
  const isCalm = (phase, mode) =>
    (phase === "CommandPhase" && mode === UI_MODE.COMMAND) || (phase === "SelectModifierPhase" && mode === UI_MODE.MODIFIER_SELECT) || !!gate;

  async function releaseMon(scene, pokemon, rec, reason, status) {
    const idx = scene.getPlayerParty().indexOf(pokemon);
    if (idx < 0) return;
    await scene.removePartyMemberModifiers(idx);
    const i2 = scene.getPlayerParty().indexOf(pokemon);
    if (i2 >= 0) scene.getPlayerParty().splice(i2, 1);
    safe(() => pokemon.destroy());
    safe(() => scene.updateModifiers(true));
    rec.status = status || (rec.status === "dead" ? "dead" : "gone");
    rec.goneReason = reason;
    rec.inParty = false;
    saveRuns();
    syncNow();
  }

  async function tryRelease(state) {
    if (busy || !lastResp?.release?.length) return;
    const { scene, party, phase, mode, run } = state;
    const calm = isCalm(phase, mode);

    for (const order of lastResp.release) {
      const rec = run.mons[order.monId];
      const pokemon = party.find((p) => p.id === order.monId);
      if (!pokemon || !rec || rec.status === "gone") continue;
      const name = monName(rec);
      const others = party.filter((p) => p !== pokemon && !isBanned(p.id) && !safe(() => p.isFainted(), false));

      if (!others.length) {
        blocked.set(order.monId, `${name} müsste freigelassen werden (${order.reason}), ist aber dein letztes Pokémon – der Run ist vorbei.`);
        if (calm && rule("forceSwitch")) await forceGameOver(scene, `${name} war dein letztes Pokémon`);
        continue;
      }
      if (isOnField(pokemon)) {
        blocked.set(
          order.monId,
          phase === "CommandPhase"
            ? `${name} muss ausgewechselt werden (${order.reason}) und wird danach freigelassen.`
            : `${name} steht noch draußen und wird im nächsten Kampf ausgewechselt und freigelassen. Tipp: Im Belohnungs-Bildschirm unter „Team“ die Reihenfolge tauschen.`,
        );
        continue;
      }
      if (!calm) {
        blocked.set(order.monId, `${name} wird gleich freigelassen (sobald du wieder am Zug bist). Grund: ${order.reason}.`);
        continue;
      }
      busy = true;
      try {
        await releaseMon(scene, pokemon, rec, `Soul Link – ${order.reason}`);
        blocked.delete(order.monId);
        toast(`🕊️ ${name} wurde freigelassen – ${order.reason}`, "gone");
      } catch (e) {
        blocked.set(order.monId, `Freilassen von ${name} fehlgeschlagen: ${e.message}. Bitte selbst freilassen.`);
      } finally {
        busy = false;
      }
      return; // eins nach dem anderen
    }
  }

  // ------------------------------------------------------------ 9) Zwangswechsel
  let lastForce = 0;
  function forceSwitchIfNeeded(s, now) {
    if (!rule("forceSwitch") || busy) return;
    if (phaseName(s) !== "CommandPhase" || safe(() => s.ui.mode, -1) !== UI_MODE.COMMAND) return;
    if (!now && Date.now() - lastForce < 1500) return;
    const cp = curPhase(s);
    const mon = safe(() => cp.getPokemon(), null);
    if (!mon || !isBanned(mon.id)) return;
    const bench = (safe(() => s.getPlayerParty(), []) || []).filter(
      (p) => p !== mon && !isOnField(p) && !isBanned(p.id) && !safe(() => p.isFainted(), false),
    );
    lastForce = Date.now();
    if (!bench.length) {
      forceGameOver(s, `${safe(() => mon.name, "Dein Pokémon")} ist tot und du hast niemanden mehr zum Einwechseln`);
      return;
    }
    toast(`🔁 ${safe(() => mon.name, "Dein Pokémon")} ist tot (${banReason(mon.id)}) – wähle, wer reinkommt!`, "death");
    safe(() =>
      s.ui.setMode(UI_MODE.PARTY, PARTY_MODE.SWITCH, safe(() => cp.getFieldIndex(), 0), undefined, (p) =>
        safe(() => p.isFainted(), false) ? `${safe(() => p.name, "")} kann nicht mehr kämpfen.` : null,
      ),
    );
  }

  // ------------------------------------------------------------ 10) Run beenden
  async function forceGameOver(s, reason) {
    if (busy) return;
    const run = runOf(s);
    if (!run || run.over) return;
    busy = true;
    try {
      run.endReason = reason;
      saveRuns();
      toast(`☠️ Run vorbei: ${reason}`, "death");
      const pm = s.phaseManager;
      const held = gate;
      gate = null;
      pm.clearPhaseQueue();
      pm.unshiftNew("GameOverPhase");
      if (held) {
        safe(() => pm.getCurrentPhase().end());
      } else {
        const cur = pm.getCurrentPhase();
        if (cur.phaseName !== "CommandPhase") await safe(() => s.ui.setMode(UI_MODE.MESSAGE), null);
        cur.end();
      }
    } catch (e) {
      console.warn("[SoulLink] Game Over fehlgeschlagen", e);
    } finally {
      setTimeout(() => (busy = false), 1500);
    }
  }

  function checkPartnerLost(state) {
    if (!rule("endRunTogether") || state.run.over) return;
    const p = lastResp?.partner;
    if (!p || !p.lastLossAt || p.lastLossAt < state.run.startedAt) return;
    if (!isCalm(state.phase, state.mode)) return;
    forceGameOver(state.scene, `${p.name} hat verloren – ihr seid aneinander gekettet`);
  }

  // ------------------------------------------------------------ 11) Shiny-Tausch (vom Overlay aus)
  async function swapOut(id) {
    const state = currentRun;
    if (!state || busy) return;
    const { scene, party, run, phase, mode } = state;
    const rec = run.mons[id];
    const pokemon = party.find((p) => p.id === id);
    const shiny = pendingShiny(run);
    if (!rec || !pokemon || !shiny) return;
    if (!isCalm(phase, mode) && !gate) return toast("Warte kurz, bis du am Zug bist oder im Belohnungs-Bildschirm.");
    if (isOnField(pokemon) && phase === "CommandPhase") return toast(`${monName(rec)} kämpft gerade – wähle ein Pokémon von der Bank.`);
    busy = true;
    try {
      if (rec.id === shiny.id) {
        await releaseMon(scene, pokemon, rec, "Shiny wieder freigelassen", "gone");
        toast(`🕊️ ${monName(rec)} wurde freigelassen.`, "gone");
      } else {
        swapIn(shiny, rec);
        await releaseMon(scene, pokemon, rec, rec.goneReason, "swapped");
      }
    } finally {
      busy = false;
    }
    render(true);
  }

  // ------------------------------------------------------------ 12) Spitznamen-Pflicht
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
    if (renaming || busy || !rule("forceNickname")) return;
    const { scene, party, phase, mode, run } = state;
    if (!isCalm(phase, mode) || gate) return;
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

  // ------------------------------------------------------------ 13) Verlauf für Statistiken
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

  // ------------------------------------------------------------ 14) Server-Sync
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

  // ------------------------------------------------------------ 15) Overlay im Spiel
  let host, root;
  const spriteUrl = (m) =>
    m && m.speciesId > 0 && m.speciesId <= 1025
      ? `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${m.shiny ? "shiny/" : ""}${m.speciesId}.png`
      : "";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
    .panel { position: fixed; z-index: 2147483000; min-width: 200px; min-height: 40px; max-width: 95vw; max-height: 95vh;
      display: flex; flex-direction: column; background: rgba(17,19,28,.92); color: #eef0f6; border: 1px solid #2c3145;
      border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.45); font-size: 12px; backdrop-filter: blur(6px);
      resize: both; overflow: hidden; }
    .panel.collapsed { resize: none; height: auto !important; min-height: 0; }
    .head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: grab; user-select: none; flex: none; touch-action: none; }
    .head:active { cursor: grabbing; }
    .grip { color: #555c75; font-size: 12px; letter-spacing: -2px; }
    .title { font-weight: 800; letter-spacing: .02em; font-size: 13px; white-space: nowrap; }
    .title b { color: #ff6b8a; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #555; flex: none; }
    .dot.ok { background: #3ddc84; } .dot.err { background: #ff5c5c; } .dot.wait { background: #f5b942; }
    .sub { color: #9aa1b8; font-size: 11px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    button { all: unset; cursor: pointer; padding: 2px 6px; border-radius: 6px; color: #c9cee0; font-size: 13px; }
    button:hover { background: #262b3d; }
    .body { overflow-y: auto; padding: 0 8px 8px; flex: 1; min-height: 0; }
    .collapsed .body { display: none; }
    .warn { background: #3a1820; border: 1px solid #6b2433; color: #ffd0d8; padding: 6px 8px; border-radius: 8px; margin: 4px 0; line-height: 1.35; }
    .hint { background: #2e2715; border-color: #5e4c1c; color: #ffe7a8; }
    .gate { background: #15253a; border-color: #2b4d78; color: #d6e8ff; font-size: 13px; }
    .skip { display: block; margin-top: 6px; font-size: 11px; color: #9fb7d8; text-decoration: underline; padding: 0; }
    .swap { background: #2b2412; border-color: #8a6d1c; color: #ffe7a8; }
    .swaplist { display: grid; gap: 4px; margin-top: 6px; }
    .swaplist button { display: flex; align-items: center; gap: 6px; background: #1b1f2d; border: 1px solid #3a3f55; padding: 4px 6px; font-size: 12px; color: #eef0f6; }
    .swaplist button:hover { border-color: #ffd36b; }
    .swaplist button[disabled] { opacity: .45; cursor: not-allowed; }
    .swaplist img { width: 26px; height: 26px; image-rendering: pixelated; }
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
    .foot { display: flex; justify-content: space-between; gap: 8px; padding: 6px 2px 0; font-size: 11px; }
    a { color: #8ab4ff; }
    .toasts { position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%); z-index: 2147483001; display: grid; gap: 6px; pointer-events: none; }
    .toast { background: rgba(17,19,28,.95); color: #fff; padding: 8px 14px; border-radius: 10px; border: 1px solid #2c3145; font-size: 13px;
      box-shadow: 0 6px 20px rgba(0,0,0,.4); animation: in .25s ease-out; }
    .toast.death { border-color: #ff5c5c; } .toast.gone { border-color: #8ab4ff; }
    @keyframes in { from { opacity: 0; transform: translateY(8px); } }
  `;

  // Position & Größe merken (verschiebbar am Kopf, größenverstellbar an der Ecke unten rechts)
  function applyBox(panel) {
    const b = cfg.box || {};
    const w = Math.min(b.w || 300, innerWidth - 10);
    panel.style.width = w + "px";
    if (b.h && !cfg.collapsed) panel.style.height = Math.min(b.h, innerHeight - 10) + "px";
    else panel.style.height = "";
    const x = b.x == null ? innerWidth - w - 10 : b.x;
    const y = b.y == null ? 10 : b.y;
    panel.style.left = Math.max(0, Math.min(x, innerWidth - 60)) + "px";
    panel.style.top = Math.max(0, Math.min(y, innerHeight - 30)) + "px";
  }
  function setupDragResize(panel) {
    let drag = null;
    let resizing = false;
    panel.addEventListener("pointerdown", (e) => {
      const pr = panel.getBoundingClientRect();
      if (e.clientX > pr.right - 20 && e.clientY > pr.bottom - 20) resizing = true; // Ecke unten rechts = Größe ändern
      const head = e.target.closest?.(".head");
      if (!head || e.target.closest("button")) return;
      const r = panel.getBoundingClientRect();
      drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
      head.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    panel.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const x = Math.max(0, Math.min(e.clientX - drag.dx, innerWidth - 60));
      const y = Math.max(0, Math.min(e.clientY - drag.dy, innerHeight - 30));
      panel.style.left = x + "px";
      panel.style.top = y + "px";
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      const r = panel.getBoundingClientRect();
      cfg.box = { ...(cfg.box || {}), x: Math.round(r.left), y: Math.round(r.top) };
      saveCfg();
    };
    panel.addEventListener("pointerup", end);
    panel.addEventListener("pointercancel", end);
    // Größe nur speichern, wenn wirklich an der Ecke gezogen wurde
    W.addEventListener(
      "pointerup",
      () => {
        if (!resizing) return;
        resizing = false;
        if (cfg.collapsed) return;
        const r = panel.getBoundingClientRect();
        cfg.box = { ...(cfg.box || {}), w: Math.round(r.width), h: Math.round(r.height) };
        saveCfg();
      },
      true,
    );
    addEventListener("resize", () => applyBox(panel));
  }

  let showSettings = false;
  function mountUi() {
    if (host || !document.body) return;
    host = document.createElement("div");
    host.id = "soullink-overlay";
    root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${CSS}</style><div class="panel"><div class="head"></div><div class="body"></div></div><div class="toasts"></div>`;
    // Eingaben im Overlay nicht ans Spiel weitergeben
    for (const ev of ["keydown", "keyup", "keypress"]) host.addEventListener(ev, (e) => e.stopPropagation());
    for (const ev of ["mousedown", "pointerdown", "touchstart", "wheel"]) host.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    document.body.appendChild(host);
    const panel = root.querySelector(".panel");
    applyBox(panel);
    setupDragResize(panel);
    root.addEventListener("click", onClick);
    root.addEventListener("submit", onSubmit);
    if (!cfg.room || !cfg.player || !cfg.secret || !cfg.server) showSettings = true;
    render(true);
  }

  function toast(text, kind = "") {
    if (!root) return;
    const box = root.querySelector(".toasts");
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    box.appendChild(el);
    while (box.children.length > 4) box.firstChild.remove();
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
      <div style="min-width:0"><div class="n">${m.shiny ? "✨" : ""}${esc(m.nick || m.name)}</div><div class="s">${st}</div></div></div>`;
  }

  function render() {
    if (!root) return;
    const panel = root.querySelector(".panel");
    panel.classList.toggle("collapsed", !!cfg.collapsed);
    applyBox(panel);
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
        <label>Raum-Name (bei beiden gleich)<input name="room" value="${esc(cfg.room)}" placeholder="z. B. gianluca-und-abdul"></label>
        <label>Dein Name<input name="player" value="${esc(cfg.player)}" maxlength="20"></label>
        <label>Raum-Passwort (bei beiden gleich)<input name="secret" type="password" value="${esc(cfg.secret)}"></label>
        <button class="btn" type="submit">Speichern & verbinden</button>
      </form>`;
    } else {
      const run = currentRun?.run;
      const shiny = pendingShiny(run);
      if (shiny && currentRun) {
        const opts = currentRun.party
          .map((p) => {
            const r = run.mons[p.id];
            if (!r) return "";
            const fighting = isOnField(p) && currentRun.phase === "CommandPhase";
            const label = r.id === shiny.id ? `${esc(monName(r))} doch nicht behalten` : `${esc(monName(r))} <span style="opacity:.6">Lv ${r.level}</span>`;
            return `<button data-a="swap" data-id="${r.id}" ${fighting ? "disabled title='kämpft gerade'" : ""}>${spriteUrl(r) ? `<img src="${spriteUrl(r)}" alt="">` : ""}${label}</button>`;
          })
          .join("");
        body += `<div class="warn swap">✨ <b>Shiny-Tausch:</b> Wer muss für <b>${esc(monName(shiny))}</b> gehen? Bis du gewählt hast, geht es nicht weiter.
          <div class="swaplist">${opts}</div></div>`;
      }
      if (gate && !shiny) {
        body += `<div class="warn gate">⏳ ${esc(gate.label)}${gate.noSkip ? "" : `<button class="skip" data-a="skipwait">Nicht warten, weiter</button>`}</div>`;
      }
      for (const [id, text] of blocked) {
        if (lastResp?.release?.some((o) => o.monId === id)) body += `<div class="warn">${esc(text)}</div>`;
        else blocked.delete(id);
      }
      for (const w of lastResp?.warnings || []) body += `<div class="warn hint">⚠️ ${esc(w.text)}</div>`;
      if (currentRun?.data.over) body += `<div class="warn">☠️ Run vorbei.${currentRun.data.endReason ? ` ${esc(currentRun.data.endReason)}.` : ""}</div>`;
      else if (currentRun) {
        const blockedCatch = currentRun.data.catchBlocked;
        body += blockedCatch
          ? `<div class="pill no">🚫 Fangen gesperrt – ${esc(blockedCatch)}${rule("shinyClause") ? " (Shinys gehen immer)" : ""}</div>`
          : `<div class="pill yes">🎯 Hier darfst du noch fangen</div>`;
      }
      const pairs = (lastResp?.pairs || []).slice().reverse();
      for (const p of pairs) {
        body += `<div class="row ${p.state}"><div class="lbl">${esc(p.title)}</div>
          ${monHtml(p.mine, false)}<div class="chain">${p.state === "dead" ? "✖" : "⛓"}</div>${monHtml(p.theirs, true)}</div>`;
      }
      if (!pairs.length) body += `<div class="empty" style="padding:6px">Noch keine Paare.</div>`;
      body += `<div class="foot">${
        cfg.server && cfg.room
          ? `<a href="${esc(cfg.server.replace(/\/+$/, ""))}/r/${encodeURIComponent(cfg.room)}" target="_blank" rel="noopener">Live-Tracker öffnen ↗</a>`
          : "<span></span>"
      }<button data-a="resetbox" title="Position und Größe zurücksetzen" style="font-size:11px;padding:0">↺ Position</button></div>`;
    }

    root.querySelector(".head").innerHTML = `<span class="grip" title="Zum Verschieben ziehen">⋮⋮</span>
        <span class="dot ${dot}"></span><span class="title">Soul <b>Link</b></span>
        <span class="sub">${esc(sub)}</span>
        <button data-a="settings" title="Einstellungen">⚙</button>
        <button data-a="collapse" title="Ein-/Ausklappen (Strg+Shift+L)">${cfg.collapsed ? "▾" : "▴"}</button>`;
    const bodyEl = root.querySelector(".body");
    const scroll = bodyEl.scrollTop;
    bodyEl.innerHTML = body;
    bodyEl.scrollTop = scroll;
  }

  function onClick(e) {
    const el = e.target.closest?.("[data-a]");
    const a = el?.dataset.a;
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
    } else if (a === "swap") {
      if (!el.disabled) swapOut(Number(el.dataset.id));
    } else if (a === "resetbox") {
      cfg.box = null;
      saveCfg();
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

  // ------------------------------------------------------------ 16) Hauptschleife
  let renderKey = "";
  async function tick() {
    mountUi();
    const state = safe(readGame, null);
    currentRun = state;
    await sync(state);
    if (gate) {
      const s = getScene();
      const res = s ? gateCheck(s, gate.wave) : { ok: true };
      if (res.ok) {
        toast(`✅ Weiter geht's!`);
        openGate();
      } else {
        gate.label = res.label;
        gate.noSkip = !!res.noSkip;
      }
    }
    if (state) {
      checkPartnerLost(state);
      forceSwitchIfNeeded(state.scene, false);
      await tryRelease(state);
      tryForceRename(state);
    }
    const key = JSON.stringify([
      lastResp, lastError, !!game, !!state, state?.data.over, state?.data.catchBlocked, gate?.label, gate?.noSkip, [...blocked],
      state && pendingShiny(state.run) ? state.party.map((p) => p.id + ":" + isOnField(p)).join() : "", state?.phase === "CommandPhase",
    ]);
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
