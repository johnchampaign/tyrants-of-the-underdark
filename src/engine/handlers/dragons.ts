// Dragons half-deck handlers.

import { grant, flagEotPromote, placeSpyAtChosenSite, sequence, registerAll,
         assassinateChoice, deployChoice, supplantChoice, chooseOne,
         returnOwnSpyChoice, returnEnemySpyChoice, moveEnemyTroopChoice,
         ifAnotherPlayerTroopAtLastPlacedSpySite, devourMarketChoice,
         supplantAtLastPlacedSpySite, supplantAtLastReturnedSpySite,
         returnEnemyTroopOrSpyChoice, playerHasOwnSpy, playerCanAssassinate,
         flagEotInnerCircleVp } from '../handler-helpers';
import type { EffectHandler } from '../types';
import { Mechanics } from '../mechanics';

/** Per Green Dragon's option-2 in-play text: +1 VP per site control marker
 *  the player currently holds. */
const grantVpPerControlMarkerHeld: EffectHandler = ctx => {
  const me = ctx.G.players[ctx.actorId];
  let n = 0;
  for (const m of Object.values(ctx.G.controlMarkers)) if (m.holder === me.color) n++;
  if (n > 0) {
    me.vp += n;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${n} VP from Green Dragon (control markers held)`);
  } else {
    Mechanics.log(ctx.G, `(Green Dragon: no control markers held — +0 VP)`);
  }
  return true;
};

/** Per Red Dragon's in-play text: +1 VP per *total*-controlled site (a
 *  site you hold AND no opponent has a spy on). Distinct from Green
 *  Dragon's "control marker" count — total control is the stricter
 *  condition where the marker shows the higher VP face. */
const grantVpPerTotalControlledSite: EffectHandler = ctx => {
  const me = ctx.G.players[ctx.actorId];
  let n = 0;
  for (const [siteId, m] of Object.entries(ctx.G.controlMarkers)) {
    if (m.holder !== me.color) continue;
    const spies = ctx.G.spies[siteId] ?? [];
    const opposingSpy = spies.some(c => c !== me.color);
    if (!opposingSpy) n++;
  }
  if (n > 0) {
    me.vp += n;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${n} VP from Red Dragon (total-controlled sites)`);
  } else {
    Mechanics.log(ctx.G, `(Red Dragon: no total-controlled sites — +0 VP)`);
  }
  return true;
};

/** Black Dragon in-play: +1 VP per 3 white troops in your trophy hall. The card
 *  says "Gain 1 VP…", which the rulebook defines as taking VP tokens
 *  immediately — NOT an end-of-game rider. */
export const grantVpPerThreeWhiteTrophies: EffectHandler = ctx => {
  const me = ctx.G.players[ctx.actorId];
  const vp = Math.floor((me.trophyHall.white ?? 0) / 3);
  if (vp > 0) {
    me.vp += vp;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${vp} VP from Black Dragon (white trophies)`);
  } else {
    Mechanics.log(ctx.G, `(Black Dragon: fewer than 3 white trophies — +0 VP)`);
  }
  return true;
};

/** White Dragon in-play: +1 VP per 2 sites you control (immediate, per rulebook
 *  "gain VP"). */
export const grantVpPerTwoSitesControlled: EffectHandler = ctx => {
  const me = ctx.G.players[ctx.actorId];
  let controlled = 0;
  for (const c of Object.values(ctx.G.siteControl)) if (c === me.color) controlled++;
  const vp = Math.floor(controlled / 2);
  if (vp > 0) {
    me.vp += vp;
    Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${vp} VP from White Dragon (sites controlled)`);
  } else {
    Mechanics.log(ctx.G, `(White Dragon: fewer than 2 sites controlled — +0 VP)`);
  }
  return true;
};

registerAll({
  'red-wyrmling':         grant({ power: 2, influence: 2 }),
  'severin-silrajin':     grant({ power: 5 }),
  'rath-modar':           sequence(grant({ draw: 2 }), placeSpyAtChosenSite()),
  'wyrmspeaker':          sequence(grant({ influence: 1 }), flagEotPromote()),

  'enchanter-of-thay':    chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → +4 Power', handler: sequence(returnOwnSpyChoice(), grant({ power: 4 })), available: playerHasOwnSpy }),
  'green-wyrmling':       sequence(placeSpyAtChosenSite(), ifAnotherPlayerTroopAtLastPlacedSpySite(grant({ influence: 2 }))),
  'watcher-of-thay':      chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → +3 Influence', handler: sequence(returnOwnSpyChoice(), grant({ influence: 3 })), available: playerHasOwnSpy }),

  'blue-wyrmling':        sequence(grant({ influence: 3 }), returnEnemyTroopOrSpyChoice()),
  'cleric-of-laogzed':    sequence(moveEnemyTroopChoice(), flagEotPromote()),

  'cult-fanatic':         sequence(grant({ influence: 2 }), devourMarketChoice()),
  'dragon-cultist':       chooseOne(
                            { label: '+2 Power', handler: grant({ power: 2 }) },
                            { label: '+2 Influence', handler: grant({ influence: 2 }) }),

  'black-wyrmling':       sequence(grant({ influence: 1 }), assassinateChoice({ whiteOnly: true })),
  'kobold':               chooseOne(
                            { label: 'Deploy a troop', handler: deployChoice({ count: 1 }) },
                            { label: 'Assassinate a white troop', handler: assassinateChoice({ whiteOnly: true }),
                              available: (G, a) => playerCanAssassinate(G, a, { whiteOnly: true }) }),
  'white-wyrmling':       sequence(deployChoice({ count: 2 }), devourMarketChoice()),
 // Dragonclaw - Assassinate a troop. Then if you have 5 or more player trophies, gain +2 Power
  'dragonclaw':           sequence(
                            assassinateChoice(),
                            (ctx => {
                             const me = ctx.G.players[ctx.actorId];
                             // "Player trophies" = colored trophies (not white).
                             let coloredTrophies = 0;
                             for (const [color, n] of Object.entries(me.trophyHall)) {
                               if (color === 'white') continue;
                               coloredTrophies += n;
                             }
                             if (coloredTrophies >= 5) {
                               me.power += 2;
                               Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +2 Power from Dragonclaw (5+ player trophies in trophy hall)`,
                                 { kind: 'power.gain', payload: { amount: 2, source: 'Dragonclaw' }, side: ctx.actorId });
                              }
                             return true;
                            })),

  // Big dragons. Each card says "Gain X VP …", which the rulebook defines as
  // taking VP tokens IMMEDIATELY when the card resolves (Final Scoring lists no
  // per-card end-of-game bonus). So the VP is granted here, in-play — NOT via an
  // engine/scoring.ts rider (those were removed; they double-counted Red/Green
  // and mistimed Black/White/Blue). Blue is the one exception the card spells
  // out: its VP is gained "at end of turn", after its promotes resolve.
  'black-dragon':         sequence(supplantChoice({ whiteOnly: true, anywhere: true }),
                                   grantVpPerThreeWhiteTrophies),
  // "promote up to 2 other cards played this turn" ("up to" = optional), THEN at
  // end of turn gain 1 VP per 3 inner-circle cards (counts the cards just promoted).
  'blue-dragon':          sequence(flagEotPromote({ count: 2, optional: true }),
                                   flagEotInnerCircleVp(3)),
  'green-dragon':         chooseOne(
                            { label: 'Place a spy + supplant a troop at that site', handler: sequence(placeSpyAtChosenSite(), supplantAtLastPlacedSpySite()) },
                            { label: 'Return a spy + supplant a troop at that site + 1 VP per control marker held', handler: sequence(returnOwnSpyChoice(), supplantAtLastReturnedSpySite(), grantVpPerControlMarkerHeld), available: playerHasOwnSpy }),
  // Red Dragon: "Supplant a troop. Return an enemy spy. +1 VP per
  // total-controlled site." Previously this returned the player's OWN
  // spy and skipped the VP grant entirely (#52). Spy-return is optional
  // since enemy spies may not exist where the player has presence.
  'red-dragon':           sequence(supplantChoice(),
                                   returnEnemySpyChoice(),
                                   grantVpPerTotalControlledSite),
  'white-dragon':         sequence(deployChoice({ count: 3 }), grantVpPerTwoSitesControlled),
});
