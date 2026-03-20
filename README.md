# 31st of February Terminal Scaffold

Static browser terminal app for the zine. It is a terminal-style UI over a pure state-machine engine.

## Files

- `index.html`: app shell (status, log, choices, input)
- `styles.css`: terminal visual style and responsive layout
- `app.js`: UI wiring, command history, localStorage save/load, export
- `engine.js`: pure game logic (`newGame`, `step`)
- `tables.json`: game rules, objectives, and flavor tables

## Run

Because browsers block module/data loading from `file://` in many setups, run with a local static server:

```bash
# Python 3
python -m http.server 8080
```

Then open:

- http://localhost:8080/31st-of-feb-game/

## Commands

- `help`
- `start` or `reset`
- `archetype camouflage|strategist|runner` (character creation)
- `roll msk` / `roll sns` / `roll log`
- `roll result` (Interview Result check)
- `roll recharge` (Return Recharge check)
- `sip spend` (negate next OS roll during a normal pool check)
- `mode auto` / `mode manual`
- `manual <dice...>` (when manual mode is active)
- `status`
- `save` / `load`
- `export`

## Implemented in this scaffold

- Character creation with name input followed by archetype selection: **Social Camouflage** (MSK 3, SNS 1, LOG 2), **System Strategist** (MSK 1, SNS 2, LOG 3), or **Tension Runner** (MSK 2, SNS 3, LOG 1).
- SIP spend command (`sip spend`) arms an OS-negation for the next pool check.
- Schema validation runs at boot and blocks play with explicit error output if `tables.json` is malformed.
- In-app objective tracker shows season, step index, and completed objective IDs.

## Notes on manual dice mode

- Standard objective checks: enter d6 values after `roll <pool>`
- Result check (`IN_R`): enter two d100 values
- Recharge (`RT_H`): enter one d100 value

## Next implementation targets

1. Add `choose <n>` command aliases for all quick-choice buttons.
2. Add SIP spend timing prompt directly in pool roll choice UI copy.
3. Expand receipt output with per-objective breakdown.
4. Add optional seeded RNG mode for reproducible playtesting.
