import { newGame, step } from "./engine.js";

const LOG_LIMIT = 500;
const LINE_DELAY_MS = 1000;

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
  trackerStation: document.getElementById("tracker-tation"),
  trackerLoop: document.getElementById("tracker-loop"),
  trackerCandidate: document.getElementById("tracker-candidate"),
  trackerMsk: document.getElementById("tracker-msk"),
  trackerSns: document.getElementById("tracker-sns"),
  trackerLog: document.getElementById("tracker-log")
};

let tables;
let state;
let history = [];
let historyIndex = -1;
let commandQueue = Promise.resolve();

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
    "tations",
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

  if (!Array.isArray(data.tations) || data.tations.length === 0) {
    errors.push("tations must be a non-empty array.");
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
  const tationIds = new Set((data.tations || []).map((tation) => tation.id));
  const objectiveIds = new Set();

  (data.tations || []).forEach((tation) => {
    if (!Array.isArray(tation.objectives)) {
      errors.push(`Station ${tation.id} must define objectives as an array.`);
      return;
    }

    tation.objectives.forEach((objectiveId) => {
      if (objectiveIds.has(objectiveId)) {
        errors.push(`Duplicate objective ID in tations: ${objectiveId}`);
      }
      objectiveIds.add(objectiveId);

      if (!objectiveCatalog[objectiveId]) {
        errors.push(`Objective referenced in tations but missing in objective_catalog: ${objectiveId}`);
      }
    });
  });

  Object.entries(objectiveCatalog).forEach(([objectiveId, objective]) => {
    if (!objective || typeof objective !== "object") {
      errors.push(`Objective ${objectiveId} must be an object.`);
      return;
    }

    if (!objective.tation_id || !tationIds.has(objective.tation_id)) {
      errors.push(`Objective ${objectiveId} has invalid tation_id.`);
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
  el.objective.textContent = state.currentObjectiveId || "-";
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
  const tation = objective ? tables.tations.find((entry) => entry.id === objective.tation_id) : null;

  el.trackerStation.textContent = tation ? tation.label : "-";
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

  await renderLines([`> ${raw}`], "in");
  state.transcript.push(`> ${raw}`);
  if (pushHistory) {
    history.push(raw);
    historyIndex = history.length;
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

  renderStatus();
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
  bindInput();
  el.input.focus();
}

boot();
