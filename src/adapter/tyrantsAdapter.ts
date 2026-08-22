// GameAdapter for Tyrants of the Underdark — Option A: WRAP boardgame.io's reducer.
//
// The framework `State` here is boardgame.io's FULL serializable client state
// object: `{ G, ctx, plugins, _undo, _redo, _stateID }`. Keeping the whole bgio
// state (not just G) keeps the `random` plugin's seed+prngstate inside the
// snapshot, so RNG/shuffles replay deterministically with zero changes to any
// shuffle call site. This was verified to round-trip cleanly through jsonCodec
// (ctx + plugins + random seed all survive) in scripts/roundtrip-check.ts.
//
// applyAction / tryApplyAction run bgio's OWN reducer (built the same way
// App.tsx:532-533 builds it for AI lookahead) against a structuredClone of the
// full state, so the mutate-in-place moves + turn machine + random plugin all
// run exactly as in live play. We never hand-roll the turn advance — bgio does.
//
// This file is ADDITIVE. It does not modify the engine, game.ts moves, the UI,
// or the hotseat client.

import type { GameAdapter, GameResult } from 'digital-boardgame-framework';
import { upgradeProseLog } from 'digital-boardgame-framework';
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import { TyrantsGame, type TyrantsState, type Color, type CardRef } from '../game';
import { SITES } from '../data/sites';
import { TROOP_SPACES, sitesSpaces } from '../data/troop-spaces';
import { lookupCard } from '../card-data';
import { hasPresence } from '../engine/map-state';
import { scoreAll } from '../engine/scoring';
import { BASE_ACTION_POWER_COST } from '../game';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The seat-index string '0'..'3'. Matches Object.keys(G.players). */
export type PlayerId = string;

/** The action vocabulary = the bgio moves we expose online. `undo` and
 *  `loadState` are deliberately excluded (local-only / dev rewind). */
export type TyrantsAction =
  | { kind: 'deployStartingTroop'; siteId: string }
  | { kind: 'playCard'; handIndex: number }
  | { kind: 'recruitFromMarket'; marketIndex: number }
  | { kind: 'recruitFromAuxStack'; stack: 'houseGuards' | 'priestesses' }
  | { kind: 'deployTroop'; spaceId: string }
  | { kind: 'assassinateTroop'; spaceId: string }
  | { kind: 'returnEnemySpy'; siteId: string; targetColor: Color }
  | { kind: 'resolveChoice'; response: unknown }
  | { kind: 'endTurn' }
  // Server-side only (the abandoned-seat sweep). Never returned by
  // legalActions, so no client can reach it; the server validates via
  // tryApplyAction, which accepts it.
  | { kind: 'forfeitSeat'; seat: PlayerId };

/** boardgame.io's full client/transport state. We treat it as opaque-ish: the
 *  adapter only reaches into `.G` and `.ctx`; `plugins` etc. ride along. */
export interface BgioState {
  G: TyrantsState;
  ctx: {
    currentPlayer: string;
    numPlayers: number;
    turn: number;
    playOrderPos: number;
    gameover?: unknown;
    [k: string]: unknown;
  };
  plugins?: unknown;
  _undo?: unknown;
  _redo?: unknown;
  _stateID?: number;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// bgio reducer (built once, like App.tsx:532-533)
// ---------------------------------------------------------------------------
//
// The reducer is pure given (state, action): it clones internally and applies
// the move + turn machine + random plugin. We build it from the same Game def
// the live client uses. halfDecks/activeSections live in G already once setup
// has run, so the reducer doesn't need setupData — it never re-runs setup.

type AnyReducer = (s: BgioState, action: unknown) => BgioState;

// ONLINE ONLY: turn off boardgame.io's built-in undo bookkeeping.
//
// bgio stores a FULL copy of `G` (plus ctx + plugins) in `state._undo` on every
// dispatched move, and only clears it at a turn boundary. On a Tyrants turn
// that's ~10 moves × ~95 KB, so the state the server clones and re-clones grows
// from ~0.3 MB to ~1.3 MB *within a single turn*, and every later move in that
// turn pays to copy all of it. That cost compounds as a game gets longer; when a
// server-side AI turn stops fitting in the request budget, nothing persists and
// the seat is stranded — the human sees a board with no buttons (#104).
//
// Nothing online can undo: `undo`/`redo` are excluded from the action vocabulary
// (see TyrantsAction), OnlinePlay stubs the bgio undo/redo props, and the game's
// OWN rewind (`G.undoStack` + the `undo` move) is a hotseat-only affordance that
// this flag does not touch. Hotseat builds its own bgio Client from TyrantsGame
// and is unaffected — we spread into a copy so TyrantsGame itself is untouched.
// Stamp G._online so the engine can tell it is being driven online. The only
// thing that reads it today is pushUndoSnapshot, which skips capturing undo
// restore-points: they are a hotseat affordance that redactState strips from
// every online view and OnlinePlay stubs out, so building them server-side was
// ~22KB of dead weight per move (#104 follow-up).
function markOnline<T>(G: T): T {
  (G as { _online?: boolean })._online = true;
  return G;
}
const onlineSetup = (
  setupData?: { halfDecks?: string[]; activeSections?: Array<"left" | "center" | "right">; humanColor?: Color },
) => (sa: Parameters<NonNullable<typeof TyrantsGame.setup>>[0]) =>
  markOnline(TyrantsGame.setup!(sa, setupData));

const ONLINE_GAME = { ...TyrantsGame, disableUndo: true, setup: onlineSetup() };

let _reducer: AnyReducer | null = null;
function reducer(): AnyReducer {
  if (!_reducer) {
    _reducer = CreateGameReducer({ game: ONLINE_GAME }) as unknown as AnyReducer;
  }
  return _reducer;
}

/** Build a fresh bgio initial full-state for a new game. Exposed for harnesses
 *  and the eventual server createGame. */
export function initialBgioState(
  numPlayers: number,
  setupData?: { halfDecks?: string[]; activeSections?: Array<'left' | 'center' | 'right'>; humanColor?: Color },
): BgioState {
  const wrapped = setupData
    ? { ...ONLINE_GAME, setup: onlineSetup(setupData) }
    : ONLINE_GAME;
  return InitializeGame({ game: wrapped, numPlayers }) as unknown as BgioState;
}

/** Translate a TyrantsAction into the bgio MAKE_MOVE dispatch shape. */
function toBgioAction(action: TyrantsAction, actor: PlayerId, currentPlayer: string): unknown {
  const mk = (type: string, args: unknown[], pid: string = actor) => ({
    type: 'MAKE_MOVE',
    payload: { type, args, playerID: pid },
  });
  switch (action.kind) {
    case 'deployStartingTroop': return mk('deployStartingTroop', [action.siteId]);
    case 'playCard':            return mk('playCard', [action.handIndex]);
    case 'recruitFromMarket':   return mk('recruitFromMarket', [action.marketIndex]);
    case 'recruitFromAuxStack': return mk('recruitFromAuxStack', [action.stack]);
    case 'deployTroop':         return mk('deployTroop', [action.spaceId]);
    case 'assassinateTroop':    return mk('assassinateTroop', [action.spaceId]);
    case 'returnEnemySpy':      return mk('returnEnemySpy', [action.siteId, action.targetColor]);
    // A pendingChoice may belong to a player who is NOT the current player (a
    // cross-player forced discard: an aberrations card makes the OPPONENT
    // discard). boardgame.io only permits the current player to submit a move,
    // so stamp resolveChoice with `currentPlayer`. The resolveChoice move
    // resolves `G.pendingChoice` (which carries its own `playerId`) regardless
    // of who submitted it, so this is safe and fixes the cross-player lock (#91).
    case 'resolveChoice':       return mk('resolveChoice', [action.response], currentPlayer);
    case 'forfeitSeat':       return mk('forfeitSeat', [action.seat]);
    case 'endTurn':             return mk('endTurn', []);
  }
}

// ---------------------------------------------------------------------------
// Legal-action enumeration (display-grade)
// ---------------------------------------------------------------------------
//
// Mirrors the random AI's enumeration (src/ai/random-ai.ts) but returns the
// FULL set of legal options rather than one pick. The non-active-player case
// (forced cross-player pendingChoice) is handled by currentActor; legalActions
// returns [] when it's not `actor`'s turn or the game is over.

function enumerateLegal(state: BgioState, actor: PlayerId): TyrantsAction[] {
  const G = state.G;
  if (state.ctx.gameover) return [];

  const acting = currentActorOf(state);
  if (acting !== actor) return [];

  // 1. Pending choice owned by this actor → enumerate resolveChoice responses.
  if (G.pendingChoice && G.pendingChoice.playerId === actor) {
    return enumerateChoiceResponses(G);
  }
  // A pending choice owned by someone else blocks this actor entirely.
  if (G.pendingChoice) return [];

  // 2. Setup phase: open starting sites.
  if (G.setupPhase) {
    const out: TyrantsAction[] = [];
    for (const s of SITES) {
      if (!s.isStartingSite) continue;
      if (!(s.id in G.siteControl)) continue;
      const spaces = sitesSpaces(s.id);
      const hasOpen = spaces.some(sp => !G.troops[sp.id]);
      const rivalHeld = spaces.some(sp => G.troops[sp.id] && G.troops[sp.id] !== 'white');
      if (hasOpen && !rivalHeld) out.push({ kind: 'deployStartingTroop', siteId: s.id });
    }
    return out;
  }

  // 3. Regular turn.
  const out: TyrantsAction[] = [];
  const me = G.players[actor];
  const color = me.color;

  // 3a. Play any hand card.
  for (let i = 0; i < me.hand.length; i++) out.push({ kind: 'playCard', handIndex: i });

  // 3b. Power-based board actions.
  const hasAnyMapPresence = SITES.some(s => hasPresence(G, color, { site: s.id }));
  if (me.power >= 1) {
    for (const t of TROOP_SPACES) {
      if (G.troops[t.id]) continue;
      let ok: boolean;
      if (!hasAnyMapPresence) ok = true;
      else if (t.parentSite) ok = hasPresence(G, color, { site: t.parentSite });
      else ok = hasPresence(G, color, { space: t.id });
      if (ok) out.push({ kind: 'deployTroop', spaceId: t.id });
    }
  }
  if (me.power >= BASE_ACTION_POWER_COST) {
    // Assassinate enemy troops where we have presence.
    for (const t of TROOP_SPACES) {
      const occ = G.troops[t.id];
      if (!occ || occ === color) continue;
      const presence = t.parentSite
        ? hasPresence(G, color, { site: t.parentSite })
        : hasPresence(G, color, { space: t.id });
      if (presence) out.push({ kind: 'assassinateTroop', spaceId: t.id });
    }
    // Return enemy spies where we have presence.
    for (const s of SITES) {
      if (!(s.id in G.siteControl)) continue;
      if (!hasPresence(G, color, { site: s.id })) continue;
      for (const c of G.spies[s.id] ?? []) {
        if (c !== color) out.push({ kind: 'returnEnemySpy', siteId: s.id, targetColor: c as Color });
      }
    }
  }

  // 3c. Recruit affordable cards from the market row and aux stacks.
  for (let i = 0; i < G.market.row.length; i++) {
    const c = G.market.row[i];
    if (!c) continue;
    const data = lookupCard(c.deck, c.slot);
    if (data && data.cost <= me.influence) out.push({ kind: 'recruitFromMarket', marketIndex: i });
  }
  for (const [stack, ref] of [
    ['priestesses', lookupCard('priestesses', 43)] as const,
    ['houseGuards', lookupCard('house-guards', 40)] as const,
  ]) {
    if (!ref) continue;
    if ((G.auxStacks[stack] ?? 0) <= 0) continue;
    if (ref.cost > me.influence) continue;
    out.push({ kind: 'recruitFromAuxStack', stack });
  }

  // 3d. End turn is always legal during a regular (non-setup) turn.
  out.push({ kind: 'endTurn' });
  return out;
}

/** Enumerate the legal `resolveChoice` responses for the live pendingChoice.
 *  The engine already publishes the legal `options` on the choice, so this is
 *  faithful (the AI does the same — random-ai.ts:40-77). */
function enumerateChoiceResponses(G: TyrantsState): TyrantsAction[] {
  const pc = G.pendingChoice!;
  const out: TyrantsAction[] = [];
  // A declinable prompt may be answered with null.
  if (pc.optional) out.push({ kind: 'resolveChoice', response: null });

  switch (pc.kind) {
    case 'choose-one': {
      // response is an index into options.
      const opts = (pc.options as unknown[] | undefined) ?? [];
      for (let i = 0; i < opts.length; i++) out.push({ kind: 'resolveChoice', response: i });
      break;
    }
    case 'select-card-in-hand': {
      // Forced-discard prompts (aberrations cards: force-a-discard, troop-killed,
      // spied-on) don't populate `options` — the discard is "any card in the
      // prompted player's hand". Enumerate that hand's indices so the engine gets
      // a valid response. Without this, enumeration falls through to a bogus
      // `null`, which the AI dutifully submits and the engine rejects as
      // INVALID_MOVE — wedging the whole turn (the "Red is taking their turn"
      // lock; PR #88 introduced these cards).
      const handOpts = pc.options as number[] | undefined;
      const idxs = (handOpts && handOpts.length > 0)
        ? handOpts
        : (G.players[pc.playerId]?.hand.map((_, i) => i) ?? []);
      for (const i of idxs) out.push({ kind: 'resolveChoice', response: i });
      if (out.length === 0) out.push({ kind: 'resolveChoice', response: null });
      break;
    }
    case 'select-card-in-discard':
    case 'select-card-in-inner-circle':
    case 'select-played-card':
    case 'select-market-card':
    case 'select-site':
    case 'select-troop-space':
    case 'select-enemy-troop':
    case 'select-enemy-spy':
    case 'select-player': {
      // response is the option value itself.
      const opts = (pc.options as unknown[] | undefined) ?? [];
      for (const o of opts) out.push({ kind: 'resolveChoice', response: o });
      // Some self-targeted prompts expose no options array; fall back to
      // null (decline / no-op) so the actor is never stuck with zero actions.
      if (out.length === 0) out.push({ kind: 'resolveChoice', response: null });
      break;
    }
    default: {
      const opts = (pc.options as unknown[] | undefined) ?? [];
      if (opts.length > 0) out.push({ kind: 'resolveChoice', response: opts[0] });
      else out.push({ kind: 'resolveChoice', response: null });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// currentActor
// ---------------------------------------------------------------------------

function currentActorOf(state: BgioState): PlayerId | null {
  if (state.ctx.gameover) return null;
  // Forced cross-player prompt: the prompted player must answer, even though
  // it's not their seat's turn (Phase 0 §7).
  const pc = state.G.pendingChoice;
  if (pc && pc.playerId) return pc.playerId;
  return state.ctx.currentPlayer;
}

// ---------------------------------------------------------------------------
// viewFor — per-player redaction (Phase 0 §6)
// ---------------------------------------------------------------------------
//
// Hidden (symmetric): every player's draw `deck` ORDER+contents (count public),
// opponents' `hand`, `market.deck` ORDER+contents (count public), `undoStack`,
// and peek-style `pendingChoice.options` / `pausedHandlerState` for non-owners.
// Public: discard, innerCircle, map, scores, log. Face-down cards become
// same-shape sentinel CardRefs so the UI can still render backs.

const HIDDEN_CARD: CardRef = { deck: '__hidden__', slot: -1, name: '', image: '' };

function hideCards(cards: CardRef[]): CardRef[] {
  return cards.map(() => ({ ...HIDDEN_CARD }));
}

function redactState(state: BgioState, viewer: PlayerId | null): BgioState {
  // structuredClone keeps the full bgio state shape (ctx/plugins ride along).
  const next = structuredClone(state);
  const G = next.G;

  for (const [pid, p] of Object.entries(G.players)) {
    if (pid === viewer) {
      // The viewer may see the CONTENTS of their own draw deck — they built it
      // and can derive it from public piles anyway — but NOT its draw ORDER.
      // Send it sorted (deck+slot+name) so the pile inspector can list it
      // without revealing what's drawn next (#73: "view deck … cant see the
      // cards" — previously the owner's own deck was redacted to blank backs).
      p.deck = [...p.deck].sort(
        (a, b) => a.deck.localeCompare(b.deck) || a.slot - b.slot || a.name.localeCompare(b.name)
      );
      // The viewer keeps their own hand as-is.
    } else {
      // Opponents: draw-deck order+contents and hand are all secret (counts
      // stay public via array length).
      p.deck = hideCards(p.deck);
      p.hand = hideCards(p.hand);
    }
  }

  // Market draw pile is face-down.
  G.market.deck = hideCards(G.market.deck);

  // Undo stack holds full pre-action snapshots that could leak hidden info.
  G.undoStack = [];

  // Per-turn snapshots are codec strings of full state (same leak risk); strip.
  G.snapshots = [];

  // A pending choice the viewer does NOT own may carry peek-style options
  // (e.g. "look at the top card of a deck"), a hidden-info-revealing prompt
  // string (e.g. "Discard the Drow Soldier you just drew"), a partially-filled
  // response, a cardKey identifying a face-down card, and paused handler state —
  // ALL of which can leak hidden info. Strip the entire payload for non-owners,
  // keeping ONLY { playerId, kind } so the UI can show a non-leaky
  // "opponent is choosing…" indicator without exposing what or why.
  if (G.pendingChoice && G.pendingChoice.playerId !== viewer) {
    G.pendingChoice = {
      kind: G.pendingChoice.kind,
      prompt: '',
      playerId: G.pendingChoice.playerId,
      // cardKey is required by the State type but identifies a (possibly
      // face-down) card, so blank it for non-owners rather than leak it.
      cardKey: '',
    };
    G.pausedHandlerState = null;
  } else if (!G.pendingChoice) {
    // Nothing pending — paused handler state should already be null, but if a
    // non-owner is somehow looking, clear opaque carry-over defensively.
    if (viewer === null) G.pausedHandlerState = null;
  }

  return next;
}

// ---------------------------------------------------------------------------
// result — map ctx.gameover (Phase 0 §7, game.ts endIf)
// ---------------------------------------------------------------------------
//
// game.ts endIf returns `{ ended: true }`; the running `p.vp` is ONLY the VP
// tokens collected during play — it does NOT include end-game scoring (site
// control, total-control, trophies, deck/inner-circle VP, card riders). The
// scoring module's scoreAll(...).total is the true final score, so we rank on
// that. Ties on the top score → multiple winners (a valid draw).

function resultOf(state: BgioState): GameResult<PlayerId> | null {
  if (!state.ctx.gameover) return null;
  const scores = scoreAll(state.G);
  // A seat that walked away and was finished by a bot forfeits its placing: it
  // can never win, and it ranks below every seat that played its own game,
  // whatever the bot managed to score for it. Otherwise abandoning a losing
  // position would be a way to dodge recording the loss.
  const forfeited = new Set(state.G.forfeitedSeats ?? []);
  const played = Object.entries(scores).filter(([pid]) => !forfeited.has(pid));

  // Winners come from the seats that actually played. If EVERY seat forfeited
  // there is no one to credit, so fall back to score alone rather than invent a
  // winner from a table of bots.
  const pool = played.length > 0 ? played : Object.entries(scores);
  let best = -Infinity;
  for (const [, sb] of pool) {
    if (sb.total > best) best = sb.total;
  }
  const winners: PlayerId[] = [];
  for (const [pid, sb] of pool) {
    if (sb.total === best) winners.push(pid);
  }
  // Finishing order (best-first) for N-player ratings. Ties on exact final score
  // are broken by seat order — rare, and only a half-pairwise rating difference.
  const byScore = (a: [string, { total: number }], b: [string, { total: number }]) => b[1].total - a[1].total;
  const ranking = [
    ...played.sort(byScore).map(([pid]) => pid),
    ...Object.entries(scores).filter(([pid]) => forfeited.has(pid)).sort(byScore).map(([pid]) => pid),
  ];
  return {
    winners,
    ranking,
    reason: forfeited.size > 0
      ? `${winners.length > 1 ? 'tie on final score' : 'highest final score'} (${forfeited.size} seat(s) forfeited)`
      : winners.length > 1 ? 'tie on final score' : 'highest final score',
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export const tyrantsAdapter: GameAdapter<BgioState, TyrantsAction, PlayerId> = {
  schemaVersion: 2,

  applyAction(state, action, actor) {
    // bgio's reducer is pure given (state, action) and clones internally, but
    // we structuredClone defensively so callers never observe shared mutation.
    const input = structuredClone(state);
    const next = reducer()(input, toBgioAction(action, actor, input.ctx.currentPlayer));
    if (next === input || next.G === input.G) {
      // bgio returns the same top-level reference on INVALID_MOVE.
      throw new Error(`applyAction: illegal ${action.kind} for ${actor}`);
    }
    return next;
  },

  tryApplyAction(state, action, actor) {
    const input = structuredClone(state);
    let next: BgioState;
    try {
      next = reducer()(input, toBgioAction(action, actor, input.ctx.currentPlayer));
    } catch (e) {
      return { state, ok: false, reason: String((e as Error)?.message ?? e) };
    }
    if (next === input || next.G === input.G) {
      // Most player-facing rejections are "you tried to do something else while a
      // required choice is still open" (e.g. a card's mandatory assassinate).
      // Surface the pending prompt instead of a cryptic "INVALID_MOVE".
      const pc = state.G.pendingChoice;
      if (pc && action.kind !== 'resolveChoice') {
        return {
          state, ok: false,
          reason: pc.prompt
            ? `Finish the current required action first: "${pc.prompt}"`
            : 'Finish the current required action first.',
        };
      }
      return { state, ok: false, reason: 'That move isn’t legal right now.' };
    }
    return { state: next, ok: true };
  },

  legalActions(state, actor) {
    return enumerateLegal(state, actor);
  },

  currentActor(state) {
    return currentActorOf(state);
  },

  viewFor(state, viewer) {
    // At game over, reveal everything. The final scoreboard scores every
    // player's deck + inner circle; computed from a REDACTED view, a client
    // zeroes out the opponent's hidden cards, so the two players see DIFFERENT
    // totals. Once the game is decided there is nothing left to hide, so both
    // players get the full state and compute the identical, correct scoreboard.
    if (state.ctx.gameover) return state;
    return redactState(state, viewer);
  },

  result(state) {
    return resultOf(state);
  },

  migrate(rawState, fromVersion) {
    const state = rawState as BgioState;
    if (fromVersion < 2) {
      // v1 → v2: G.log was string[] (prose lines); wrap into structured
      // GameLogEntry objects (kind 'legacy') so old online snapshots in
      // Supabase keep rendering and appendGameLog can extend them.
      const G = state.G as unknown as { log?: unknown[] };
      if (Array.isArray(G.log) && G.log.some(l => typeof l === 'string')) {
        G.log = upgradeProseLog(G.log.map(l =>
          typeof l === 'string' ? l : JSON.stringify(l)));
      }
    }
    return state;
  },
};
