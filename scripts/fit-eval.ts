// Fit a linear position evaluator against the logged corpus.
//
// The shipped evaluator is scoreAll's VP total: "who wins if we stop now".
// Benchmarked over 10,979 real positions it names the eventual winner 36.6% of
// the time in the opening third (random: 28.9%) — near-blind exactly when the
// game is still open and the AI's choices matter most.
//
// Each (position, seat) here is a supervised example: features in,
// final margin out. Ridge regression on ~17 features, fitted with a
// SPLIT BY GAME — positions inside one game share a board, an opponent set and
// an outcome, so splitting by position would leak the answer across the split
// and report a score the model cannot reproduce on a game it has not seen.
//
// Usage:
//   npm run fit-eval
//   npm run fit-eval -- --lambda 5 --holdout 0.3 --seed 7
import { writeFileSync } from 'node:fs';
import { loadCorpus, finalMargin, type Position } from './corpus';
import { EVAL_FEATURE_NAMES, differentialFeatures, applyFitted, type FittedEval } from '../src/ai/eval-features';
import { stateValue, setPositionalWeights } from '../src/ai/lookahead';

const argv = process.argv.slice(2);
const num = (k: string, d: number) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? Number(argv[i + 1]) : d; };
const LAMBDA = num('lambda', 10);
const HOLDOUT = num('holdout', 0.3);
const SEED = num('seed', 1);
const OUT = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : 'src/ai/fitted-eval.json'; })();

/** Deterministic PRNG so a reported split is reproducible. */
function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Solve (A + lambda I) w = b by Gauss-Jordan with partial pivoting. */
function ridgeSolve(A: number[][], b: number[], lambda: number): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row.map((v, j) => v + (i === j ? lambda : 0)), b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue; // singular column: leave weight 0
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (!factor) continue;
      for (let j = col; j <= n; j++) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

interface Sample { x: number[]; y: number }

function samplesFrom(positions: Position[]): Sample[] {
  const out: Sample[] = [];
  for (const pos of positions) {
    for (let i = 0; i < pos.seats.length; i++) {
      try {
        out.push({ x: differentialFeatures(pos.G, pos.seats[i]), y: finalMargin(pos.finals, i) });
      } catch { /* unscoreable position */ }
    }
  }
  return out;
}

// ---------- metrics (shared shape with bench-eval) ----------
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
  const rx = rank(xs), ry = rank(ys), n = xs.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n;
  let num2 = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; num2 += a * b; dx += a * a; dy += b * b; }
  return dx && dy ? num2 / Math.sqrt(dx * dy) : 0;
}

const BUCKETS = ['early', 'mid', 'late'] as const;
const bucketOf = (p: number) => (p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2);

/** Score any position->value function the way bench-eval does. */
function score(positions: Position[], valueOf: (G: Position['G'], seat: string) => number) {
  const hits = [0, 0, 0], ns = [0, 0, 0];
  const xs: number[] = [], ys: number[] = [];
  let all = 0, allN = 0;
  for (const pos of positions) {
    let values: number[];
    try { values = pos.seats.map(s => valueOf(pos.G, s)); } catch { continue; }
    const b = bucketOf(pos.progress);
    const predicted = values.indexOf(Math.max(...values));
    const actual = pos.finals.indexOf(Math.max(...pos.finals));
    ns[b]++; allN++;
    if (predicted === actual) { hits[b]++; all++; }
    for (let i = 0; i < pos.seats.length; i++) { xs.push(values[i]); ys.push(pos.finals[i]); }
  }
  return {
    overall: allN ? all / allN : 0,
    byBucket: BUCKETS.map((_, i) => (ns[i] ? hits[i] / ns[i] : 0)),
    counts: ns,
    rho: spearman(xs, ys),
  };
}

// ---------- run ----------
const t0 = Date.now();
const corpus = loadCorpus();
console.log('=== Fit evaluator against the logged corpus ===');
console.log(`Games: ${corpus.games}   Positions: ${corpus.positions.length}`);

// Split BY GAME.
const rnd = mulberry(SEED);
const testGames = new Set(corpus.gameIds.filter(() => rnd() < HOLDOUT));
const train = corpus.positions.filter(p => !testGames.has(p.gameId));
const test = corpus.positions.filter(p => testGames.has(p.gameId));
console.log(`Split by game (seed ${SEED}, holdout ${HOLDOUT}): ${corpus.games - testGames.size} train games / ${testGames.size} test games`);
console.log(`  train positions: ${train.length}   test positions: ${test.length}`);

const trainSamples = samplesFrom(train);
const d = EVAL_FEATURE_NAMES.length;

// Standardise on the TRAINING set only.
const mean = new Array<number>(d).fill(0);
for (const s of trainSamples) for (let i = 0; i < d; i++) mean[i] += s.x[i];
for (let i = 0; i < d; i++) mean[i] /= trainSamples.length;
const std = new Array<number>(d).fill(0);
for (const s of trainSamples) for (let i = 0; i < d; i++) std[i] += (s.x[i] - mean[i]) ** 2;
for (let i = 0; i < d; i++) std[i] = Math.sqrt(std[i] / trainSamples.length) || 1;

// Normal equations on standardised features.
const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
const b = new Array<number>(d).fill(0);
let ybar = 0;
for (const s of trainSamples) ybar += s.y;
ybar /= trainSamples.length;
for (const s of trainSamples) {
  const z = s.x.map((v, i) => (v - mean[i]) / std[i]);
  const yc = s.y - ybar;
  for (let i = 0; i < d; i++) {
    b[i] += z[i] * yc;
    for (let j = i; j < d; j++) A[i][j] += z[i] * z[j];
  }
}
for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) A[i][j] = A[j][i];

const weights = ridgeSolve(A, b, LAMBDA * trainSamples.length / 1000);
const model: FittedEval = {
  featureNames: EVAL_FEATURE_NAMES, mean, std, weights, intercept: ybar,
  meta: { lambda: LAMBDA, seed: SEED, holdout: HOLDOUT, trainGames: corpus.games - testGames.size, trainSamples: trainSamples.length },
};

// ---------- compare on HELD-OUT games ----------
setPositionalWeights(null); // baseline is the shipped pure-VP evaluator
const base = score(test, (G, s) => stateValue(G, s));
const fit = score(test, (G, s) => applyFitted(model, differentialFeatures(G, s)));

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
console.log('\n--- held-out games: winner identification ---');
console.log('  phase   positions   shipped (VP)    fitted');
BUCKETS.forEach((n, i) => console.log(
  `  ${n.padEnd(7)} ${String(base.counts[i]).padStart(8)}   ${pct(base.byBucket[i]).padStart(11)}  ${pct(fit.byBucket[i]).padStart(9)}`));
console.log(`  ${'ALL'.padEnd(7)} ${String(test.length).padStart(8)}   ${pct(base.overall).padStart(11)}  ${pct(fit.overall).padStart(9)}`);
console.log(`\n  Spearman        shipped ${base.rho.toFixed(4)}   fitted ${fit.rho.toFixed(4)}`);
const dEarly = (fit.byBucket[0] - base.byBucket[0]) * 100;
const dAll = (fit.overall - base.overall) * 100;
console.log(`  Delta           overall ${dAll >= 0 ? '+' : ''}${dAll.toFixed(2)}pp   early ${dEarly >= 0 ? '+' : ''}${dEarly.toFixed(2)}pp`);

console.log('\n--- fitted weights (standardised; sign = direction, magnitude = VP of final margin per SD) ---');
EVAL_FEATURE_NAMES.map((n, i) => [n, weights[i]] as const)
  .sort((x, y) => Math.abs(y[1]) - Math.abs(x[1]))
  .forEach(([n, w]) => console.log(`  ${n.padEnd(22)} ${w >= 0 ? '+' : ''}${w.toFixed(3)}`));

// The holdout above exists to produce an honest estimate of how this model
// behaves on a game it has never seen. Having got that estimate, the model
// actually shipped is refit on EVERY game — throwing away 30% of the evidence
// in the artifact would be leaving accuracy on the table for no reason. The
// reported numbers stay the held-out ones, which is the conservative claim.
const fullSamples = samplesFrom(corpus.positions);
const fMean = new Array<number>(d).fill(0);
for (const s2 of fullSamples) for (let i = 0; i < d; i++) fMean[i] += s2.x[i];
for (let i = 0; i < d; i++) fMean[i] /= fullSamples.length;
const fStd = new Array<number>(d).fill(0);
for (const s2 of fullSamples) for (let i = 0; i < d; i++) fStd[i] += (s2.x[i] - fMean[i]) ** 2;
for (let i = 0; i < d; i++) fStd[i] = Math.sqrt(fStd[i] / fullSamples.length) || 1;
const fA = Array.from({ length: d }, () => new Array<number>(d).fill(0));
const fB = new Array<number>(d).fill(0);
let fYbar = 0;
for (const s2 of fullSamples) fYbar += s2.y;
fYbar /= fullSamples.length;
for (const s2 of fullSamples) {
  const z = s2.x.map((v, i) => (v - fMean[i]) / fStd[i]);
  const yc = s2.y - fYbar;
  for (let i = 0; i < d; i++) {
    fB[i] += z[i] * yc;
    for (let j = i; j < d; j++) fA[i][j] += z[i] * z[j];
  }
}
for (let i = 0; i < d; i++) for (let j = 0; j < i; j++) fA[i][j] = fA[j][i];
const shipped: FittedEval = {
  featureNames: EVAL_FEATURE_NAMES,
  mean: fMean, std: fStd,
  weights: ridgeSolve(fA, fB, LAMBDA * fullSamples.length / 1000),
  intercept: fYbar,
  meta: {
    lambda: LAMBDA, fittedOn: 'all games', games: corpus.games, samples: fullSamples.length,
    heldOutEstimate: {
      seed: SEED, holdout: HOLDOUT, testGames: testGames.size,
      winnerIdShipped: Number(base.overall.toFixed(4)), winnerIdFitted: Number(fit.overall.toFixed(4)),
      earlyShipped: Number(base.byBucket[0].toFixed(4)), earlyFitted: Number(fit.byBucket[0].toFixed(4)),
      spearmanShipped: Number(base.rho.toFixed(4)), spearmanFitted: Number(fit.rho.toFixed(4)),
    },
    generatedAt: new Date().toISOString(),
  },
};

writeFileSync(OUT, JSON.stringify(shipped, null, 2) + '\n');
console.log(`\nWrote ${OUT} (refit on all ${corpus.games} games; metrics above are held-out)`);
console.log(`Wall clock: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
