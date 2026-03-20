const CREATION_ORDER = ["msk", "sns", "log"];

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

function flattenObjectiveOrder(seasons) {
  return seasons
    .slice()
    .sort((a, b) => a.order - b.order)
    .flatMap((season) => season.objectives);
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

function currentCreationPool(state) {
  const idx = state.characterCreation.currentIndex;
  return state.characterCreation.order[idx] || null;
}

function buildCreationChoices(state) {
  const pool = currentCreationPool(state);
  return state.characterCreation.remainingValues.map((value) => ({
    label: `Set ${pool.toUpperCase()} to ${value}`,
    command: `assign ${pool} ${value}`
  }));
}

function promptCharacterCreation(state, lines) {
  const pool = currentCreationPool(state);
  const remaining = state.characterCreation.remainingValues.join(", ");
  lines.push(`Character creation: assign ${pool.toUpperCase()} from remaining values [${remaining}].`);
  return {
    prompt: `Assign ${pool.toUpperCase()} with: assign ${pool} <value>`,
    choices: buildCreationChoices(state)
  };
}

function finishCharacterCreation(state, tables, lines) {
  state.characterCreation.pending = false;
  lines.push("Character creation complete.");
  lines.push(`Pools: MSK ${state.pools.msk}, SNS ${state.pools.sns}, LOG ${state.pools.log}`);
  return nextObjective(state, tables, lines);
}

function assignCreationValue(state, tables, pool, value) {
  const lines = [];

  if (!state.characterCreation.pending) {
    return { state, lines: ["Character creation is already complete."], prompt: ">", choices: [] };
  }

  const expectedPool = currentCreationPool(state);
  if (pool !== expectedPool) {
    return {
      state,
      lines: [`Assign ${expectedPool.toUpperCase()} next. Use: assign ${expectedPool} <value>`],
      prompt: state.prompt,
      choices: state.choices || []
    };
  }

  if (!state.characterCreation.remainingValues.includes(value)) {
    return {
      state,
      lines: ["That value is unavailable. Use one of the remaining values shown."],
      prompt: state.prompt,
      choices: state.choices || []
    };
  }

  state.pools[pool] = value;
  state.characterCreation.remainingValues = state.characterCreation.remainingValues.filter((n) => n !== value);
  state.characterCreation.currentIndex += 1;
  lines.push(`${pool.toUpperCase()} set to ${value}.`);

  if (state.characterCreation.currentIndex >= state.characterCreation.order.length - 1) {
    const lastPool = currentCreationPool(state);
    if (lastPool && state.characterCreation.remainingValues.length === 1) {
      const lastValue = state.characterCreation.remainingValues[0];
      state.pools[lastPool] = lastValue;
      state.characterCreation.remainingValues = [];
      state.characterCreation.currentIndex += 1;
      lines.push(`${lastPool.toUpperCase()} auto-set to ${lastValue}.`);
    }
    return {
      state,
      lines,
      ...finishCharacterCreation(state, tables, lines)
    };
  }

  const next = promptCharacterCreation(state, lines);
  return {
    state,
    lines,
    prompt: next.prompt,
    choices: next.choices
  };
}

function nextObjective(state, tables, lines) {
  if (state.objectiveIndex >= state.objectiveOrder.length) {
    state.objectiveIndex = 0;
    state.loopCount += 1;
    state.sip += tables.sip_rules.gain_per_completed_loop;
    lines.push("A full loop has completed. SIP +1.");
  }

  const objectiveId = state.objectiveOrder[state.objectiveIndex];
  const objective = tables.objective_catalog[objectiveId];
  state.currentObjectiveId = objectiveId;

  lines.push("");
  lines.push(`[${objective.symbol}] ${objective.name} (${objectiveId})`);
  const setupPrompt = pickPrompt(objective);
  if (setupPrompt) {
    lines.push(`Prompt: ${setupPrompt}`);
  }

  if (objective.special_check === "loop_receipt_summary") {
    lines.push(`Receipt: Loop ${state.loopCount} | Battery ${state.battery}% | Stability ${state.stability}% | Successes ${state.successes} | Glitches ${state.glitches}`);
    state.objectiveIndex += 1;

    if (state.stability <= 0) {
      state.gameOver = true;
      lines.push("Stability reached 0%. The loop breaks. You are free.");
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

  if (objective.special_check === "d100_plus_d100_below_stability") {
    state.awaiting = { type: "result_check" };
    return {
      prompt: "Result check. Enter 'roll result' or 'manual <player_d100> <os_d100>'.",
      choices: [
        { label: "Roll Result", command: "roll result" }
      ]
    };
  }

  const poolChoices = (objective.pool_options || ["msk", "sns", "log"]).map((pool) => ({
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
    prompt: `Choose a pool for ${objective.name}.`,
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

  lines.push(`Pool ${pool.toUpperCase()} roll: [${playerDice.join(", ")}] = ${playerTotal}`);
  lines.push(`OS die ${os.die}: ${os.value >= 0 ? "+" : ""}${os.value} (${os.effect})`);
  lines.push(`Total ${total} vs DC ${dc}: ${success ? "SUCCESS" : "GLITCH"}`);

  applyStabilityDelta(state, tables, diceCount, success);

  if (total === dc) {
    const overlayPenalty = tables.narrative_resolution.outcome_flavor.equal_dc_overlay.stability_penalty;
    state.stability = clamp(state.stability - overlayPenalty, tables.core_rules.stability_floor, tables.core_rules.stability_ceiling);
    const glitchFlavor = tables.random_flavor_tables.big_book_of_glitches.entries[rollDie(20) - 1];
    lines.push(`Equal-DC overlay: Stability -${overlayPenalty}% and forced glitch flavor.`);
    lines.push(`Glitch: ${glitchFlavor}`);
  } else if (success) {
    const table = tables.random_flavor_tables.architecture_of_success.tables[pool];
    lines.push(`Success flavor: ${table[rollDie(12) - 1]}`);
  }

  applyObjectiveCost(state, tables);
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
  const os = manualPair ? manualPair[1] : rollDie(100);
  const total = player + os;
  const glitch = total < state.stability;

  lines.push(`Result check: Player ${player} + OS ${os} = ${total}`);
  lines.push(`Current Stability: ${state.stability}`);
  lines.push(glitch ? "Outcome: GLITCH (below Stability)." : "Outcome: Stable (equal/above Stability).");

  if (glitch) {
    state.glitches += 1;
  } else {
    state.successes += 1;
  }

  applyObjectiveCost(state, tables);
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
      order: [...CREATION_ORDER],
      currentIndex: 0,
      remainingValues: [...tables.pools.creation_values]
    },
    battery: 100,
    stability: 100,
    sip: tables.sip_rules.start,
    sipNegateNextOs: false,
    loopCount: 1,
    objectiveOrder: flattenObjectiveOrder(tables.seasons),
    objectiveIndex: 0,
    currentObjectiveId: null,
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
    lines.push("- assign msk|sns|log 1|2|3 (during character creation)");
    lines.push("- roll msk|sns|log|result|recharge");
    lines.push("- sip spend");
    lines.push("- mode auto|manual");
    lines.push("- manual <dice...>");
    lines.push("- save | load | export");
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
      "31st of February companion initialized.",
      "You are Candidate Ibis. Assign your stat pools to begin."
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

  if (command === "save" || command === "load") {
    return {
      state,
      lines: ["Handled by UI storage layer."],
      prompt: ">",
      choices: []
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

  if (command === "assign") {
    const pool = (args[0] || "").toLowerCase();
    const value = Number(args[1]);
    if (!["msk", "sns", "log"].includes(pool) || ![1, 2, 3].includes(value)) {
      return {
        state,
        lines: ["Usage: assign msk|sns|log 1|2|3"],
        prompt: state.prompt || ">",
        choices: state.choices || []
      };
    }
    return assignCreationValue(state, tables, pool, value);
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
      if (values.length !== 2 || values.some((n) => n < 1 || n > 100)) {
        return { state, lines: ["Enter two d100 values: manual <player> <os>"], prompt: ">", choices: [] };
      }
      return resolveResultCheck(state, tables, values);
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

    if (which === "result") {
      return resolveResultCheck(state, tables, null);
    }

    if (which === "recharge") {
      return resolveRecharge(state, tables, null);
    }

    if (!["msk", "sns", "log"].includes(which)) {
      return { state, lines: ["Use: roll msk | roll sns | roll log | roll result | roll recharge"], prompt: ">", choices: [] };
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

export function serializeState(state) {
  return JSON.stringify(state);
}

export function deserializeState(serialized, tables) {
  try {
    const parsed = JSON.parse(serialized);
    const baseline = newGame(tables);
    return {
      ...baseline,
      ...parsed,
      pools: {
        ...baseline.pools,
        ...(parsed.pools || {})
      }
    };
  } catch {
    return newGame(tables);
  }
}
