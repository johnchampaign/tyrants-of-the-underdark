// Composable building blocks for effect handlers.
//
// Most cards combine 1–3 of: grant resources, draw, place a spy, assassinate a troop,
// deploy a troop, supplant, promote, end-of-turn promote, devour-cost, choose-one.
// These helpers cover the recurring shapes so individual card handlers stay one-liners.

import { CardRegistry } from './registry';
import { Mechanics } from './mechanics';
import type { EffectContext, EffectHandler, PendingChoice } from './types';
import { placeSpy, assassinateTroop, deployTroop, hasPresence, returnSpy, returnTroop, moveTroop } from './map-state';
import { SITES } from '../data/sites';
import { ROUTES } from '../data/routes';
import { TROOP_SPACES, sitesSpaces, routeSpaces } from '../data/troop-spaces';
import { lookupCard, cardsInDeck } from '../card-data';
import type { CardRef, Color, TyrantsState } from '../game';

// ---------- Pure grants ----------

export function grant(opts: { power?: number; influence?: number; draw?: number }): EffectHandler {
  return ctx => {
    if (opts.power) Mechanics.gainPower(ctx.G, ctx.actorId, opts.power);
    if (opts.influence) Mechanics.gainInfluence(ctx.G, ctx.actorId, opts.influence);
    if (opts.draw) Mechanics.draw(ctx.G, ctx.actorId, opts.draw, ctx.random);
    return true;
  };
}

// ---------- End-of-turn promote-a-card flag ----------
//
// "At the end of your turn, promote a card played this turn" — set a flag that the
// turn-end step will surface as a "select a played card to promote" prompt. The
// played-card list lives on the per-turn promotion queue.

export function flagEotPromote(
  opts?: { count?: number; aspectFilter?: string; typeFilter?: string; optional?: boolean },
): EffectHandler {
  return ctx => {
    const n = opts?.count ?? 1;
    // Push the triggering card N times so the endTurn picker can exclude it from each
    // resulting prompt (most cards specify "another card played this turn"). The
    // optional aspectFilter (e.g. 'Obedience' for the Air/Fire/Water Myrmidons)
    // is carried as a property on the queued entry; game.ts filters the
    // 'select-played-card' eligible list by aspect when set.
    //
    // Default to mandatory. The reading is that "may" cards are optional
    // and "promote..." (no "may") cards are mandatory — community
    // consensus on BGG thread 1712589 (NOT a designer ruling; the actual
    // designers Peter Lee / Rodney Thompson / Andrew Veen didn't weigh
    // in there). It's the consistent reading of the printed effects, so
    // we use it as the default. Callers whose printed text is
    // "you may promote..." opt out with `optional: true`. The flag is
    // carried on the trigger so game.ts's endTurn prompt can use it.
    const trigger: import('../game').EotPromoteTrigger = { ...ctx.card };
    let tag = ' another card';
    if (opts?.aspectFilter) {
      trigger.aspectFilter = opts.aspectFilter;
      tag = ` ${opts.aspectFilter} card`;
    }
    if (opts?.typeFilter) {
      trigger.typeFilter = opts.typeFilter;
      tag = ` ${opts.typeFilter} cards`
    }
    if (opts?.optional) trigger.optional = true;
    for (let i = 0; i < n; i++) ctx.G.pendingEotPromotions.push(trigger); 
    Mechanics.log(ctx.G, `(eot: queued ${opts?.typeFilter ? '' : n} promote —${tag} played this turn${opts?.optional ? ', optional' : ''})`);
    return true;
  };
}

// ---------- Place a spy ----------
//
// Surfaces a site picker. Resolves to the chosen siteId (string) or null if declined
// (placement is mandatory in rulebook terms; we keep it optional via PendingChoice
// only for cards that explicitly offer it as a choice).

/** Self-heal the spiesLeft count for games saved before the spy-supply
 *  field was added. If me.spiesLeft is missing (undefined), back-fill it
 *  from the current board: 5 minus the player's spies currently placed.
 *  Cap at >= 0 so an over-spied legacy save doesn't go negative.
 *  Idempotent — once the field is a real number, this is a no-op. */
export function ensureSpiesLeftInitialized(G: import('../game').TyrantsState, color: import('../game').Color): void {
  const pid = Object.keys(G.players).find(k => G.players[k].color === color);
  if (!pid) return;
  const me = G.players[pid];
  if (typeof me.spiesLeft === 'number') return;
  let onBoard = 0;
  for (const arr of Object.values(G.spies)) {
    if (arr.includes(color)) onBoard++;
  }
  me.spiesLeft = Math.max(0, 5 - onBoard);
}

export function placeSpyAtChosenSite(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    const me = ctx.G.players[ctx.actorId];
    const myColor = me.color;
    ensureSpiesLeftInitialized(ctx.G, myColor);
    type Phase = 'init' | 'place' | 'empty-choice' | 'empty-return' | 'empty-place';
    const state = (ctx.handlerState as { phase: Phase } | null) ?? { phase: 'init' as Phase };

    // Helper: list of sites where a fresh spy could land. Must be in play
    // and not already have one of my spies.
    const placeableSites = () => SITES
      .filter(s => s.id in ctx.G.siteControl && !(ctx.G.spies[s.id] ?? []).includes(myColor))
      .map(s => s.id);
    // Helper: sites where I currently have a spy (eligible to return).
    const ownSpySites = () => SITES
      .filter(s => (ctx.G.spies[s.id] ?? []).includes(myColor))
      .map(s => s.id);

    // ---- Phase 0: entry. Branch on whether the supply has any spies left.
    if (state.phase === 'init') {
      if (me.spiesLeft > 0) {
        // Normal path: prompt for the site to place at.
        ctx.pendingChoice = {
          kind: 'select-site',
          prompt: 'Place a spy at which site?',
          options: placeableSites(),
          optional: opts?.optional,
        } as PendingChoice;
        ctx.paused = true;
        ctx.handlerState = { phase: 'place' };
        return false;
      }
      // Supply empty (rulebook: "either do nothing OR first return one of
      // your existing spies and then place it"). Offer the choice. If the
      // player has no own spies on the board either — somehow — only the
      // skip path is available, so we skip silently.
      if (ownSpySites().length === 0) {
        Mechanics.log(ctx.G, `(place spy: supply empty and no spies on board — skipped)`);
        ctx.handlerState = null;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'choose-one',
        prompt: 'Your spy supply is empty. What would you like to do?',
        options: ['Do nothing', 'Return a placed spy, then place it at a new site'],
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'empty-choice' };
      return false;
    }

    // ---- Phase: normal place — resume from the place-site prompt.
    if (state.phase === 'place') {
      const siteId = ctx.pendingChoice?.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      ctx.handlerState = null;
      if (siteId && placeSpy(ctx.G, myColor, siteId)) {
        me.spiesLeft -= 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} placed spy at ${siteId} (spies left: ${me.spiesLeft})`);
        (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite = siteId;
      }
      return true;
    }

    // ---- Phase: empty-supply skip-vs-return choice.
    if (state.phase === 'empty-choice') {
      const idx = ctx.pendingChoice?.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null || idx === 0) {
        // "Do nothing" or implicit dismissal.
        Mechanics.log(ctx.G, `(place spy: supply empty, declined to return-and-replace)`);
        ctx.handlerState = null;
        return true;
      }
      // Picked "return a placed spy, then place". Prompt for the return site.
      ctx.pendingChoice = {
        kind: 'select-site',
        prompt: 'Return a spy from which site?',
        options: ownSpySites(),
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'empty-return' };
      return false;
    }

    // ---- Phase: empty-supply return-site picked, now do the return and
    // immediately re-prompt for the new place-site.
    if (state.phase === 'empty-return') {
      const siteId = ctx.pendingChoice?.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!siteId) {
        // User dismissed the return picker — back out gracefully.
        ctx.handlerState = null;
        return true;
      }
      if (returnSpy(ctx.G, myColor, siteId)) {
        me.spiesLeft += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned spy from ${siteId} to refill supply (spies left: ${me.spiesLeft})`);
      }
      ctx.pendingChoice = {
        kind: 'select-site',
        prompt: 'Place the spy at which site?',
        options: placeableSites(),
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'empty-place' };
      return false;
    }

    // ---- Phase: empty-supply place site picked.
    if (state.phase === 'empty-place') {
      const siteId = ctx.pendingChoice?.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      ctx.handlerState = null;
      if (siteId && placeSpy(ctx.G, myColor, siteId)) {
        me.spiesLeft -= 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} placed spy at ${siteId} (spies left: ${me.spiesLeft})`);
        (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite = siteId;
      }
      return true;
    }

    // Defensive: unknown phase. Reset.
    ctx.handlerState = null;
    return true;
  };
}

/** Supplant a troop at the site where you just placed a spy (used by Green Dragon's primary). */
export function supplantAtLastPlacedSpySite(): EffectHandler {
  return ctx => {
    // Stash the target site in handlerState on first call so it survives the pause
    // between prompt and click. We deliberately do NOT clear the transient stash
    // up front (older code did, which made the click silently no-op).
    const Gx = ctx.G as unknown as { _lastPlacedSpySite?: string };
    const stashed = ctx.handlerState as { siteId?: string } | null;
    const siteId = stashed?.siteId ?? Gx._lastPlacedSpySite;
    if (!siteId) { ctx.handlerState = null; return true; }
    ctx.handlerState = { siteId };
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id)
        .filter(id => {
          const occ = ctx.G.troops[id];
          return occ && occ !== me.color;
        });
      if (eligible.length === 0) return true;
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Supplant a troop at ${siteId} (the spy's site).`,
        options: eligible,
        optional: true,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    ctx.handlerState = null;
    Gx._lastPlacedSpySite = undefined;
    if (!spaceId) return true;
    const me = ctx.G.players[ctx.actorId];
    const killed = assassinateTroop(ctx.G, spaceId);
    if (!killed) return true;
    if (killed === 'white') me.trophyHall.white += 1;
    else if (killed !== me.color) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
    if (me.barracksLeft > 0) {
      if (deployTroop(ctx.G, me.color, spaceId)) {
        me.barracksLeft -= 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} (barracks: ${me.barracksLeft})`,
          { kind: 'troop.supplant', payload: { site: spaceId, target: killed }, side: ctx.actorId });
      }
    } else {
      me.vp += 1;
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} — barracks empty, +1 VP`,
        { kind: 'troop.supplant', payload: { site: spaceId, target: killed, barracksEmpty: true }, side: ctx.actorId });
    }
    return true;
  };
}

/** Assassinate a troop at the site where you just placed a spy (used by Succubus, Yan-C-Bin). */
export function assassinateAtLastPlacedSpySite(): EffectHandler {
  return ctx => {
    const Gx = ctx.G as unknown as { _lastPlacedSpySite?: string };
    // Stash the target site in handlerState on first entry so it survives
    // the pause for the user's troop-pick. The earlier implementation read
    // _lastPlacedSpySite AND cleared it on every entry, so on re-entry
    // after the user picked a target the siteId was undefined and the
    // assassinate silently bailed out (Succubus place-then-assassinate
    // chain visibly skipped the assassinate step).
    const stashed = ctx.handlerState as { siteId?: string } | null;
    const siteId = stashed?.siteId ?? Gx._lastPlacedSpySite;
    if (!siteId) { ctx.handlerState = null; return true; }

    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id)
        .filter(id => {
          const occ = ctx.G.troops[id];
          return occ && occ !== me.color;
        });
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, `(assassinate at ${siteId}: no enemy/white troops to target — skipped)`);
        Gx._lastPlacedSpySite = undefined;
        ctx.handlerState = null;
        return true;
      }
      Mechanics.log(ctx.G, `(assassinate at ${siteId}: choose a troop — ${eligible.length} eligible)`);
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Assassinate a troop at ${siteId}.`,
        options: eligible,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { siteId };
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    // The site has been consumed by either path (target chosen or declined),
    // so clear the transient stash for any downstream handlers and our own
    // handlerState ledger.
    Gx._lastPlacedSpySite = undefined;
    ctx.handlerState = null;
    if (!spaceId) {
      Mechanics.log(ctx.G, `(assassinate at ${siteId}: declined)`);
      return true;
    }
    const me = ctx.G.players[ctx.actorId];
    const killed = assassinateTroop(ctx.G, spaceId);
    if (killed === 'white') me.trophyHall.white += 1;
    else if (killed) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} assassinated ${killed} at ${spaceId}`,
      { kind: 'troop.assassinate', payload: { site: spaceId, target: killed }, side: ctx.actorId });
    return true;
  };
}

// ---------- Devour-from-hand optional cost ----------
//
// Surfaces a "select-card-in-hand" prompt; on pick, devours that card and runs the
// follow-up effect. Decline (or no cards in hand) skips the effect entirely — the
// devour is the cost for the bonus effect.

interface DevourState { paid?: boolean; childState?: unknown }

export function devourFromHandCost(thenEffect: EffectHandler, opts?: { promptLabel?: string }): EffectHandler {
  return ctx => {
    let state = (ctx.handlerState as DevourState | null) ?? {};
    if (!state.paid) {
      if (!ctx.pendingChoice) {
        const me = ctx.G.players[ctx.actorId];
        if (me.hand.length === 0) {
          // No card to devour → the whole gated effect fizzles. Flag it so the
          // "Play all basic" classifier doesn't silently auto-play (and waste)
          // a devour card as if it were a free basic — the dry-run sees no
          // prompt either way, but this marker tells it the play fizzled (#74).
          (ctx.G as unknown as { _playFizzledNoFood?: boolean })._playFizzledNoFood = true;
          ctx.handlerState = null;
          return true;
        }
        ctx.pendingChoice = {
          kind: 'select-card-in-hand',
          prompt: opts?.promptLabel ?? 'Devour a card from your hand to trigger this effect?',
          optional: true,
        } as PendingChoice;
        ctx.paused = true;
        return false;
      }
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; } // declined cost
      const me = ctx.G.players[ctx.actorId];
      const card = me.hand[idx];
      if (!card) { ctx.handlerState = null; return true; }
      me.hand.splice(idx, 1);
      Mechanics.devour(ctx.G, card);
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} devoured ${card.name} from hand`,
      { kind: 'card.devour', payload: { card: card.name, from: 'hand' }, side: ctx.actorId });
      state = { paid: true, childState: null };
    }
    // Run the gated follow-up.
    const childCtx: EffectContext = {
      ...ctx,
      pendingChoice: ctx.pendingChoice,
      handlerState: state.childState,
      paused: ctx.paused,
    };
    const done = thenEffect(childCtx);
    if (!done) {
      ctx.pendingChoice = childCtx.pendingChoice;
      ctx.paused = true;
      ctx.handlerState = { paid: true, childState: childCtx.handlerState };
      return false;
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Return one of your own spies ----------
//
// Surfaces a site picker over sites where the player has a spy. Returns the spy on
// resolve. If onReturned is provided, calls it with the chosen siteId so the caller
// can chain a follow-up (e.g. "supplant a troop there").

export function returnOwnSpyChoice(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      ensureSpiesLeftInitialized(ctx.G, me.color);
      const eligible = SITES
        .filter(s => (ctx.G.spies[s.id] ?? []).includes(me.color))
        .map(s => s.id);
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, '(return own spy: you have no spies on the board — skipped)');
        return true;
      }
      // Auto-resolve the trivial case: exactly one eligible site (and the prompt
      // is mandatory — for optional callers we still surface so the user can
      // decline). This avoids an "accidental" click on a slot at the only-spy
      // site being misread later as a supplant target (Spellspinner et al).
      if (eligible.length === 1 && !opts?.optional) {
        const siteId = eligible[0];
        if (returnSpy(ctx.G, me.color, siteId)) {
          me.spiesLeft += 1;
          Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned spy from ${siteId} (auto: only one) (spies left: ${me.spiesLeft})`);
          (ctx.G as unknown as { _lastReturnedSpySite?: string })._lastReturnedSpySite = siteId;
        }
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-site',
        prompt: 'Return one of your spies from which site?',
        options: eligible,
        optional: opts?.optional ?? true,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const siteId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!siteId) return true;
    const me = ctx.G.players[ctx.actorId];
    ensureSpiesLeftInitialized(ctx.G, me.color);
    if (returnSpy(ctx.G, me.color, siteId)) {
      me.spiesLeft += 1;
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned spy from ${siteId} (spies left: ${me.spiesLeft})`);
      // Stash the site for any chained handlers that need it.
      (ctx.G as unknown as { _lastReturnedSpySite?: string })._lastReturnedSpySite = siteId;
    }
    return true;
  };
}

/** Supplant a troop at the most-recently returned spy's site (used by Spellspinner). */
/** Assassinate a troop at the site where you just returned a spy.
 *  Mirror of supplantAtLastReturnedSpySite but no redeploy. Used by
 *  Cloaker: "Return a spy → assassinate a troop at that site." Without
 *  this binding, the generic assassinateChoice() runs a presence-filter
 *  after the spy is gone — and if the spy was your only presence at
 *  that site, you can no longer reach it (reported as #39). */
export function assassinateAtLastReturnedSpySite(): EffectHandler {
  return ctx => {
    const Gx = ctx.G as unknown as { _lastReturnedSpySite?: string };
    const stashed = ctx.handlerState as { siteId?: string } | null;
    const siteId = stashed?.siteId ?? Gx._lastReturnedSpySite;
    if (!siteId) { ctx.handlerState = null; return true; }
    ctx.handlerState = { siteId };
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      // Any non-self troop at that site (rulebook treats white troops as
      // legal assassinate targets, same as any other "assassinate a troop"
      // clause; trophy goes to the player's white pile).
      const eligible = TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id)
        .filter(id => {
          const occ = ctx.G.troops[id];
          return occ && occ !== me.color;
        });
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, `(assassinate at ${siteId}: no eligible targets — skipped)`);
        ctx.handlerState = null;
        Gx._lastReturnedSpySite = undefined;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Assassinate a troop at ${siteId}.`,
        options: eligible,
        optional: true,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    ctx.handlerState = null;
    Gx._lastReturnedSpySite = undefined;
    if (!spaceId) return true;
    const me = ctx.G.players[ctx.actorId];
    const killed = assassinateTroop(ctx.G, spaceId);
    if (!killed) return true;
    if (killed === 'white') me.trophyHall.white += 1;
    else if (killed !== me.color) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} assassinated ${killed} at ${spaceId}`,
      { kind: 'troop.assassinate', payload: { site: spaceId, target: killed }, side: ctx.actorId });
    return true;
  };
}

export function supplantAtLastReturnedSpySite(): EffectHandler {
  return ctx => {
    // Stash the target site in handlerState so it survives across the
    // prompt→click pause. Previously this cleared `_lastReturnedSpySite` on the
    // first call, then re-read it after resume → undefined → silent no-op.
    const Gx = ctx.G as unknown as { _lastReturnedSpySite?: string };
    const stashed = ctx.handlerState as { siteId?: string } | null;
    const siteId = stashed?.siteId ?? Gx._lastReturnedSpySite;
    if (!siteId) { ctx.handlerState = null; return true; }
    ctx.handlerState = { siteId };
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      // Only spaces at that site, occupied by an enemy.
      const eligible = TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id)
        .filter(id => {
          const occ = ctx.G.troops[id];
          return occ && occ !== me.color;
        });
      if (eligible.length === 0) return true;
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Supplant a troop at ${siteId}.`,
        options: eligible,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    ctx.handlerState = null;
    Gx._lastReturnedSpySite = undefined;
    if (!spaceId) return true;
    const me = ctx.G.players[ctx.actorId];
    const killed = assassinateTroop(ctx.G, spaceId);
    if (!killed) return true;
    if (killed === 'white') me.trophyHall.white += 1;
    else if (killed !== me.color) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
    if (me.barracksLeft > 0) {
      if (deployTroop(ctx.G, me.color, spaceId)) {
        me.barracksLeft -= 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} (barracks: ${me.barracksLeft})`,
          { kind: 'troop.supplant', payload: { site: spaceId, target: killed }, side: ctx.actorId });
      }
    } else {
      me.vp += 1;
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} — barracks empty, +1 VP`,
        { kind: 'troop.supplant', payload: { site: spaceId, target: killed, barracksEmpty: true }, side: ctx.actorId });
    }
    return true;
  };
}

// ---------- Troop-space targeting helpers ----------

/** Spaces a player has presence at (the legal targets for assassinate/return from spaces).
 *  Filtered to spaces in active sections only (membership in G.troops). */
export function spacesWithPresence(G: import('../game').TyrantsState, color: import('../game').Color): string[] {
  const out: string[] = [];
  for (const ts of TROOP_SPACES) {
    if (!(ts.id in G.troops)) continue;
    if (ts.parentSite) {
      if (hasPresence(G, color, { site: ts.parentSite })) out.push(ts.id);
    } else if (ts.parentRoute) {
      if (hasPresence(G, color, { space: ts.id })) out.push(ts.id);
    }
  }
  return out;
}

/** Empty spaces the player may deploy into (presence required unless `anywhere` is true,
 *  per rulebook p.12). Restricted to spaces in active sections — inactive
 *  spaces are absent from G.troops entirely (their id is not a key), so the
 *  `id in G.troops` test acts as both an "exists" and "in play" check. */
function legalDeployTargets(
  G: import('../game').TyrantsState,
  color: import('../game').Color,
  anywhere: boolean
): string[] {
  const empty = TROOP_SPACES.filter(ts => ts.id in G.troops && G.troops[ts.id] === null);
  if (anywhere) return empty.map(ts => ts.id);
  const out: string[] = [];
  for (const ts of empty) {
    if (ts.parentSite && hasPresence(G, color, { site: ts.parentSite })) out.push(ts.id);
    else if (ts.parentRoute && hasPresence(G, color, { space: ts.id })) out.push(ts.id);
  }
  return out;
}

/** Assassinate `count` enemy troops the player has presence at. Trophy hall is auto-updated. */
export function assassinateChoice(opts?: { count?: number; whiteOnly?: boolean; sameSite?: boolean; optional?: boolean }): EffectHandler {
  const count = opts?.count ?? 1;
  // The "site key" of a troop space is the segment before the colon — the
  // parentSite for site spaces, the parentRoute for route spaces (see
  // data/troop-spaces.ts: ids are `${site|route}:${index}`). Death Tyrant
  // ("up to 3 troops at a single site") locks every kill after the first to
  // the first target's site key.
  const siteKeyOf = (spaceId: string) => spaceId.split(':')[0];
  return ctx => {
    let state = (ctx.handlerState as { remaining: number; site?: string } | null) ?? { remaining: count };

    // 1. Process the prior response, if any.
    if (ctx.pendingChoice) {
      const spaceId = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!spaceId) { ctx.handlerState = null; return true; }
      const killed = assassinateTroop(ctx.G, spaceId);
      if (killed === 'white') ctx.G.players[ctx.actorId].trophyHall.white += 1;
      else if (killed) ctx.G.players[ctx.actorId].trophyHall[killed] = (ctx.G.players[ctx.actorId].trophyHall[killed] ?? 0) + 1;
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} assassinated ${killed} at ${spaceId}`,
      { kind: 'troop.assassinate', payload: { site: spaceId, target: killed }, side: ctx.actorId });
      // Lock subsequent kills to this site when sameSite is set.
      const lockedSite = opts?.sameSite ? (state.site ?? siteKeyOf(spaceId)) : undefined;
      state = { remaining: state.remaining - 1, site: lockedSite };
    }

    // 2. Set up next prompt or finish.
    if (state.remaining <= 0) { ctx.handlerState = null; return true; }
    const me = ctx.G.players[ctx.actorId];
    const eligible = spacesWithPresence(ctx.G, me.color).filter(id => {
      const occ = ctx.G.troops[id];
      if (!occ || occ === me.color) return false;
      if (opts?.whiteOnly && occ !== 'white') return false;
      if (opts?.sameSite && state.site && siteKeyOf(id) !== state.site) return false;
      return true;
    });
    if (eligible.length === 0) {
      Mechanics.log(ctx.G, `(${opts?.whiteOnly ? 'assassinate white' : 'assassinate'}: no eligible targets at any space where you have presence — skipped)`);
      ctx.handlerState = null;
      return true;
    }
    ctx.pendingChoice = {
      kind: 'select-troop-space',
      prompt: opts?.whiteOnly ? `Assassinate a white troop (${state.remaining} left).` : `Assassinate an enemy troop (${state.remaining} left).`,
      options: eligible,
      optional: opts?.optional,
    } as PendingChoice;
    ctx.paused = true;
    ctx.handlerState = state;
    return false;
  };
}

/** Deploy `count` of the player's own troops. `anywhere` waives presence checks. */
export function deployChoice(opts?: { count?: number; anywhere?: boolean; costless?: boolean; optional?: boolean}): EffectHandler {
  const count = opts?.count ?? 1;
  return ctx => {
    let state = (ctx.handlerState as { remaining: number } | null) ?? { remaining: count };

    // 1. Process the prior response, if any.
    if (ctx.pendingChoice) {
      const spaceId = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!spaceId) { ctx.handlerState = null; return true; }
      const me = ctx.G.players[ctx.actorId];
      // Costless: the token isn't coming from this player's barracks (e.g. Orcus
      // moves an opponent's troop from their trophy hall onto the board as the
      // active player's color). Skip the barracks bookkeeping and the
      // empty-barracks → +1 VP fallback.
      if (opts?.costless) {
        if (deployTroop(ctx.G, me.color, spaceId)) {
          Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} placed a free troop at ${spaceId}`,
            { kind: 'troop.deploy', payload: { site: spaceId, free: true }, side: ctx.actorId });
        }
      } else if (me.barracksLeft <= 0) {
        // Rulebook p.12: with empty barracks, each deploy converts to +1 VP
        // instead of placing a token.
        me.vp += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} deploy → +1 VP (barracks empty)`);
      } else if (deployTroop(ctx.G, me.color, spaceId)) {
        me.barracksLeft -= 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} deployed at ${spaceId} (barracks: ${me.barracksLeft})`,
        { kind: 'troop.deploy', payload: { site: spaceId }, side: ctx.actorId });
      }
      state = { remaining: state.remaining - 1 };
    }

    // 2. Set up next prompt or finish.
    if (state.remaining <= 0) { ctx.handlerState = null; return true; }
    const me = ctx.G.players[ctx.actorId];
    const eligible = legalDeployTargets(ctx.G, me.color, !!opts?.anywhere);
    if (eligible.length === 0) {
      Mechanics.log(ctx.G, `(deploy: no empty space ${opts?.anywhere ? 'on the board' : 'where you have presence'} — skipped)`);
      ctx.handlerState = null;
      return true;
    }
    ctx.pendingChoice = {
      kind: 'select-troop-space',
      prompt: `Deploy a troop (${state.remaining} left).${opts?.anywhere ? ' Anywhere on the board.' : ''}`,
      options: eligible,
      optional: opts?.optional,
    } as PendingChoice;
    ctx.paused = true;
    ctx.handlerState = state;
    return false;
  };
}

/** Supplant: assassinate a target and then deploy in the same space. */
export function supplantChoice(opts?: { whiteOnly?: boolean; anywhere?: boolean; optional?: boolean }): EffectHandler {
  return ctx => {
    const state = (ctx.handlerState as { picked?: string } | null) ?? {};
    if (!ctx.pendingChoice && !state.picked) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = (opts?.anywhere
        ? TROOP_SPACES.map(t => t.id).filter(id => {
            const occ = ctx.G.troops[id];
            return occ && occ !== me.color && (!opts?.whiteOnly || occ === 'white');
          })
        : spacesWithPresence(ctx.G, me.color).filter(id => {
            const occ = ctx.G.troops[id];
            return occ && occ !== me.color && (!opts?.whiteOnly || occ === 'white');
          })
      );
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, `(supplant${opts?.whiteOnly ? ' white' : ''}: no eligible targets ${opts?.anywhere ? 'on the board' : 'where you have presence'} — skipped)`);
        ctx.handlerState = null;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: opts?.whiteOnly ? 'Supplant a white troop.' : 'Supplant a troop.',
        options: eligible,
        optional:  opts?.optional,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    if (ctx.pendingChoice) {
      const spaceId = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!spaceId) { ctx.handlerState = null; return true; }
      const me = ctx.G.players[ctx.actorId];
      const killed = assassinateTroop(ctx.G, spaceId);
      if (!killed) {
        Mechanics.log(ctx.G, `(supplant skipped: no troop at ${spaceId})`);
        ctx.handlerState = null;
        return true;
      }
      if (killed === 'white') me.trophyHall.white += 1;
      else if (killed !== me.color) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
      // Per rulebook: supplant = assassinate + deploy. The placed troop comes from
      // your barracks; if your barracks is empty, treat per p.12 (deploy converts to
      // +1 VP token instead). We still place a token visually but cap barracks at 0.
      if (me.barracksLeft > 0) {
        if (deployTroop(ctx.G, me.color, spaceId)) {
          me.barracksLeft -= 1;
          Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} (barracks: ${me.barracksLeft})`,
          { kind: 'troop.supplant', payload: { site: spaceId, target: killed }, side: ctx.actorId });
        }
      } else {
        me.vp += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} — barracks empty, +1 VP instead of deploy`,
        { kind: 'troop.supplant', payload: { site: spaceId, target: killed, barracksEmpty: true }, side: ctx.actorId });
      }
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Choose one of N sub-handlers ----------
//
// Surfaces a choose-one PendingChoice, then runs the picked sub-handler. The sub-handler
// may suspend; state is preserved across resumptions in `handlerState`.

export interface ChoiceOption {
  label: string;
  handler: EffectHandler;
  /** Predicate: option is offered only when this returns true. Used to hide options
   *  whose action isn't currently legal (e.g. "return a spy → ..." when you have no
   *  spies on the board). Eligibility is re-evaluated when the prompt is set up, not
   *  on every state tick. */
  available?: (G: import('../game').TyrantsState, actorId: string) => boolean;
}

interface ChooseOneState { selectedLabel: string | null; childState: unknown }

export function chooseOne(...opts: ChoiceOption[]): EffectHandler {
  return ctx => {
    let state = (ctx.handlerState as ChooseOneState | null) ?? { selectedLabel: null, childState: null };

    // Phase 1: present choice (filter to legal options), capture response on resume.
    if (state.selectedLabel === null) {
      const legal = opts.filter(o => !o.available || o.available(ctx.G, ctx.actorId));
      if (legal.length === 0) {
        // All options are blocked by their `available` predicates — log it
        // so the user understands why the card produced no visible effect.
        Mechanics.log(ctx.G, '(chooseOne: no legal options — skipped)');
        ctx.handlerState = null;
        return true;
      }

      if (!ctx.pendingChoice) {
        ctx.pendingChoice = {
          kind: 'choose-one',
          prompt: 'Choose one:',
          options: legal.map(o => o.label),
        } as PendingChoice;
        ctx.paused = true;
        return false;
      }
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null || idx < 0 || idx >= legal.length) { ctx.handlerState = null; return true; }
      state = { selectedLabel: legal[idx].label, childState: null };
    }

    // Phase 2: run the selected sub-handler (matched by label so we don't store
    // functions in the immer-tracked state).
    const selectedOpt = opts.find(o => o.label === state.selectedLabel);
    if (!selectedOpt) { ctx.handlerState = null; return true; }
    const childCtx: EffectContext = {
      ...ctx,
      pendingChoice: ctx.pendingChoice,
      handlerState: state.childState,
      paused: ctx.paused,
    };
    const done = selectedOpt.handler(childCtx);
    if (!done) {
      ctx.pendingChoice = childCtx.pendingChoice;
      ctx.paused = true;
      ctx.handlerState = { selectedLabel: state.selectedLabel, childState: childCtx.handlerState };
      return false;
    }
    // Propagate well-known top-level flags the engine reads off the
    // outermost handlerState (currently just `returnedToSupply` —
    // devourSelfThen / Insane Outcast). Otherwise wiping with `null`
    // erased the flag and the card stayed in cardsPlayedThisTurn /
    // discard — visible as Cultist of Myrkul being offered for end-of-
    // turn promotion after it self-devoured.
    const childFlags = childCtx.handlerState as { returnedToSupply?: boolean } | null;
    if (childFlags?.returnedToSupply) ctx.handlerState = { returnedToSupply: true };
    else ctx.handlerState = null;
    return true;
  };
}

// ---------- Common availability predicates ----------

/** True when the player has at least one spy on the board AND at least one of
 *  those spy sites has a troop the player could supplant (i.e. an enemy or
 *  white troop in any slot of that site). Used to gate Graz'zt's
 *  "return-spies-and-supplant" option so it isn't offered when no spy can
 *  produce a benefit. */
export function playerHasUsefulSpyForSupplant(G: import('../game').TyrantsState, actorId: string): boolean {
  const color = G.players[actorId].color;
  for (const s of SITES) {
    if (!(G.spies[s.id] ?? []).includes(color)) continue;
    // Site has my spy; does it have a troop I could supplant?
    for (const t of TROOP_SPACES) {
      if (t.parentSite !== s.id) continue;
      const occ = G.troops[t.id];
      if (occ && occ !== color) return true;
    }
  }
  return false;
}

export function playerHasOwnSpy(G: import('../game').TyrantsState, actorId: string): boolean {
  const color = G.players[actorId].color;
  for (const arr of Object.values(G.spies)) if (arr.includes(color)) return true;
  return false;
}

export function playerHasOwnTroopOnBoard(G: import('../game').TyrantsState, actorId: string, opts?: {returnFailsafe?: boolean}): boolean {
  const color = G.players[actorId].color;
  // This is a failsafe to avoid a player removing their only troop
  const returnFailsafeOn = opts?.returnFailsafe ?? false;
  if (returnFailsafeOn) {
    let count = 0;
    for (const t of Object.values(G.troops)) {
      if (t === color) {
        count++;
        // Optional optimization: exit early as soon as we find at least 2
        if (count >= 2) return true;
      }
    }
  } else {
    for (const t of Object.values(G.troops)) if (t === color) return true;
  }
  return false;
}

// ---------- Move an enemy troop ----------
//
// Two-phase pick: first the enemy troop to move (any space with an enemy occupant — by
// rulebook p.11 "enemy" includes white troops), then the empty destination space (anywhere
// on the board). Loops `count` times.

interface MoveState { remaining: number; from: string | null }

export function moveEnemyTroopChoice(opts?: { count?: number; optional?: boolean }): EffectHandler {
  const count = opts?.count ?? 1;
  return ctx => {
    let state = (ctx.handlerState as MoveState | null) ?? { remaining: count, from: null };

    // 1. Process any pending response from the previous prompt.
    if (ctx.pendingChoice) {
      const picked = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (state.from === null) {
        // Was the "pick troop to move" prompt.
        if (!picked) { ctx.handlerState = null; return true; }
        state = { remaining: state.remaining, from: picked };
      } else {
        // Was the "pick destination" prompt.
        if (picked && moveTroop(ctx.G, state.from, picked)) {
          Mechanics.log(ctx.G, `Moved troop ${state.from} → ${picked}`);
        }
        state = { remaining: state.remaining - 1, from: null };
      }
    }

    // 2. Decide what to do next.
    if (state.remaining <= 0) { ctx.handlerState = null; return true; }

    const me = ctx.G.players[ctx.actorId];
    if (state.from === null) {
      // Rulebook p.12 "Move a Troop": you may move a troop ONLY from a
      // space where you have Presence. Destination is unrestricted (any
      // empty troop space) — that part the handler already gets right.
      const eligible = TROOP_SPACES.filter(t => {
        if (!(t.id in ctx.G.troops)) return false;
        const occ = ctx.G.troops[t.id];
        if (!occ || occ === me.color) return false;
        if (t.parentSite) return hasPresence(ctx.G, me.color, { site: t.parentSite });
        if (t.parentRoute) return hasPresence(ctx.G, me.color, { space: t.id });
        return false;
      }).map(t => t.id);
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, '(move enemy troop: no enemy / white troops at any space where you have presence — skipped)');
        ctx.handlerState = null;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Move an enemy troop — pick the troop (${state.remaining} left).`,
        options: eligible,
        optional: opts?.optional,
      } as PendingChoice;
    } else {
      const empty = TROOP_SPACES.filter(t => t.id in ctx.G.troops && ctx.G.troops[t.id] === null).map(t => t.id);
      if (empty.length === 0) { ctx.handlerState = null; return true; }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Move the ${ctx.G.troops[state.from]} troop to which empty space?`,
        options: empty,
        optional: opts?.optional,
      } as PendingChoice;
    }
    ctx.paused = true;
    ctx.handlerState = state;
    return false;
  };
}

// ---------- Compose multiple sub-handlers in sequence ----------
//
// Runs sub-handlers in order; if any suspends, the parent suspends too. Resumes from
// the same sub-handler on the next call. Uses `handlerState` to track progress.

interface SeqState { stepIdx: number; childState: unknown }

export function sequence(...steps: EffectHandler[]): EffectHandler {
  return ctx => {
    let state = (ctx.handlerState as SeqState | null) ?? { stepIdx: 0, childState: null };
    while (state.stepIdx < steps.length) {
      // Run the current step with its preserved childState.
      const childCtx: EffectContext = {
        ...ctx,
        pendingChoice: ctx.pendingChoice,
        handlerState: state.childState,
        paused: ctx.paused,
      };
      const done = steps[state.stepIdx](childCtx);
      if (!done) {
        // Sub-handler suspended.
        ctx.pendingChoice = childCtx.pendingChoice;
        ctx.paused = true;
        ctx.handlerState = { stepIdx: state.stepIdx, childState: childCtx.handlerState };
        return false;
      }
      // Sub-handler completed; advance. Carry forward any returnedToSupply
      // flag the sub-handler set so a devour-self inside a sequence still
      // takes effect when the outer sequence ends (e.g. Revenant promotes
      // itself via handlerState.returnedToSupply after the assassinate
      // phase completes).
      const childFlags = childCtx.handlerState as { returnedToSupply?: boolean } | null;
      const carry = childFlags?.returnedToSupply ? true : (state as { returnedToSupply?: boolean }).returnedToSupply ?? false;
      state = { stepIdx: state.stepIdx + 1, childState: null, ...(carry ? { returnedToSupply: true } : {}) } as SeqState & { returnedToSupply?: boolean };
      // After resume of a sub-handler, clear pendingChoice for the next step.
      ctx.pendingChoice = null;
      ctx.paused = false;
    }
    const finalFlags = state as { returnedToSupply?: boolean };
    ctx.handlerState = finalFlags.returnedToSupply ? { returnedToSupply: true } : null;
    return true;
  };
}

// ---------- Focus keyword (Elemental half-deck) ----------
//
// Rulebook p.9: "Whenever you play a card with Focus, if you played another card of that
// card's aspect this turn OR if you reveal a card of that aspect from your hand, you get
// the Focus effect."
//
// Implementation: auto-triggers when `turnAspectsPlayed[aspect] > 1` (current card + at
// least one other of the same aspect already in the turn tally). The manual-reveal path
// is not yet supported; if the count is 1, the Focus effect is silently skipped.

interface FocusState { revealChecked?: boolean; childState?: unknown }

export function focus(aspect: string, bonus: EffectHandler): EffectHandler {
  const key = aspect.toLowerCase();
  return ctx => {
    let state = (ctx.handlerState as FocusState | null) ?? {};
    const count = ctx.G.turnAspectsPlayed[key] ?? 0;

    // Auto-trigger: another same-aspect card was already played this turn.
    if (count > 1) {
      if (!state.revealChecked) Mechanics.log(ctx.G, `Focus (${aspect}) triggered (chain).`);
      const childCtx: EffectContext = { ...ctx, pendingChoice: ctx.pendingChoice, handlerState: state.childState, paused: ctx.paused };
      const done = bonus(childCtx);
      if (!done) {
        ctx.pendingChoice = childCtx.pendingChoice; ctx.paused = true;
        ctx.handlerState = { revealChecked: true, childState: childCtx.handlerState };
        return false;
      }
      ctx.handlerState = null;
      return true;
    }

    // Otherwise surface a reveal prompt over aspect-matching hand cards.
    if (!state.revealChecked) {
      if (!ctx.pendingChoice) {
        const me = ctx.G.players[ctx.actorId];
        const eligible: number[] = [];
        for (let i = 0; i < me.hand.length; i++) {
          const d = lookupCard(me.hand[i].deck, me.hand[i].slot);
          if (d?.aspect.toLowerCase() === key) eligible.push(i);
        }
        if (eligible.length === 0) { ctx.handlerState = null; return true; } // no eligible reveal
        ctx.pendingChoice = {
          kind: 'select-card-in-hand',
          prompt: `Reveal a ${aspect} card from hand for the Focus bonus?`,
          options: eligible,
          optional: true,
        } as PendingChoice;
        ctx.paused = true;
        return false;
      }
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; } // declined
      Mechanics.log(ctx.G, `Focus (${aspect}) triggered (revealed).`);
      state = { revealChecked: true, childState: null };
    }

    const childCtx: EffectContext = { ...ctx, pendingChoice: ctx.pendingChoice, handlerState: state.childState, paused: ctx.paused };
    const done = bonus(childCtx);
    if (!done) {
      ctx.pendingChoice = childCtx.pendingChoice; ctx.paused = true;
      ctx.handlerState = { revealChecked: true, childState: childCtx.handlerState };
      return false;
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Promote the top card(s) of the player's deck ----------
//
// Pops the top of the deck and promotes it via Mechanics.promote, which already honors
// the Insane Outcast self-eject rule (returns to supply instead of joining inner circle).
// Reshuffles the discard into the deck if the deck is empty.

export function promoteTopOfDeck(opts?: { count?: number }): EffectHandler {
  const count = opts?.count ?? 1;
  return ctx => {
    const me = ctx.G.players[ctx.actorId];
    for (let i = 0; i < count; i++) {
      if (me.deck.length === 0) {
        if (me.discard.length === 0) break;
        // Deterministic Fisher-Yates with the boardgame.io seeded RNG when
        // available. Mirrors the shuffle in Mechanics.draw so promote-on-empty
        // and draw-on-empty behave the same way under replay.
        const rng = ctx.random ? () => ctx.random!.Number() : () => Math.random();
        const deck = me.discard.slice();
        for (let k = deck.length - 1; k > 0; k--) {
          const j = Math.floor(rng() * (k + 1));
          [deck[k], deck[j]] = [deck[j], deck[k]];
        }
        me.deck = deck;
        me.discard = [];
      }
      const card = me.deck.shift();
      if (!card) break;
      // Promoting the top of the deck reveals a previously-hidden card — bars undo.
      Mechanics.markInfoRevealed(ctx.G);
      Mechanics.promote(ctx.G, ctx.actorId, card);
    }
    return true;
  };
}

// ---------- Free filtered recruit from market ----------
//
// Aerisi Kalinoth / Gar Shatterkeel / Marlos Urnrayle / Vanifer all read:
//   "Recruit a [Aspect] card from the market that costs N or less."
// Surfaces a market picker filtered to slots matching aspect + cost cap. Recruit is
// free (no influence spent).

/** Free recruit (paid by an effect, not by influence) of a single card from
 *  the market row, with an optional aspect filter and cost ceiling.
 *
 *  When `includeAuxStacks` is true, House Guards (cost 3) and Priestesses
 *  (cost 5) are also offered as eligible picks if their cost meets the
 *  ceiling and there are copies left in the aux stack. Encoded as
 *  sentinel indices: -1 = houseGuards, -2 = priestesses. UI renders
 *  these alongside the market row; resolve dispatches to the right
 *  Mechanics helper. Used by Conjurer (#53). */
export function recruitFromMarketFiltered(opts: {
  aspect?: string;
  maxCost: number;
  includeAuxStacks?: boolean;
  quantity?: number;
  optional?: boolean;
}): EffectHandler {
  const count = opts.quantity ?? 1;
  return ctx => {
    let state = (ctx.handlerState as { remaining: number } | null) ?? { remaining: count };

    // 1. Process the prior response, if any.
    if (ctx.pendingChoice) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; } // declined mid-sequence
      if (idx === -1) {
        const HG = lookupCard('house-guards', 40);
        if (HG) Mechanics.recruitFromAuxStack(ctx.G, ctx.actorId, 'houseGuards',
          { deck: HG.deck, slot: HG.slot, name: HG.name, image: HG.image });
      } else if (idx === -2) {
        const PR = lookupCard('priestesses', 43);
        if (PR) Mechanics.recruitFromAuxStack(ctx.G, ctx.actorId, 'priestesses',
          { deck: PR.deck, slot: PR.slot, name: PR.name, image: PR.image });
      } else {
        Mechanics.recruitFromMarket(ctx.G, ctx.actorId, idx);
      }
      state = { remaining: state.remaining - 1 };
    }

    // 2. Set up next prompt or finish.
    if (state.remaining <= 0) { ctx.handlerState = null; return true; }
    const eligible: number[] = [];
    for (let i = 0; i < ctx.G.market.row.length; i++) {
      const c = ctx.G.market.row[i];
      if (!c) continue;
      const data = lookupCard(c.deck, c.slot);
      if (!data) continue;
      if (opts.aspect && data.aspect.toLowerCase() !== opts.aspect.toLowerCase()) continue;
      if (data.cost > opts.maxCost) continue;
      eligible.push(i);
    }
    if (opts.includeAuxStacks) {
      // House Guard: cost 3, drow/Obedience. Priestess of Lolth: cost 5,
      // drow/Obedience. Aspect filter applies; both are Obedience.
      const HG = lookupCard('house-guards', 40);
      const PR = lookupCard('priestesses', 43);
      if (HG && ctx.G.auxStacks.houseGuards > 0
        && HG.cost <= opts.maxCost
        && (!opts.aspect || HG.aspect.toLowerCase() === opts.aspect.toLowerCase())) {
        eligible.push(-1);
      }
      if (PR && ctx.G.auxStacks.priestesses > 0
        && PR.cost <= opts.maxCost
        && (!opts.aspect || PR.aspect.toLowerCase() === opts.aspect.toLowerCase())) {
        eligible.push(-2);
      }
    }
    if (eligible.length === 0) {
      if (state.remaining < count) {
        Mechanics.log(ctx.G, `(recruit: market layout changed or lacks eligible targets — remaining picks skipped)`);
      }
      ctx.handlerState = null;
      return true;
    }
    const label = opts.aspect ? `${opts.aspect} card` : 'card';
    const quantityTag = count > 1 ? ` (${state.remaining} left)` : '';
    ctx.pendingChoice = {
      kind: 'select-market-card',
      prompt: `Recruit a ${label} costing ≤${opts.maxCost} (free). ${quantityTag}`,
      options: eligible,
      optional: opts?.optional,
    } as PendingChoice;
    ctx.paused = true;
    ctx.handlerState = state;
    return false;
  };
}

// ---------- Give Insane Outcasts to opponents ----------
//
// Places a fresh Insane Outcast card into the target opponent's discard pile (rulebook
// p.13: "If the supply of … Insane Outcasts runs out, the game continues, but you'll no
// longer be able to recruit one of those cards."). We don't yet track the 30-card
// supply cap; that's deferred until end-game scoring needs it.

function makeOutcastRef(): CardRef | null {
  const data = cardsInDeck('insane-outcasts')[0];
  if (!data) return null;
  return { deck: data.deck, slot: data.slot, name: data.name, image: data.image };
}

/** "Give an Insane Outcast to each opponent" (rulebook-phrased: each opponent recruits one). */
export function giveOutcastToEachOpponent(opts?: { count?: number }): EffectHandler {
  const count = opts?.count ?? 1;
  return ctx => {
    const ref = makeOutcastRef();
    if (!ref) return true;
    for (const pid of Object.keys(ctx.G.players)) {
      if (pid === ctx.actorId) continue;
      for (let i = 0; i < count; i++) {
        ctx.G.players[pid].discard.push({ ...ref });
      }
      Mechanics.log(ctx.G, `P${Number(pid) + 1} received ${count} Insane Outcast${count > 1 ? 's' : ''}`);
    }
    return true;
  };
}

/** "Give an Insane Outcast to a chosen opponent." Surfaces a select-player picker. */
export function giveOutcastToChosenOpponent(): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const opponents = Object.keys(ctx.G.players).filter(id => id !== ctx.actorId);
      if (opponents.length === 0) return true;
      ctx.pendingChoice = {
        kind: 'select-player',
        prompt: 'Give an Insane Outcast to which opponent?',
        options: opponents,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const pid = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!pid) return true;
    const ref = makeOutcastRef();
    if (!ref) return true;
    ctx.G.players[pid].discard.push({ ...ref });
    Mechanics.log(ctx.G, `P${Number(pid) + 1} received Insane Outcast`);
    return true;
  };
}

// ---------- Whole-deck-to-discard + promote-from-discard (Matron Mother) ----------

export function moveDeckToDiscard(): EffectHandler {
  return ctx => {
    const me = ctx.G.players[ctx.actorId];
    if (me.deck.length === 0) return true;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} moved ${me.deck.length} cards from deck to discard`);
    me.discard.push(...me.deck);
    me.deck = [];
    return true;
  };
}

export function promoteFromDiscardChoice(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      // Cards played this turn sit in the player's PLAY AREA per the rules, but
      // the engine also pushes them into `discard` during the turn. Effects that
      // promote "from your discard pile" (Matron Mother, Necromancer) must NOT
      // offer those play-area cards (#65). Exclude one discard entry per
      // card-played-this-turn (by deck::slot, multiset — handles duplicates).
      const playedLeft = new Map<string, number>();
      for (const c of ctx.G.cardsPlayedThisTurn) {
        const k = `${c.deck}::${c.slot}`;
        playedLeft.set(k, (playedLeft.get(k) ?? 0) + 1);
      }
      const options: number[] = [];
      for (let i = 0; i < me.discard.length; i++) {
        const c = me.discard[i];
        const k = `${c.deck}::${c.slot}`;
        const n = playedLeft.get(k) ?? 0;
        if (n > 0) { playedLeft.set(k, n - 1); continue; } // play-area card — skip
        options.push(i);
      }
      if (options.length === 0) {
        // No eligible cards, so no picker opens. Players reported this as a
        // silent no-op — they chose "promote from discard" and nothing
        // happened, with no explanation (#86 Vampire / #87 Necromancer). The
        // promote is correctly skipped (and any later effect, e.g. Vampire's
        // VP, still applies), but surface a note so the player understands
        // why the prompt never appeared. Distinguish a truly empty discard
        // from "everything in the discard is a card played this turn" — the
        // latter is the common case (cards played this turn sit in the play
        // area, not the discard pile, per #65) and is the more confusing one.
        const name = ctx.card?.name ?? 'This card';
        const msg = me.discard.length > 0
          ? `(${name}: no cards in your discard pile to promote — cards played this turn don't count)`
          : `(${name}: your discard pile is empty — nothing to promote)`;
        Mechanics.log(ctx.G, msg);
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-card-in-discard',
        prompt: 'Promote a card from your discard.',
        options,
        optional: opts?.optional,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const idx = ctx.pendingChoice.response as number | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (idx == null) return true;
    const me = ctx.G.players[ctx.actorId];
    const card = me.discard[idx];
    if (!card) return true;
    me.discard.splice(idx, 1);
    Mechanics.promote(ctx.G, ctx.actorId, card);
    return true;
  };
}

// ---------- End-of-turn inner-circle VP (Blue Dragon) ----------

/** Queue an end-of-turn "gain 1 VP per `perN` cards in your inner circle" grant.
 *  Blue Dragon: "At end of turn, promote up to 2 …, THEN gain 1 VP for every 3
 *  cards in your inner circle." The grant is deferred to turn.onEnd
 *  (applyEotInnerCircleVp) so it counts the cards promoted this turn. Per the
 *  rulebook this is an immediate "gain VP" (VP tokens), NOT an end-of-game
 *  rider — its only special timing is "end of turn." */
export function flagEotInnerCircleVp(perN: number): EffectHandler {
  return ctx => {
    if (!ctx.G.pendingEotInnerCircleVp) ctx.G.pendingEotInnerCircleVp = [];
    ctx.G.pendingEotInnerCircleVp.push({ playerId: ctx.actorId, perN, source: ctx.card.name });
    return true;
  };
}

/** Drain G.pendingEotInnerCircleVp, awarding each queued inner-circle VP bonus.
 *  Called from turn.onEnd, once this turn's promotes have resolved so the
 *  inner-circle count is final. */
export function applyEotInnerCircleVp(G: TyrantsState): void {
  const queue = G.pendingEotInnerCircleVp;
  if (!queue || queue.length === 0) return;
  for (const g of queue) {
    const pl = G.players[g.playerId];
    if (!pl) continue;
    const vp = Math.floor(pl.innerCircle.length / g.perN);
    if (vp > 0) Mechanics.gainVpTokens(G, g.playerId, vp);
    else Mechanics.log(G, `(${g.source}: inner circle has fewer than ${g.perN} cards — +0 VP)`);
  }
  G.pendingEotInnerCircleVp = [];
}

// ---------- Devour-from-inner-circle optional cost (Zuggtmoy) ----------

interface DevourICState { paid?: boolean; childState?: unknown }

export function devourFromInnerCircleCost(thenEffect: EffectHandler, opts?: { promptLabel?: string }): EffectHandler {
  return ctx => {
    let state = (ctx.handlerState as DevourICState | null) ?? {};
    if (!state.paid) {
      if (!ctx.pendingChoice) {
        const me = ctx.G.players[ctx.actorId];
        if (me.innerCircle.length === 0) { ctx.handlerState = null; return true; }
        ctx.pendingChoice = {
          kind: 'select-card-in-inner-circle',
          prompt: opts?.promptLabel ?? 'Devour a card from your inner circle to trigger this effect?',
          options: me.innerCircle.map((_, i) => i),
          optional: true,
        } as PendingChoice;
        ctx.paused = true;
        return false;
      }
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; }
      const me = ctx.G.players[ctx.actorId];
      const card = me.innerCircle[idx];
      if (!card) { ctx.handlerState = null; return true; }
      me.innerCircle.splice(idx, 1);
      Mechanics.devour(ctx.G, card);
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} devoured ${card.name} from inner circle`,
      { kind: 'card.devour', payload: { card: card.name, from: 'inner-circle' }, side: ctx.actorId });
      state = { paid: true, childState: null };
    }
    const childCtx: EffectContext = {
      ...ctx,
      pendingChoice: ctx.pendingChoice,
      handlerState: state.childState,
      paused: ctx.paused,
    };
    const done = thenEffect(childCtx);
    if (!done) {
      ctx.pendingChoice = childCtx.pendingChoice;
      ctx.paused = true;
      ctx.handlerState = { paid: true, childState: childCtx.handlerState };
      return false;
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Return one of your own troops (rulebook p.13) ----------
//
// Return from a troop space or site anywhere on the board to your barracks.

export function returnOwnTroopChoice(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = TROOP_SPACES.filter(t => ctx.G.troops[t.id] === me.color).map(t => t.id);
      // Skip at 0 troops (nothing to return) AND at 1 (the "can't return your
      // last troop" failsafe — callers also gate the option behind a >=2 check).
      // `<= 0` alone would let a mandatory choice surface over an empty options
      // list, which the UI can't resolve (no targets, no decline) → softlock.
      if (eligible.length <= 1) {
        Mechanics.log(ctx.G, eligible.length === 0
          ? '(return own troop: you have no troops on the board — skipped)'
          : '(return own troop: only your last troop remains — skipped)');
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: 'Return one of your troops to barracks.',
        options: eligible,
        optional: opts?.optional,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!spaceId) return true;
    const me = ctx.G.players[ctx.actorId];
    if (ctx.G.troops[spaceId] === me.color) {
      ctx.G.troops[spaceId] = null;
      me.barracksLeft += 1;
      Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned troop ${spaceId} to barracks`);
    }
    return true;
  };
}

/** "Return one of your troops or spies" — chooses kind first, then targets. */
export function returnOwnTroopOrSpyChoice(): EffectHandler {
  return chooseOne(
    { label: 'Return one of your troops', handler: returnOwnTroopChoice({ optional: false }) },
    { label: 'Return one of your spies',  handler: returnOwnSpyChoice() },
  );
}

/** Return an enemy troop from a space where you have presence (rulebook p.13).
 *  Pass `{ includeWhite: true }` for cards that explicitly let you return
 *  white (Underdark) troops too — Intellect Devourer reads "return up to 2
 *  troops or spies", which in the rulebook covers white as well as
 *  opposing-player colors. */
export function returnEnemyTroopChoice(opts?: { includeWhite?: boolean }): EffectHandler {
  const includeWhite = !!opts?.includeWhite;
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = TROOP_SPACES.filter(t => {
        const occ = ctx.G.troops[t.id];
        if (!occ || occ === me.color) return false;
        if (!includeWhite && occ === 'white') return false;
        if (t.parentSite) return hasPresence(ctx.G, me.color, { site: t.parentSite });
        if (t.parentRoute) return hasPresence(ctx.G, me.color, { space: t.id });
        return false;
      }).map(t => t.id);
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, '(return troop: no eligible troops at any space where you have presence — skipped)');
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: includeWhite
          ? "Return a troop (white or enemy) to its owner's barracks."
          : "Return an enemy troop (to its owner's barracks).",
        options: eligible,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const spaceId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!spaceId) return true;
    const occ = ctx.G.troops[spaceId];
    if (occ && (occ !== 'white' || includeWhite)) {
      // Use returnTroop so the site-control recompute fires (and the
      // marker transfer / return-to-map logic runs). The earlier
      // implementation null'd the slot directly, which left
      // G.siteControl and the marker holder stale until the next mutation
      // triggered a recompute — visible as "I returned the enemy's
      // troop but the marker still says they control the site".
      const returned = returnTroop(ctx.G, spaceId);
      if (returned && returned !== 'white') {
        const ownerEntry = Object.entries(ctx.G.players).find(([, p]) => p.color === returned);
        if (ownerEntry) ownerEntry[1].barracksLeft += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned ${returned} troop from ${spaceId}`);
      } else if (returned === 'white') {
        // White troops return to the common supply (not tracked per-player).
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned white troop from ${spaceId}`);
      }
    }
    return true;
  };
}

/** Return an enemy spy from a site where you have presence (rulebook p.13). */
export function returnEnemySpyChoice(): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      const eligible = SITES.filter(s => {
        if (!hasPresence(ctx.G, me.color, { site: s.id })) return false;
        return (ctx.G.spies[s.id] ?? []).some(c => c !== me.color);
      }).map(s => s.id);
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, '(return enemy spy: no enemy spies at any site where you have presence — skipped)');
        return true;
      }
      ctx.pendingChoice = {
        kind: 'select-site',
        prompt: 'Return an enemy spy from which site?',
        options: eligible,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const siteId = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!siteId) return true;
    const me = ctx.G.players[ctx.actorId];
    const arr = ctx.G.spies[siteId] ?? [];
    const enemyColor = arr.find(c => c !== me.color);
    if (enemyColor) {
      if (returnSpy(ctx.G, enemyColor, siteId)) {
        // The returned spy goes back to its owner's supply, not yours.
        ensureSpiesLeftInitialized(ctx.G, enemyColor);
        const ownerPid = Object.keys(ctx.G.players).find(k => ctx.G.players[k].color === enemyColor);
        if (ownerPid) ctx.G.players[ownerPid].spiesLeft += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned ${enemyColor} spy from ${siteId}`);
      }
    }
    return true;
  };
}

/** "Return an enemy troop or spy" — Blue Wyrmling's secondary effect.
 *  Pass `{ includeWhite: true }` to also let the player return white
 *  (Underdark) troops — used by Intellect Devourer.
 *  Pass `{ fizzleIfNoTargets: true }` to set _playFizzledNoFood when
 *  no enemy troops or spies are returnable, preventing "play all basic"
 *  from auto-playing the card for zero effect (e.g. High Priest of Myrkul). */
export function returnEnemyTroopOrSpyChoice(opts?: { includeWhite?: boolean; fizzleIfNoTargets?: boolean }): EffectHandler {
  const includeWhite = !!opts?.includeWhite;
  const fizzleIfNoTargets = !!opts?.fizzleIfNoTargets;
  return ctx => {
    // When fizzleIfNoTargets is set, check upfront whether either option has
    // any valid targets. If not, mark the fizzle flag so the "Play all basic"
    // classifier skips this card — exactly as devourFromHandCost does when
    // the hand is empty.
    if (fizzleIfNoTargets && !ctx.pendingChoice && !ctx.handlerState) {
      const troopAvailable = includeWhite
        ? playerCanReturnAnyTroop(ctx.G, ctx.actorId)
        : playerCanReturnEnemyTroop(ctx.G, ctx.actorId);
      const spyAvailable = playerCanReturnEnemySpy(ctx.G, ctx.actorId);
      if (!troopAvailable && !spyAvailable) {
        (ctx.G as unknown as { _playFizzledNoFood?: boolean })._playFizzledNoFood = true;
        ctx.handlerState = null;
        Mechanics.log(ctx.G, '(return enemy troop or spy: no valid targets available — skipped)');
        return true;
      }
    }
    return chooseOne(
      {
        label: includeWhite ? 'Return a troop (white or enemy)' : 'Return an enemy troop',
        handler: returnEnemyTroopChoice({ includeWhite }),
        available: includeWhite ? playerCanReturnAnyTroop : playerCanReturnEnemyTroop,
      },
      { label: 'Return an enemy spy', handler: returnEnemySpyChoice(), available: playerCanReturnEnemySpy },
    )(ctx);
  };
}

/** True when the player has at least one enemy player-color troop they could
 *  legally return — i.e. a troop in a space where they have presence. */
export function playerCanReturnEnemyTroop(G: import('../game').TyrantsState, actorId: string): boolean {
  const me = G.players[actorId];
  for (const t of TROOP_SPACES) {
    const occ = G.troops[t.id];
    if (!occ || occ === me.color || occ === 'white') continue;
    if (t.parentSite && hasPresence(G, me.color, { site: t.parentSite })) return true;
    if (t.parentRoute && hasPresence(G, me.color, { space: t.id })) return true;
  }
  return false;
}

/** Same as playerCanReturnEnemyTroop but also accepts white troops as
 *  eligible — used by Intellect Devourer. */
export function playerCanReturnAnyTroop(G: import('../game').TyrantsState, actorId: string): boolean {
  const me = G.players[actorId];
  for (const t of TROOP_SPACES) {
    const occ = G.troops[t.id];
    if (!occ || occ === me.color) continue;
    if (t.parentSite && hasPresence(G, me.color, { site: t.parentSite })) return true;
    if (t.parentRoute && hasPresence(G, me.color, { space: t.id })) return true;
  }
  return false;
}

/** True when the player has at least one troop they could legally assassinate
 *  — a non-self, non-empty troop in a space where they have presence.
 *  `whiteOnly` restricts the eligible-target set to the white pile (used by
 *  Weaponmaster's "Assassinate a white troop" option so it doesn't surface
 *  when no whites are within reach). */
export function playerCanAssassinate(
  G: import('../game').TyrantsState,
  actorId: string,
  opts?: { whiteOnly?: boolean },
): boolean {
  const me = G.players[actorId];
  for (const t of TROOP_SPACES) {
    if (!(t.id in G.troops)) continue; // outside active sections
    const occ = G.troops[t.id];
    if (!occ || occ === me.color) continue;
    if (opts?.whiteOnly && occ !== 'white') continue;
    if (t.parentSite && hasPresence(G, me.color, { site: t.parentSite })) return true;
    if (t.parentRoute && hasPresence(G, me.color, { space: t.id })) return true;
  }
  return false;
}

/** True when the player has at least one enemy spy they could legally return —
 *  a spy at a site where the player has presence. */
export function playerCanReturnEnemySpy(G: import('../game').TyrantsState, actorId: string): boolean {
  const me = G.players[actorId];
  for (const s of SITES) {
    if (!hasPresence(G, me.color, { site: s.id })) continue;
    if ((G.spies[s.id] ?? []).some(c => c !== me.color)) return true;
  }
  return false;
}

// ---------- Conditional grants gated on the last placed spy site ----------
//
// Three variants over `_lastPlacedSpySite` (stashed by placeSpyAtChosenSite):
//   - ifTroopAtLastPlacedSpySite           — your own troop at the site
//   - ifEnemyTroopAtLastPlacedSpySite      — any non-self troop (incl. white)
//   - ifAnotherPlayerTroopAtLastPlacedSpySite
//       — strictly another PLAYER's troop (non-self, non-white). This is the
//         exact phrasing on Infiltrator's printed card ("another player's
//         troop"), and white/unaligned troops don't satisfy "another player".

export function ifTroopAtLastPlacedSpySite(bonus: EffectHandler): EffectHandler {
  return ctx => {
    const siteId = (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
    if (!siteId) return true;
    const me = ctx.G.players[ctx.actorId];
    const hasTroop = TROOP_SPACES.some(t => t.parentSite === siteId && ctx.G.troops[t.id] === me.color);
    if (!hasTroop) return true;
    Mechanics.log(ctx.G, `(spy-site own-troop bonus triggered at ${siteId})`);
    return bonus(ctx);
  };
}

/** Bonus only fires if at least one space at the spy's site has a troop
 *  owned by another PLAYER (i.e. an enemy color — white doesn't count, since
 *  white is unaligned, not "another player"). */
export function ifAnotherPlayerTroopAtLastPlacedSpySite(bonus: EffectHandler): EffectHandler {
  return ctx => {
    const siteId = (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
    if (!siteId) return true;
    const me = ctx.G.players[ctx.actorId];
    const hasOpponent = TROOP_SPACES.some(t => {
      if (t.parentSite !== siteId) return false;
      const occ = ctx.G.troops[t.id];
      return !!occ && occ !== me.color && occ !== 'white';
    });
    if (!hasOpponent) return true;
    Mechanics.log(ctx.G, `(spy-site another-player-troop bonus triggered at ${siteId})`);
    return bonus(ctx);
  };
}

/** "If an enemy troop is at the spy-placed site, run bonus."
 *  Used by Green Wyrmling: place a spy, then if enemy troops at that site, +2 Influence.
 *  "Enemy" includes white troops per rulebook p.11. */
export function ifEnemyTroopAtLastPlacedSpySite(bonus: EffectHandler): EffectHandler {
  return ctx => {
    const siteId = (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
    if (!siteId) return true;
    const me = ctx.G.players[ctx.actorId];
    const hasEnemy = TROOP_SPACES.some(t => {
      if (t.parentSite !== siteId) return false;
      const occ = ctx.G.troops[t.id];
      return occ && occ !== me.color;
    });
    if (!hasEnemy) return true;
    Mechanics.log(ctx.G, `(spy-site enemy-troop bonus triggered at ${siteId})`);
    return bonus(ctx);
  };
}

// ---------- Devour a market card ----------

export function devourMarketChoice(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const eligible: number[] = [];
      for (let i = 0; i < ctx.G.market.row.length; i++) if (ctx.G.market.row[i]) eligible.push(i);
      if (eligible.length === 0) return true;
      ctx.pendingChoice = {
        kind: 'select-market-card',
        prompt: 'Devour a card in the market.',
        options: eligible,
        optional: opts?.optional ?? true,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const idx = ctx.pendingChoice.response as number | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (idx == null) return true;
    const card = ctx.G.market.row[idx];
    if (!card) return true;
    Mechanics.devour(ctx.G, card);
    const refill = ctx.G.market.deck.shift() ?? null;
    if (refill) Mechanics.markInfoRevealed(ctx.G);
    ctx.G.market.row[idx] = refill;
    return true;
  };
}

// ---------- Add an Insane Outcast to your own discard (e.g. Derro) ----------

export function recruitOutcastToSelf(): EffectHandler {
  return ctx => {
    const ref = makeOutcastRef();
    if (!ref) return true;
    ctx.G.players[ctx.actorId].discard.push({ ...ref });
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} added Insane Outcast to discard`);
    return true;
  };
}

// ---------- Adjacency-aware Outcast giver (Gibbering Mouther) ----------
//
// After a deploy, give an Outcast to a player who has a troop "adjacent" to the just-
// deployed space. Adjacency follows the rulebook's space-level definition (rules p.10,
// p.22; see docs/core-model.md "Presence") — NOT whole-route/whole-site proximity:
//   - Two route-spaces on the same route are adjacent iff their indices are consecutive.
//   - A route's ENDMOST space touches the site at that end (index 0 ↔ site a,
//     index N-1 ↔ site b); interior route-spaces touch no site.
//   - A 0-space route makes its two sites directly adjacent.
//   - Spaces sharing a site are adjacent (a troop right beside yours).
// The previous implementation counted EVERY space on every connected route as adjacent
// to a site, and every space on a route plus BOTH endpoint sites as adjacent to any
// route-space — far too broad (e.g. a troop halfway down a 3-space route was wrongly
// treated as adjacent to both sites). Bug found by Drew W.
export function spacesAdjacentTo(spaceId: string): string[] {
  const s = TROOP_SPACES.find(t => t.id === spaceId);
  if (!s) return [];
  const out = new Set<string>();

  if (s.parentSite) {
    // Other spaces at the same site.
    for (const t of sitesSpaces(s.parentSite)) if (t.id !== spaceId) out.add(t.id);
    // Each connecting route contributes only the single endmost space that
    // touches this site — or, for a 0-space route, the connected site directly.
    for (const r of ROUTES) {
      if (r.a !== s.parentSite && r.b !== s.parentSite) continue;
      const spaces = routeSpaces(r.id);
      if (spaces.length === 0) {
        const otherSite = r.a === s.parentSite ? r.b : r.a;
        for (const t of sitesSpaces(otherSite)) out.add(t.id);
      } else {
        const endIdx = r.a === s.parentSite ? 0 : spaces.length - 1;
        out.add(`${r.id}:${endIdx}`);
      }
    }
  } else if (s.parentRoute) {
    const r = ROUTES.find(rr => rr.id === s.parentRoute)!;
    const last = routeSpaces(s.parentRoute).length - 1;
    // Consecutive spaces on the same route.
    if (s.index > 0) out.add(`${s.parentRoute}:${s.index - 1}`);
    if (s.index < last) out.add(`${s.parentRoute}:${s.index + 1}`);
    // An endpoint site is adjacent only when this space is at that end of the
    // route (a single-space route touches both ends).
    if (s.index === 0) for (const t of sitesSpaces(r.a)) out.add(t.id);
    if (s.index === last) for (const t of sitesSpaces(r.b)) out.add(t.id);
  }

  return [...out];
}

export function giveOutcastToOpponentAdjacentToLastDeploy(): EffectHandler {
  return ctx => {
    const Gx = ctx.G as unknown as { _lastDeploySpace?: string; _recentDeploySpaces?: string[] };
    // Prefer the full list of deploys made during this card's resolution (Gibbering
    // Mouther deploys 2, opponent must be adjacent to AT LEAST 1 of them). Fall back
    // to the last deploy for single-deploy callers.
    const deploys = (Gx._recentDeploySpaces && Gx._recentDeploySpaces.length > 0)
      ? Gx._recentDeploySpaces
      : (Gx._lastDeploySpace ? [Gx._lastDeploySpace] : []);
    if (deploys.length === 0) return true;
    const myColor = ctx.G.players[ctx.actorId].color;
    const opponentColors = new Set<string>();
    for (const deploySpace of deploys) {
      for (const sp of spacesAdjacentTo(deploySpace)) {
        const occ = ctx.G.troops[sp];
        if (occ && occ !== 'white' && occ !== myColor) opponentColors.add(occ);
      }
    }
    // Map troop colors back to player IDs.
    const opponentIds: string[] = [];
    for (const pid of Object.keys(ctx.G.players)) {
      if (pid === ctx.actorId) continue;
      if (opponentColors.has(ctx.G.players[pid].color)) opponentIds.push(pid);
    }
    if (opponentIds.length === 0) {
      Mechanics.log(ctx.G, '(no opponent has a troop adjacent to a deployed troop — no Outcast given)');
      return true;
    }
    if (!ctx.pendingChoice) {
      ctx.pendingChoice = {
        kind: 'select-player',
        prompt: 'Give an Insane Outcast to which adjacent opponent?',
        options: opponentIds,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const pid = ctx.pendingChoice.response as string | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (!pid) return true;
    const ref = makeOutcastRef();
    if (!ref) return true;
    ctx.G.players[pid].discard.push({ ...ref });
    Mechanics.log(ctx.G, `P${Number(pid) + 1} received Insane Outcast (adjacent to deploy)`);
    return true;
  };
}

// ---------- Return ALL your spies, supplanting at each (Graz'zt) ----------
//
// User chooses ANY NUMBER of their placed spies; for each one they pick, the spy
// returns to their supply and they supplant a troop at that spy's site. They can
// stop at any point. If a chosen spy's site has no supplantable troops, we
// surface a confirmation before returning it for no benefit (the user can either
// confirm "yes, return anyway" or back out and pick a different spy).
//
// State machine:
//   - phase 'pick-spy-or-stop': chooseOne over remaining spy sites + "Stop".
//   - phase 'confirm-empty':    confirm returning a spy at a site with no
//                               supplantable troops (no benefit).
//   - phase 'supplant':         select-troop-space picker for the supplant.

interface GrazztState {
  phase: 'pick-spy-or-stop' | 'confirm-empty' | 'supplant';
  /** Sites the player has spies at right now. Refreshed each pass so a
   *  mid-card effect that moves spies stays consistent. */
  remaining: string[];
  /** Which site the player most recently picked — relevant during
   *  'confirm-empty' and 'supplant' phases. */
  picked?: string;
}

function grazztRefreshRemaining(G: import('../game').TyrantsState, color: import('../game').Color): string[] {
  return SITES.filter(s => (G.spies[s.id] ?? []).includes(color)).map(s => s.id);
}

function grazztSupplantTargets(G: import('../game').TyrantsState, color: import('../game').Color, siteId: string): string[] {
  return TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id).filter(id => {
    const occ = G.troops[id];
    return occ && occ !== color;
  });
}

export function returnAnySpiesAndSupplantAtEach(): EffectHandler {
  return ctx => {
    const me = ctx.G.players[ctx.actorId];
    const myColor = me.color;
    let state = ctx.handlerState as GrazztState | null;

    // First entry — open the pick-spy-or-stop prompt.
    if (!state) {
      ensureSpiesLeftInitialized(ctx.G, myColor);
      const remaining = grazztRefreshRemaining(ctx.G, myColor);
      if (remaining.length === 0) {
        Mechanics.log(ctx.G, `(Graz'zt return: no spies on the board — skipped)`);
        return true;
      }
      ctx.pendingChoice = {
        kind: 'choose-one',
        prompt: 'Return a spy and supplant at its site (or stop).',
        options: [...remaining.map(s => `Return spy from ${s}`), 'Stop'],
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'pick-spy-or-stop', remaining };
      return false;
    }

    // Phase: user just picked a spy site (or stop).
    if (state.phase === 'pick-spy-or-stop') {
      const idx = ctx.pendingChoice?.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null || idx >= state.remaining.length) {
        // Picked "Stop" (or response invalid).
        ctx.handlerState = null;
        return true;
      }
      const picked = state.remaining[idx];
      const targets = grazztSupplantTargets(ctx.G, myColor, picked);
      if (targets.length === 0) {
        // No supplantable troops — confirm before wasting the spy.
        ctx.pendingChoice = {
          kind: 'choose-one',
          prompt: `${picked} has no enemy / white troops to supplant. Return this spy anyway (no benefit)?`,
          options: ['Yes, return the spy', 'No, pick a different spy'],
        } as PendingChoice;
        ctx.paused = true;
        ctx.handlerState = { phase: 'confirm-empty', remaining: state.remaining, picked };
        return false;
      }
      // Eligible supplant targets — return the spy now and prompt the supplant pick.
      ensureSpiesLeftInitialized(ctx.G, myColor);
      if (returnSpy(ctx.G, myColor, picked)) {
        me.spiesLeft += 1;
        Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned spy from ${picked} (spies left: ${me.spiesLeft})`);
      }
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Supplant a troop at ${picked}.`,
        options: targets,
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'supplant', remaining: state.remaining, picked };
      return false;
    }

    // Phase: confirm-empty (the spy's site has no supplantable troops).
    if (state.phase === 'confirm-empty') {
      const idx = ctx.pendingChoice?.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx === 0 && state.picked) {
        // User confirmed — return the spy with no supplant.
        ensureSpiesLeftInitialized(ctx.G, myColor);
        if (returnSpy(ctx.G, myColor, state.picked)) {
          me.spiesLeft += 1;
          Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} returned spy from ${state.picked} (no supplant — site had no targets) (spies left: ${me.spiesLeft})`);
        }
      }
      // Either way, re-open the pick-spy-or-stop loop with refreshed remaining.
      const remaining = grazztRefreshRemaining(ctx.G, myColor);
      if (remaining.length === 0) {
        ctx.handlerState = null;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'choose-one',
        prompt: 'Return another spy and supplant at its site (or stop).',
        options: [...remaining.map(s => `Return spy from ${s}`), 'Stop'],
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'pick-spy-or-stop', remaining };
      return false;
    }

    // Phase: supplant pick at the just-returned spy's site.
    if (state.phase === 'supplant') {
      const spaceId = ctx.pendingChoice?.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (spaceId) {
        const killed = assassinateTroop(ctx.G, spaceId);
        if (killed) {
          if (killed === 'white') me.trophyHall.white += 1;
          else if (killed !== myColor) me.trophyHall[killed] = (me.trophyHall[killed] ?? 0) + 1;
          if (me.barracksLeft > 0) {
            if (deployTroop(ctx.G, myColor, spaceId)) {
              me.barracksLeft -= 1;
              Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} (barracks: ${me.barracksLeft})`,
          { kind: 'troop.supplant', payload: { site: spaceId, target: killed }, side: ctx.actorId });
            }
          } else {
            me.vp += 1;
            Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} supplanted ${killed} at ${spaceId} — barracks empty, +1 VP`,
        { kind: 'troop.supplant', payload: { site: spaceId, target: killed, barracksEmpty: true }, side: ctx.actorId });
          }
        }
      }
      const remaining = grazztRefreshRemaining(ctx.G, myColor);
      if (remaining.length === 0) {
        ctx.handlerState = null;
        return true;
      }
      ctx.pendingChoice = {
        kind: 'choose-one',
        prompt: 'Return another spy and supplant at its site (or stop).',
        options: [...remaining.map(s => `Return spy from ${s}`), 'Stop'],
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'pick-spy-or-stop', remaining };
      return false;
    }

    // Defensive: unknown phase.
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Take a trophy and place it (Orcus) ----------
//
// Up to N iterations. Each iteration:
//   1. Pick a (player, color) pair — any trophy hall, any color with count > 0.
//   2. Pick an empty board space (anywhere).
//   3. Remove 1 trophy of that color from that hall; place a token OF THAT COLOR
//      at the chosen space.
// Each iteration is optional; declining a pick ends the whole effect early
// (per "the player could choose not to do it or to only do one").
// The placed token is the literal color taken — could be white, an enemy color,
// or even the active player's own color (if they take from their own hall).

interface OrcusIterState {
  remaining: number;
  /** When set, we've already picked the (player, color) and are waiting for a space. */
  picked?: { playerId: string; color: Color | 'white'; label: string };
}

/** opts.ownerPid restricts trophy-taking to a SPECIFIC player's hall —
 *  used by Lich ("take 2 trophies from THEIR hall" where "they" is the
 *  opponent with a troop at the spy site). When omitted, any player's
 *  hall is eligible (Orcus's behavior). */
export function takeTrophyAndPlace(opts: { count: number; ownerPid?: string; whiteOnly?: boolean; restrictToPresence?: boolean; optional?: boolean }): EffectHandler {
  return ctx => {
    let state = (ctx.handlerState as OrcusIterState | null) ?? { remaining: opts.count };

    // Step 2 resume: a space was picked → place the token, then loop.
    if (ctx.pendingChoice && state.picked) {
      const spaceId = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!spaceId) { ctx.handlerState = null; return true; } // declined → stop
      const { playerId: srcId, color, label } = state.picked;
      const src = ctx.G.players[srcId];
      if ((src.trophyHall[color] ?? 0) > 0) {
        src.trophyHall[color] = (src.trophyHall[color] ?? 0) - 1;
        // Place the token of that color (NOT the active player's color, unless
        // the color happens to be the active player's).
        if (!ctx.G.troops[spaceId]) {
          ctx.G.troops[spaceId] = color;
          Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} took ${label} trophy and placed ${color} at ${spaceId}`);
        }
      }
      state = { remaining: state.remaining - 1 };
      ctx.handlerState = state;
    }

    // Step 1 resume: a (player, color) pair was picked → prompt for board space.
    if (ctx.pendingChoice && !state.picked) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; } // declined → stop
      const choices = enumerateTrophies(ctx.G, opts.ownerPid, opts.whiteOnly);
      const sel = choices[idx];
      if (!sel) { ctx.handlerState = null; return true; }
      // Placement spaces. The deploy keyword is presence-restricted (rulebook
      // p.12) UNLESS the card says "anywhere on the board". Orcus prints that
      // phrase, so it places on any empty space; Lich does NOT, so its deploy
      // is limited to empty spaces where the active player has presence
      // (restrictToPresence). With no eligible space, the trophy can't be
      // placed — skip the rest of the effect (the trophy was not yet removed).
      const me = ctx.G.players[ctx.actorId];
      const eligible = opts.restrictToPresence
        ? legalDeployTargets(ctx.G, me.color, false)
        : TROOP_SPACES.filter(t => t.id in ctx.G.troops && ctx.G.troops[t.id] === null).map(t => t.id);
      if (eligible.length === 0) {
        Mechanics.log(ctx.G, `(deploy: no empty space ${opts.restrictToPresence ? 'where you have presence' : 'on the board'} — skipped)`);
        ctx.handlerState = null;
        return true;
      }
      state = { remaining: state.remaining, picked: sel };
      ctx.pendingChoice = {
        kind: 'select-troop-space',
        prompt: `Place the ${sel.color} trophy on an empty space${opts.restrictToPresence ? ' where you have presence' : ''} (or decline to skip).`,
        options: eligible,
        optional: opts?.optional ?? true,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = state;
      return false;
    }

    // Loop end?
    if (state.remaining <= 0) { ctx.handlerState = null; return true; }

    // Step 1 fresh prompt: list every (player, color) with > 0 trophies,
    // optionally restricted to opts.ownerPid.
    const choices = enumerateTrophies(ctx.G, opts.ownerPid);
    if (choices.length === 0) { ctx.handlerState = null; return true; }
    const targetTag = opts.ownerPid != null ? ` from P${Number(opts.ownerPid) + 1}'s hall` : '';
    ctx.pendingChoice = {
      kind: 'choose-one',
      prompt: `Take a trophy${targetTag} (${state.remaining} remaining). Pick which trophy + color:`,
      options: choices.map(c => c.label),
      optional: opts?.optional ?? true,
    } as PendingChoice;
    ctx.paused = true;
    ctx.handlerState = { remaining: state.remaining, picked: undefined };
    return false;
  };
}

function enumerateTrophies(
  G: import('../game').TyrantsState,
  ownerPid?: string,
  whiteOnly?: boolean,
): Array<{ playerId: string; color: Color | 'white'; label: string }> {
  const out: Array<{ playerId: string; color: Color | 'white'; label: string }> = [];
  for (const [pid, p] of Object.entries(G.players)) {
    if (ownerPid != null && pid !== ownerPid) continue;
    for (const [color, n] of Object.entries(p.trophyHall)) {
      if (whiteOnly && color !== 'white') continue;
      if (n > 0) out.push({
        playerId: pid,
        color: color as Color | 'white',
        label: `P${Number(pid) + 1} hall · ${color} (×${n})`,
      });
    }
  }
  return out;
}

// ---------- Repeat a handler N times ----------
//
// Just builds a sequence of N copies of `handler`. Used by Weaponmaster
// ("repeat three times: deploy a troop or assassinate a white troop").

export function times(n: number, handler: EffectHandler): EffectHandler {
  return sequence(...Array.from({ length: n }, () => handler));
}

// ---------- Conditional one-shot grants (read state, maybe grant) ----------

/** Grant something if a predicate on G + actorId is true (e.g. "+3 money if 4+ promoted"). */
export function conditionalGrant(
  predicate: (G: import('../game').TyrantsState, actorId: string) => boolean,
  bonus: EffectHandler,
  description: string
): EffectHandler {
  return ctx => {
    if (predicate(ctx.G, ctx.actorId)) {
      Mechanics.log(ctx.G, `Conditional met: ${description}.`);
      return bonus(ctx);
    }
    return true;
  };
}

// ---------- Reactive-on-forced-discard ----------
//
// Some Aberrations cards (Grimlock, Umber Hulk, Ambassador) print a
// reactive bonus that fires when an OPPONENT's effect forces you to
// discard the card from your hand. The reactive runs in the context of
// the discarded card's OWNER, with the offending player also in scope
// (e.g. Umber Hulk forces the offender to discard one back). The discard
// helpers below fire the reactive via fireForcedDiscardReactive() right
// after pushing the card to discard.

type ReactiveOnForcedDiscard = (
  G: import('../game').TyrantsState,
  ownerPid: string,
  offenderPid: string
) => void;

const onForcedDiscardHandlers: Record<string, ReactiveOnForcedDiscard> = {};

export function registerOnForcedDiscard(effectKey: string, handler: ReactiveOnForcedDiscard): void {
  onForcedDiscardHandlers[effectKey] = handler;
}

function fireForcedDiscardReactive(
  G: import('../game').TyrantsState,
  card: CardRef,
  ownerPid: string,
  offenderPid: string,
): void {
  const data = lookupCard(card.deck, card.slot);
  if (!data) return;
  const reactive = onForcedDiscardHandlers[data.effectKey];
  if (!reactive) return;
  try { reactive(G, ownerPid, offenderPid); }
  catch (e) { Mechanics.log(G, `(forced-discard reactive on ${data.name} errored: ${e})`); }
}

// ---------- Aberrations expansion: discard-from-opponents ----------
//
// Aberrations' theme is forcing opponents to discard from their hand. The
// "discard from hand" verb here means "move from opponent's hand pile to
// their discard pile" — the card stays in their cycling deck (unlike
// devour which removes it entirely). Per the printed expansion's
// triggers, most discard effects gate on the target having at least N
// cards in hand ("...if they have 3+").
//
// IMPORTANT: per the rules, the player being forced to discard chooses
// which card from their hand to discard — not the player who triggered the
// effect, and not "the rightmost card." Earlier implementations popped
// the last hand slot; we now publish a cross-player `select-card-in-hand`
// pendingChoice routed to the target, and the AI / human picks per their
// own discard heuristic (own worst card).

/** Apply a chosen discard from a target's hand and fire any reactive. Pure
 *  helper used after a `select-card-in-hand` prompt resolves. */
function applyForcedDiscard(
  G: import('../game').TyrantsState, targetPid: string, idx: number | null, offenderPid: string,
): void {
  if (idx == null) return;
  const target = G.players[targetPid];
  const card = target.hand[idx];
  if (!card) return;
  target.hand.splice(idx, 1);
  target.discard.push(card);
  Mechanics.log(G, `P${Number(targetPid) + 1} discarded ${card.name} (forced)`);
  fireForcedDiscardReactive(G, card, targetPid, offenderPid);
}

/** Force EACH opponent (excluding ctx.actorId) with at least `minHand`
 *  cards to choose a card from their hand to discard. Loops over the
 *  qualifying targets, surfacing one `select-card-in-hand` prompt at a
 *  time (each routed to the respective target). State is preserved across
 *  the inter-prompt pauses via handlerState. */
export function eachOpponentDiscardsIfMinHand(minHand: number = 4): EffectHandler {
  return ctx => {
    interface S { remaining: string[]; activeTarget: string | null }
    const state = (ctx.handlerState as S | null) ?? {
      remaining: Object.keys(ctx.G.players)
        .filter(pid => pid !== ctx.actorId && ctx.G.players[pid].hand.length >= minHand),
      activeTarget: null,
    };
    // Process response from the active target (if any).
    if (state.activeTarget !== null && ctx.pendingChoice) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      applyForcedDiscard(ctx.G, state.activeTarget, idx, ctx.actorId);
      state.activeTarget = null;
    }
    // Pump the queue: prompt the next eligible target, or finish.
    while (state.remaining.length > 0) {
      const next = state.remaining[0];
      state.remaining = state.remaining.slice(1);
      // Re-check hand size — a chained reactive may have changed it.
      if (ctx.G.players[next].hand.length < minHand) continue;
      ctx.pendingChoice = {
        kind: 'select-card-in-hand',
        prompt: `P${Number(next) + 1}: pick a card to discard (forced by P${Number(ctx.actorId) + 1}'s effect).`,
        playerId: next,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { remaining: state.remaining, activeTarget: next };
      return false;
    }
    ctx.handlerState = null;
    return true;
  };
}

/** Actor picks ONE opponent (with at least `minHand` cards). That opponent
 *  then chooses which card from their own hand to discard. Two-phase prompt:
 *  first a `select-player` to the actor, then a `select-card-in-hand` to the
 *  chosen target. State across the pauses is held in `handlerState`. */
export function chooseOpponentToDiscard(minHand: number = 4): EffectHandler {
  return ctx => {
    interface S { phase: 'pick-target' | 'pick-card'; target?: string }
    const state = (ctx.handlerState as S | null) ?? { phase: 'pick-target' };
    if (state.phase === 'pick-target') {
      if (!ctx.pendingChoice) {
        const eligible = Object.keys(ctx.G.players).filter(id => {
          if (id === ctx.actorId) return false;
          return ctx.G.players[id].hand.length >= minHand;
        });
        if (eligible.length === 0) {
          Mechanics.log(ctx.G, `(force discard: no opponent has ${minHand}+ cards in hand — skipped)`);
          ctx.handlerState = null;
          return true;
        }
        ctx.pendingChoice = {
          kind: 'select-player',
          prompt: `Choose an opponent (with ${minHand}+ cards) to discard a card.`,
          options: eligible,
          optional: false,
        } as PendingChoice;
        ctx.paused = true;
        ctx.handlerState = { phase: 'pick-target' };
        return false;
      }
      const targetPid = ctx.pendingChoice.response as string | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (!targetPid) { ctx.handlerState = null; return true; }
      if (ctx.G.players[targetPid].hand.length < minHand) { ctx.handlerState = null; return true; }
      // Surface the discard prompt to the target.
      ctx.pendingChoice = {
        kind: 'select-card-in-hand',
        prompt: `P${Number(targetPid) + 1}: pick a card to discard (forced by P${Number(ctx.actorId) + 1}'s effect).`,
        playerId: targetPid,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { phase: 'pick-card', target: targetPid };
      return false;
    }
    // phase === 'pick-card': process target's discard pick.
    if (ctx.pendingChoice) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (state.target) applyForcedDiscard(ctx.G, state.target, idx, ctx.actorId);
    }
    ctx.handlerState = null;
    return true;
  };
}

/** Force the OWNER of a specific color (typically the player whose troop
 *  was just killed) to discard a card from hand if they have at least
 *  `minHand`. Used by Mindwitness — its discard targets the player whose
 *  troop the Mindwitness just assassinated, not an arbitrary opponent. */
export function forcePlayerOfColorToDiscardIfMinHand(
  color: import('../game').Color | 'white',
  actorPid: string,
  minHand: number = 4,
): EffectHandler {
  return ctx => {
    if (color === 'white') { ctx.handlerState = null; return true; } // white has no owner
    interface S { activeTarget?: string }
    const state = (ctx.handlerState as S | null) ?? {};
    // Resume: target has picked.
    if (state.activeTarget && ctx.pendingChoice) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      applyForcedDiscard(ctx.G, state.activeTarget, idx, actorPid);
      ctx.handlerState = null;
      Mechanics.log(ctx.G, `(troop-killed discard fulfilled for P${Number(state.activeTarget) + 1})`);
      return true;
    }
    // Initial: find target, surface prompt.
    const targetPid = Object.keys(ctx.G.players).find(k => ctx.G.players[k].color === color);
    if (!targetPid || targetPid === actorPid) { ctx.handlerState = null; return true; }
    if (ctx.G.players[targetPid].hand.length < minHand) { ctx.handlerState = null; return true; }
    ctx.pendingChoice = {
      kind: 'select-card-in-hand',
      prompt: `P${Number(targetPid) + 1}: pick a card to discard (your troop was killed).`,
      playerId: targetPid,
    } as PendingChoice;
    ctx.paused = true;
    ctx.handlerState = { activeTarget: targetPid };
    return false;
  };
}

/** Each opponent with a TROOP at the site of the last-placed spy gets a
 *  cross-player prompt to discard a card if they have at least `minHand`
 *  cards. Used by Chuul. Iterates qualifying opponents via handlerState,
 *  one prompt at a time. */
export function eachOpponentAtLastSpySiteDiscardsIfMinHand(minHand: number = 4): EffectHandler {
  return ctx => {
    interface S { remaining: string[]; activeTarget: string | null; siteId: string }
    const G = ctx.G;
    let state = ctx.handlerState as S | null;
    if (!state) {
      const siteId = (G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
      if (!siteId) return true;
      const me = G.players[ctx.actorId];
      const presentColors = new Set<string>();
      for (const sp of TROOP_SPACES.filter(t => t.parentSite === siteId)) {
        const occ = G.troops[sp.id];
        if (occ && occ !== me.color && occ !== 'white') presentColors.add(occ);
      }
      const remaining = Object.entries(G.players)
        .filter(([pid, p]) => pid !== ctx.actorId
          && presentColors.has(p.color)
          && p.hand.length >= minHand)
        .map(([pid]) => pid);
      state = { remaining, activeTarget: null, siteId };
    }
    // Process active target's pick.
    if (state.activeTarget !== null && ctx.pendingChoice) {
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      applyForcedDiscard(G, state.activeTarget, idx, ctx.actorId);
      state.activeTarget = null;
    }
    // Pump the queue.
    while (state.remaining.length > 0) {
      const next = state.remaining[0];
      state.remaining = state.remaining.slice(1);
      if (G.players[next].hand.length < minHand) continue;
      ctx.pendingChoice = {
        kind: 'select-card-in-hand',
        prompt: `P${Number(next) + 1}: pick a card to discard (your troop at ${state.siteId} was spied on).`,
        playerId: next,
      } as PendingChoice;
      ctx.paused = true;
      ctx.handlerState = { remaining: state.remaining, activeTarget: next, siteId: state.siteId };
      return false;
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Undead expansion: devour-self ----------
//
// Many Undead cards offer a triggered effect at the cost of "devour this
// card" — sacrificing the card being played so it leaves the deck entirely.
// devourSelfThen wraps the gated effect with the self-devour mechanic.
// Implementation: mark the card to self-eject via the same mechanism
// Insane Outcast uses (ctx.handlerState.returnedToSupply), then run the
// gated effect. game.ts checks handlerState.returnedToSupply at the end
// of the play and skips adding the card to discard.

export function devourSelfThen(after: EffectHandler): EffectHandler {
  return ctx => {
    // Run the gated effect first so its prompts surface normally. Track
    // the after-handler's state so resumes work. Mark self-eject in our
    // ledger; we'll write it onto ctx.handlerState only on completion.
    const state = (ctx.handlerState as { childState?: unknown } | null) ?? {};
    const childCtx: EffectContext = { ...ctx, handlerState: state.childState ?? null };
    const done = after(childCtx);
    if (!done) {
      ctx.pendingChoice = childCtx.pendingChoice;
      ctx.paused = childCtx.paused;
      ctx.handlerState = { childState: childCtx.handlerState };
      return false;
    }
    Mechanics.log(ctx.G, `(devoured ${ctx.card.name} self)`);
    // Push to the devoured pile so Ghost ("recruit top of devoured pile")
    // and any future devoured-pile lookups can see this card. Without this
    // the card vanishes entirely — not in deck/hand/discard, not even
    // accessible to recovery effects. The `returnedToSupply` flag then
    // tells game.ts to skip the usual "push to discard + cardsPlayedThisTurn"
    // path, since the card is leaving play.
    if (!ctx.G.devouredPile) ctx.G.devouredPile = [];
    ctx.G.devouredPile.push({ ...ctx.card });
    ctx.handlerState = { returnedToSupply: true };
    return true;
  };
}

/** Like devourSelfThen, but the player may DECLINE the self-devour. If
 *  they decline, the gated effect doesn't fire either (per the printed
 *  card text "devour this card to [effect]"). */
export function optionalDevourSelfThen(after: EffectHandler, label?: string): EffectHandler {
  return ctx => {
    interface S { paid?: boolean; declined?: boolean; childState?: unknown }
    const state = (ctx.handlerState as S | null) ?? {};
    if (!state.paid && !state.declined) {
      if (!ctx.pendingChoice) {
        ctx.pendingChoice = {
          kind: 'choose-one',
          prompt: label ?? `Devour ${ctx.card.name} for the bonus effect?`,
          options: ['Decline', 'Devour for bonus'],
        } as PendingChoice;
        ctx.paused = true;
        ctx.handlerState = {};
        return false;
      }
      const pick = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (pick == null || pick === 0) {
        ctx.handlerState = null;
        return true;
      }
      // Proceed with the gated effect, then mark self-devour at completion.
      const newState: S = { paid: true, childState: null };
      ctx.handlerState = newState;
      return runChild();
    }
    if (state.declined) { ctx.handlerState = null; return true; }
    return runChild();

    function runChild(): boolean {
      const s = ctx.handlerState as S;
      const childCtx: EffectContext = { ...ctx, handlerState: s.childState ?? null };
      const done = after(childCtx);
      if (!done) {
        ctx.pendingChoice = childCtx.pendingChoice;
        ctx.paused = childCtx.paused;
        ctx.handlerState = { paid: true, childState: childCtx.handlerState };
        return false;
      }
      Mechanics.log(ctx.G, `(devoured ${ctx.card.name} self)`);
      // Same as devourSelfThen: push to the devoured pile for tracking
      // and downstream effects (Ghost / future devoured-pile lookups).
      if (!ctx.G.devouredPile) ctx.G.devouredPile = [];
      ctx.G.devouredPile.push({ ...ctx.card });
      ctx.handlerState = { returnedToSupply: true };
      return true;
    }
  };
}

/** Carrion Crawler: devour ONE card in the market row, then put `ctx.card`
 *  itself into that market slot. The card-being-played effectively swaps
 *  position with a market card it devours — the played card stays in the
 *  market (does NOT go to the player's discard), and the devoured market
 *  card leaves play entirely. handlerState.returnedToSupply tells game.ts
 *  to skip adding ctx.card to discard. */
export function marketDevourReplaceWithSelf(): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const eligible: number[] = [];
      for (let i = 0; i < ctx.G.market.row.length; i++) {
        if (ctx.G.market.row[i]) eligible.push(i);
      }
      if (eligible.length === 0) { ctx.handlerState = null; return true; }
      ctx.pendingChoice = {
        kind: 'select-market-card',
        prompt: `Devour a card from the market; ${ctx.card.name} replaces it.`,
        options: eligible,
        // Mandatory per card text — the swap isn't conditional, it's part
        // of the printed effect. User question on #50 confirmed: "decline"
        // shouldn't be an option here.
        optional: false,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const idx = ctx.pendingChoice.response as number | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (idx == null) { ctx.handlerState = null; return true; }
    const devoured = ctx.G.market.row[idx];
    if (!devoured) { ctx.handlerState = null; return true; }
    Mechanics.devour(ctx.G, devoured);
    ctx.G.market.row[idx] = { ...ctx.card };
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} swapped ${ctx.card.name} into the market (devoured ${devoured.name})`);
    // The played card ends up in the market, NOT the player's discard.
    ctx.handlerState = { returnedToSupply: true };
    return true;
  };
}

// ---------- Promote from non-played-this-turn zones ----------
//
// Promote-from-played-this-turn (the most common shape — Air/Fire/Water
// Myrmidons, Drow Negotiator, etc.) goes through the EoT
// pendingEotPromotions queue. The Necromancer (Undead expansion) offers
// promote-from-hand and promote-self as additional sources — these
// fire immediately within the card's effect resolution rather than at
// end of turn.

/** Pick one card from the player's hand and promote it (move to inner
 *  circle). Optional decline. Used by Necromancer's "promote a card
 *  from your hand" branch. */
export function promoteFromHandChoice(opts?: { optional?: boolean }): EffectHandler {
  return ctx => {
    if (!ctx.pendingChoice) {
      const me = ctx.G.players[ctx.actorId];
      if (me.hand.length === 0) return true;
      ctx.pendingChoice = {
        kind: 'select-card-in-hand',
        prompt: 'Promote a card from your hand (it moves to your inner circle)',
        options: me.hand.map((_, i) => i),
        optional: opts?.optional,
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const idx = ctx.pendingChoice.response as number | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (idx == null) return true;
    const me = ctx.G.players[ctx.actorId];
    const card = me.hand[idx];
    if (!card) return true;
    me.hand.splice(idx, 1);
    Mechanics.promote(ctx.G, ctx.actorId, card);
    return true;
  };
}

/** Promote THIS card (ctx.card) — move the card being played to the
 *  inner circle instead of letting it land in discard. Sets the
 *  returnedToSupply flag so the engine's playCard cleanup skips the
 *  normal discard push. Used by Necromancer's "promote this card"
 *  branch and Revenant's 8+-trophy bonus (via a similar pattern). */
export function promoteSelf(): EffectHandler {
  return ctx => {
    // If the handler paused for a choice before reaching here, the engine
    // already pushed this card into discard + cardsPlayedThisTurn (so a
    // cross-player prompt could find it). Pull those entries back out before
    // promoting, otherwise the card lingers in discard and the end-of-turn
    // "promote a card played this turn" prompt would offer it again.
    const me = ctx.G.players[ctx.actorId];
    const di = me.discard.findIndex(c => c.deck === ctx.card.deck && c.slot === ctx.card.slot);
    if (di >= 0) me.discard.splice(di, 1);
    const pi = ctx.G.cardsPlayedThisTurn.findIndex(c => c.deck === ctx.card.deck && c.slot === ctx.card.slot);
    if (pi >= 0) ctx.G.cardsPlayedThisTurn.splice(pi, 1);
    // Keep the per-player display list (PlayerData.cardsPlayed) in sync with the
    // game-level cardsPlayedThisTurn, else a self-promoted card lingers in the
    // "played this turn" display/count after it's been promoted out.
    const ppi = me.cardsPlayed.findIndex(c => c.deck === ctx.card.deck && c.slot === ctx.card.slot);
    if (ppi >= 0) me.cardsPlayed.splice(ppi, 1);
    Mechanics.promote(ctx.G, ctx.actorId, ctx.card);
    ctx.handlerState = { returnedToSupply: true };
    return true;
  };
}

// ---------- Recruit from devoured pile (Ghost) ----------
//
// "Treat the top card of the devoured pile as if it were in the market."
// Surface a prompt offering the top devoured card at its printed cost.
// Decline is always available. If the player can't afford the cost the
// prompt skips silently. Recruited card lands in the player's discard
// like any normal market recruit; the devoured pile shrinks.

export function recruitFromDevouredPile(): EffectHandler {
  return ctx => {
    const G = ctx.G;
    if (!G.devouredPile || G.devouredPile.length === 0) return true;
    if (!ctx.pendingChoice) {
      const top = G.devouredPile[G.devouredPile.length - 1];
      const data = lookupCard(top.deck, top.slot);
      if (!data) return true;
      const me = G.players[ctx.actorId];
      if (me.influence < data.cost) {
        Mechanics.log(G, `(devoured-pile recruit: ${top.name} costs ${data.cost}, only ${me.influence} influence — skipped)`);
        return true;
      }
      ctx.pendingChoice = {
        kind: 'choose-one',
        prompt: `Recruit ${top.name} (cost ${data.cost}) from the devoured pile?`,
        options: ['Decline', `Recruit (−${data.cost} influence)`],
      } as PendingChoice;
      ctx.paused = true;
      return false;
    }
    const pick = ctx.pendingChoice.response as number | null;
    ctx.pendingChoice = null;
    ctx.paused = false;
    if (pick == null || pick === 0) return true;
    const pileNow = ctx.G.devouredPile ?? [];
    const top = pileNow.pop();
    if (!top) return true;
    const data = lookupCard(top.deck, top.slot);
    if (!data) return true;
    if (!Mechanics.expendInfluence(ctx.G, ctx.actorId, data.cost)) {
      // Couldn't pay — put the card back.
      pileNow.push(top);
      return true;
    }
    ctx.G.players[ctx.actorId].discard.push(top);
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} recruited ${top.name} from devoured pile (cost ${data.cost})`,
      { kind: 'card.recruit', payload: { card: top.name, from: 'devoured-pile' }, side: ctx.actorId });
    return true;
  };
}

// ---------- Play a card from a non-hand zone ----------
//
// Ulitharid: "Play a card in the market that costs 4 or less, then
// devour it." Elder Brain: "Play a card from your inner-circle as if
// it were in your hand (it stays there)." Both need a primitive that
// looks up the picked card's effect handler and runs it as if normally
// played, threading any pendingChoice back through the calling card.
//
// Implementation: trampoline pattern. The outer Ulitharid/Elder Brain
// handler holds the state machine (phase, picked card, child-state);
// each engine resume re-enters the outer handler, which dispatches to
// the inner card's registered handler with a child ctx carrying the
// foreign card. game.ts's resolveChoice always re-enters the outer
// handler (because pendingChoice.cardKey is stamped with the OUTER
// card's key), so the trampoline is transparent.

export function playForeignCard(opts: {
  source: 'market' | 'inner-circle';
  maxCost?: number;
  /** After resolution, what to do with the picked card. */
  cleanup: 'devour-from-market' | 'leave-in-place';
  promptLabel?: string;
}): EffectHandler {
  return ctx => {
    interface State {
      phase: 'pick' | 'play';
      pickedRef?: CardRef;
      pickedMarketIdx?: number;   // remembered so cleanup knows the slot
      pickedInnerCircleIdx?: number;
      childState?: unknown;
    }
    let state = (ctx.handlerState as State | null) ?? { phase: 'pick' };

    // --- Phase: pick the source card ---
    if (state.phase === 'pick') {
      if (!ctx.pendingChoice) {
        if (opts.source === 'market') {
          const eligible: number[] = [];
          for (let i = 0; i < ctx.G.market.row.length; i++) {
            const c = ctx.G.market.row[i];
            if (!c) continue;
            const data = lookupCard(c.deck, c.slot);
            if (!data) continue;
            if (opts.maxCost != null && data.cost > opts.maxCost) continue;
            eligible.push(i);
          }
          if (eligible.length === 0) { ctx.handlerState = null; return true; }
          ctx.pendingChoice = {
            kind: 'select-market-card',
            prompt: opts.promptLabel ?? `Pick a market card to play${opts.maxCost != null ? ` (cost ≤${opts.maxCost})` : ''}`,
            options: eligible,
            optional: true,
          } as PendingChoice;
        } else { // inner-circle
          const me = ctx.G.players[ctx.actorId];
          if (me.innerCircle.length === 0) { ctx.handlerState = null; return true; }
          ctx.pendingChoice = {
            kind: 'select-card-in-inner-circle',
            prompt: opts.promptLabel ?? 'Pick a card from your inner circle to play (it stays there)',
            options: me.innerCircle.map((_, i) => i),
            optional: true,
          } as PendingChoice;
        }
        ctx.paused = true;
        ctx.handlerState = state;
        return false;
      }
      const idx = ctx.pendingChoice.response as number | null;
      ctx.pendingChoice = null;
      ctx.paused = false;
      if (idx == null) { ctx.handlerState = null; return true; }
      let pickedRef: CardRef | undefined;
      if (opts.source === 'market') {
        const c = ctx.G.market.row[idx];
        if (c) pickedRef = { ...c };
        state = { phase: 'play', pickedRef, pickedMarketIdx: idx, childState: null };
      } else {
        const me = ctx.G.players[ctx.actorId];
        const c = me.innerCircle[idx];
        if (c) pickedRef = { ...c };
        state = { phase: 'play', pickedRef, pickedInnerCircleIdx: idx, childState: null };
      }
      if (!pickedRef) { ctx.handlerState = null; return true; }
      ctx.handlerState = state;
    }

    // --- Phase: dispatch to the picked card's handler ---
    if (state.phase === 'play' && state.pickedRef) {
      const data = lookupCard(state.pickedRef.deck, state.pickedRef.slot);
      const handler = data ? CardRegistry.get(data.effectKey) : undefined;
      if (handler) {
        const childCtx: EffectContext = {
          ...ctx,
          card: state.pickedRef,
          pendingChoice: ctx.pendingChoice,
          handlerState: state.childState ?? null,
          paused: ctx.paused,
        };
        const done = handler(childCtx);
        if (!done) {
          ctx.pendingChoice = childCtx.pendingChoice;
          ctx.paused = childCtx.paused;
          ctx.handlerState = { ...state, childState: childCtx.handlerState };
          return false;
        }
      } else {
        Mechanics.log(ctx.G, `(${state.pickedRef.name}: no handler — played as no-op)`);
      }
      // Cleanup: market-devour swaps in top of deck; leave-in-place is a no-op
      // (the inner-circle card never moved).
      if (opts.cleanup === 'devour-from-market') {
        const slotIdx = state.pickedMarketIdx ?? -1;
        if (slotIdx >= 0 && ctx.G.market.row[slotIdx]) {
          const removed = ctx.G.market.row[slotIdx]!;
          Mechanics.devour(ctx.G, removed);
          const refill = ctx.G.market.deck.shift() ?? null;
          if (refill) Mechanics.markInfoRevealed(ctx.G);
          ctx.G.market.row[slotIdx] = refill;
        }
      }
      ctx.handlerState = null;
      return true;
    }
    ctx.handlerState = null;
    return true;
  };
}

// ---------- Tiny convenience: register many handlers at once ----------

export function registerAll(table: Record<string, EffectHandler>) {
  for (const [key, fn] of Object.entries(table)) CardRegistry.register(key, fn);
}
