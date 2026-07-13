// Map state mutations and presence/control helpers.
//
// Kept separate from Mechanics.ts because the volume of board logic warrants its own module.
// Every mutation that affects troop occupancy or spies recomputes site control for
// affected sites inside the same call — callers should NOT touch G.troops / G.spies directly.

import type { TyrantsState, Color } from '../game';
import { logEvent } from './log';
import { ROUTES, ADJACENCY } from '../data/routes';
import { TROOP_SPACES_BY_ID, sitesSpaces, routeSpaces } from '../data/troop-spaces';
import { SITES_BY_ID } from '../data/sites';
import SLOT_POSITIONS from '../../assets/slot-positions-auto.json';

/** Per-route geometric mapping of the two endmost slot indices (0 and N-1) to the
 *  physical endpoint site each one is closer to. Computed once from calibrated
 *  slot positions vs site positions, because the (a, b) ordering in routes.ts
 *  is arbitrary — slot 0 isn't guaranteed to be near `r.a`. Used by
 *  hasPresenceAtRouteSpace so endmost-slot presence checks the right endpoint
 *  regardless of how the route was authored. Falls back to (slot0→a, slotN→b)
 *  for routes whose slot positions aren't calibrated. */
const ROUTE_ENDMOST_ENDPOINTS: Record<string, { first: SiteId; last: SiteId }> = (() => {
  const out: Record<string, { first: SiteId; last: SiteId }> = {};
  const slots = SLOT_POSITIONS as Record<string, { x: number; y: number }>;
  for (const r of ROUTES) {
    const lastIdx = r.spaces - 1;
    if (r.spaces === 0) continue;
    const slot0 = slots[`${r.id}:0`];
    const slotN = slots[`${r.id}:${lastIdx}`];
    const a = SITES_BY_ID[r.a], b = SITES_BY_ID[r.b];
    if (!slot0 || !slotN || !a || !b) {
      // No calibration → trust authored direction.
      out[r.id] = { first: r.a, last: r.b };
      continue;
    }
    const dist = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    // Pick whichever endpoint is nearer to slot 0; the other endpoint owns slot N-1.
    const firstIsA = dist(slot0, a) + dist(slotN, b) <= dist(slot0, b) + dist(slotN, a);
    out[r.id] = firstIsA ? { first: r.a, last: r.b } : { first: r.b, last: r.a };
  }
  return out;
})();

export type TroopOwner = Color | 'white';
export type TroopSpaceId = string;
export type SiteId = string;

/** Return the site that a space belongs to (directly for site-spaces, both endpoints for route-spaces). */
export function siteOf(spaceId: TroopSpaceId): SiteId | null {
  const s = TROOP_SPACES_BY_ID[spaceId];
  return s?.parentSite ?? null;
}

export function adjacentSitesOfSpace(spaceId: TroopSpaceId): SiteId[] {
  const s = TROOP_SPACES_BY_ID[spaceId];
  if (!s) return [];
  if (s.parentSite) return [s.parentSite];
  if (s.parentRoute) {
    const r = ROUTES.find(rr => rr.id === s.parentRoute);
    return r ? [r.a, r.b] : [];
  }
  return [];
}

/** True if the player has a troop in any of this site's own slots. (No spy/no adjacency.) */
function hasTroopAtSite(G: TyrantsState, color: Color, siteId: SiteId): boolean {
  for (const sp of sitesSpaces(siteId)) {
    if (G.troops[sp.id] === color) return true;
  }
  return false;
}

/** Compute whether `color` has presence at the given site (rulebook p.10). */
export function hasPresenceAtSite(G: TyrantsState, color: Color, siteId: SiteId): boolean {
  // (a) Spy at the site
  if ((G.spies[siteId] ?? []).includes(color)) return true;
  // (b) Troop in a site space
  if (hasTroopAtSite(G, color, siteId)) return true;
  // (c) Either a troop in the route-space *adjacent to* the site (endmost of the
  // touching route — not mid-route), OR — for routes with zero spaces (sites that
  // touch each other directly) — a troop at the other endpoint site.
  for (const adj of ADJACENCY[siteId] ?? []) {
    const r = adj.route;
    const sp = routeSpaces(r.id);
    if (sp.length === 0) {
      // Direct adjacency: troop at the neighboring site grants presence here.
      if (hasTroopAtSite(G, color, adj.other)) return true;
      continue;
    }
    // Use geometric endpoint mapping (slot 0 might be near r.b rather than r.a,
    // depending on how the route was authored). Same fix as the endmost branch
    // of hasPresenceAtRouteSpace.
    const endpoints = ROUTE_ENDMOST_ENDPOINTS[r.id] ?? { first: r.a, last: r.b };
    const adjacentIdx = endpoints.first === siteId ? 0 : sp.length - 1;
    if (G.troops[sp[adjacentIdx].id] === color) return true;
  }
  return false;
}

/** Compute whether `color` has presence at the given route-space (rulebook p.10).
 *
 *  Strict rule: a route-space is presence-on if you have a TROOP on an adjacent
 *  space — either an adjacent route-space, or an adjacent endpoint site (only for
 *  the endmost route-spaces). Spies do NOT grant route-space presence, and site
 *  presence inherited through adjacency does NOT propagate further across routes. */
export function hasPresenceAtRouteSpace(G: TyrantsState, color: Color, spaceId: TroopSpaceId): boolean {
  const s = TROOP_SPACES_BY_ID[spaceId];
  if (!s || !s.parentRoute) return false;
  const r = ROUTES.find(rr => rr.id === s.parentRoute);
  if (!r) return false;
  const routeSp = routeSpaces(r.id);
  const idx = s.index;
  // (a) Endmost: requires troop *at* the physically-adjacent endpoint site
  // (not just presence). The (a, b) ordering in routes.ts is arbitrary, so we
  // look up which endpoint each end-slot is geometrically closer to via
  // ROUTE_ENDMOST_ENDPOINTS (computed from calibrated slot positions). Without
  // this indirection, routes authored with the "wrong" a/b order silently
  // rejected legitimate deploys at one end.
  const endpoints = ROUTE_ENDMOST_ENDPOINTS[r.id] ?? { first: r.a, last: r.b };
  if (idx === 0 && hasTroopAtSite(G, color, endpoints.first)) return true;
  if (idx === routeSp.length - 1 && hasTroopAtSite(G, color, endpoints.last)) return true;
  // (b) Troop on the adjacent space along the same route.
  const a = routeSp[idx - 1];
  const b = routeSp[idx + 1];
  if (a && G.troops[a.id] === color) return true;
  if (b && G.troops[b.id] === color) return true;
  return false;
}

/** General predicate combining the two above. */
export function hasPresence(G: TyrantsState, color: Color, target: { site?: SiteId; space?: TroopSpaceId }): boolean {
  if (target.site) return hasPresenceAtSite(G, color, target.site);
  if (target.space) {
    const s = TROOP_SPACES_BY_ID[target.space];
    if (!s) return false;
    if (s.parentSite) return hasPresenceAtSite(G, color, s.parentSite);
    return hasPresenceAtRouteSpace(G, color, target.space);
  }
  return false;
}

/** Recompute the controller of one or more sites and update G.siteControl
 *  atomically. Per rulebook p.11: a player controls a site only if they have
 *  strictly MORE troops there than each other faction — including the white
 *  (unaligned) troops still on the site. White tokens count toward the
 *  comparison but cannot themselves "control" anything (a white majority
 *  just means nobody controls). */
export function recomputeSiteControl(G: TyrantsState, siteIds: SiteId[]) {
  for (const siteId of siteIds) {
    // Tally every owner (including 'white') so the white pile competes.
    const counts: Partial<Record<TroopOwner, number>> = {};
    for (const sp of sitesSpaces(siteId)) {
      const t = G.troops[sp.id];
      if (t) counts[t] = (counts[t] || 0) + 1;
    }
    // Strict-majority leader: must exceed every other entry, white included.
    let leader: TroopOwner | null = null;
    let leaderCount = 0;
    let tied = false;
    for (const [owner, c] of Object.entries(counts) as [TroopOwner, number][]) {
      if (c > leaderCount) { leader = owner; leaderCount = c; tied = false; }
      else if (c === leaderCount) { tied = true; }
    }
    // Whites can win the count but cannot be a "controller". If white is the
    // strict leader, or anyone ties (including with whites), nobody controls.
    const newController: Color | null = tied || leaderCount === 0 || leader === 'white'
      ? null
      : (leader as Color);
    G.siteControl[siteId] = newController;

    // Site-control marker bookkeeping per the revised rulebook:
    //   "When you take control of a site that has a control marker, take
    //    that marker from the game map or from the site's previous
    //    controller and place it in front of you. If control of the site
    //    becomes tied, return that site's control marker to the game map."
    // Transfer the chit immediately on every control change. If we now
    // have no controller, the chit returns to the map (holder = null).
    const m = G.controlMarkers[siteId];
    if (m && m.holder !== newController) {
      const previous = m.holder;
      m.holder = newController;
      if (newController) {
        logEvent(G, `${m.siteId} control marker → ${newController}${previous ? ` (from ${previous})` : ' (from map)'}`,
          { kind: 'site.control', payload: { site: m.siteId, controller: newController, previous: previous ?? null }, side: null });
      } else if (previous) {
        logEvent(G, `${m.siteId} control marker → returned to map (no controller)`,
          { kind: 'site.control', payload: { site: m.siteId, controller: null, previous }, side: null });
      }
    }

    // Pay the marker's once-per-turn effect immediately on transfer, so the
    // active player gets the bonus the moment they take the marker (rulebook
    // "...starting immediately on the turn you take the marker"). Held-from-
    // a-previous-turn markers are paid at turn.onBegin; the same ledger
    // (markerInfluenceGrantedThisTurn) guards against double-paying when a
    // player flips control on/off mid-turn.
    if (m && newController === G.activeTurnColor && newController != null) {
      payMarkerEffect(G, m, newController);
    }
  }
}

/** Apply one control-marker's per-turn effect to `color`'s player. Pays the
 *  CONTROL bonus at most once per turn, and the TC delta at most once per
 *  turn — so a player who gains control mid-turn and later upgrades to TC
 *  gets BOTH bonuses across the same turn (the TC payment pays only the
 *  difference). Without the TC ledger, the upgrade was silently skipped —
 *  the "I had TC at end of turn but got no VP" bug.
 *
 *  Per user spec: "award the VP as soon as you have total control, or at
 *  the beginning of your turn if you start with it (same as it does for
 *  influence). Same as influence, you only get it once per turn, you
 *  can't farm VP by losing and gaining total control." */
function payMarkerEffect(G: TyrantsState, m: { siteId: string; controlInfluence: number; controlVp: number; totalControlInfluence: number; totalControlVp: number }, color: Color): void {
  if (!G.markerTcGrantedThisTurn) G.markerTcGrantedThisTurn = []; // legacy-save backfill
  const tc = hasTotalControl(G, color, m.siteId);
  const controlPaid = G.markerInfluenceGrantedThisTurn.includes(m.siteId);
  const tcPaid = G.markerTcGrantedThisTurn.includes(m.siteId);
  // Decide what owed delta to pay:
  //   - At TC and TC not yet paid: total owed = TC bonus. Already paid =
  //     control bonus if control was paid earlier. Pay the delta.
  //   - At control and neither paid: pay control bonus.
  //   - Otherwise: nothing left to pay this turn.
  let inf = 0, vp = 0;
  let upgrade = false;
  if (tc && !tcPaid) {
    inf = m.totalControlInfluence - (controlPaid ? m.controlInfluence : 0);
    vp = m.totalControlVp - (controlPaid ? m.controlVp : 0);
    upgrade = controlPaid;
  } else if (!tc && !controlPaid) {
    inf = m.controlInfluence;
    vp = m.controlVp;
  } else {
    return;
  }
  const pid = Object.keys(G.players).find(k => G.players[k].color === color);
  if (!pid) return;
  const p = G.players[pid];
  if (inf > 0) p.influence += inf;
  if (vp > 0) p.vp += vp;
  if (!controlPaid) G.markerInfluenceGrantedThisTurn.push(m.siteId);
  if (tc) G.markerTcGrantedThisTurn.push(m.siteId);
  // Suppress no-op log lines (delta might be 0/0 if the marker has no
  // additional TC reward beyond its control reward — Phaerlin, etc.).
  if (inf === 0 && vp === 0) return;
  const parts: string[] = [];
  if (inf > 0) parts.push(`+${inf} influence`);
  if (vp > 0) parts.push(`+${vp} VP`);
  const suffix = upgrade
    ? ' (upgrade to TOTAL CONTROL)'
    : (tc ? ' (TOTAL CONTROL)' : '');
  logEvent(G, `P${Number(pid) + 1} ${parts.join(', ')} from ${m.siteId} control marker${suffix}`,
    { kind: 'marker.reward', payload: { site: m.siteId, influence: inf, vp, totalControl: tc }, side: pid });
}

/** Used by turn.onBegin to pay markers the active player already held from a
 *  previous turn. Re-exported so game.ts can drive the start-of-turn payout
 *  without duplicating the once-per-turn ledger logic. */
export function payHeldMarkerEffectsAtTurnStart(G: TyrantsState, color: Color): void {
  for (const m of Object.values(G.controlMarkers)) {
    if (m.holder === color) payMarkerEffect(G, m, color);
  }
}

/** True if all of a site's spaces are occupied by `color` and no enemy spies are present (rulebook p.11). */
export function hasTotalControl(G: TyrantsState, color: Color, siteId: SiteId): boolean {
  for (const sp of sitesSpaces(siteId)) {
    if (G.troops[sp.id] !== color) return false;
  }
  for (const spy of G.spies[siteId] ?? []) {
    if (spy !== color) return false;
  }
  return true;
}

// --- Mutations (route through these — never touch G.troops / G.spies directly) ---

export function deployTroop(G: TyrantsState, color: Color, spaceId: TroopSpaceId): boolean {
  // Only spaces in active board sections are keys in G.troops (2P = center,
  // 3P = center + one outer, 4P = all three). Spaces in out-of-play sections —
  // and the routes that connect an active site to an inactive one — are absent
  // entirely. Reject those here so no deploy path (base action, card effect, or
  // AI) can ever leak a troop into an out-of-play zone, which previously added a
  // brand-new key and quietly extended the live board into the unused sections.
  if (!(spaceId in G.troops)) return false;
  if (G.troops[spaceId]) return false;
  G.troops[spaceId] = color;
  // Stash for any chained handlers that care about the deploy location.
  // `_lastDeploySpace` is the most recent deploy; `_recentDeploySpaces` accumulates
  // every deploy made during the current card's resolution (reset in game.ts on
  // each fresh playCard). Used by Gibbering Mouther's "outcast to player adjacent
  // to at least 1 deployed troop."
  const Gx = G as unknown as { _lastDeploySpace?: string; _recentDeploySpaces?: string[] };
  Gx._lastDeploySpace = spaceId;
  (Gx._recentDeploySpaces ??= []).push(spaceId);
  const sid = siteOf(spaceId);
  if (sid) recomputeSiteControl(G, [sid]);
  return true;
}

export function assassinateTroop(G: TyrantsState, spaceId: TroopSpaceId): TroopOwner | null {
  const t = G.troops[spaceId];
  if (!t) return null;
  G.troops[spaceId] = null;
  const sid = siteOf(spaceId);
  if (sid) recomputeSiteControl(G, [sid]);
  return t;
}

export function moveTroop(G: TyrantsState, from: TroopSpaceId, to: TroopSpaceId): boolean {
  // Used by card effects that move troops (including white troops or enemy troops).
  // For base-action "move a troop" (your own only), callers should filter beforehand.
  const t = G.troops[from];
  if (!t) return false;
  if (G.troops[to]) return false;
  G.troops[from] = null;
  G.troops[to] = t;
  const affected = new Set<string>();
  const a = siteOf(from), b = siteOf(to);
  if (a) affected.add(a);
  if (b) affected.add(b);
  if (affected.size) recomputeSiteControl(G, [...affected]);
  return true;
}

export function placeSpy(G: TyrantsState, color: Color, siteId: SiteId): boolean {
  const arr = (G.spies[siteId] ??= []);
  if (arr.includes(color)) return false;
  arr.push(color);
  recomputeSiteControl(G, [siteId]); // affects total-control only, but cheap
  return true;
}

export function returnSpy(G: TyrantsState, color: Color, siteId: SiteId): boolean {
  const arr = G.spies[siteId] ?? [];
  const idx = arr.indexOf(color);
  if (idx < 0) return false;
  arr.splice(idx, 1);
  recomputeSiteControl(G, [siteId]);
  return true;
}

// ---------- Token conservation invariant ----------
//
// Each player starts with 40 tokens of their color (rulebook p.2). White tokens
// start at a fixed count (sum of `startsWithWhite` slots). Tokens move between
// three locations:
//   - a player's barracks (`barracksLeft`),
//   - the board (`G.troops[spaceId]`),
//   - someone's trophy hall (`G.players[*].trophyHall[color]`).
// At every moment, the total per color must equal the starting count. Violations
// reveal bookkeeping bugs (e.g. assassinate that didn't credit a trophy, or
// supplant that didn't decrement barracks). We surface them in the live log so
// they show up immediately instead of festering until end-of-game scoring is off.

import { TROOP_SPACES as ALL_TROOP_SPACES } from '../data/troop-spaces';
const STARTING_BARRACKS_PER_PLAYER = 40;
// Expected white-troop total depends on which board sections are actually in
// play (2P = center only, 3P = center + one outer, 4P = all three). Spaces in
// inactive sections are absent from G.troops entirely, so we scope the count
// to keys present in G.troops at check time. Pre-2026-05 this used a global
// constant across all sections, which fired a perpetual white-conservation
// violation in every 2P/3P game.
function expectedWhiteTotal(G: TyrantsState): number {
  let n = 0;
  for (const ts of ALL_TROOP_SPACES) if (ts.startsWithWhite && ts.id in G.troops) n++;
  return n;
}

export interface TokenConservationViolation {
  color: string;
  expected: number;
  actual: number;
  delta: number;
  breakdown: { onBoard: number; trophies: Record<string, number>; barracks: Record<string, number> };
}

export function checkTokenConservation(G: TyrantsState): TokenConservationViolation[] {
  const out: TokenConservationViolation[] = [];
  const playerColors = Object.values(G.players).map(p => p.color);
  const colors: (Color | 'white')[] = [...playerColors, 'white'];

  for (const color of colors) {
    let onBoard = 0;
    for (const v of Object.values(G.troops)) if (v === color) onBoard++;
    const trophies: Record<string, number> = {};
    for (const [pid, p] of Object.entries(G.players)) {
      const t = p.trophyHall[color] ?? 0;
      if (t > 0) trophies[`P${Number(pid) + 1}`] = t;
    }
    const trophiesSum = Object.values(trophies).reduce((s, n) => s + n, 0);
    const barracks: Record<string, number> = {};
    if (color !== 'white') {
      const owner = Object.entries(G.players).find(([, p]) => p.color === color);
      if (owner) barracks[`P${Number(owner[0]) + 1}`] = owner[1].barracksLeft;
    }
    const barracksSum = Object.values(barracks).reduce((s, n) => s + n, 0);

    const expected = color === 'white' ? expectedWhiteTotal(G) : STARTING_BARRACKS_PER_PLAYER;
    const actual = onBoard + trophiesSum + barracksSum;
    if (actual !== expected) {
      out.push({
        color, expected, actual, delta: actual - expected,
        breakdown: { onBoard, trophies, barracks },
      });
    }
  }
  return out;
}

export function returnTroop(G: TyrantsState, spaceId: TroopSpaceId): TroopOwner | null {
  // For player troops, the caller is expected to update barracks counts separately
  // (we don't track barracks/supply piece counts yet).
  const t = G.troops[spaceId];
  if (!t || t === 'white') return null;
  G.troops[spaceId] = null;
  const sid = siteOf(spaceId);
  if (sid) recomputeSiteControl(G, [sid]);
  return t;
}
