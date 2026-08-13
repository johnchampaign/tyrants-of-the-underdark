// Effect handler contract — ported from the Impulse/Innovation patterns onto boardgame.io.
//
// One handler per unique effectKey. Handlers may suspend by setting ctx.pendingChoice
// and returning false; the engine will surface the choice to the UI/AI and re-invoke
// the handler with ctx.pendingChoice.response populated.

import type { TyrantsState, CardRef } from '../game';

// Single source of truth lives in game.ts (canonical four + human-pick extras).
export type { Color } from '../game';

export type PendingChoiceKind =
  | 'select-card-in-hand'
  | 'select-card-in-discard'
  | 'select-card-in-inner-circle'
  | 'select-played-card'
  | 'select-market-card'
  | 'select-site'
  | 'select-troop-space'
  | 'select-enemy-troop'
  | 'select-enemy-spy'
  | 'choose-one'
  | 'select-player';

export interface PendingChoice {
  kind: PendingChoiceKind;
  prompt: string;
  options?: unknown[];        // semantics vary by kind
  optional?: boolean;
  response?: unknown;         // filled in by UI/AI before resume
  // Added by the game-level dispatcher when the choice is stored on G:
  /** The player who owns / answers this choice (filled in by game.ts when the
   *  prompt is published). Usually the same as the actor, but for cross-player
   *  prompts (an opponent forcing this player to discard) `playerId` is the
   *  *target* and `actorId` below is the player whose card is mid-resolution. */
  playerId?: string;
  /** The player whose card effect is suspended waiting on this choice. Equal
   *  to `playerId` for self-targeted prompts; differs when one player's card
   *  asks another player to act (forced discard etc.). The suspended handler's
   *  card lives in `G.players[actorId].discard`; omitted = falls back to
   *  `playerId` (legacy behavior). */
  actorId?: string;
  /** "<deck>::<slot>" key of the card whose effect surfaced this choice. Lets
   *  AI / UI distinguish e.g. an Insane Outcast's "discard to return" prompt
   *  from a Succubus / Marilith "devour from hand" prompt. */
  cardKey?: string;
  /** Subset of `options` that the UI should mark as *the ones that pay off*.
   *  Purely advisory — every entry in `options` stays legal and clickable.
   *  Used by place-a-spy prompts whose card does something else at that same
   *  site afterwards (Yan-C-Bin assassinates there, Green Dragon supplants
   *  there, Infiltrator wants an opponent troop there): without it the player
   *  can spend the spy on a site where the follow-up has no legal target and
   *  only find out from a parenthetical log line. Reported as #105. */
  highlight?: string[];
}

export interface EffectContext {
  /** The card being resolved. */
  card: CardRef;
  /** Player who triggered the effect (usually the current player). */
  actorId: string;
  /** Game state — handlers mutate this directly under boardgame.io's Immer-backed proxy. */
  G: TyrantsState;
  /** Pending choice request. Null when the handler is not awaiting input. */
  pendingChoice: PendingChoice | null;
  /** True when handler suspended awaiting input. */
  paused: boolean;
  /** Opaque slot for multi-stage handlers to stash progress between resumptions. */
  handlerState: unknown;
  /** Seeded RNG from the boardgame.io random plugin, if available. Handlers
   *  that need randomness (notably deck reshuffles on draw/promote) MUST use
   *  this rather than Math.random so replay / save-load is deterministic. */
  random?: { Number(): number };
}

/**
 * Returns true when the effect ran to completion this call; false when it suspended.
 * On suspension, the handler must have set ctx.pendingChoice and ctx.paused = true.
 */
export type EffectHandler = (ctx: EffectContext) => boolean;
