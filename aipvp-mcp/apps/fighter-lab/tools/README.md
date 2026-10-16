# Fighter Lab balance tools

Command-line tools that simulate thousands of battles with the real engine. They were used to tune the numbers in
`engine.js` (`PRICE`, `WPRICE`, `STAT_PCT`, item values) and `optimizer.js`. Run them from `apps/fighter-lab/`:

| Tool | What it does |
|---|---|
| `node tools/calibrate-skills.cjs [rounds]` | Prices skill effects so forged archetypes of equal power win about equally (prints a new `PRICE`). |
| `node tools/calibrate-weapons.cjs [rounds]` | The same for weapon effects (prints a new `WPRICE`). |
| `node tools/stats-balance.cjs` | Power vs Vitality vs Speed at levels 4, 15 and 35. |
| `node tools/item-balance.cjs [potionHeal]` | Each item with its best rule vs no item. |
| `node tools/ladder-check.cjs [basic\|pro]` | How beatable each rival is for a basic-skills player, or for Pro builds. |
| `node tools/optimize.cjs [fighter.json] [balance] [effort]` | Runs the Pro build on a saved fighter and prints the build, win rates and level-up path. |

Results are noisy (each matchup is a few hundred simulated battles), so differences under about 0.05 aren't meaningful.
The balance tests in `engine.test.mjs` and `optimizer.test.mjs` hold the tuned values in place.
