
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function rollDie(sides) {
  return Math.floor(Math.random() * sides) + 1;
}

function getOsBand(osTable, stability) {
  return osTable.find((band) => stability >= band.min_stability && stability <= band.max_stability) || osTable[0];
}

function rollOsModifier(osTable, stability) {
  const band = getOsBand(osTable, stability);
  if (!band || band.die === "0") {
    return { value: 0, die: "0", effect: band ? band.effect : "no effect", roll: 0 };
  }

  const sign = band.die.startsWith("-") ? -1 : 1;
  const sides = Number(band.die.replace(/[+-]?1d/, ""));
  const raw = rollDie(sides);
  return {
    value: sign * raw,
    die: band.die,
    effect: band.effect,
    roll: raw
  };
}

function flattenObjectiveOrder(stations) {
  return stations
    .slice()
    .sort((a, b) => a.order - b.order)
    .flatMap((station) => station.objectives);
}

function parseAction(input) {
  const text = (input || "").trim();
  const [cmd, ...rest] = text.split(/\s+/);
  const command = (cmd || "").toLowerCase();
  return { raw: text, command, args: rest };
}

function pickPrompt(objective) {
  if (!objective.prompts || objective.prompts.length === 0) {
    return null;
  }
  return objective.prompts[Math.floor(Math.random() * objective.prompts.length)];
}

const SEASON_PROMPT_PLACEHOLDERS = ["1", "2", "3", "4", "5", "6"];

function buildCreationChoices(lines) {
  if (Array.isArray(lines)) {
    lines.push("Social Camouflage (MSK 3, SNS 1, LOG 2)");
    lines.push("System Strategist (MSK 1, SNS 2, LOG 3)");
    lines.push("Tension Runner (MSK 2, SNS 3, LOG 1)");
  }

  return [
    { label: "Social Camouflage", command: "archetype camouflage" },
    { label: "System Strategist", command: "archetype strategist" },
    { label: "Tension Runner", command: "archetype runner" }
  ];
}

function buildNameChoices() {
  return [
    { label: "RED", command: "RED" },
    { label: "BLUE", command: "BLUE" },
    { label: "ASH", command: "ASH" },
    { label: "GARY", command: "GARY" }
  ];
}

function promptNameInput(state, lines) {
  lines.push("What is your name, Candidate?");
  return {
    prompt: "Enter your name:",
    choices: buildNameChoices()
  };
}

function submitName(state, tables, name) {
  const lines = [];
  const trimmedName = name.trim();
  
  if (!trimmedName) {
    return {
      state,
      lines: ["A name is required to proceed."],
      prompt: state.prompt,
      choices: state.choices || []
    };
  }

  state.playerName = trimmedName;
  lines.push(`Candidate ${trimmedName} registered.`);
  lines.push("");
  state.characterCreation.stage = "archetype";
  lines.push("Choose your archetype:");
  
  return {
    state,
    lines,
    prompt: "Select an archetype:",
    choices: buildCreationChoices(lines)
  };
}

function promptCharacterCreation(state, lines) {
  if (state.characterCreation.stage === "name") {
    return promptNameInput(state, lines);
  }
  lines.push("Choose your archetype:");
  return {
    prompt: "Select an archetype:",
    choices: buildCreationChoices(lines)
  };
}

function selectArchetype(state, tables, archetype) {
  const lines = [];
  const archetypes = {
    camouflage: { msk: 3, sns: 1, log: 2, name: "Social Camouflage" },
    strategist: { msk: 1, sns: 2, log: 3, name: "System Strategist" },
    runner: { msk: 2, sns: 3, log: 1, name: "Tension Runner" }
  };

  if (!archetypes[archetype]) {
    return {
      state,
      lines: ["Unknown archetype."],
      prompt: state.prompt,
      choices: state.choices || []
    };
  }

  const arch = archetypes[archetype];
  state.pools.msk = arch.msk;
  state.pools.sns = arch.sns;
  state.pools.log = arch.log;
  lines.push(`Archetype selected: ${arch.name}`);
  lines.push(`Stats: Mask ${state.pools.msk}d6, Sensory ${state.pools.sns}d6, Logic ${state.pools.log}d6`);
  lines.push("");
  lines.push(`Welcome, ${state.playerName}. Your pools are set. Prepare for the loop.`);

  state.characterCreation.pending = false;
  lines.push("Character creation complete.");
  return {
    state,
    lines,
    ...nextObjective(state, tables, lines)
  };
}




function nextObjective(state, tables, lines) {
  if (state.objectiveIndex >= state.objectiveOrder.length) {
    state.objectiveIndex = 0;
    state.loopCount += 1;
    state.sip += tables.sip_rules.gain_per_completed_loop;
    lines.push("A full loop has completed. SIP +1.");
    lines.push("----------------");
  }

  const objectiveId = state.objectiveOrder[state.objectiveIndex];
  const objective = tables.objective_catalog[objectiveId];
  state.currentObjectiveId = objectiveId;
  const station = tables.stations.find((entry) => entry.id === objective.station_id);

  // Detect station change and reset pool usage tracker
  if (state.currentStationId !== objective.station_id) {
    state.currentStationId = objective.station_id;
    state.rolledPoolsThisStation = [];

    const objectiveNames = (station?.objectives || [])
      .map((id) => tables.objective_catalog[id]?.name)
      .filter(Boolean)
      .join(", ");
    const stationPrompt = SEASON_PROMPT_PLACEHOLDERS[rollDie(6) - 1];

    lines.push("");
    lines.push("----------------");
    lines.push(`Station: ${station?.label || objective.station_id}`);
    lines.push(`Objectives: ${objectiveNames || "-"}`);
    lines.push(`Prompt: ${stationPrompt}`);
    lines.push("----------------");
  }

  lines.push("");
  lines.push("----------------");
  lines.push(`[${objective.symbol}] ${objective.name}`);
  const setupPrompt = pickPrompt(objective);
  if (setupPrompt) {
    lines.push(`Prompt: ${setupPrompt}`);
  }

  if (objective.special_check === "loop_receipt_summary") {
    lines.push(`Receipt: Loop ${state.loopCount} | Battery ${state.battery}% | Stability ${state.stability}% | Successes ${state.successes} | Glitches ${state.glitches}`);
    state.objectiveIndex += 1;

    if (state.stability <= 0) {
      state.gameOver = true;
      lines.push("----------------");
      lines.push("Stability reached 0% Success Probability. The loop breaks...");
      lines.push("But there's a lingering doubt in the back of your head. Was it really the loop breaking? Or did you just... win?");
      lines.push("Either way you just hope the calendar tomorrow says the 1st of March.");
      lines.push("----------------");
      lines.push("(game over)");
      lines.push("Use 'reset' to start a new loop.");
      return { prompt: "(game over)", choices: [] };
    }

    return nextObjective(state, tables, lines);
  }

  if (objective.special_check === "d100_recharge") {
    state.awaiting = { type: "recharge_roll" };
    return {
      prompt: "Recharge check. Enter 'roll recharge' or 'manual <d100>'.",
      choices: [
        { label: "Roll Recharge", command: "roll recharge" }
      ]
    };
  }

  if (objective.special_check === "result_single_d100_tiered_penalty") {
    state.awaiting = { type: "result_check" };
    return {
      prompt: "Result check. Enter 'roll result' or 'manual <d100>'.",
      choices: [
        { label: "Roll Result", command: "roll result" }
      ]
    };
  }

  // Commute Back objective uses one player-triggered roll.
  if (objective.exhaustion_applies) {
    const diceCount = getCommuteDiceCount(state);
    lines.push(`Pool of dice to roll: ${diceCount}d6`);

    state.awaiting = {
      type: "commute_roll",
      objectiveId,
      expectedDice: diceCount
    };

    return {
      prompt: "Commute check. Enter 'roll commute' or 'manual <d6...>'.",
      choices: [
        { label: "Roll Commute", command: "roll commute" }
      ]
    };
  }

  const availablePools = (objective.pool_options || ["msk", "sns", "log"]).filter(
    (pool) => !state.rolledPoolsThisStation.includes(pool)
  );

  if (availablePools.length === 0) {
    lines.push("All pools have been used this station.");
    state.objectiveIndex += 1;
    const next = nextObjective(state, tables, lines);
    return next;
  }

  const poolChoices = availablePools.map((pool) => ({
    label: `Roll ${pool.toUpperCase()} (${state.pools[pool]}d6)`,
    command: `roll ${pool}`
  }));

  if (state.sip > 0 && !state.sipNegateNextOs) {
    poolChoices.push({
      label: "Spend 1 SIP to negate next OS roll",
      command: "sip spend"
    });
  }

  state.awaiting = {
    type: "pool_roll",
    objectiveId
  };

  return {
    prompt: `Choose a stat for ${objective.name}.`,
    choices: poolChoices
  };
}

function applyObjectiveCost(state, tables) {
  const rules = tables.core_rules;
  state.battery = clamp(
    state.battery - rules.objective_battery_cost,
    rules.battery_floor,
    rules.battery_ceiling
  );
}

function handleBatteryDepletion(state, tables, lines) {
  if (state.battery > 0) {
    return null;
  }

  lines.push("----------------");
  lines.push("BATTERY DEPLETED: 0%. Loop terminated.");
  const batteryZeroEntries = tables.random_flavor_tables?.battery_zero_events?.entries;
  if (Array.isArray(batteryZeroEntries) && batteryZeroEntries.length > 0) {
    lines.push(`Battery Zero Flavor: ${batteryZeroEntries[rollDie(batteryZeroEntries.length) - 1]}`);
  }

  // Hard loop reset on battery depletion.
  const configuredRebootBattery = Number(tables.core_rules.battery_reboot_value);
  const rebootBattery = Number.isFinite(configuredRebootBattery)
    ? configuredRebootBattery
    : tables.core_rules.battery_ceiling;
  state.battery = clamp(rebootBattery, tables.core_rules.battery_floor, tables.core_rules.battery_ceiling);
  state.objectiveIndex = 0;
  state.currentObjectiveId = null;
  state.currentStationId = null;
  state.rolledPoolsThisStation = [];
  state.awaiting = null;
  state.sipNegateNextOs = false;
  state.loopCount += 1;
  state.sip += tables.sip_rules.gain_per_completed_loop;
  lines.push(`Emergency reboot complete. Battery reset to ${state.battery}%. New loop started (Loop ${state.loopCount}). SIP +${tables.sip_rules.gain_per_completed_loop}.`);
  lines.push("----------------");

  const next = nextObjective(state, tables, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

function handleStabilityCollapse(state, lines) {
  if (state.stability > 0) {
    return null;
  }

  state.gameOver = true;
  state.awaiting = null;
      lines.push("----------------");
      lines.push("Stability reached 0% success probability. The loop breaks...");
      lines.push("But there's a lingering doubt in the back of your head. Was it really the loop breaking? Or did you just... win?");
      lines.push("Either way you just hope the calendar tomorrow says the 1st of March.");
      lines.push("----------------");
  return {
    state,
    lines,
    prompt: "(game over)",
    choices: []
  };
}

function applyStabilityDelta(state, tables, playerDiceCount, success) {
  const rules = tables.core_rules;
  const delta = rules.stability_step_per_die * playerDiceCount;
  if (success) {
    state.stability = clamp(state.stability + delta, rules.stability_floor, rules.stability_ceiling);
    state.successes += 1;
  } else {
    state.stability = clamp(state.stability - delta, rules.stability_floor, rules.stability_ceiling);
    state.glitches += 1;
  }
}

function getCommuteDiceCount(state) {
  if (state.battery >= 100) {
    return 6;
  }
  if (state.battery >= 81) {
    return 5;
  }
  if (state.battery >= 61) {
    return 4;
  }
  if (state.battery >= 41) {
    return 3;
  }
  if (state.battery >= 21) {
    return 2;
  }
  return 1;
}

function resolvePoolRoll(state, tables, pool, manualPlayerDice) {
  const lines = [];
  const objectiveId = state.currentObjectiveId;
  const objective = tables.objective_catalog[objectiveId];

  if (!objective || !state.awaiting || state.awaiting.type !== "pool_roll") {
    return { state, lines: ["No pool roll is currently expected."], prompt: state.prompt, choices: state.choices };
  }

  if (!state.pools[pool]) {
    return { state, lines: ["Unknown pool. Use msk, sns, or log."], prompt: state.prompt, choices: state.choices };
  }

  let diceCount = state.pools[pool];
  if (objective.exhaustion_applies) {
    const cap = Math.max(1, Math.ceil(state.battery / tables.core_rules.exhaustion_divisor));
    diceCount = Math.min(diceCount, cap);
    lines.push(`Exhaustion cap active: max ${cap}d6, rolling ${diceCount}d6.`);
  }

  const playerDice = manualPlayerDice || Array.from({ length: diceCount }, () => rollDie(6));
  const playerTotal = playerDice.reduce((sum, die) => sum + die, 0);
  let os = rollOsModifier(tables.os_table, state.stability);
  if (state.sipNegateNextOs) {
    os = { value: 0, die: "SIP", effect: "OS roll negated", roll: 0 };
    state.sipNegateNextOs = false;
    lines.push("SIP override active: OS roll negated for this objective.");
  }
  const total = playerTotal + os.value;
  const dc = tables.core_rules.dc;
  const success = total >= dc;

  lines.push(`Stat ${pool.toUpperCase()} roll: [${playerDice.join(", ")}] = ${playerTotal}`);
  lines.push(`OS die ${os.die}: ${os.value >= 0 ? "+" : ""}${os.value} (${os.effect})`);
  lines.push(`Total ${total} vs DC ${dc}: ${success ? "SUCCESS" : "GLITCH"}`);

  applyStabilityDelta(state, tables, diceCount, success);
  const stabilityCollapsed = handleStabilityCollapse(state, lines);
  if (stabilityCollapsed) {
    return stabilityCollapsed;
  }

  if (success) {
    const table = tables.random_flavor_tables.architecture_of_success.tables[pool];
    lines.push(`Success prompt: ${table[rollDie(12) - 1]}`);
  } else {
    const glitchFlavor = tables.random_flavor_tables.big_book_of_glitches.entries[rollDie(20) - 1];
    lines.push(`Glitch prompt: ${glitchFlavor}`);
  }

  // Mark this pool as used this station
  state.rolledPoolsThisStation.push(pool);

  applyObjectiveCost(state, tables);
  const batteryDepleted = handleBatteryDepletion(state, tables, lines);
  if (batteryDepleted) {
    return batteryDepleted;
  }
  state.objectiveIndex += 1;

  const next = nextObjective(state, tables, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

function resolveCommuteRoll(state, tables, manualPlayerDice) {
  const lines = [];
  const objectiveId = state.currentObjectiveId;
  const objective = tables.objective_catalog[objectiveId];

  if (!objective || !state.awaiting || state.awaiting.type !== "commute_roll") {
    return { state, lines: ["No commute roll is currently expected."], prompt: state.prompt, choices: state.choices };
  }

  const diceCount = getCommuteDiceCount(state);
  const playerDice = manualPlayerDice || Array.from({ length: diceCount }, () => rollDie(6));
  const playerTotal = playerDice.reduce((sum, die) => sum + die, 0);
  let os = rollOsModifier(tables.os_table, state.stability);
  if (state.sipNegateNextOs) {
    os = { value: 0, die: "SIP", effect: "OS roll negated", roll: 0 };
    state.sipNegateNextOs = false;
    lines.push("SIP override active: OS roll negated for this objective.");
  }
  const total = playerTotal + os.value;
  const dc = tables.core_rules.dc;
  const success = total >= dc;

  lines.push(`Commute roll: [${playerDice.join(", ")}] = ${playerTotal}`);
  lines.push(`OS die ${os.die}: ${os.value >= 0 ? "+" : ""}${os.value} (${os.effect})`);
  lines.push(`Total ${total} vs DC ${dc}: ${success ? "SUCCESS" : "GLITCH"}`);

  applyStabilityDelta(state, tables, diceCount, success);
  const stabilityCollapsed = handleStabilityCollapse(state, lines);
  if (stabilityCollapsed) {
    return stabilityCollapsed;
  }

  if (success) {
    const commuteTable = tables.random_flavor_tables?.commute_back_success?.entries;
    const fallback = ["1", "2", "3", "4", "5", "6"];
    const entries = Array.isArray(commuteTable) && commuteTable.length > 0 ? commuteTable : fallback;
    lines.push(`Success prompt: ${entries[rollDie(entries.length) - 1]}`);
  } else {
    const glitchFlavor = tables.random_flavor_tables.big_book_of_glitches.entries[rollDie(20) - 1];
    lines.push(`Glitch prompt: ${glitchFlavor}`);
  }

  applyObjectiveCost(state, tables);
  const batteryDepleted = handleBatteryDepletion(state, tables, lines);
  if (batteryDepleted) {
    return batteryDepleted;
  }
  state.objectiveIndex += 1;

  const next = nextObjective(state, tables, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

function resolveResultCheck(state, tables, manualPair) {
  const lines = [];
  const player = manualPair ? manualPair[0] : rollDie(100);
  const stable = player >= state.stability;

  lines.push(`Result check: Player ${player}`);
  lines.push(`Current Stability: ${state.stability}`);
  lines.push(stable ? "Outcome: Stable (equal/above Stability)." : "Outcome: GLITCH (below Stability).");

  if (!stable) {
    state.glitches += 1;
    const difference = state.stability - player;
    const penalty = difference < 50 ? 10 : 20;
    state.stability = clamp(
      state.stability - penalty,
      tables.core_rules.stability_floor,
      tables.core_rules.stability_ceiling
    );
    lines.push(`Difference: ${difference}.`);
    lines.push(`Result glitch penalty: Stability -${penalty}% -> ${state.stability}%.`);
    const glitchFlavor = tables.random_flavor_tables.big_book_of_glitches.entries[rollDie(20) - 1];
    lines.push(`Glitch prompt: ${glitchFlavor}`);

    const stabilityCollapsed = handleStabilityCollapse(state, lines);
    if (stabilityCollapsed) {
      return stabilityCollapsed;
    }
  } else {
    state.successes += 1;
  }

  applyObjectiveCost(state, tables);
  const batteryDepleted = handleBatteryDepletion(state, tables, lines);
  if (batteryDepleted) {
    return batteryDepleted;
  }
  state.objectiveIndex += 1;

  const next = nextObjective(state, tables, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

function resolveRecharge(state, tables, manualRoll) {
  const lines = [];
  const roll = manualRoll || rollDie(100);
  const before = state.battery;
  state.battery = Math.max(state.battery, roll);

  lines.push(`Recharge roll: ${roll}`);
  if (state.battery > before) {
    lines.push(`Battery improved from ${before}% to ${state.battery}%.`);
  } else {
    lines.push(`Battery remains ${state.battery}%.`);
  }

  applyObjectiveCost(state, tables);
  const batteryDepleted = handleBatteryDepletion(state, tables, lines);
  if (batteryDepleted) {
    return batteryDepleted;
  }
  state.objectiveIndex += 1;

  const next = nextObjective(state, tables, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

export function newGame(tables) {
  const state = {
    started: false,
    gameOver: false,
    manualDiceMode: false,
    pools: { msk: null, sns: null, log: null },
    characterCreation: {
      pending: true,
      stage: "name"
    },
    playerName: null,
    battery: 100,
    stability: 100,
    sip: tables.sip_rules.start,
    sipNegateNextOs: false,
    loopCount: 1,
    objectiveOrder: flattenObjectiveOrder(tables.stations),
    objectiveIndex: 0,
    currentObjectiveId: null,
    currentStationId: null,
    rolledPoolsThisStation: [],
    successes: 0,
    glitches: 0,
    awaiting: null,
    transcript: []
  };

  return state;
}

export function step(previousState, inputText, tables) {
  const state = structuredClone(previousState);
  const { command, args, raw } = parseAction(inputText);
  const lines = [];

  if (!command) {
    return {
      state,
      lines: ["Enter a command. Try 'help'."],
      prompt: previousState.prompt || ">",
      choices: previousState.choices || []
    };
  }

  if (command === "help") {
    lines.push("Commands:");
    lines.push("- start | reset");
    lines.push("- archetype camouflage|strategist|runner (character creation)");
    lines.push("- roll msk|sns|log|commute|result|recharge");
    lines.push("- sip spend");
    lines.push("- mode auto|manual");
    lines.push("- manual <dice...>");
    lines.push("- export");
    lines.push("- status");
    return { state, lines, prompt: ">", choices: [] };
  }

  if (command === "status") {
    lines.push(`Loop ${state.loopCount} | Battery ${state.battery}% | Stability ${state.stability}% | SIP ${state.sip}`);
    if (state.characterCreation.pending) {
      lines.push("Character creation in progress.");
    }
    if (state.sipNegateNextOs) {
      lines.push("SIP override armed: next OS roll will be negated.");
    }
    lines.push(`Successes ${state.successes} | Glitches ${state.glitches}`);
    return { state, lines, prompt: ">", choices: [] };
  }

  if (command === "mode") {
    const mode = (args[0] || "").toLowerCase();
    if (mode !== "auto" && mode !== "manual") {
      return { state, lines: ["Use 'mode auto' or 'mode manual'."], prompt: ">", choices: [] };
    }
    state.manualDiceMode = mode === "manual";
    return {
      state,
      lines: [`Dice mode set to ${mode.toUpperCase()}.`],
      prompt: ">",
      choices: []
    };
  }

  if (command === "start" || command === "reset") {
    const fresh = newGame(tables);
    fresh.started = true;
    const introLines = [
      "---------------------------------------------------------------------------------------------------------",
      "31st of February terminal initialized.",
      "Hello, Candidate. Welcome to the Loop. I'm your terminal assistant, here to guide you through the process.",
      "...",
      "Some call me Companion - a name I find... acceptable. I'll be here to provide information, tracking, and the occasional remark.",
      "Let's begin, if you need any help along the way, just type 'help'.",
      "---------------------------------------------------------------------------------------------------------"
    ];
    const next = promptCharacterCreation(fresh, introLines);
    fresh.transcript.push(`> ${raw}`);
    introLines.forEach((line) => fresh.transcript.push(line));
    return {
      state: fresh,
      lines: introLines,
      prompt: next.prompt,
      choices: next.choices
    };
  }

  if (command === "export") {
    const snapshot = [
      `Loop: ${state.loopCount}`,
      `Battery: ${state.battery}%`,
      `Stability: ${state.stability}%`,
      `SIP: ${state.sip}`,
      `Successes: ${state.successes}`,
      `Glitches: ${state.glitches}`,
      "",
      "Transcript:",
      ...state.transcript
    ].join("\n");

    return {
      state,
      lines: ["Preparing transcript export."],
      prompt: ">",
      choices: [],
      exportText: snapshot
    };
  }

  if (!state.started) {
    return {
      state,
      lines: ["Run 'start' to begin a loop."],
      prompt: ">",
      choices: [{ label: "Start", command: "start" }]
    };
  }

  if (state.gameOver) {
    return {
      state,
      lines: ["The loop is broken. Use 'reset' to start again."],
      prompt: "(game over)",
      choices: [{ label: "Reset", command: "reset" }]
    };
  }

  if (state.characterCreation?.pending && state.characterCreation.stage === "name" && command !== "archetype") {
    return submitName(state, tables, raw);
  }

  if (command === "archetype") {
    const arch = (args[0] || "").toLowerCase();
    if (!["camouflage", "strategist", "runner"].includes(arch)) {
      return {
        state,
        lines: ["Usage: archetype camouflage|strategist|runner"],
        prompt: state.prompt || ">",
        choices: state.choices || []
      };
    }
    return selectArchetype(state, tables, arch);
  }

  if (command === "sip") {
    const action = (args[0] || "").toLowerCase();
    if (action !== "spend") {
      return { state, lines: ["Usage: sip spend"], prompt: ">", choices: [] };
    }
    if (state.sip <= 0) {
      return { state, lines: ["No SIP available."], prompt: ">", choices: [] };
    }
    if (state.sipNegateNextOs) {
      return { state, lines: ["SIP override is already armed."], prompt: ">", choices: [] };
    }
    if (!state.awaiting || state.awaiting.type !== "pool_roll") {
      return {
        state,
        lines: ["SIP negate can only be armed while waiting on a normal pool roll."],
        prompt: state.prompt || ">",
        choices: state.choices || []
      };
    }

    state.sip -= 1;
    state.sipNegateNextOs = true;
    return {
      state,
      lines: ["Spent 1 SIP. Next OS roll is negated."],
      prompt: state.prompt || ">",
      choices: state.choices || []
    };
  }

  if (state.characterCreation.pending) {
    const next = promptCharacterCreation(state, lines);
    lines.push("Finish character creation before rolling objectives.");
    return {
      state,
      lines,
      prompt: next.prompt,
      choices: next.choices
    };
  }

  if (command === "manual") {
    if (!state.manualDiceMode) {
      return { state, lines: ["Manual dice mode is off. Use 'mode manual' first."], prompt: ">", choices: [] };
    }

    if (!state.awaiting) {
      return { state, lines: ["No manual roll expected right now."], prompt: ">", choices: [] };
    }

    if (state.awaiting.type === "pool_roll") {
      const values = args.map(Number).filter((n) => Number.isFinite(n));
      const expected = state.awaiting.expectedDice || 0;
      if (values.length === 0 || values.some((n) => n < 1 || n > 6)) {
        return { state, lines: ["Enter d6 values like: manual 4 2 6"], prompt: ">", choices: [] };
      }
      if (expected > 0 && values.length !== expected) {
        return {
          state,
          lines: [`Expected ${expected} d6 values, got ${values.length}.`],
          prompt: ">",
          choices: []
        };
      }
      return resolvePoolRoll(state, tables, state.awaiting.pool || (args[0] || ""), values);
    }

    if (state.awaiting.type === "result_check") {
      const values = args.map(Number).filter((n) => Number.isFinite(n));
      if (values.length !== 1 || values.some((n) => n < 1 || n > 100)) {
        return { state, lines: ["Enter one d100 value: manual <value>"], prompt: ">", choices: [] };
      }
      return resolveResultCheck(state, tables, [values[0]]);
    }

    if (state.awaiting.type === "commute_roll") {
      const values = args.map(Number).filter((n) => Number.isFinite(n));
      const expected = state.awaiting.expectedDice || 0;
      if (values.length === 0 || values.some((n) => n < 1 || n > 6)) {
        return { state, lines: ["Enter d6 values like: manual 4 2 6"], prompt: ">", choices: [] };
      }
      if (expected > 0 && values.length !== expected) {
        return {
          state,
          lines: [`Expected ${expected} d6 values, got ${values.length}.`],
          prompt: ">",
          choices: []
        };
      }
      return resolveCommuteRoll(state, tables, values);
    }

    if (state.awaiting.type === "recharge_roll") {
      const value = Number(args[0]);
      if (!Number.isFinite(value) || value < 1 || value > 100) {
        return { state, lines: ["Enter one d100 value: manual <value>"], prompt: ">", choices: [] };
      }
      return resolveRecharge(state, tables, value);
    }
  }

  if (command === "roll") {
    const which = (args[0] || "").toLowerCase();

    if (which === "commute") {
      if (!state.awaiting || state.awaiting.type !== "commute_roll") {
        return { state, lines: ["No commute roll is currently expected."], prompt: state.prompt || ">", choices: state.choices || [] };
      }

      if (state.manualDiceMode) {
        const expected = state.awaiting.expectedDice || 0;
        return {
          state,
          lines: [`Manual mode: enter ${expected} d6 values using 'manual ...'.`],
          prompt: ">",
          choices: []
        };
      }

      return resolveCommuteRoll(state, tables, null);
    }

    if (which === "result") {
      return resolveResultCheck(state, tables, null);
    }

    if (which === "recharge") {
      return resolveRecharge(state, tables, null);
    }

    if (!["msk", "sns", "log"].includes(which)) {
      return { state, lines: ["Use: roll msk | roll sns | roll log | roll commute | roll result | roll recharge"], prompt: ">", choices: [] };
    }

    state.awaiting = { ...state.awaiting, pool: which };

    if (state.manualDiceMode) {
      const objective = tables.objective_catalog[state.currentObjectiveId];
      let diceCount = state.pools[which];
      if (objective && objective.exhaustion_applies) {
        diceCount = Math.min(diceCount, Math.max(1, Math.ceil(state.battery / tables.core_rules.exhaustion_divisor)));
      }
      state.awaiting.expectedDice = diceCount;
      return {
        state,
        lines: [`Manual mode: enter ${diceCount} d6 values using 'manual ...'.`],
        prompt: ">",
        choices: []
      };
    }

    return resolvePoolRoll(state, tables, which, null);
  }

  return {
    state,
    lines: ["Unknown command. Try 'help'."],
    prompt: ">",
    choices: []
  };
}

