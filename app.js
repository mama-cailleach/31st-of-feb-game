import { newGame, step } from "./engine.js";

const LOG_LIMIT = 500;
const LINE_DELAY_MS = 750; // line delay
const MUSIC_VOLUME = 0.24;
const BLIP_VOLUME = 0.2;

const el = {
  log: document.getElementById("log"),
  input: document.getElementById("terminal-input"),
  prompt: document.getElementById("prompt-text"),
  choices: document.getElementById("choices"),
  battery: document.getElementById("stat-battery"),
  stability: document.getElementById("stat-stability"),
  sip: document.getElementById("stat-sip"),
  objective: document.getElementById("stat-objective"),
  osDie: document.getElementById("tracker-os-die"),
  mode: document.getElementById("stat-mode"),
  trackerStation: document.getElementById("tracker-station"),
  trackerLoop: document.getElementById("tracker-loop"),
  trackerCandidate: document.getElementById("tracker-candidate"),
  trackerMsk: document.getElementById("tracker-msk"),
  trackerSns: document.getElementById("tracker-sns"),
  trackerLog: document.getElementById("tracker-log"),
  audioToggle: document.getElementById("audio-toggle")
};

let tables;
let state;
let history = [];
let historyIndex = -1;
let commandQueue = Promise.resolve();

const audio = {
  userActivated: false,
  muted: false,
  musicEnabled: true,
  sfxEnabled: true,
  music: null,
  blips: [],
  blipCursor: 0
};

function shuffle(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function createAudio(path, volume) {
  const track = new Audio(path);
  track.preload = "auto";
  track.volume = volume;
  return track;
}

function updateAudioToggleUi() {
  if (!el.audioToggle) {
    return;
  }

  el.audioToggle.textContent = audio.muted ? "Sound: OFF" : "Sound: ON";
  el.audioToggle.setAttribute("aria-pressed", String(audio.muted));
  el.audioToggle.classList.toggle("is-muted", audio.muted);
}

function stopBackgroundMusic() {
  if (!audio.music) {
    return;
  }
  audio.music.pause();
  audio.music.currentTime = 0;
}

function syncBackgroundMusic() {
  if (!audio.music || !audio.userActivated) {
    return;
  }

  const shouldPlay = state?.started && !state?.gameOver && !audio.muted && audio.musicEnabled;
  if (shouldPlay) {
    audio.music.play().catch(() => {
      // Ignore browser autoplay and decode errors to keep gameplay responsive.
    });
    return;
  }

  audio.music.pause();
  audio.music.currentTime = 0;
}

function setMuted(nextMuted) {
  audio.muted = nextMuted;
  updateAudioToggleUi();

  if (audio.muted) {
    stopBackgroundMusic();
  } else {
    syncBackgroundMusic();
  }
}

function nextBlip() {
  if (!audio.blips.length) {
    return null;
  }

  if (audio.blipCursor >= audio.blips.length) {
    audio.blipCursor = 0;
    shuffle(audio.blips);
  }

  const blip = audio.blips[audio.blipCursor];
  audio.blipCursor += 1;
  return blip;
}

function playRandomBlip() {
  if (!audio.userActivated || audio.muted || !audio.sfxEnabled) {
    return;
  }

  const blip = nextBlip();
  if (!blip) {
    return;
  }

  blip.currentTime = 0;
  blip.play().catch(() => {
    // Ignore transient playback errors for rapid command bursts.
  });
}

function initAudio() {
  audio.music = createAudio("./sounds/bg_music.ogg", MUSIC_VOLUME);
  audio.music.loop = true;

  audio.blips = [
    "./sounds/blip1.ogg",
    "./sounds/blip2.ogg",
    "./sounds/blip3.ogg",
    "./sounds/blip4.ogg",
    "./sounds/blip5.ogg",
    "./sounds/blip6.ogg"
  ].map((path) => createAudio(path, BLIP_VOLUME));

  shuffle(audio.blips);
  updateAudioToggleUi();
}

function runAudioCommand(raw) {
  const [command, arg] = raw.toLowerCase().split(/\s+/);

  if (command === "sound" && (arg === "on" || arg === "off")) {
    setMuted(arg === "off");
    return [arg === "on" ? "Sound is ON." : "Sound is OFF."];
  }

  if (command === "music" && (arg === "on" || arg === "off")) {
    audio.musicEnabled = arg === "on";
    syncBackgroundMusic();
    return [audio.musicEnabled ? "Music is ON." : "Music is OFF."];
  }

  if (command === "sfx" && (arg === "on" || arg === "off")) {
    audio.sfxEnabled = arg === "on";
    return [audio.sfxEnabled ? "SFX is ON." : "SFX is OFF."];
  }

  return null;
}

async function loadTables() {
  // Bypass browser cache so table edits are reflected immediately during iteration.
  const response = await fetch(`./tables.json?v=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load tables.json: ${response.status}`);
  }
  return response.json();
}

function validateTablesSchema(data) {
  const errors = [];
  const requiredRoot = [
    "core_rules",
    "pools",
    "sip_rules",
    "os_table",
    "stations",
    "objective_catalog",
    "random_flavor_tables",
    "narrative_resolution"
  ];

  if (!data || typeof data !== "object") {
    return ["tables.json root must be an object."];
  }

  requiredRoot.forEach((key) => {
    if (!(key in data)) {
      errors.push(`Missing root key: ${key}`);
    }
  });

  if (!Array.isArray(data.stations) || data.stations.length === 0) {
    errors.push("stations must be a non-empty array.");
  }

  if (!Array.isArray(data.os_table) || data.os_table.length === 0) {
    errors.push("os_table must be a non-empty array.");
  }

  const pools = data.pools || {};
  ["msk", "sns", "log"].forEach((poolKey) => {
    if (!pools[poolKey]) {
      errors.push(`pools.${poolKey} is required.`);
    }
  });

  const creationValues = pools.creation_values;
  if (!Array.isArray(creationValues) || creationValues.length !== 3) {
    errors.push("pools.creation_values must be [1,2,3].");
  }

  const coreRules = data.core_rules || {};
  if (
    "battery_reboot_value" in coreRules
    && (!Number.isFinite(coreRules.battery_reboot_value)
      || coreRules.battery_reboot_value < coreRules.battery_floor
      || coreRules.battery_reboot_value > coreRules.battery_ceiling)
  ) {
    errors.push("core_rules.battery_reboot_value must be a number between battery_floor and battery_ceiling.");
  }

  const objectiveCatalog = data.objective_catalog || {};
  const stationIds = new Set((data.stations || []).map((station) => station.id));
  const objectiveIds = new Set();

  (data.stations || []).forEach((station) => {
    if (!Array.isArray(station.objectives)) {
      errors.push(`Station ${station.id} must define objectives as an array.`);
      return;
    }

    station.objectives.forEach((objectiveId) => {
      if (objectiveIds.has(objectiveId)) {
        errors.push(`Duplicate objective ID in stations: ${objectiveId}`);
      }
      objectiveIds.add(objectiveId);

      if (!objectiveCatalog[objectiveId]) {
        errors.push(`Objective referenced in stations but missing in objective_catalog: ${objectiveId}`);
      }
    });
  });

  Object.entries(objectiveCatalog).forEach(([objectiveId, objective]) => {
    if (!objective || typeof objective !== "object") {
      errors.push(`Objective ${objectiveId} must be an object.`);
      return;
    }

    if (!objective.station_id || !stationIds.has(objective.station_id)) {
      errors.push(`Objective ${objectiveId} has invalid station_id.`);
    }

    if (!objective.symbol || !objective.name) {
      errors.push(`Objective ${objectiveId} must include symbol and name.`);
    }

    if (objective.pool_options) {
      const invalidPool = objective.pool_options.find((pool) => !["msk", "sns", "log"].includes(pool));
      if (invalidPool) {
        errors.push(`Objective ${objectiveId} has invalid pool option: ${invalidPool}`);
      }
    }
  });

  const successTables = data.random_flavor_tables?.architecture_of_success?.tables;
  if (!successTables || !Array.isArray(successTables.msk) || !Array.isArray(successTables.sns) || !Array.isArray(successTables.log)) {
    errors.push("architecture_of_success tables for msk/sns/log are required.");
  }

  const glitchEntries = data.random_flavor_tables?.big_book_of_glitches?.entries;
  if (!Array.isArray(glitchEntries) || glitchEntries.length === 0) {
    errors.push("big_book_of_glitches.entries must be a non-empty array.");
  }

  const batteryZeroEntries = data.random_flavor_tables?.battery_zero_events?.entries;
  if (!Array.isArray(batteryZeroEntries) || batteryZeroEntries.length === 0) {
    errors.push("battery_zero_events.entries must be a non-empty array.");
  }

  return errors;
}

function lineElement(text, kind = "out") {
  const p = document.createElement("p");
  p.className = `line ${kind}`;
  p.textContent = text;
  return p;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLine(line, kind = "out") {
  el.log.appendChild(lineElement(line, kind));
  if (line.trim().length > 0) {
    playRandomBlip();
  }

  while (el.log.childElementCount > LOG_LIMIT) {
    el.log.removeChild(el.log.firstChild);
  }

  el.log.scrollTop = el.log.scrollHeight;
}

async function renderLines(lines, kind = "out") {
  for (let i = 0; i < lines.length; i += 1) {
    appendLine(lines[i], kind);
    if (i < lines.length - 1) {
      await sleep(LINE_DELAY_MS);
    }
  }
}

function enqueueCommand(input, pushHistory = true) {
  commandQueue = commandQueue.then(() => runCommand(input, pushHistory));
}

function renderChoices(choices) {
  el.choices.replaceChildren();
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-btn";
    button.textContent = `${index + 1}. ${choice.label}`;
    button.addEventListener("click", () => enqueueCommand(choice.command, false));
    el.choices.appendChild(button);
  });
}

function renderStatus() {
  el.battery.textContent = `${state.battery}%`;
  el.stability.textContent = `${state.stability}%`;
  el.sip.textContent = String(state.sip);
  const objectiveName = state.currentObjectiveId
    ? tables?.objective_catalog?.[state.currentObjectiveId]?.name
    : null;
  el.objective.textContent = objectiveName || "-";
  const osBand = tables?.os_table?.find(
    (band) => state.stability >= band.min_stability && state.stability <= band.max_stability
  );
  el.osDie.textContent = osBand?.die || "-";
  el.mode.textContent = state.manualDiceMode ? "MANUAL" : "AUTO";
  renderTracker();
}

function renderTracker() {
  if (!state || !tables) {
    return;
  }

  if (state.characterCreation?.pending) {
    el.trackerStation.textContent = "Character Creation";
    el.trackerMsk.textContent = state.pools.msk ?? "-";
    el.trackerSns.textContent = state.pools.sns ?? "-";
    el.trackerLog.textContent = state.pools.log ?? "-";
    if (state.characterCreation.stage === "name") {
      el.trackerLoop.textContent = "-";
      el.trackerCandidate.textContent = "Enter your name";
    } else {
      el.trackerLoop.textContent = "-";
      el.trackerCandidate.textContent = `${state.playerName || "Candidate"} - Choose archetype`;
    }
    return;
  }

  const objectiveId = state.currentObjectiveId;
  const objective = objectiveId ? tables.objective_catalog[objectiveId] : null;
  const station = objective ? tables.stations.find((entry) => entry.id === objective.station_id) : null;

  el.trackerStation.textContent = station ? station.label : "-";
  el.trackerLoop.textContent = `${state.loopCount}`;
  el.trackerCandidate.textContent = state.playerName || "-";
  el.trackerMsk.textContent = state.pools.msk ?? "-";
  el.trackerSns.textContent = state.pools.sns ?? "-";
  el.trackerLog.textContent = state.pools.log ?? "-";
}

function downloadTextFile(fileName, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

async function runCommand(input, pushHistory = true) {
  const raw = input.trim();
  if (!raw) {
    return;
  }

  audio.userActivated = true;

  await renderLines([`> ${raw}`], "in");
  state.transcript.push(`> ${raw}`);
  if (pushHistory) {
    history.push(raw);
    historyIndex = history.length;
  }

  const audioCommandLines = runAudioCommand(raw);
  if (audioCommandLines) {
    await renderLines(audioCommandLines);
    audioCommandLines.forEach((line) => state.transcript.push(line));
    syncBackgroundMusic();
    return;
  }

  const result = step(state, raw, tables);
  state = result.state;
  state.prompt = result.prompt;
  state.choices = result.choices;

  await renderLines(result.lines);
  result.lines.forEach((line) => state.transcript.push(line));
  renderChoices(result.choices || []);
  el.prompt.textContent = result.prompt || ">";

  if (result.exportText) {
    const stamp = new Date().toISOString().replace(/[.:]/g, "-");
    downloadTextFile(`31st-of-feb-loop-${stamp}.txt`, result.exportText);
    await renderLines(["Transcript downloaded."]);
  }

  syncBackgroundMusic();
  renderStatus();
}

function bindAudioToggle() {
  if (!el.audioToggle) {
    return;
  }

  el.audioToggle.addEventListener("click", () => {
    audio.userActivated = true;
    setMuted(!audio.muted);
  });
}

function bindInput() {
  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      enqueueCommand(el.input.value, true);
      el.input.value = "";
      return;
    }

    if (event.key === "ArrowUp") {
      if (history.length === 0) {
        return;
      }
      historyIndex = Math.max(0, historyIndex - 1);
      el.input.value = history[historyIndex] || "";
      event.preventDefault();
      return;
    }

    if (event.key === "ArrowDown") {
      if (history.length === 0) {
        return;
      }
      historyIndex = Math.min(history.length, historyIndex + 1);
      el.input.value = history[historyIndex] || "";
      event.preventDefault();
    }
  });
}

async function boot() {
  initAudio();

  try {
    tables = await loadTables();
  } catch (error) {
    await renderLines([`Error loading tables: ${error.message}`]);
    el.input.disabled = true;
    return;
  }

  const schemaErrors = validateTablesSchema(tables);
  if (schemaErrors.length > 0) {
    await renderLines(["Schema validation failed for tables.json.", ...schemaErrors.map((err) => `- ${err}`)]);
    el.prompt.textContent = "schema-error>";
    el.input.disabled = true;
    return;
  }

  state = newGame(tables);
  await renderLines([
    "Terminal ready...",
    "Choose an option below or type a command to get started.",
    "Type 'start' to begin or 'help' for commands."
  ]);
  renderChoices([
    { label: "Start Loop", command: "start" },
    { label: "Help", command: "help" },
    { label: "Manual Dice Mode", command: "mode manual" }
  ]);
  el.prompt.textContent = ">";

  renderStatus();
  bindAudioToggle();
  bindInput();
  el.input.focus();
}

boot();
