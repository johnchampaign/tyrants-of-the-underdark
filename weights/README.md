# Heuristic AI weight files

JSON files in this directory are partial overrides on `DEFAULT_WEIGHTS`
(see `src/ai/heuristic-weights.ts` for the full set + defaults). Any
omitted field falls through to the default, so a weight file can be as
small as a single knob.

## Running a tournament

```
npm run tournament -- --games 100 --a weights/baseline.json --b weights/aggressive.json
npm run tournament -- --games 100 --b weights/aggressive.json     # A defaults to DEFAULT_WEIGHTS
npm run tournament -- --games 200 --num-players 2 --half-decks demons,drow
```

The runner prints per-variant win rate and avg score, the win-rate gap,
and a ±2σ noise floor — if the gap is smaller than the noise floor,
treat the result as a tie.

## Suggested workflow for tuning

### Manual (hypothesis-driven)

1. Save the current defaults as `weights/baseline.json` (empty `{}` works
   — defaults pass through).
2. Make a hypothesis: e.g. "the AI under-values assassinating enemies on
   high-VP non-control sites; raising `assassinateVpMultiplier` from 1 to
   2 should help."
3. Save the tweaked weights as `weights/v2.json` and run a 100–200 game
   tournament against the baseline.
4. If the gap clears the noise floor, promote v2 → baseline and iterate.

### Automated (hill-climber)

```
npm run tune -- --iters 50 --games-per-trial 100 --num-players 2
npm run tune -- --iters 30 --seed weights/tuned.json    # resume from last accepted
```

Each iteration mutates a single random knob, plays a head-to-head
tournament against the current best, and accepts only if the win-rate
gap exceeds the ±2σ noise floor. Accepted weights are written to
`weights/tuned.json`; every trial (accept or reject) is appended to
`weights/tune-log.json` (JSONL).

**Tournament size matters.** 80 games/trial = ±15 pp noise floor — only
big jumps clear it. 200 games/trial = ±10 pp noise floor, but each
trial takes ~2.5 min for 2P. Trade-off: many cheap trials catch easy
wins, few expensive trials catch small ones.

**Validate before promoting.** Hill-climbing is one-shot per trial, so
the tuner can drift on a lucky run. Confirm any accepted tune by
running a fresh 300-game tournament against the baseline before
promoting `tuned.json` into shipped defaults.

## How long a run actually takes

**Budget hours, not minutes.** Measured Sept 2026 on a 12-core box:

| Setup | Per game | 200 games |
|---|---|---|
| 2P | ~83 s | ~5.5 h |
| 4P | ~137 s | ~7.5 h |

An earlier version of this file claimed "~1.4 games/sec for 2P" — that
predates the turn-end rollout, which costs roughly 100x. The runner
prints nothing between its header and the final summary, so a run in
progress is indistinguishable from a hung one; check that the node
process is pinned at 100% CPU rather than reading anything into the
silence. Size the run before starting it: the noise floor is
+/-2*sqrt(0.5/seat-games), so 200 2P games buys +/-10pp and 40 4P games
buys only +/-15.8pp — wide enough that most real effects hide inside it.
