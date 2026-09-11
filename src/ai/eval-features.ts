// Per-seat position features for the fitted evaluator.
//
// The shipped evaluator is scoreAll's VP total, which answers "who would win if
// the game stopped right now". Measured against 10,979 real logged positions it
// identifies the eventual winner only 36.6% of the time in the first third of a
// game (random is 28.9%) — barely better than chance while the game is still
// open. That is the gap this feature set exists to close: the things that
// DECIDE a game but score zero VP today — board presence, barracks burn-down,
// deck quality, tempo.
//
// ONE definition, used by both the fitter (scripts/fit-eval.ts) and the runtime
// evaluator. Training on one set of features and serving another is the classic
// way to ship a model that measured well and plays badly, so there is
// deliberately no second copy of this arithmetic anywhere.
import type { TyrantsState } from '../game';
import { SITES, SITES_BY_ID } from '../data/sites';
import { TROOP_SPACES_BY_ID, sitesSpaces } from '../data/troop-spaces';
import { lookupCard } from '../card-data';
import { scorePlayer } from '../engine/scoring';
import { hasPresence } from '../engine/map-state';

/** Feature names, in the order featuresFor returns them. A fitted weight file
 *  stores this list so a stale model can be detected rather than silently
 *  misapplied. */
export const EVAL_FEATURE_NAMES = [
  // --- what scoreAll already counts, split into its parts so the fit can
  //     weight them differently (a trophy now is not worth a deck VP now) ---
  'sites', 'totalControl', 'trophies', 'deckVp', 'innerCircleVp', 'vpTokens',
  // --- board presence: invisible to scoreAll ---
  'troopsOnBoard', 'troopsAtMarkerSites', 'routeTroops',
  'spiesOnBoard', 'spiesInReserve',
  // --- the approach to a garrisoned city ---
  // A control-marker site that starts full of white troops cannot be deployed
  // into at all: the only way in is to stand adjacent (or put a spy there),
  // assassinate a white, then take the freed slot. That is a multi-turn
  // project, and an evaluation that stops at end-of-turn can only see it if
  // the first steps are worth something on their own. Without these two, the
  // heavy markers were simply never approached — Araumycos finished untouched
  // in three-quarters of the games where it went unclaimed, whites still
  // standing. Reported from BGG as the AI neglecting the bottom cities.
  'markerFootholds', 'markerSlotsOpen',
  // --- the clock: barracks running out is one of the two end-game triggers ---
  'barracksLeft',
  // --- engine quality ---
  'cyclingDeckSize', 'cyclingDeckVpDensity', 'innerCircleCount',
  // --- transient resources ---
  'influence', 'power',
] as const;

export type EvalFeatures = number[];

/** Total VP printed on every card in the cycling deck (deck + hand + discard),
 *  and the card count, in one pass. */
function cyclingDeck(p: { deck: unknown[]; hand: unknown[]; discard: unknown[] }): { n: number; vp: number } {
  let n = 0, vp = 0;
  for (const pile of [p.deck, p.hand, p.discard]) {
    for (const c of pile as Array<{ deck: string; slot: number }>) {
      n++;
      vp += lookupCard(c.deck, c.slot)?.deckVp ?? 0;
    }
  }
  return { n, vp };
}

/** Feature vector for one seat. Order matches EVAL_FEATURE_NAMES. */
export function featuresFor(G: TyrantsState, seat: string): EvalFeatures {
  const p = G.players[seat];
  if (!p) return EVAL_FEATURE_NAMES.map(() => 0);
  const colour = p.color;
  const s = scorePlayer(G, seat);

  let troopsOnBoard = 0, troopsAtMarkerSites = 0, routeTroops = 0;
  for (const [spaceId, occupant] of Object.entries(G.troops ?? {})) {
    if (occupant !== colour) continue;
    const space = TROOP_SPACES_BY_ID[spaceId];
    if (!space) continue;
    if (space.parentSite) {
      troopsOnBoard++;
      if (SITES_BY_ID[space.parentSite]?.hasControlMarker) troopsAtMarkerSites++;
    } else {
      routeTroops++;
    }
  }

  let spiesOnBoard = 0;
  for (const cols of Object.values(G.spies ?? {})) {
    if (cols?.includes(colour)) spiesOnBoard++;
  }

  // Footholds: marker sites I can reach into but do not yet hold, and the slots
  // standing empty at them. Killing a white at a site I am adjacent to converts
  // directly into markerSlotsOpen, so the intermediate step of a multi-turn
  // capture stops being invisible.
  let markerFootholds = 0, markerSlotsOpen = 0;
  for (const site of SITES) {
    if (!site.hasControlMarker) continue;
    if (!(site.id in (G.siteControl ?? {}))) continue;
    if (G.siteControl[site.id] === colour) continue;
    if (!hasPresence(G, colour, { site: site.id })) continue;
    markerFootholds++;
    for (const sp of sitesSpaces(site.id)) {
      if (!G.troops[sp.id]) markerSlotsOpen++;
    }
  }

  const cd = cyclingDeck(p);

  return [
    s.sites, s.totalControl, s.trophies, s.deckVp, s.innerCircleVp, s.vpTokens,
    troopsOnBoard, troopsAtMarkerSites, routeTroops,
    spiesOnBoard, p.spiesLeft ?? 0,
    markerFootholds, markerSlotsOpen,
    p.barracksLeft ?? 0,
    cd.n, cd.n > 0 ? cd.vp / cd.n : 0, p.innerCircle?.length ?? 0,
    p.influence ?? 0, p.power ?? 0,
  ];
}

/** The evaluator's actual input: my features minus the MEAN of my opponents'.
 *  Same framing as stateValue, so a model fitted on final margin is learning
 *  exactly the quantity the evaluator is asked to produce. */
export function differentialFeatures(G: TyrantsState, seat: string): EvalFeatures {
  const seats = Object.keys(G.players ?? {});
  const mine = featuresFor(G, seat);
  const others = seats.filter(s => s !== seat);
  if (others.length === 0) return mine;
  const acc = new Array<number>(mine.length).fill(0);
  for (const o of others) {
    const f = featuresFor(G, o);
    for (let i = 0; i < acc.length; i++) acc[i] += f[i];
  }
  return mine.map((v, i) => v - acc[i] / others.length);
}

/** A fitted linear evaluator, as written to weights/eval-fitted.json. */
export interface FittedEval {
  featureNames: readonly string[];
  /** Feature standardisation from the training set — applied before `weights`. */
  mean: number[];
  std: number[];
  weights: number[];
  intercept: number;
  /** Provenance, so a model can be traced to the run that produced it. */
  meta?: Record<string, unknown>;
}

export function applyFitted(model: FittedEval, f: EvalFeatures): number {
  let v = model.intercept;
  for (let i = 0; i < f.length; i++) {
    const sd = model.std[i] || 1;
    v += model.weights[i] * ((f[i] - model.mean[i]) / sd);
  }
  return v;
}
