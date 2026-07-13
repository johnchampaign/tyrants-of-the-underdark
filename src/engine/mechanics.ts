// Mechanics façade — every zone/score mutation routes through here so logging,
// game-over checks, and (future) site-control recomputation all stay in one place.
//
// Inherited convention from Impulse/Innovation: handlers and moves never touch piles,
// resource pools, or scores directly. They call Mechanics.

import type { TyrantsState, CardRef } from '../game';
import { logEvent, type LogMeta } from './log';

function p(G: TyrantsState, playerId: string) {
  const player = G.players[playerId];
  if (!player) throw new Error(`Unknown player ${playerId}`);
  return player;
}

export const Mechanics = {
  log(G: TyrantsState, line: string, meta?: LogMeta) {
    logEvent(G, line, meta);
  },

  /** Mark that hidden information just became visible (a card drawn, the
   *  market refilled, the top of a deck looked at). This is a one-way door
   *  for the within-turn undo: it wipes the undo stack so the player can't
   *  rewind back across the reveal and re-draw into different cards. */
  markInfoRevealed(G: TyrantsState) {
    if (G.undoStack && G.undoStack.length > 0) G.undoStack = [];
  },

  gainPower(G: TyrantsState, playerId: string, n: number, source?: string) {
    p(G, playerId).power += n;
    if (n !== 0) Mechanics.log(G, `P${Number(playerId) + 1} +${n} Power${source ? ` from ${source}` : ''}`,
      { kind: 'power.gain', payload: { amount: n, ...(source ? { source } : {}) }, side: playerId });
  },
  gainInfluence(G: TyrantsState, playerId: string, n: number, source?: string) {
    p(G, playerId).influence += n;
    if (n !== 0) Mechanics.log(G, `P${Number(playerId) + 1} +${n} Influence${source ? ` from ${source}` : ''}`,
      { kind: 'influence.gain', payload: { amount: n, ...(source ? { source } : {}) }, side: playerId });
  },
  expendPower(G: TyrantsState, playerId: string, n: number): boolean {
    const pl = p(G, playerId);
    if (pl.power < n) return false;
    pl.power -= n;
    return true;
  },
  expendInfluence(G: TyrantsState, playerId: string, n: number): boolean {
    const pl = p(G, playerId);
    if (pl.influence < n) return false;
    pl.influence -= n;
    return true;
  },

  gainVpTokens(G: TyrantsState, playerId: string, n: number) {
    p(G, playerId).vp += n;
    Mechanics.log(G, `P${Number(playerId) + 1} +${n} VP`,
      { kind: 'vp.gain', payload: { amount: n }, side: playerId });
  },

  draw(G: TyrantsState, playerId: string, n: number, random?: { Number(): number }) {
    const pl = p(G, playerId);
    const rng = random ? () => random.Number() : () => Math.random();
    for (let i = 0; i < n; i++) {
      if (pl.deck.length === 0) {
        // Cards played THIS turn live in the play area in front of you until
        // end of turn — they aren't in the discard pile yet, so a mid-turn
        // reshuffle must not scoop them back into the deck. The engine keeps
        // played cards in `discard` for bookkeeping but also tracks the exact
        // object references in `cardsPlayedThisTurn`; exclude those from the
        // shuffle so a freshly-played draw card can't be reshuffled and drawn
        // again and again on the same turn (#76). They return to the
        // reshuffle pool next turn, once cardsPlayedThisTurn is cleared.
        // Exclude by VALUE (deck+slot), count-matched for duplicates — NOT by
        // object reference. Online play serializes the state to the store and
        // back on every move (JSON), which does not preserve shared references:
        // the played card in `discard` becomes a different object than the one
        // in `cardsPlayedThisTurn`, so a reference Set silently fails to exclude
        // it and the card gets reshuffled + redrawn on the same turn — an
        // infinite loop (e.g. Information Broker "return a spy → draw 3" replayed
        // forever). Reference identity held in hotseat/tests, which is why this
        // only ever surfaced online (#76 regression).
        const playedCounts = new Map<string, number>();
        for (const c of G.cardsPlayedThisTurn ?? []) {
          const k = `${c.deck}:${c.slot}`;
          playedCounts.set(k, (playedCounts.get(k) ?? 0) + 1);
        }
        const reshufflable: typeof pl.discard = [];
        const stayInPlay: typeof pl.discard = [];
        for (const c of pl.discard) {
          const k = `${c.deck}:${c.slot}`;
          const n = playedCounts.get(k) ?? 0;
          if (n > 0) { playedCounts.set(k, n - 1); stayInPlay.push(c); }
          else reshufflable.push(c);
        }
        if (reshufflable.length === 0) return;
        // Reshuffle + draw exposes hidden card order — close the undo door.
        Mechanics.markInfoRevealed(G);
        // Deterministic reshuffle via the seeded boardgame.io RNG when passed
        // through. Callers in move handlers should pass ctx.random. Fenwick-
        // free Fisher-Yates on a copy so we don't mutate discard mid-loop.
        const deck = reshufflable;
        for (let k = deck.length - 1; k > 0; k--) {
          const j = Math.floor(rng() * (k + 1));
          [deck[k], deck[j]] = [deck[j], deck[k]];
        }
        pl.deck = deck;
        // Keep the in-play (played-this-turn) cards in discard; everything else
        // moved to the deck. `stayInPlay` was partitioned by value above.
        pl.discard = stayInPlay;
      }
      const c = pl.deck.shift();
      if (c) {
        // A card moving from the (face-down) deck into hand is new information.
        Mechanics.markInfoRevealed(G);
        pl.hand.push(c);
      }
    }
  },

  discardCard(G: TyrantsState, playerId: string, card: CardRef) {
    const pl = p(G, playerId);
    const idx = pl.hand.findIndex(c => c.deck === card.deck && c.slot === card.slot);
    if (idx < 0) throw new Error(`Card ${card.name} not in hand`);
    pl.hand.splice(idx, 1);
    pl.discard.push(card);
  },

  promote(G: TyrantsState, playerId: string, card: CardRef) {
    const pl = p(G, playerId);
    // NOTE: this used to defensively splice `cardsPlayedThisTurn` by the
    // first entry matching deck+slot. That was wrong for any promote whose
    // source ISN'T the play area (Matron Mother / Necromancer promote-from-
    // discard, promote-from-hand, promote-top-of-deck): with duplicate
    // cards (Nobles, Soldiers, House Guards) it evicted a *different* same-
    // type card the player actually played this turn, so the end-of-turn
    // "promote a card played this turn" prompt could no longer target it
    // (#59). Removal from the played list is now the caller's job — the EOT
    // path splices by exact index, and promoteSelf removes its own entry.
    // Insane Outcast self-eject: if would be promoted, return to supply instead.
    if (card.deck === 'insane-outcasts') {
      Mechanics.log(G, `P${Number(playerId) + 1} cannot promote ${card.name} (returns to supply)`);
      // (No supply tracking yet; just drop the card.)
      return;
    }
    pl.innerCircle.push(card);
    Mechanics.log(G, `P${Number(playerId) + 1} promoted ${card.name}`,
      { kind: 'card.promote', payload: { card: card.name }, side: playerId });
  },

  devour(G: TyrantsState, card: CardRef) {
    // Insane Outcast self-eject: if would be devoured, return to supply instead.
    if (card.deck === 'insane-outcasts') {
      Mechanics.log(G, `${card.name} cannot be devoured (returns to supply)`);
      return;
    }
    Mechanics.log(G, `${card.name} devoured`,
      { kind: 'card.devour', payload: { card: card.name } });
    // Track the devoured card so cards that interact with the pile (Ghost
    // — "treat the top of devoured as if in market") can reference it.
    // turn.onBegin backfills the field on legacy saves.
    if (!G.devouredPile) G.devouredPile = [];
    G.devouredPile.push(card);
  },

  recruitFromMarket(G: TyrantsState, playerId: string, marketIndex: number): boolean {
    const card = G.market.row[marketIndex];
    if (!card) return false;
    p(G, playerId).discard.push(card);
    const refill = G.market.deck.shift() ?? null;
    // Refilling the row from the face-down market deck reveals a new card to
    // everyone — recruiting from the market is therefore not undoable.
    if (refill) Mechanics.markInfoRevealed(G);
    G.market.row[marketIndex] = refill;
    Mechanics.log(G, `P${Number(playerId) + 1} recruited ${card.name}`,
      { kind: 'card.recruit', payload: { card: card.name, from: 'market' }, side: playerId });
    return true;
  },

  /** Recruit from a permanent aux stack (House Guards or Priestesses). The
   *  stack must have a card remaining; the resource cost is checked + spent
   *  by the caller (the move handler in game.ts). Returns false if the
   *  stack is empty. */
  recruitFromAuxStack(
    G: TyrantsState, playerId: string,
    stack: 'houseGuards' | 'priestesses',
    card: { deck: string; slot: number; name: string; image: string },
  ): boolean {
    if (G.auxStacks[stack] <= 0) return false;
    p(G, playerId).discard.push(card);
    G.auxStacks[stack] -= 1;
    Mechanics.log(G, `P${Number(playerId) + 1} recruited ${card.name} (${G.auxStacks[stack]} left in stack)`,
      { kind: 'card.recruit', payload: { card: card.name, from: stack }, side: playerId });
    return true;
  },

  // -- map mutations come once we wire occupancy into TyrantsState --
  // deployTroop, assassinateTroop, moveTroop, placeSpy, returnTroop, returnSpy,
  // supplant, recomputeSiteControl
};
