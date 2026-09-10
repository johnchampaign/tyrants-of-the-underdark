// Replay-divergence analyzer: load human-played game logs, replay each
// human turn with the AI, compare the resulting end-of-turn state to
// what the human actually achieved.
//
// Humans win 87.5% of games in the current log corpus. AI-vs-AI
// tournaments at the level of strategic tweaks have hit a TIE plateau
// in 2P. This script measures the AI's gap against actual human play
// turn-by-turn, surfacing decision points where the AI underperforms
// — useful for targeted improvements.
//
// Methodology:
//   For each human turn in each log file:
//     1. Decode the turn-start snapshot → G_before.
//     2. Build a boardgame.io state with G=G_before, ctx.currentPlayer=pid.
//     3. Run the heuristic AI through the turn (apply moves until
//        ctx.currentPlayer changes or game over).
//     4. Decode the next turn-start snapshot → G_after_human (state
//        after the human played).
//     5. Compute score(G_after_*)[pid] − score(G_before)[pid] for both
//        AI and human. The delta is "how many VP did this turn earn?"
//     6. Record (turn, pid, ai_gain, human_gain, log_lines).
//
// Output: aggregate stats + top N turns where the AI underperformed
// the human, with the human's natural-language log lines for context.
//
// Usage:
//   npm run replay-divergence -- --logs-dir logs/ --top 20
//   npm run replay-divergence -- --player 0 --browser-only

import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { decideHeuristicMoveWithWeights } from '../src/ai/heuristic-ai';
import { DEFAULT_WEIGHTS } from '../src/ai/heuristic-weights';
import { scoreAll } from '../src/engine/scoring';
import type { SimulateMoveFn, RolloutToTurnEndFn } from '../src/ai/lookahead';

interface Args {
  logsDir: string;
  topN: number;
  browserOnly: boolean;
  /** Replay only turns for this player (e.g. P0 = the human seat). Default: any non-AI seat. */
  playerFilter: string | null;
  /** Disable lookahead during replay (faster, comparable to no-lookahead variant). */
  noLookahead: boolean;
}

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string, d: string) => { const i = a.indexOf(`--${k}`); return i >= 0 ? a[i + 1] : d; };
  const has = (k: string) => a.includes(`--${k}`);
  return {
    logsDir: get('logs-dir', 'logs'),
    topN: parseInt(get('top', '20')),
    browserOnly: has('browser-only'),
    playerFilter: a.indexOf('--player') >= 0 ? a[a.indexOf('--player') + 1] : null,
    noLookahead: has('no-lookahead'),
  };
}

interface SnapshotRec { turn: number; playerId: string; color: string; codec: string }
interface TurnLogRec { turn: number; playerId: string; color: string; lines: string[] }
interface GameLog {
  source: string;
  meta?: { numPlayers?: number; aiStyles?: string[]; winner?: string };
  game: {
    numPlayers: number;
    halfDecks: string[];
    aiStyles?: string[];
    snapshots: SnapshotRec[];
    turnLogs: TurnLogRec[];
  };
}

/** The save codec deliberately omits fields that live elsewhere in the log
 *  file (turnLogs / snapshots), fields that are per-session (undoStack), and
 *  fields that postdate the logs we're reading (logTurn / logSide arrived with
 *  log-format v2; cardsPlayed and pendingEotInnerCircleVp were added later).
 *  Handing that state straight to the reducer means the first playCard does
 *  `players[pid].cardsPlayed.push(...)` on undefined — which is why this
 *  analyzer used to replay turn 1 of each game and throw on every turn after
 *  it, silently discarding 95% of the corpus. Fill the gaps before replaying. */
function rehydrate(G: TyrantsState): TyrantsState {
  const g = G as unknown as Record<string, unknown>;
  g.turnLogs ??= [];
  g.snapshots ??= [];
  g.undoStack ??= [];
  g.pendingEotInnerCircleVp ??= [];
  g.log ??= [];
  g.cardsPlayedThisTurn ??= [];
  g.turnAspectsPlayed ??= {};
  g.logTurn ??= 1;
  g.logSide ??= null;
  // NOTE: auxStacks is deliberately NOT filled in. Logs old enough to lack it
  // predate House Guards / Priestesses being implemented at all, so inventing
  // full stacks would hand the replaying AI two recruit options the human
  // never had and quietly bias the comparison in the AI's favour. Those games
  // are counted and excluded instead — see preFeature below.
  for (const p of Object.values(G.players as unknown as Record<string, Record<string, unknown>>)) {
    p.cardsPlayed ??= [];
  }
  return G;
}

/** Peek at a codec without rehydrating it — used to test for fields whose
 *  absence means "this log predates a rules feature". */
function gPeek(codec: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(codec.trim(), 'base64').toString('utf-8')) as Record<string, unknown>;
}

function decodeCodec(codec: string): Partial<TyrantsState> {
  // Node has Buffer for base64 + utf-8 decoding.
  const json = Buffer.from(codec.trim(), 'base64').toString('utf-8');
  return JSON.parse(json) as Partial<TyrantsState>;
}

/** True if the given player slot is a human (no AI style assigned). The
 *  aiStyles array is (numPlayers - 1) long for browser games (P0 is the
 *  human, others are AI in slots 1..n-1). For sim logs, all slots are AI. */
function isHumanSeat(log: GameLog, pid: string): boolean {
  const styles = log.game.aiStyles ?? log.meta?.aiStyles ?? [];
  const idx = Number(pid);
  // Browser game convention: P0 is human, aiStyles[i] applies to P(i+1).
  if (idx === 0) return styles.length > 0; // P0 only "human" if there ARE AIs
  // For non-P0 slots: aiStyles[idx-1] is their style (if present).
  return styles[idx - 1] === undefined;
}

interface BgState {
  G: TyrantsState;
  ctx: { currentPlayer: string; turn: number; gameover?: unknown; numPlayers: number; phase?: string };
  _stateID?: number;
  plugins?: unknown;
}
type Reducer = (state: BgState, action: unknown) => BgState;
const makeMoveAction = (type: string, args: unknown[], playerID: string) => ({
  type: 'MAKE_MOVE',
  payload: { type, args, playerID },
});

interface DivergenceRec {
  file: string;
  turn: number;
  pid: string;
  humanGain: number;
  aiGain: number;
  delta: number;     // aiGain - humanGain. Negative = AI did worse.
  humanLines: string[];
}

function replayOneTurn(
  log: GameLog,
  snapshotIdx: number,
  noLookahead: boolean,
): { aiEndG: TyrantsState; gBefore: TyrantsState } | null {
  const snap = log.game.snapshots[snapshotIdx];
  const pid = snap.playerId;
  const gBefore = rehydrate(decodeCodec(snap.codec) as TyrantsState);

  // Build a fresh bgio state and substitute G + ctx fields.
  const wrappedGame = {
    ...TyrantsGame,
    setup: (sa: Parameters<NonNullable<typeof TyrantsGame.setup>>[0]) =>
      TyrantsGame.setup!(sa, { halfDecks: log.game.halfDecks }),
  };
  const reducer = CreateGameReducer({ game: wrappedGame }) as unknown as Reducer;
  let state = InitializeGame({ game: wrappedGame, numPlayers: log.game.numPlayers }) as unknown as BgState;

  // Splice in our decoded G; carefully restore the fields that
  // encodeSnapshot peeled off (snapshots, turnLogs are absent in codec).
  state = {
    ...state,
    G: { ...gBefore, snapshots: [], turnLogs: [] } as TyrantsState,
  };
  state.ctx = { ...state.ctx, currentPlayer: pid, turn: snap.turn };

  const simulate: SimulateMoveFn = (G, playerId, moveName, args) => {
    const wrapped = { ...state, G };
    const next = reducer(wrapped, makeMoveAction(moveName, args, playerId));
    if (next === wrapped) return null;
    return next.G;
  };
  const rollout: RolloutToTurnEndFn = (G, playerId, moveName, args) => {
    let s: BgState = { ...state, G };
    s = reducer(s, makeMoveAction(moveName, args, playerId));
    if (s.G === G) return null;
    let inner = 50;
    while (inner-- > 0) {
      if (s.ctx.gameover) break;
      if (s.ctx.currentPlayer !== playerId) break;
      const m = decideHeuristicMoveWithWeights(s.G, playerId, DEFAULT_WEIGHTS);
      if (!m) { s = reducer(s, makeMoveAction('endTurn', [], playerId)); continue; }
      const next = reducer(s, makeMoveAction(m.name, m.args as unknown[], playerId));
      if (next === s) s = reducer(s, makeMoveAction('endTurn', [], playerId));
      else s = next;
    }
    return s.G;
  };

  // Drive the turn to completion. Safety cap to bail on bad state.
  let safety = 100;
  while (safety-- > 0) {
    if (state.ctx.gameover) break;
    if (state.ctx.currentPlayer !== pid) break; // turn ended
    const w = DEFAULT_WEIGHTS;
    const m = noLookahead
      ? decideHeuristicMoveWithWeights(state.G, pid, w)
      : decideHeuristicMoveWithWeights(state.G, pid, w, simulate, rollout);
    if (!m) {
      state = reducer(state, makeMoveAction('endTurn', [], pid));
      continue;
    }
    const next = reducer(state, makeMoveAction(m.name, m.args as unknown[], pid));
    if (next === state) {
      state = reducer(state, makeMoveAction('endTurn', [], pid));
    } else {
      state = next;
    }
  }
  if (safety <= 0) return null; // gave up
  return { aiEndG: state.G, gBefore };
}

function totalScore(G: TyrantsState, pid: string): number {
  const all = scoreAll(G);
  return all[pid]?.total ?? 0;
}

async function main() {
  const args = parseArgs();
  const dir = args.logsDir;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));

  const divergences: DivergenceRec[] = [];
  let analyzed = 0;
  let humanGainSum = 0, aiGainSum = 0;
  let skipped = 0;
  let loadBoundaries = 0;
  let preFeature = 0;

  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as GameLog;
    if (args.browserOnly && raw.source !== 'browser-game') continue;
    const log: GameLog = raw;
    const snapshots = log.game.snapshots;
    if (!snapshots || snapshots.length < 2) continue;

    for (let i = 0; i < snapshots.length - 1; i++) {
      const snap = snapshots[i];
      const nextSnap = snapshots[i + 1];
      // Only analyze HUMAN turns. (The "human" is whichever slot wasn't an AI.)
      if (args.playerFilter && snap.playerId !== args.playerFilter) continue;
      if (!args.playerFilter && !isHumanSeat(log, snap.playerId)) continue;

      // A player can paste a saved game in mid-session ("[state loaded from
      // codec]"). At that boundary snapshot i is the pre-load position and
      // i+1 is the loaded one, so the "human's turn" spans an entire imported
      // game and scores as a +80 VP swing. Those aren't turns anyone played;
      // consecutive turn numbers are what a real turn looks like.
      if (nextSnap.turn !== snap.turn + 1) { loadBoundaries++; continue; }

      // Same problem, and the turn numbers stay consecutive through it, so the
      // check above doesn't catch it: the human's log says so outright.
      const preTurnLog = log.game.turnLogs.find(t => t.turn === snap.turn && t.playerId === snap.playerId);
      if ((preTurnLog?.lines ?? []).some(l => l.includes('state loaded from codec'))) {
        loadBoundaries++; continue;
      }
      // Games older than the House Guard / Priestess stacks can't be replayed
      // against today's rules without giving the AI options the human lacked.
      if ((gPeek(snap.codec) as { auxStacks?: unknown }).auxStacks === undefined) {
        preFeature++; continue;
      }

      try {
        const replay = replayOneTurn(log, i, args.noLookahead);
        if (!replay) { skipped++; continue; }
        const before = totalScore(replay.gBefore, snap.playerId);
        const aiAfter = totalScore(replay.aiEndG, snap.playerId);
        const humanG = rehydrate(decodeCodec(nextSnap.codec) as TyrantsState);
        const humanAfter = totalScore(humanG, snap.playerId);

        const humanGain = humanAfter - before;
        const aiGain = aiAfter - before;
        const delta = aiGain - humanGain;

        const turnLog = log.game.turnLogs.find(t => t.turn === snap.turn && t.playerId === snap.playerId);
        const lines = turnLog?.lines ?? [];

        divergences.push({
          file: f, turn: snap.turn, pid: snap.playerId,
          humanGain, aiGain, delta, humanLines: lines,
        });
        analyzed++;
        humanGainSum += humanGain;
        aiGainSum += aiGain;
      } catch (e) {
        skipped++;
        if (skipped < 5) console.error(`Skip ${f} turn ${snap.turn}: ${e}`);
      }
    }
  }

  console.log(`\n=== Replay divergence summary ===`);
  console.log(`Logs scanned: ${files.length}`);
  console.log(`Human turns analyzed: ${analyzed}`);
  console.log(`Turns skipped (errors): ${skipped}`);
  console.log(`Turns skipped (mid-game codec loads, not real turns): ${loadBoundaries}`);
  console.log(`Turns skipped (logs predating the aux recruit stacks): ${preFeature}`);
  if (analyzed === 0) { console.log('No turns to analyze.'); return; }
  console.log(`Avg human VP gain per turn: ${(humanGainSum / analyzed).toFixed(2)}`);
  console.log(`Avg AI VP gain per turn:    ${(aiGainSum / analyzed).toFixed(2)}`);
  console.log(`Average gap (AI - human):   ${((aiGainSum - humanGainSum) / analyzed).toFixed(2)} VP/turn`);

  // Histogram of delta = aiGain - humanGain.
  const buckets = [-Infinity, -10, -5, -2, -1, 0, 1, 2, 5, 10, Infinity];
  const counts = new Array(buckets.length - 1).fill(0);
  for (const d of divergences) {
    for (let b = 0; b < buckets.length - 1; b++) {
      if (d.delta >= buckets[b] && d.delta < buckets[b + 1]) { counts[b]++; break; }
    }
  }
  console.log(`\n=== Delta histogram (aiGain - humanGain, VP) ===`);
  for (let b = 0; b < buckets.length - 1; b++) {
    const lo = buckets[b] === -Infinity ? '-inf' : buckets[b];
    const hi = buckets[b + 1] === Infinity ? '+inf' : buckets[b + 1];
    const pct = (100 * counts[b] / analyzed).toFixed(1);
    console.log(`  [${String(lo).padStart(4)}, ${String(hi).padStart(4)}): ${String(counts[b]).padStart(4)} (${pct}%)`);
  }

  // Top N turns where AI did worst relative to human.
  divergences.sort((a, b) => a.delta - b.delta);
  const worst = divergences.slice(0, args.topN);
  console.log(`\n=== Top ${args.topN} turns where AI UNDERPERFORMED the human ===`);
  console.log(`(These are turns where humans made strategically-better choices the AI missed.)\n`);
  for (const d of worst) {
    console.log(`[${d.file}] turn ${d.turn} P${Number(d.pid) + 1}: human +${d.humanGain.toFixed(1)}, AI +${d.aiGain.toFixed(1)}, delta ${d.delta.toFixed(1)}`);
    console.log('  Human played:');
    for (const line of d.humanLines.slice(1)) console.log(`    ${line}`);
    console.log('');
  }

  // Top N turns where AI did BEST relative to human. These are
  // suspicious: if AI consistently scored more per turn yet humans win
  // 87.5% of games, these turns likely show the AI greedily grabbing
  // immediate VP at the expense of long-term setup the human chose.
  divergences.sort((a, b) => b.delta - a.delta);
  const best = divergences.slice(0, args.topN);
  console.log(`\n=== Top ${args.topN} turns where AI OUTPERFORMED the human ===`);
  console.log(`(These often reveal AI greedy plays vs human strategic-setup plays.)\n`);
  for (const d of best) {
    console.log(`[${d.file}] turn ${d.turn} P${Number(d.pid) + 1}: human +${d.humanGain.toFixed(1)}, AI +${d.aiGain.toFixed(1)}, delta ${d.delta.toFixed(1)}`);
    console.log('  Human played:');
    for (const line of d.humanLines.slice(1)) console.log(`    ${line}`);
    console.log('');
  }
}

await main();
