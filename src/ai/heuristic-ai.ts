// Heuristic AI based on user strategy notes:
//   - Spend all influence on the highest-cost affordable card (smallest # of cards per turn).
//   - Devour/promote-out-of-cycle low-influence cards (Nobles) but keep cycling deck >= 5.
//   - Spread troops across sites; prefer control-marker sites.
//   - Assassinate enemy troops where possible (trophies = end-game VP).
//   - Grab site control whenever practical.

import type { TyrantsState, Color } from '../game';
import { BASE_ACTION_POWER_COST, MARKER_VALUES } from '../game';
import { SITES, SITES_BY_ID } from '../data/sites';
import { TROOP_SPACES, TROOP_SPACES_BY_ID, sitesSpaces } from '../data/troop-spaces';
import { ADJACENCY } from '../data/routes';
import { lookupCard } from '../card-data';
import { hasPresence } from '../engine/map-state';
import type { AiMove } from './random-ai';
import { DEFAULT_WEIGHTS, type HeuristicWeights } from './heuristic-weights';
import { takePhaseSnapshot, type PhaseSnapshot } from './game-phase';
import { lookaheadPick, setPositionalWeights, type SimulateMoveFn, type RolloutToTurnEndFn } from './lookahead';
import { categoryOfCard, categoryRank } from './card-classes';

// Module-level pointer to the currently active weights. Per-call entrypoints
// (decideHeuristicMove / decideHeuristicMoveWithWeights) swap this in for the
// duration of a single move decision. Module-global keeps the score-helper
// signatures un-noisy without threading weights through every callsite.
let WEIGHTS: HeuristicWeights = DEFAULT_WEIGHTS;

// Module-level pointer to the current move's phase snapshot. Set at the top
// of decideHeuristicMove so resolveChoice (and the scoring helpers) can
// read it without recomputing scoreAll on every call. Null when not in a
// move decision (or when called with no game state, e.g. unit tests).
let PHASE: PhaseSnapshot | null = null;

// Module-level pointer to the simulate function for 1-ply lookahead. Set
// by decideHeuristicMoveWithWeights / decideHeuristicMove when the caller
// provides one. Null when no simulator is available (e.g. the live web
// client) — the heuristic falls back to score-only ranking in that case.
let SIMULATE: SimulateMoveFn | null = null;

// Module-level pointer to the turn-end rollout function. When non-null,
// tactical-phase decision points use this for richer lookahead — apply
// move + rollout remaining actions of the turn with the heuristic + score
// at end-of-turn. Set null inside rollouts to prevent recursive blow-up.
let ROLLOUT: RolloutToTurnEndFn | null = null;

function cyclingDeckSize(G: TyrantsState, pid: string): number {
  const p = G.players[pid];
  return p.deck.length + p.hand.length + p.discard.length;
}

function cardCost(deck: string, slot: number): number {
  return lookupCard(deck, slot)?.cost ?? 0;
}

/** Lower = better candidate for removal from cycling deck (devour from hand, promote
 *  to Inner Circle). Starter cards (Noble, Soldier) are equally bad — both pump the
 *  ratio of "dead-weight" draws — so they share the lowest score. Among recruited
 *  cards, prefer to trash the cheapest (lowest-influence-payoff) ones.
 *
 *  Goal per user: raise the average influence of remaining cycling cards so future
 *  hands draw a smaller but more powerful set. */
function trashScore(deck: string, slot: number): number {
  // Insane Outcasts are pure deck poison (deckVp = -1, innerCircleVp = 0, no
  // effect, just clogs your draw). Score them WORSE than starters so they're
  // preferred for any devour/promote/discard prompt that asks "which card to
  // get rid of?". Promoting an Outcast self-ejects it back to the supply
  // (Mechanics.promote), so we strictly want to promote them when possible.
  if (deck === 'insane-outcasts') return -10;
  const isStarter = deck === 'starter-1';
  // Starters score 0; recruited cards score by their cost (higher cost = worse to trash).
  return isStarter ? 0 : WEIGHTS.trashRecruitedBase + cardCost(deck, slot);
}

/** VP value of promoting this card into the inner circle. Used in
 *  endgame-phase promote decisions where deck-thinning matters less
 *  than banking VP for end-of-game scoring. */
function innerCircleVpOf(deck: string, slot: number): number {
  return lookupCard(deck, slot)?.innerCircleVp ?? 0;
}

/** Phase-aware promote score: returns a number where HIGHER means "more
 *  desirable to promote." Early game we want to trash junk (so high score
 *  for low trash-score cards — i.e. the worst-to-keep, best-to-trash);
 *  endgame we want to bank VP (high score for high-innerCircleVp cards).
 *  The `endgamePromoteByVp` weight (0..1) blends the two strategies. */
function promoteScore(deck: string, slot: number): number {
  // Trash-mode: lower trashScore = better promote target. Invert by negating.
  const trashMode = -trashScore(deck, slot);
  // VP-mode: just the inner-circle VP directly.
  const vpMode = innerCircleVpOf(deck, slot);
  const inEndgame = PHASE?.phase === 'endgame';
  // In endgame, blend toward VP-mode by the weight. Outside endgame, always
  // trash-mode (the user's early-game rule: thin the deck).
  if (!inEndgame) return trashMode;
  const w = Math.max(0, Math.min(1, WEIGHTS.endgamePromoteByVp));
  // Rescale trashMode roughly into the same range as vpMode (which is 0..10)
  // so the blend isn't dominated by one mode's scale.
  return (1 - w) * (trashMode / 2) + w * vpMode;
}

function pickRandom<T>(arr: T[]): T | undefined {
  return arr.length ? arr[Math.floor(Math.random() * arr.length)] : undefined;
}

/** Troops you'd have to place to project presence from `from` into every other
 *  in-play site: one per troop space along each route, plus one to enter the
 *  site at the far end. Sites outside the current player count (absent from
 *  G.siteControl) are not traversable. Dijkstra over 26 nodes — cheap, and only
 *  called during setup. */
function deployDistances(G: TyrantsState, from: string): Record<string, number> {
  const dist: Record<string, number> = { [from]: 0 };
  // Small graph: a linear-scan frontier is faster than a heap here.
  const seen = new Set<string>();
  for (;;) {
    let cur: string | null = null;
    let best = Infinity;
    for (const [id, d] of Object.entries(dist)) {
      if (seen.has(id) || d >= best) continue;
      cur = id; best = d;
    }
    if (cur === null) break;
    seen.add(cur);
    for (const { other, route } of ADJACENCY[cur] ?? []) {
      if (!(other in G.siteControl)) continue;
      const next = best + route.spaces + 1;
      if (next < (dist[other] ?? Infinity)) dist[other] = next;
    }
  }
  return dist;
}

/** Payout of a control marker per troop it takes to hold outright. Whites count
 *  toward the cost because each one has to be supplanted before the slot is
 *  yours. Higher = a marker worth opening near. */
function markerWorth(siteId: string): number {
  const m = MARKER_VALUES[siteId];
  const site = SITES_BY_ID[siteId];
  if (!m || !site) return 0;
  const payout = m.controlInfluence + m.controlVp + m.totalControlInfluence + m.totalControlVp;
  const cost = site.troopSlots + site.whitesAtStart;
  return cost > 0 ? payout / cost : 0;
}

/** How well-placed a candidate starting site is for contesting the control
 *  markers that are actually on the board this game. Starting sites carry no
 *  marker themselves, so without this the opening was ranked on printed VP —
 *  which says nothing about where the game is won. */
function openingProximity(G: TyrantsState, siteId: string): number {
  const dist = deployDistances(G, siteId);
  let v = 0;
  for (const site of SITES) {
    if (!site.hasControlMarker || !(site.id in G.siteControl)) continue;
    const d = dist[site.id];
    if (d === undefined) continue;
    v += markerWorth(site.id) / (1 + d);
  }
  return v;
}

/** Score an empty troop space for deployment. Higher = better. */
function scoreDeploySpace(G: TyrantsState, pid: string, spaceId: string): number {
  const me = G.players[pid];
  const t = TROOP_SPACES_BY_ID[spaceId];
  if (!t) return -Infinity;
  let s = 0;
  if (t.parentSite) {
    s += WEIGHTS.deployBaseSite;
    const site = SITES_BY_ID[t.parentSite];
    if (site?.hasControlMarker) s += WEIGHTS.deployControlMarker;
    s += (site?.vp ?? 0) * WEIGHTS.deployVpMultiplier;
    // Spread: penalize sites where we already own multiple slots.
    let mine = 0, total = 0, enemy = 0;
    for (const sp of sitesSpaces(t.parentSite)) {
      total++;
      const occ = G.troops[sp.id];
      if (occ === me.color) mine++;
      else if (occ && occ !== 'white') enemy++;
    }
    s -= mine * WEIGHTS.deployOwnPenalty;
    // Bonus if this deploy could establish control (we'd tie or beat enemy lead).
    if (mine + 1 > Math.max(enemy, mine)) s += WEIGHTS.deployEstablishBonus;
    // Slightly prefer sites that aren't already full of our troops.
    if (mine === 0 && total > 0) s += WEIGHTS.deployFirstFootBonus;
  } else {
    // Route space: useful for reach, but lower priority.
    s += WEIGHTS.deployRouteSpace;
  }
  return s;
}

/** How much denial-value would a fresh spy at `siteId` add for `myColor`?
 *  Only meaningful at control-marker sites; returns 0 elsewhere.
 *
 *  Rules:
 *  - Marker site, currently controlled by an opponent, no opposing spy yet
 *    → high value (we deny total control AND tax their power to remove us).
 *  - Marker site already covered by an opposing spy → 0 (TC already denied,
 *    our second spy doesn't compound).
 *  - I already have a spy at this site → 0 (the engine rejects a duplicate
 *    placement and the resource is wasted).
 *  - Non-marker site → 0 (no TC to deny; the +1 site-control VP is a smaller
 *    concern and is handled by the base control-marker scoring).
 */
function siteDenialValue(G: TyrantsState, siteId: string, myColor: Color): number {
  const site = SITES_BY_ID[siteId];
  if (!site?.hasControlMarker) return 0;
  const spiesHere = G.spies[siteId] ?? [];
  if (spiesHere.includes(myColor)) return 0;
  // Any opposing-color spy already there? (Whites don't have spies; only
  // the four player colors do, so non-myColor entries are by definition
  // opposing players' spies.)
  if (spiesHere.some(c => c !== myColor)) return 0;
  const controller = G.siteControl[siteId];
  if (!controller || controller === myColor) return 0;
  return WEIGHTS.siteDenialBonus;
}

function scoreAssassinateSpace(G: TyrantsState, pid: string, spaceId: string): number {
  const me = G.players[pid];
  const occ = G.troops[spaceId];
  if (!occ || occ === me.color) return -Infinity;
  let s = occ === 'white' ? WEIGHTS.assassinateWhite : WEIGHTS.assassinateEnemy;
  const t = TROOP_SPACES_BY_ID[spaceId];
  const siteId = t?.parentSite;
  if (siteId) {
    const site = SITES_BY_ID[siteId];
    if (site?.hasControlMarker) s += WEIGHTS.assassinateControlMarker;
    s += (site?.vp ?? 0) * WEIGHTS.assassinateVpMultiplier;
  }
  return s;
}

function legalDeployTargets(G: TyrantsState, pid: string): string[] {
  const me = G.players[pid];
  const hasAnyMapPresence = SITES.some(s => hasPresence(G, me.color, { site: s.id }));
  const out: string[] = [];
  for (const t of TROOP_SPACES) {
    // Only active-section spaces are keys in G.troops; out-of-play spaces are
    // absent (undefined), so an `if (G.troops[t.id]) continue` occupancy check
    // alone would treat them as empty and offer them as deploy targets. Skip
    // anything not in play, then skip occupied active spaces.
    if (!(t.id in G.troops)) continue;
    if (G.troops[t.id]) continue;
    let ok = !hasAnyMapPresence;
    if (!ok) {
      ok = t.parentSite
        ? hasPresence(G, me.color, { site: t.parentSite })
        : hasPresence(G, me.color, { space: t.id });
    }
    if (ok) out.push(t.id);
  }
  return out;
}

/** Sample from `sorted` (best first) among the top-K entries, weighted by rank
 *  (N, N-1, …, 1) so the strongest stays most likely but the pick varies. With
 *  topK ≤ 1 it always returns the single best (deterministic — the old
 *  behaviour). Used to give the AI's opening starting-site some variety so it
 *  doesn't anchor the same spot every game — Drew W.'s feedback (#83). A top-4
 *  pool yields roughly 40/30/20/10%, matching his suggested distribution. */
function weightedRankPick<T>(sorted: T[], topK: number): T | undefined {
  if (sorted.length === 0) return undefined;
  const pool = sorted.slice(0, Math.max(1, Math.floor(topK || 1)));
  if (pool.length <= 1) return pool[0];
  const total = pool.reduce((s, _v, i) => s + (pool.length - i), 0);
  let r = Math.random() * total;
  for (let i = 0; i < pool.length; i++) {
    r -= pool.length - i;
    if (r < 0) return pool[i];
  }
  return pool[pool.length - 1];
}

function legalAssassinateTargets(G: TyrantsState, pid: string): string[] {
  const me = G.players[pid];
  const out: string[] = [];
  for (const t of TROOP_SPACES) {
    const occ = G.troops[t.id];
    if (!occ || occ === me.color) continue;
    const presence = t.parentSite
      ? hasPresence(G, me.color, { site: t.parentSite })
      : hasPresence(G, me.color, { space: t.id });
    if (presence) out.push(t.id);
  }
  return out;
}

function resolveChoice(G: TyrantsState, pid: string): AiMove {
  const pc = G.pendingChoice!;
  const me = G.players[pid];
  const opts = (pc.options ?? []) as unknown[];

  switch (pc.kind) {
    case 'select-card-in-hand': {
      // Two flavors of this prompt:
      //   (a) Devour-from-hand (Succubus / Marilith / etc.): permanently
      //       trashes a card from your cycling deck. Skip if optional and
      //       trashing would drop the cycling deck below threshold.
      //   (b) Insane Outcast's "discard to return the Outcast to supply":
      //       moves the card from hand to discard (NOT removed from cycling
      //       deck). The deck-floor guard doesn't apply — discarding doesn't
      //       shrink the deck. Always worth doing if any card is eligible
      //       (the Outcast itself is pure poison; even sacrificing a starter
      //       turn-resource is a good trade).
      const isOutcastDiscard = pc.cardKey?.startsWith('insane-outcasts::') ?? false;
      const idxs = (opts as number[]).length > 0
        ? (opts as number[])
        : me.hand.map((_, i) => i);
      if (idxs.length === 0) return { name: 'resolveChoice', args: [null] };
      if (pc.optional && !isOutcastDiscard && cyclingDeckSize(G, pid) - 1 < WEIGHTS.minCyclingDeck) {
        return { name: 'resolveChoice', args: [null] };
      }
      let bestIdx = idxs[0];
      let bestScore = Infinity;
      for (const i of idxs) {
        const c = me.hand[i];
        if (!c) continue;
        const score = trashScore(c.deck, c.slot);
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }
      return { name: 'resolveChoice', args: [bestIdx] };
    }
    case 'select-card-in-discard':
    case 'select-played-card': {
      // Promote into Inner Circle: REMOVES the card from your cycling deck and
      // banks its inner-circle VP for end-game. Early/mid game: strategic value
      // lies in deck-thinning weakest cards (Nobles / Soldiers / cheap recruits).
      // Endgame (per user strategy notes): no time left to benefit from a thinner
      // deck — promote the card with the highest inner-circle VP instead, which
      // banks the most score. promoteScore() blends these by phase.
      // Guard against shrinking cycling deck below threshold — but DISABLE the
      // guard in endgame: if the game is about to end you don't need to draw any
      // more cards, banking VP is strictly better.
      const idxs = opts as number[];
      if (idxs.length === 0) return { name: 'resolveChoice', args: [null] };
      const inEndgame = PHASE?.phase === 'endgame';
      if (pc.optional && !inEndgame && cyclingDeckSize(G, pid) - 1 < WEIGHTS.minCyclingDeck) {
        return { name: 'resolveChoice', args: [null] };
      }
      const pool = pc.kind === 'select-card-in-discard' ? me.discard : G.cardsPlayedThisTurn;
      let best = idxs[0], bestScore = -Infinity;
      for (const i of idxs) {
        const c = pool[i];
        if (!c) continue;
        // promoteScore: HIGHER = better promote target (opposite of trashScore).
        const score = promoteScore(c.deck, c.slot);
        if (score > bestScore) { bestScore = score; best = i; }
      }
      return { name: 'resolveChoice', args: [best] };
    }
    case 'select-card-in-inner-circle': {
      // Devour from inner circle: drop lowest-value card.
      const idxs = opts as number[];
      if (idxs.length === 0) return { name: 'resolveChoice', args: [null] };
      let worst = idxs[0], worstCost = Infinity;
      for (const i of idxs) {
        const c = me.innerCircle[i];
        if (!c) continue;
        const cost = cardCost(c.deck, c.slot);
        if (cost < worstCost) { worstCost = cost; worst = i; }
      }
      return { name: 'resolveChoice', args: [worst] };
    }
    case 'select-market-card': {
      const idxs = opts as number[];
      if (idxs.length === 0) return { name: 'resolveChoice', args: [null] };
      let best = idxs[0], bestCost = -1;
      for (const i of idxs) {
        const c = G.market.row[i];
        if (!c) continue;
        const cost = cardCost(c.deck, c.slot);
        if (cost > bestCost) { bestCost = cost; best = i; }
      }
      return { name: 'resolveChoice', args: [best] };
    }
    case 'select-troop-space': {
      const ids = opts as string[];
      if (ids.length === 0) return { name: 'resolveChoice', args: [pc.optional ? null : null] };
      // Split into enemy-occupied (assassinate / return-troop / supplant
      // targets) and empty (deploy targets). When a simulator is available,
      // use 1-ply lookahead — score each candidate by the state-value AFTER
      // the move resolves. This catches consequence-aware wins the per-
      // component scoring misses: assassinating an enemy that flips site
      // control, deploying the space that creates total control, supplant
      // chains that net us a trophy AND a marker, etc.
      const enemies = ids.filter(id => {
        const occ = G.troops[id];
        return occ && occ !== me.color;
      });
      if (enemies.length > 0) {
        // Prefer rollout-based lookahead (sees end-of-turn consequences)
        // over 1-ply (sees only the immediate post-move state). Fall back
        // to 1-ply when no rollout is available, then to pure heuristic.
        const lookaheadFn = ROLLOUT ?? SIMULATE;
        if (lookaheadFn) {
          const pick = lookaheadPick(
            enemies,
            id => ({ name: 'resolveChoice', args: [id] }),
            G, pid, lookaheadFn,
            id => scoreAssassinateSpace(G, pid, id),
          );
          return { name: 'resolveChoice', args: [pick] };
        }
        enemies.sort((a, b) => scoreAssassinateSpace(G, pid, b) - scoreAssassinateSpace(G, pid, a));
        return { name: 'resolveChoice', args: [enemies[0]] };
      }
      const empties = ids.filter(id => !G.troops[id]);
      if (empties.length > 0) {
        const lookaheadFn = ROLLOUT ?? SIMULATE;
        if (lookaheadFn) {
          const pick = lookaheadPick(
            empties,
            id => ({ name: 'resolveChoice', args: [id] }),
            G, pid, lookaheadFn,
            id => scoreDeploySpace(G, pid, id),
          );
          return { name: 'resolveChoice', args: [pick] };
        }
        empties.sort((a, b) => scoreDeploySpace(G, pid, b) - scoreDeploySpace(G, pid, a));
        return { name: 'resolveChoice', args: [empties[0]] };
      }
      return { name: 'resolveChoice', args: [ids[0]] };
    }
    case 'select-site': {
      const ids = opts as string[];
      if (ids.length === 0) return { name: 'resolveChoice', args: [pc.optional ? null : null] };
      // 1-ply lookahead beats the per-component scoring here too — it
      // automatically accounts for the consequences a spy placement
      // triggers (denying total control, drawing/grant chains on the
      // playing card, etc.). Fall through to heuristic-only ranking when
      // no simulator is available.
      const lookaheadFn = ROLLOUT ?? SIMULATE;
      if (lookaheadFn) {
        // Heuristic tiebreak for site picks: same components used by the
        // pure-heuristic fallback below (control-marker, VP, denial, own-spy
        // penalty) flattened to a single score.
        const heuScore = (id: string) => {
          const s = SITES_BY_ID[id];
          let v = (s?.hasControlMarker ? WEIGHTS.siteControlMarkerBonus : 0) + (s?.vp ?? 0);
          v += siteDenialValue(G, id, me.color);
          if ((G.spies[id] ?? []).includes(me.color)) v -= WEIGHTS.siteOwnSpyPenalty;
          return v;
        };
        const pick = lookaheadPick(ids, id => ({ name: 'resolveChoice', args: [id] }), G, pid, lookaheadFn, heuScore);
        return { name: 'resolveChoice', args: [pick] };
      }
      // Site-pick scoring components:
      //   - Base value: control-marker bonus + printed VP.
      //   - Denial bonus: at marker sites currently controlled by an opponent
      //     and not yet covered by an opposing spy. My spy there denies them
      //     total control AND forces them to spend power removing it.
      //   - Own-spy penalty: don't double-up where I already have a spy
      //     (no extra denial value, and the engine rejects double placement).
      // The same scoring applies to placement and return prompts. For a
      // return prompt every option has my color in spies, so the own-spy
      // penalty applies uniformly and the denial bonus is suppressed by
      // the "already have my spy here" gate inside siteDenialValue.
      const ranked = ids.slice().sort((a, b) => {
        const sa = SITES_BY_ID[a], sb = SITES_BY_ID[b];
        let av = (sa?.hasControlMarker ? WEIGHTS.siteControlMarkerBonus : 0) + (sa?.vp ?? 0);
        let bv = (sb?.hasControlMarker ? WEIGHTS.siteControlMarkerBonus : 0) + (sb?.vp ?? 0);
        av += siteDenialValue(G, a, me.color);
        bv += siteDenialValue(G, b, me.color);
        if ((G.spies[a] ?? []).includes(me.color)) av -= WEIGHTS.siteOwnSpyPenalty;
        if ((G.spies[b] ?? []).includes(me.color)) bv -= WEIGHTS.siteOwnSpyPenalty;
        return bv - av;
      });
      return { name: 'resolveChoice', args: [ranked[0]] };
    }
    case 'choose-one': {
      const arr = opts as string[];
      if (arr.length === 0) return { name: 'resolveChoice', args: [null] };
      // Per replay-divergence finding: the old "always pick option 0"
      // policy was the AI's single biggest leak. On chooseOne cards like
      // Information Broker, Enchanter of Thay, Watcher of Thay, Vrock,
      // Night Hag, etc., humans REPEATEDLY pick option 1 ("return spy →
      // +draws / +power / +supplant") when they have spies on the board,
      // converting presence into immediate resources that fuel multi-card
      // combos. The AI was leaving that value on the table every turn.
      //
      // Use lookahead (rollout preferred over 1-ply) to simulate each
      // option and pick the one whose resulting state (or end-of-turn
      // state) is best. Falls back to option 0 only when no simulator is
      // available (the live web client).
      const lookaheadFn = ROLLOUT ?? SIMULATE;
      if (lookaheadFn && arr.length > 1) {
        const candidates = arr.map((_, i) => i);
        const pick = lookaheadPick(
          candidates,
          i => ({ name: 'resolveChoice', args: [i] }),
          G, pid, lookaheadFn,
        );
        return { name: 'resolveChoice', args: [pick] };
      }
      return { name: 'resolveChoice', args: [0] };
    }
    case 'select-player': {
      const ids = opts as string[];
      // Pick the player with highest score (give them the outcast / steal from them).
      let best = ids[0] ?? null, bestScore = -Infinity;
      for (const id of ids) {
        const score = (G.players[id]?.vp ?? 0)
          + (G.players[id] ? Object.values(G.players[id].trophyHall).reduce((s, n) => s + n, 0) : 0);
        if (score > bestScore) { bestScore = score; best = id; }
      }
      return { name: 'resolveChoice', args: [best] };
    }
    default:
      return { name: 'resolveChoice', args: [opts[0] ?? null] };
  }
}

/** Decide a move with an explicit weights configuration. Swaps the module-
 *  level WEIGHTS and SIMULATE pointers for the duration of the call.
 *  Synchronous, so no reentrancy worries — one move per call. The
 *  `simulate` arg is optional: pass it to enable 1-ply lookahead, omit
 *  it to fall back to score-only ranking. */
export function decideHeuristicMoveWithWeights(
  G: TyrantsState,
  currentPlayer: string,
  weights: HeuristicWeights,
  simulate?: SimulateMoveFn,
  rollout?: RolloutToTurnEndFn,
): AiMove | null {
  const prevW = WEIGHTS;
  const prevS = SIMULATE;
  const prevR = ROLLOUT;
  WEIGHTS = weights;
  // The lookahead evaluator prices board presence that scoreAll can't see.
  // Zero weights restore pure-VP evaluation, so a weight file opts in.
  const prevP = setPositionalWeights(
    (weights.spyPresenceValue || weights.spyMarkerPresenceValue)
      ? { spy: weights.spyPresenceValue, spyAtMarker: weights.spyMarkerPresenceValue }
      : null);
  // Respect the weight-level toggle so a weight file can opt OUT of
  // lookahead even when the harness offers one — used by the validation
  // tournament to compare lookahead-on vs lookahead-off variants under
  // the same engine + same RNG.
  SIMULATE = (simulate && weights.useLookahead > 0) ? simulate : null;
  ROLLOUT = (rollout && weights.useLookahead > 0) ? rollout : null;
  try {
    return decideHeuristicMove(G, currentPlayer);
  } finally {
    WEIGHTS = prevW;
    SIMULATE = prevS;
    ROLLOUT = prevR;
    setPositionalWeights(prevP);
  }
}

export function decideHeuristicMove(G: TyrantsState, currentPlayer: string): AiMove | null {
  // Refresh the phase snapshot for this move. resolveChoice and the
  // promote-scoring helpers read this via the module-level PHASE pointer.
  // We skip the snapshot during setup (no scores yet) and pendingChoice
  // resolution (caller already entered the move; the prior snapshot from
  // the SAME move is what we want, but it was cleared — re-take it).
  if (!G.setupPhase) {
    PHASE = takePhaseSnapshot(
      G, currentPlayer,
      WEIGHTS.phaseLateBarracks,
      WEIGHTS.phaseEndgameBarracks,
    );
  } else {
    PHASE = null;
  }

  // 1. Resolve pending choice if it's ours.
  if (G.pendingChoice && G.pendingChoice.playerId === currentPlayer) {
    return resolveChoice(G, currentPlayer);
  }
  if (G.pendingChoice) return null;

  // 2. Setup phase.
  if (G.setupPhase) {
    const open = SITES.filter(s =>
      s.isStartingSite && s.id in G.siteControl &&
      sitesSpaces(s.id).some(sp => !G.troops[sp.id]) &&
      !sitesSpaces(s.id).some(sp => G.troops[sp.id] && G.troops[sp.id] !== 'white')
    );
    // Prefer a starting site with a control marker / highest VP, then sample
    // among the top few (weighted by rank) so the AI doesn't open at the same
    // site every game — keeps the strongest most likely but adds variety (#83).
    const proximity = WEIGHTS.openingMarkerProximity > 0
      ? new Map(open.map(s => [s.id, openingProximity(G, s.id)]))
      : null;
    const openingScore = (s: (typeof open)[number]) =>
      (s.hasControlMarker ? WEIGHTS.siteControlMarkerBonus : 0) + s.vp
      + (proximity ? WEIGHTS.openingMarkerProximity * proximity.get(s.id)! : 0);
    open.sort((a, b) => openingScore(b) - openingScore(a));
    const pick = weightedRankPick(open, WEIGHTS.openingVarianceTopK) ?? pickRandom(open);
    return pick ? { name: 'deployStartingTroop', args: [pick.id] } : null;
  }

  const me = G.players[currentPlayer];

  // 3a. Play all hand cards first (always strictly better than not playing).
  //
  // Card-pick within the hand follows the category-rank order from
  // src/ai/card-classes.ts:
  //   1. 'hand'       — devour-cost cards (Marilith, Succubus, etc.),
  //                     draw cards (Rather Modar), Insane Outcast. Play
  //                     while hand is full so their prompts have options.
  //   2. 'power' / 'other' — pure +power and meta effects. Stockpile
  //                          power, no in-turn ordering sensitivity.
  //   3. 'tactical'   — board-interactive (spies, supplant, deploy-via-
  //                     effect, etc.). The order-sensitive zone, but for
  //                     now resolved by category ALONE plus heuristic
  //                     ordering inside category. Future work: turn-end
  //                     rollout to search interactive-card orderings.
  //   4. 'influence'  — pure +influence. Lock in influence after tactical.
  //
  // Cards not in the table fall through to 'other' (mid-priority). Ties
  // within a rank: preserve hand-index order (stable sort) — gives a
  // deterministic, reproducible play sequence for the tournament harness.
  if (me.hand.length > 0) {
    if (WEIGHTS.useCardOrdering > 0) {
      const ranked = me.hand
        .map((c, i) => ({ i, rank: categoryRank(categoryOfCard(c)) }))
        .sort((a, b) => a.rank - b.rank || a.i - b.i);
      return { name: 'playCard', args: [ranked[0].i] };
    }
    // Legacy fallback: play hand[0], but still prefer an Insane Outcast
    // first when one is present alongside other cards (small fix that
    // predates the full category-ordering work).
    let pickIdx = 0;
    if (me.hand.length > 1) {
      const outcastIdx = me.hand.findIndex(c => c.deck === 'insane-outcasts');
      if (outcastIdx >= 0) pickIdx = outcastIdx;
    }
    return { name: 'playCard', args: [pickIdx] };
  }

  // 3b. Spend Power on board — phase-aware priority.
  //   Per user strategy notes:
  //   - When AHEAD in late/endgame: deploy aggressively to drain barracks
  //     and trigger game-end while leading. Assassinate still OK but deploy
  //     comes first if it would establish/extend a lead at a control site.
  //   - When BEHIND in late/endgame: prefer assassinate (trophies = VP that
  //     don't accelerate end). Suppress deploys when behind in endgame
  //     entirely if behindEndgameDeploySuppression > 0 — deploying just
  //     hastens our defeat.
  //   - Early/mid game: default behavior — assassinate at threshold, then
  //     deploy if power left.
  const isLateOrEnd = PHASE?.phase === 'late' || PHASE?.phase === 'endgame';
  const isEndgame = PHASE?.phase === 'endgame';
  const lead = PHASE?.lead ?? 0;
  const ahead = lead >= WEIGHTS.phaseLeadThreshold;
  const behind = lead <= -WEIGHTS.phaseLeadThreshold;

  // Clamp the tuneable threshold up to the engine's actual base-action cost.
  // The weights file can raise this (be MORE reluctant to assassinate) but
  // never lower it past what the engine will accept — otherwise the AI
  // proposes an unaffordable move, the reducer returns INVALID_MOVE, and
  // the tournament harness burns the turn via fallback endTurn.
  const assassinateThreshold = Math.max(WEIGHTS.powerThresholdForAssassinate, BASE_ACTION_POWER_COST);

  // Decide ordering of (assassinate, deploy):
  //   - ahead+late → deploy first (accelerate end)
  //   - behind+late → assassinate first (farm trophies, avoid hastening end)
  //   - otherwise   → assassinate first (current default)
  const deployFirst = ahead && isLateOrEnd;

  const tryAssassinate = (): AiMove | null => {
    if (me.power < assassinateThreshold) return null;
    const targets = legalAssassinateTargets(G, currentPlayer);
    if (targets.length === 0) return null;
    const lookaheadFn = ROLLOUT ?? SIMULATE;
    if (lookaheadFn) {
      const pick = lookaheadPick(
        targets,
        id => ({ name: 'assassinateTroop', args: [id] }),
        G, currentPlayer, lookaheadFn,
        id => scoreAssassinateSpace(G, currentPlayer, id),
      );
      return { name: 'assassinateTroop', args: [pick] };
    }
    // Heuristic fallback when no simulator (live web client). Multipliers
    // like behindAssassinateMultiplier are kept live for tuneability —
    // they don't currently affect ARGMAX (single-action choice) but will
    // matter when we extend to ranking across action types.
    targets.sort((a, b) => scoreAssassinateSpace(G, currentPlayer, b) - scoreAssassinateSpace(G, currentPlayer, a));
    return { name: 'assassinateTroop', args: [targets[0]] };
  };

  const tryDeploy = (): AiMove | null => {
    if (me.power < 1) return null;
    // Suppress deploys when behind in endgame — deploying drains the
    // common barracks pool that triggers game end, and we don't want to
    // end the game while losing.
    if (behind && isEndgame && WEIGHTS.behindEndgameDeploySuppression > 0) return null;
    const targets = legalDeployTargets(G, currentPlayer);
    if (targets.length === 0) return null;
    const lookaheadFn = ROLLOUT ?? SIMULATE;
    if (lookaheadFn) {
      const pick = lookaheadPick(
        targets,
        id => ({ name: 'deployTroop', args: [id] }),
        G, currentPlayer, lookaheadFn,
        id => scoreDeploySpace(G, currentPlayer, id),
      );
      return { name: 'deployTroop', args: [pick] };
    }
    targets.sort((a, b) => scoreDeploySpace(G, currentPlayer, b) - scoreDeploySpace(G, currentPlayer, a));
    // The aheadDeployUrgencyMultiplier is kept live for tuneability but
    // doesn't currently affect ARGMAX (single-action choice). It will
    // matter when we extend to ranking across action types.
    void WEIGHTS.aheadDeployUrgencyMultiplier;
    void WEIGHTS.behindAssassinateMultiplier;
    return { name: 'deployTroop', args: [targets[0]] };
  };

  if (deployFirst) {
    const m = tryDeploy() ?? tryAssassinate();
    if (m) return m;
  } else {
    const m = tryAssassinate() ?? tryDeploy();
    if (m) return m;
  }

  // 3c. Recruit — pick the highest-scoring affordable purchase across the
  // market row AND the permanent aux stacks (Priestess of Lolth, House
  // Guard). The aux stacks were previously ignored entirely, which left
  // the AI ending turns with 2-3 unspent influence whenever the market
  // had nothing cheap. Per competitive-play notes, Priestess at 2 inf
  // is a strong buy and worth recruiting repeatedly.
  type Cand =
    | { kind: 'market'; idx: number; cost: number; icVp: number; deckVp: number; isAux: false; tactical: boolean }
    | { kind: 'aux'; stack: 'houseGuards' | 'priestesses'; cost: number; icVp: number; deckVp: number; isAux: true; tactical: false };
  const candidates: Cand[] = [];

  for (let i = 0; i < G.market.row.length; i++) {
    const c = G.market.row[i];
    if (!c) continue;
    const data = lookupCard(c.deck, c.slot);
    if (!data || data.cost > me.influence) continue;
    candidates.push({
      kind: 'market', idx: i, cost: data.cost,
      icVp: data.innerCircleVp ?? 0, deckVp: data.deckVp ?? 0, isAux: false,
      // 'tactical' = effect touches the board (spy / assassinate / supplant /
      // promote). Aux stacks (Priestess=influence, House Guard=power) never are.
      tactical: categoryOfCard(c) === 'tactical',
    });
  }
  // Aux stacks: lookup once, push if affordable + stack non-empty.
  const auxRefs = [
    { stack: 'priestesses' as const, ref: lookupCard('priestesses', 43) },
    { stack: 'houseGuards' as const, ref: lookupCard('house-guards', 40) },
  ];
  for (const { stack, ref } of auxRefs) {
    if (!ref) continue;
    if ((G.auxStacks[stack] ?? 0) <= 0) continue;
    if (ref.cost > me.influence) continue;
    candidates.push({
      kind: 'aux', stack, cost: ref.cost,
      icVp: ref.innerCircleVp ?? 0, deckVp: ref.deckVp ?? 0, isAux: true, tactical: false,
    });
  }

  if (candidates.length > 0) {
    const scoreOf = (c: Cand) => {
      const raw =
        WEIGHTS.recruitIcVpWeight * c.icVp +
        WEIGHTS.recruitDeckVpWeight * c.deckVp +
        WEIGHTS.recruitCostWeight * c.cost +
        (c.isAux ? WEIGHTS.recruitAuxStackBonus : 0) +
        (c.tactical ? WEIGHTS.recruitTacticalBonus : 0);
      // Blend raw value vs per-influence efficiency. Per-inf favors low-cost
      // high-IC-VP cards (Priestess). Blend factor 0..1: 0=raw only, 1=per-inf only.
      const blend = Math.max(0, Math.min(1, WEIGHTS.recruitPerInfluenceBlend));
      const perInf = raw / Math.max(1, c.cost);
      return (1 - blend) * raw + blend * perInf * c.cost; // perInf*cost keeps scale comparable
    };
    candidates.sort((a, b) => scoreOf(b) - scoreOf(a));
    const best = candidates[0];
    if (best.kind === 'market') {
      return { name: 'recruitFromMarket', args: [best.idx] };
    }
    return { name: 'recruitFromAuxStack', args: [best.stack] };
  }

  // 3d. End turn.
  return { name: 'endTurn', args: [] };
}
