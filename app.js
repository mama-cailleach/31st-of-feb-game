import { newGame, step, serializeState, deserializeState } from "./engine.js";

const STORAGE_KEY = "31st_of_feb_companion_state";
const LOG_LIMIT = 500;

const el = {
  log: document.getElementById("log"),
  input: document.getElementById("terminal-input"),
  prompt: document.getElementById("prompt-text"),
  choices: document.getElementById("choices"),
  battery: document.getElementById("stat-battery"),
  stability: document.getElementById("stat-stability"),
  sip: document.getElementById("stat-sip"),
  objective: document.getElementById("stat-objective"),
  mode: document.getElementById("stat-mode"),
  trackerSeason: document.getElementById("tracker-season"),
  trackerLoop: document.getElementById("tracker-loop"),
  trackerCandidate: document.getElementById("tracker-candidate")
};

let tables;
let state;
let history = [];
let historyIndex = -1;

async function loadTables() {
  const response = await fetch("./tables.json");
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
    "seasons",
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

  if (!Array.isArray(data.seasons) || data.seasons.length === 0) {
    errors.push("seasons must be a non-empty array.");
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

  const objectiveCatalog = data.objective_catalog || {};
  const seasonIds = new Set((data.seasons || []).map((season) => season.id));
  const objectiveIds = new Set();

  (data.seasons || []).forEach((season) => {
    if (!Array.isArray(season.objectives)) {
      errors.push(`Season ${season.id} must define objectives as an array.`);
      return;
    }

    season.objectives.forEach((objectiveId) => {
      if (objectiveIds.has(objectiveId)) {
        errors.push(`Duplicate objective ID in seasons: ${objectiveId}`);
      }
      objectiveIds.add(objectiveId);

      if (!objectiveCatalog[objectiveId]) {
        errors.push(`Objective referenced in seasons but missing in objective_catalog: ${objectiveId}`);
      }
    });
  });

  Object.entries(objectiveCatalog).forEach(([objectiveId, objective]) => {
    if (!objective || typeof objective !== "object") {
      errors.push(`Objective ${objectiveId} must be an object.`);
      return;
    }

    if (!objective.season_id || !seasonIds.has(objective.season_id)) {
      errors.push(`Objective ${objectiveId} has invalid season_id.`);
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

  return errors;
}

function lineElement(text, kind = "out") {
  const p = document.createElement("p");
  p.className = `line ${kind}`;
  p.textContent = text;
  return p;
}

function renderLines(lines, kind = "out") {
  lines.forEach((line) => {
    el.log.appendChild(lineElement(line, kind));
  });

  while (el.log.childElementCount > LOG_LIMIT) {
    el.log.removeChild(el.log.firstChild);
  }

  el.log.scrollTop = el.log.scrollHeight;
}

function renderChoices(choices) {
  el.choices.replaceChildren();
  choices.forEach((choice, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice-btn";
    button.textContent = `${index + 1}. ${choice.label}`;
    button.addEventListener("click", () => runCommand(choice.command, false));
    el.choices.appendChild(button);
  });
}

function renderStatus() {
  el.battery.textContent = `${state.battery}%`;
  el.stability.textContent = `${state.stability}%`;
  el.sip.textContent = String(state.sip);
  el.objective.textContent = state.currentObjectiveId || "-";
  el.mode.textContent = state.manualDiceMode ? "MANUAL" : "AUTO";
  renderTracker();
}

function renderTracker() {
  if (!state || !tables) {
    return;
  }

  if (state.characterCreation?.pending) {
    el.trackerSeason.textContent = "Character Creation";
    if (state.characterCreation.stage === "name") {
      el.trackerLoop.textContent = "1/2";
      el.trackerCandidate.textContent = "Enter your name";
    } else {
      el.trackerLoop.textContent = "2/2";
      el.trackerCandidate.textContent = `${state.playerName || "Candidate"} - Choose archetype`;
    }
    return;
  }

  const objectiveId = state.currentObjectiveId;
  const objective = objectiveId ? tables.objective_catalog[objectiveId] : null;
  const season = objective ? tables.seasons.find((entry) => entry.id === objective.season_id) : null;

  el.trackerSeason.textContent = season ? season.label : "-";
  el.trackerLoop.textContent = `${state.loopCount}`;
  el.trackerCandidate.textContent = state.playerName || "-";
}

function persistState() {
  localStorage.setItem(STORAGE_KEY, serializeState(state));
}

function loadState() {
  const serialized = localStorage.getItem(STORAGE_KEY);
  if (!serialized) {
    return newGame(tables);
  }
  return deserializeState(serialized, tables);
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

function runCommand(input, pushHistory = true) {
  const raw = input.trim();
  if (!raw) {
    return;
  }

  renderLines([`> ${raw}`], "in");
  state.transcript.push(`> ${raw}`);
  if (pushHistory) {
    history.push(raw);
    historyIndex = history.length;
  }

  if (raw.toLowerCase() === "load") {
    state = loadState();
    renderLines(["Loaded state from localStorage."]);
    state.transcript.push("Loaded state from localStorage.");
    renderChoices(state.choices || []);
    el.prompt.textContent = state.prompt || ">";
    renderStatus();
    return;
  }

  const result = step(state, raw, tables);
  state = result.state;
  state.prompt = result.prompt;
  state.choices = result.choices;

  renderLines(result.lines);
  result.lines.forEach((line) => state.transcript.push(line));
  renderChoices(result.choices || []);
  el.prompt.textContent = result.prompt || ">";

  if (raw.toLowerCase() === "save") {
    persistState();
    renderLines(["Saved state to localStorage."]);
  } else if (result.exportText) {
    const stamp = new Date().toISOString().replace(/[.:]/g, "-");
    downloadTextFile(`31st-of-feb-loop-${stamp}.txt`, result.exportText);
    renderLines(["Transcript downloaded."]);
  } else {
    persistState();
  }

  renderStatus();
}

function bindInput() {
  el.input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      runCommand(el.input.value, true);
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
  try {
    tables = await loadTables();
  } catch (error) {
    renderLines([`Error loading tables: ${error.message}`]);
    el.input.disabled = true;
    return;
  }

  const schemaErrors = validateTablesSchema(tables);
  if (schemaErrors.length > 0) {
    renderLines(["Schema validation failed for tables.json.", ...schemaErrors.map((err) => `- ${err}`)]);
    el.prompt.textContent = "schema-error>";
    el.input.disabled = true;
    return;
  }

  state = loadState();
  if (state.started) {
    renderLines([
      "State restored from localStorage.",
      "Continue with the current loop or use 'reset' for a fresh run."
    ]);
    renderChoices(state.choices || []);
    el.prompt.textContent = state.prompt || ">";
  } else {
    renderLines([
      "31st of February terminal scaffold ready.",
      "Type 'start' to begin or 'help' for commands."
    ]);
    renderChoices([
      { label: "Start Loop", command: "start" },
      { label: "Help", command: "help" },
      { label: "Manual Dice Mode", command: "mode manual" }
    ]);
    el.prompt.textContent = ">";
  }

  renderStatus();
  bindInput();
  persistState();
  el.input.focus();
}

boot();
