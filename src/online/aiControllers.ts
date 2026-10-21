// Server-side AI opponents for Tyrants of the Underdark online play. Keyed by
// difficulty — these keys are the rating-id suffixes the AI plays under on the
// leaderboard (e.g. `ai:tyrants:random`). Bump a key (e.g. 'standard@2') if you
// ever change an AI's strength so it earns a fresh rating instead of dragging
// the old one.
//
// These wrap the EXISTING decision logic from src/ai/* as framework
// PlayerControllers. The server drives AI seats: it calls selectAction with the
// current state + actor, dispatches the returned Action, and re-invokes until
// the AI seat is no longer the actor.
//
// CPU NOTE: We deliberately do NOT use src/ai/lookahead.ts (deep search) here —
// it would blow the Cloudflare Worker per-move CPU budget. The two shipped
// difficulties are:
//   - 'random'   → src/ai/random-ai.ts (decideAiMove): pick a legal-ish move.
//   - 'standard' → src/ai/heuristic-ai.ts (decideHeuristicMove): the SINGLE-PLY
//                  heuristic. Called WITHOUT a simulate/rollout fn, so the
//                  heuristic's lookahead code paths are never taken (it falls
//                  back to score-only ranking — see heuristic-ai.ts comments).
//
// Both decide-fns operate on the raw bgio G + seat string and return an AiMove
// `{ name, args }`. We translate that into the adapter's TyrantsAction. The
// server hands AI seats the FULL (un-redacted) state, so reaching into
// `ctx.state.G` is correct here. Every controller falls back to the first legal
// action if the decision logic returns null or an unrecognized move, so an AI
// seat is never stuck.

import type { PlayerController } from 'digital-boardgame-framework';
import type { BgioState, TyrantsAction, PlayerId } from '../adapter/tyrantsAdapter';
import type { Color } from '../game';
import { decideAiMove, type AiMove } from '../ai/random-ai';
import { decideHeuristicMove } from '../ai/heuristic-ai';

type Ctrl = PlayerController<BgioState, TyrantsAction, PlayerId>;
type Decide = (G: BgioState['G'], currentPlayer: string) => AiMove | null;

/** Translate the legacy AiMove shape into the adapter's TyrantsAction. Returns
 *  null for an unrecognized/empty move so the caller can fall back to a legal
 *  action. */
function toAction(move: AiMove | null): TyrantsAction | null {
  if (!move) return null;
  switch (move.name) {
    case 'deployStartingTroop': return { kind: 'deployStartingTroop', siteId: move.args[0] };
    case 'playCard':            return { kind: 'playCard', handIndex: move.args[0] };
    case 'recruitFromMarket':   return { kind: 'recruitFromMarket', marketIndex: move.args[0] };
    case 'recruitFromAuxStack': return { kind: 'recruitFromAuxStack', stack: move.args[0] };
    case 'deployTroop':         return { kind: 'deployTroop', spaceId: move.args[0] };
    case 'assassinateTroop':    return { kind: 'assassinateTroop', spaceId: move.args[0] };
    case 'returnEnemySpy':      return { kind: 'returnEnemySpy', siteId: move.args[0], targetColor: move.args[1] as Color };
    case 'resolveChoice':       return { kind: 'resolveChoice', response: move.args[0] };
    case 'endTurn':             return { kind: 'endTurn' };
    default:                    return null;
  }
}

/** Build a PlayerController from one of the synchronous decide-fns. The fn sees
 *  the seat's redacted view G (the framework hands each AI seat viewFor(state,
 *  seat)) and must only read it — the view shares structure with the real
 *  state. We translate its
 *  move and validate it against the adapter's legal actions; on any miss we play
 *  the first legal action so the seat always advances. */
function controllerFrom(decide: Decide): Ctrl {
  return {
    selectAction: async (ctx) => {
      const legal = ctx.adapter.legalActions(ctx.state, ctx.actor);
      let chosen: TyrantsAction | null = null;
      try {
        chosen = toAction(decide(ctx.state.G, ctx.actor));
      } catch {
        chosen = null;
      }
      // Confirm the chosen action is actually legal in this state. The decide
      // logic mirrors the adapter's enumeration, but if it ever drifts (or a
      // pending-choice response shape differs), fall back rather than have the
      // engine reject the move and leave the seat wedged.
      if (chosen) {
        const ok = legal.some((a) => JSON.stringify(a) === JSON.stringify(chosen));
        if (ok) return chosen;
      }
      if (legal.length > 0) return legal[0];
      // No legal action enumerated — end the turn as a last resort.
      return { kind: 'endTurn' };
    },
  };
}

export const tyrantsControllers: Record<string, Ctrl> = {
  // Beatable baseline: picks among any-legal moves (mostly random).
  random: controllerFrom(decideAiMove),
  // Single-ply heuristic — no lookahead (Worker-CPU-safe).
  standard: controllerFrom(decideHeuristicMove),
};

/** How the server splits a long AI run across requests (framework >=0.55
 *  `aiSlice`). NOT `perSeat`: AI seats interleave within a turn — an
 *  Aberrations card (Chuul, Nothic, Gauth…) hands a forced-discard prompt to
 *  each opponent and then back to the player, so perSeat would add two ~0.2 s
 *  round trips per prompt (~11% of AI turns in 3–4p AI games). Instead cap by
 *  work. 10 steps (~40–130 ms CPU in production mode) tripped Cloudflare's
 *  per-request CPU limit in bursts: a killed slice saves nothing, so every
 *  poll re-ran one and was killed again (253 kills in one hour, Oct 2026).
 *  With the per-step clones and the online turn-start snapshot gone, a step is
 *  ~2.4 ms p50 / 8 ms max (node, production mode), so 3 steps ≈ 9–15 ms per
 *  request including decode/encode/transport; the client's aiPending refetch
 *  carries the turn on. */
export const TYRANTS_AI_SLICE = { maxSteps: 3 } as const;
