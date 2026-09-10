// Evaluation benchmark: how well does the AI's position evaluator predict who
// actually wins?
//
// WHY THIS EXISTS. Judging an AI change by playing tournaments costs hours —
// a 200-game 2P run measured at ~5.5h, and at that sample size the noise floor
// (+/-10pp) swallows most real effects, so the usual verdict is "TIE" after
// half a day. That is a terrible feedback loop for tuning an evaluator.
//
// The logged corpus offers a much cheaper instrument. Every uploaded game
// carries a full encoded state at each turn boundary AND the final scores, so
// each (position, seat) pair is a labelled prediction problem: from here, how
// well did this seat actually do? Scoring the evaluator against ~11k real
// positions needs no simulation and no RNG — it is fast and DETERMINISTIC, so
// a difference of 0.5pp is a difference, not noise.
//
// What it measures is deliberately NOT "VP gained per turn". That metric
// rewards exactly the greedy myopia the replay-divergence numbers exposed (the
// AI out-earns humans 0.70 VP/turn and still loses 70% of games). Predicting
// the eventual winner from a mid-game position is the thing a good evaluator
// has to do, and the thing the shipped one does badly.
//
// METRICS
//   winner-ID accuracy — from a position, does argmax(stateValue) name the
//     seat that actually won? Baseline is 1/numPlayers.
//   Spearman rho — does the evaluator ORDER seats the way the final scores did?
//   Both bucketed into thirds of each game, because an evaluator that only
//     works once the scores are already decided is worth nothing.
//
// Usage:
//   npm run bench-eval
//   npm run bench-eval -- --variant off      # pure-VP evaluator only
//   npm run bench-eval -- --spy 2 --spy-marker 2
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TyrantsState } from '../src/game';
import { stateValue, setPositionalWeights } from '../src/ai/lookahead';
import { DEFAULT_WEIGHTS } from '../src/ai/heuristic-weights';

interface Snap { turn: number; playerId: string; color: string; codec: string }
interface GameLog {
  source?: string;
  game: {
    numPlayers: number;
    scores: Record<string, { total: number }>;
    snapshots?: Snap[];
    turnLogs?: { lines: string[] }[];
  };
}

const argv = process.argv.slice(2);
const getNum = (k: string, d: number) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? Number(argv[i + 1]) : d;
};
const variant = (() => {
  const i = argv.indexOf('--variant');
  return i >= 0 ? argv[i + 1] : 'both';
})();
const logsDir = (() => {
  const i = argv.indexOf('--logs-dir');
  return i >= 0 ? argv[i + 1] : 'logs';
})();

/** One labelled position: the evaluator sees `G`, and we already know how the
 *  game turned out. `progress` is 0 at the opening and 1 at the last turn. */
interface Position { G: TyrantsState; seats: string[]; finals: number[]; progress: number }

function load(): { positions: Position[]; games: number; skipped: Record<string, number> } {
  const positions: Position[] = [];
  const skipped: Record<string, number> = { noSnapshots: 0, codecLoaded: 0, undecodable: 0 };
  let games = 0;

  for (const f of readdirSync(logsDir).filter(n => n.endsWith('.json'))) {
    let log: GameLog;
    try { log = JSON.parse(readFileSync(join(logsDir, f), 'utf-8')) as GameLog; }
    catch { skipped.undecodable++; continue; }
    const g = log.game;
    const snaps = g?.snapshots;
    if (!snaps || snaps.length < 2 || !g.scores) { skipped.noSnapshots++; continue; }
    // A game resumed from a pasted codec has snapshots belonging to a DIFFERENT
    // game than its final scores, so every label before the load is wrong.
    if ((g.turnLogs ?? []).some(t => (t.lines ?? []).some(l => l.includes('state loaded from codec')))) {
      skipped.codecLoaded++; continue;
    }
    const seats = Object.keys(g.scores).sort();
    const finals = seats.map(s => g.scores[s].total);
    games++;
    for (let i = 0; i < snaps.length; i++) {
      let G: TyrantsState;
      try { G = JSON.parse(Buffer.from(snaps[i].codec.trim(), 'base64').toString('utf-8')) as TyrantsState; }
      catch { skipped.undecodable++; continue; }
      positions.push({ G, seats, finals, progress: snaps.length > 1 ? i / (snaps.length - 1) : 0 });
    }
  }
  return { positions, games, skipped };
}

/** Spearman rank correlation. Ties get averaged ranks. */
function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs), ry = rank(ys);
  const n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = rx[i] - mx, b = ry[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx && dy ? num / Math.sqrt(dx * dy) : 0;
}

interface Bucket { hits: number; n: number; xs: number[]; ys: number[] }
const newBucket = (): Bucket => ({ hits: 0, n: 0, xs: [], ys: [] });
const BUCKETS = ['early', 'mid', 'late'] as const;
const bucketOf = (p: number) => (p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2);

function evaluate(positions: Position[], label: string, spy: number, spyMarker: number) {
  const prev = setPositionalWeights(
    (spy || spyMarker) ? { spy, spyAtMarker: spyMarker } : null);
  const buckets = BUCKETS.map(newBucket);
  const all = newBucket();
  let errors = 0;

  for (const pos of positions) {
    let values: number[];
    try { values = pos.seats.map(s => stateValue(pos.G, s)); }
    catch { errors++; continue; }
    const b = buckets[bucketOf(pos.progress)];
    // Winner-ID: does the evaluator's best-looking seat go on to win?
    const predicted = values.indexOf(Math.max(...values));
    const actual = pos.finals.indexOf(Math.max(...pos.finals));
    for (const target of [b, all]) {
      target.n++;
      if (predicted === actual) target.hits++;
      target.xs.push(...values);
      target.ys.push(...pos.finals);
    }
  }
  setPositionalWeights(prev);

  const row = (name: string, t: Bucket) =>
    `  ${name.padEnd(7)} ${String(t.n).padStart(6)}  ${(t.n ? (t.hits / t.n) * 100 : 0).toFixed(1).padStart(6)}%  ${spearman(t.xs, t.ys).toFixed(4).padStart(8)}`;

  console.log(`\n--- ${label} ---`);
  console.log('  phase   positions  winner-ID   Spearman');
  BUCKETS.forEach((n, i) => console.log(row(n, buckets[i])));
  console.log(row('ALL', all));
  if (errors) console.log(`  (${errors} positions the evaluator could not score)`);
  return { acc: all.n ? all.hits / all.n : 0, rho: spearman(all.xs, all.ys), buckets };
}

const t0 = Date.now();
const { positions, games, skipped } = load();
console.log('=== Evaluation benchmark ===');
console.log(`Games used: ${games}   Positions: ${positions.length}`);
console.log(`Skipped — no snapshots/scores: ${skipped.noSnapshots}, resumed from a pasted codec: ${skipped.codecLoaded}, undecodable: ${skipped.undecodable}`);
const perGameBaseline = positions.length
  ? positions.reduce((s, p) => s + 1 / p.seats.length, 0) / positions.length
  : 0;
console.log(`Random winner-ID baseline: ${(perGameBaseline * 100).toFixed(1)}%`);

const spy = getNum('spy', DEFAULT_WEIGHTS.spyPresenceValue);
const spyMarker = getNum('spy-marker', DEFAULT_WEIGHTS.spyMarkerPresenceValue);

let off = null, on = null;
if (variant !== 'on') off = evaluate(positions, 'pure VP (positional weights off)', 0, 0);
if (variant !== 'off') on = evaluate(positions, `shipped (spy ${spy}, at-marker ${spyMarker})`, spy, spyMarker);

if (off && on) {
  const dAcc = (on.acc - off.acc) * 100;
  const dRho = on.rho - off.rho;
  console.log(`\nShipped − pure VP:  winner-ID ${dAcc >= 0 ? '+' : ''}${dAcc.toFixed(2)}pp   Spearman ${dRho >= 0 ? '+' : ''}${dRho.toFixed(4)}`);
  const dEarly = (on.buckets[0].hits / on.buckets[0].n - off.buckets[0].hits / off.buckets[0].n) * 100;
  console.log(`Early game only:    winner-ID ${dEarly >= 0 ? '+' : ''}${dEarly.toFixed(2)}pp`);
  console.log('\nNo RNG anywhere in this benchmark: rerunning gives identical numbers, so');
  console.log('a difference here is a real difference, not a sample-size artifact.');
}
console.log(`\nWall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
