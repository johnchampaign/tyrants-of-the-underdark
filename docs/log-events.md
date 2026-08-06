# Game-log event registry (log-format v2)

Since framework 0.42.0 / adapter schemaVersion 2, `G.log` is an array of
structured `GameLogEntry` objects instead of prose strings:

```ts
{ seq, turn, side?, kind, msg?, payload?, secret? }
```

- `seq` — monotonic event index, stable across log-cap trims (cap: 500,
  `LOG_CAP` in `src/engine/log.ts`). `G.turnLogStart` is seq-based.
- `turn` — bgio turn counter, stamped from `G.logTurn` (set at turn.onBegin).
- `side` — acting seat `'0'..'3'`, defaulting to the current player
  (`G.logSide`); `null` for neutral/system events.
- `msg` — the human-readable prose the UI renders (identical wording to the
  old string log).
- All writes go through `logEvent` in `src/engine/log.ts` (usually via
  `Mechanics.log(G, msg, meta?)`).

Legacy `string[]` logs (old local saves / pasted codecs / v1 online
snapshots) are upgraded to `kind: 'legacy'` entries by
`ensureStructuredLog` (turn.onBegin, loadState) and by
`tyrantsAdapter.migrate` (v1 → v2, via the framework's `upgradeProseLog`).
The renderer (`logLineText`) tolerates plain strings just in case.

## Kinds

| kind | payload | notes |
|---|---|---|
| `game.start` | `{ firstSeat: number }` | setup; who goes first |
| `turn.start` | `{ player: string, color: string }` | one per turn |
| `card.play` | `{ card: string }` | card played from hand |
| `card.recruit` | `{ card: string, from: 'market' \| 'houseGuards' \| 'priestesses' \| 'devoured-pile' }` | |
| `card.promote` | `{ card: string, source?: string }` | to inner circle |
| `card.devour` | `{ card: string, from?: 'hand' \| 'inner-circle' }` | |
| `card.focus` | `{ aspect: string, via: 'chain' \| 'revealed' \| 'none' \| 'declined', card: string, enabledBy?: string[], revealed?: string }` | outcome of a Focus keyword. `chain` fires with no prompt (another card of that aspect was already played — `enabledBy` names them); `none`/`declined` are explanatory notes, not triggers |
| `power.gain` | `{ amount: number, source?: string, site?: string }` | source e.g. `'Beholder'`, `'Banshee'` |
| `influence.gain` | `{ amount: number, source?: string }` | |
| `vp.gain` | `{ amount: number, source?: string }` | |
| `troop.deploy` | `{ site: string, setup?: true, free?: true }` | `site` is a space id (or site id during setup) |
| `troop.assassinate` | `{ site: string, target: string }` | target = color or `'white'` |
| `troop.supplant` | `{ site: string, target: string, barracksEmpty?: true }` | |
| `site.control` | `{ site: string, controller: string \| null, previous: string \| null }` | control-marker transfer |
| `marker.reward` | `{ site: string, influence: number, vp: number, totalControl: boolean }` | per-turn marker payout |
| `system` | — | e.g. `[state loaded from codec]` |
| `note` | — | everything else: prose-only lines (skips, prompts, minor effects) |
| `legacy` | — | wrapped pre-v2 string lines from migrated saves |

When adding a new structured event, add its kind + payload shape here.
