// Undead half-deck handlers (expansion).
//
// Theme: devour-this-card mechanics — sacrifice the card being played for
// a triggered effect. Self-devour uses devourSelfThen / optionalDevour
// SelfThen helpers in handler-helpers.ts. Some cards also manipulate
// trophies and the devoured pile (treat devoured cards as market, steal
// trophies for re-deploy, etc.).
//
// Card text source: assets/raw-card-data.csv + Kelsam reference card.
// Several effects are partial or stubbed; iterate as we go.

import { grant, flagEotPromote, placeSpyAtChosenSite, sequence, registerAll, times,
         assassinateChoice, deployChoice, supplantChoice, chooseOne,
         returnOwnSpyChoice, returnEnemyTroopOrSpyChoice,
         devourFromHandCost, optionalDevourSelfThen, devourSelfThen,
         marketDevourReplaceWithSelf, takeTrophyAndPlace,
         recruitFromMarketFiltered, recruitFromDevouredPile,
         promoteFromHandChoice, promoteSelf,
         conditionalGrant, promoteFromDiscardChoice, promotableDiscardIndices,
         assassinateAtLastPlacedSpySite,
         playerHasOwnSpy, playerCanAssassinate } from '../handler-helpers';
import { TROOP_SPACES } from '../../data/troop-spaces';
import { Mechanics } from '../mechanics';
import { totalTrophies } from '../../game';

registerAll({
  // Cost 2 — Vampire Spawn: +1 money + return another player's troop/spy
  'vampire-spawn':       sequence(grant({ influence: 1 }), returnEnemyTroopOrSpyChoice()),

  // Cost 2 — Skeletal Horde: deploy 2; optional devour-self → deploy 3
  'skeletal-horde':      sequence(
                           deployChoice({ count: 2 }),
                           optionalDevourSelfThen(deployChoice({ count: 3 }),
                                                  'Devour Skeletal Horde for 3 more deploys?')),

  // Cost 2 — Cultist of Myrkul: chooseOne(+2 money, devour-self → eot promote x2)
  'cultist-of-myrkul':   chooseOne(
                           { label: '+2 Influence', handler: grant({ influence: 2 }) },
                           { label: 'Devour this card → EoT promote x2',
                             // "promote up to 2 other cards played this turn" — "up to"
                             // makes the promote count player-choosable; flip to optional
                             // so the player can decline each prompt.
                             handler: devourSelfThen(flagEotPromote({ count: 2, optional: true })) }),

  // Cost 2 — Carrion Crawler: +3 power + replace a market card with self
  //   (the card-being-played enters the market in place of a devoured one)
  'carrion-crawler':     sequence(grant({ power: 3 }), marketDevourReplaceWithSelf()),

  // Cost 2 — Wraith: spy; optional devour-self → assassinate at the spy site
  'wraith':              sequence(
                           placeSpyAtChosenSite({ followUp: 'assassinate' }),
                           optionalDevourSelfThen(assassinateAtLastPlacedSpySite(),
                                                  'Devour Wraith to assassinate at the spy site?')),

  // Cost 3 — Wight: chooseOne(+2 power, devour-from-hand → supplant)
  'wight':               chooseOne(
                           { label: '+2 Power', handler: grant({ power: 2 }) },
                           { label: 'Devour a hand card → supplant a troop',
                             handler: devourFromHandCost(supplantChoice()),
                             available: (G, a) => G.players[a].hand.length > 0 }),

  // Cost 3 — Ghost: chooseOne(place spy, return spy → recruit top of
  //   devoured pile as if from market). Devoured pile is tracked
  //   server-side in G.devouredPile (Mechanics.devour pushes to it).
  'ghost':               chooseOne(
                           { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                           { label: 'Return a spy → recruit top of devoured pile',
                             handler: sequence(returnOwnSpyChoice(), recruitFromDevouredPile()),
                             available: playerHasOwnSpy }),

  // Cost 3 — Flesh Golem: +2 power; optional devour-self → assassinate
  'flesh-golem':         sequence(
                           grant({ power: 2 }),
                           optionalDevourSelfThen(assassinateChoice(),
                                                  'Devour Flesh Golem to assassinate?',
                                                  )),

  // Cost 3 — Ravenous Zombies: +1 power + assassinate a white troop
  'ravenous-zombies':    sequence(grant({ power: 1 }), assassinateChoice({ whiteOnly: true })),
  // Cost 3 — Minotaur Skeleton: chooseOne(deploy 3, devour-self → assassinate up to 3 whites at one site)
  //   "At one site" restriction approximated as 3 white assassinates.
  'minotaur-skeleton':   chooseOne(
                           { label: 'Deploy 3 troops', handler: deployChoice({ count: 3 }) },
                           { label: 'Devour this → assassinate up to 3 white troops at one site',
                             handler: optionalDevourSelfThen(assassinateChoice({ count: 3, whiteOnly: true, sameSite: true }),
                                                              'Devour Minotaur Skeleton?'),
                             available: (G, a) => playerCanAssassinate(G, a, { whiteOnly: true }) }),

  // Cost 4 — Banshee: spy + "if there is another spy there, +3 attack."
  //   "Another spy" = any spy other than the one we just placed (incl.
  //   our own from an earlier turn, per a literal read of the printed
  //   text). Check spies count at the last-placed site after our placement;
  //   length > 1 means at least one was already there.
  'banshee':             sequence(
                           placeSpyAtChosenSite(),
                           (ctx => {
                             const siteId = (ctx.G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
                             if (!siteId) return true;
                             const spies = ctx.G.spies[siteId] ?? [];
                             if (spies.length > 1) {
                               ctx.G.players[ctx.actorId].power += 3;
                               Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +3 Power from Banshee (another spy at ${siteId})`,
                                 { kind: 'power.gain', payload: { amount: 3, source: 'Banshee', site: siteId }, side: ctx.actorId });
                             }
                             return true;
                           })),

  // Cost 4 — Ogre Zombie: supplant a white troop anywhere
  'ogre-zombie':         supplantChoice({ whiteOnly: true, anywhere: true }),
  // Cost 4 — Revenant: assassinate 2 troops; if you have 8+ trophies,
  //   self-promote (move this card to inner circle instead of discard).
  //
  // The earlier hand-rolled step-counter wrapper had a latent bug
  // (problem-report #42): it returned false BETWEEN the two assassinates
  // without setting a pendingChoice, so the engine's resolveChoice path
  // saw "not done, no prompt" and stalled — only the first assassinate
  // ever fired. Replaced with sequence(assassinateChoice({count:2}), …)
  // which is engine-safe and also gets the correct "(2 left) → (1 left)"
  // prompt counter (cf. #38).
  'revenant':            (ctx => {
                           // Run the 2-assassinate stage via the count=2 helper
                           // (no inter-pick stall, correct "(2 left)/(1 left)"
                           // prompt label). When that stage finishes we check
                           // the trophy threshold and optionally self-promote.
                           // Inner state distinguishes the two phases.
                           interface RS { phase: 'assassinate' | 'promote'; sub?: unknown; returnedToSupply?: boolean }
                           const state = (ctx.handlerState as RS | null) ?? { phase: 'assassinate', sub: null };
                           if (state.phase === 'assassinate') {
                             const handler = assassinateChoice({ count: 2 });
                             const childCtx = { ...ctx, handlerState: state.sub ?? null,
                                                 pendingChoice: ctx.pendingChoice, paused: ctx.paused } as typeof ctx;
                             const done = handler(childCtx);
                             ctx.pendingChoice = childCtx.pendingChoice;
                             ctx.paused = childCtx.paused;
                             if (!done) {
                               ctx.handlerState = { phase: 'assassinate', sub: childCtx.handlerState };
                               return false;
                             }
                             // Assassinate phase complete — fall through to promote check.
                           }
                           const me = ctx.G.players[ctx.actorId];
                           if (totalTrophies(me) >= 8) {
                             Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} promoted Revenant (8+ trophies)`,
                               { kind: 'card.promote', payload: { card: 'Revenant', source: 'self-promote' }, side: ctx.actorId });
                             me.innerCircle.push({ ...ctx.card });
                             ctx.handlerState = { returnedToSupply: true };
                             return true;
                           }
                           ctx.handlerState = null;
                           return true;
                         }),

  // Cost 5 — Conjurer: chooseOne(place spy, return spy → recruit up to 2
  //   cards of cost ≤3). Uses recruitFromMarketFiltered twice with
  //   maxCost=3, optional declines.
  'conjurer':            chooseOne(
                           { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                           { label: 'Return a spy → free-recruit up to 2 cards (cost ≤3)',
                             handler: sequence(
                               returnOwnSpyChoice(),
                               recruitFromMarketFiltered({ maxCost: 3, includeAuxStacks: true, quantity: 2, optional: true })),
                             available: playerHasOwnSpy }),
  // Cost 5 — Necromancer: chooseOne over four branches per the printed
  //   text — "+3 money OR promote this card OR promote a card from your
  //   hand OR promote a card from your discard."
  'necromancer':         chooseOne(
                           { label: '+3 Influence', handler: grant({ influence: 3 }) },
                           { label: 'Promote this card (Necromancer → inner circle)', handler: promoteSelf() },
                           { label: 'Promote a card from your hand', handler: promoteFromHandChoice(),
                             available: (G, a) => G.players[a].hand.length > 0 },
                           // #108: `discard.length > 0` counted this turn's
                           // play-area cards, so the option showed up on turns
                           // where nothing was actually promotable and picking
                           // it did nothing. Ask the same question the picker
                           // will.
                           { label: 'Promote a card from your discard', handler: promoteFromDiscardChoice(),
                             available: (G, a) => promotableDiscardIndices(G, a).length > 0 }),

  // Cost 6 — Death Knight: supplant a troop + 1 VP per 5 player trophies
  'death-knight':        sequence(
                           supplantChoice(),
                           (ctx => {
                             const me = ctx.G.players[ctx.actorId];
                             // "Player trophies" = colored trophies (not white).
                             let coloredTrophies = 0;
                             for (const [color, n] of Object.entries(me.trophyHall)) {
                               if (color === 'white') continue;
                               coloredTrophies += n;
                             }
                             const vp = Math.floor(coloredTrophies / 5);
                             if (vp > 0) {
                               me.vp += vp;
                               Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${vp} VP from Death Knight (${coloredTrophies} player trophies)`,
                                 { kind: 'vp.gain', payload: { amount: vp, source: 'Death Knight' }, side: ctx.actorId });
                             }
                             return true;
                           })),
  // Cost 6 — Mummy Lord: choose twice: assassinate a white troop, OR
  //   take a white trophy from another player and place it. We surface
  //   the choice menu twice (the player can do either action, or both,
  //   or both-the-same).
  // "Choose 2 times: Assassinate a white troop OR take a white troop from
  //  ANY trophy hall and deploy it anywhere on the board." Two corrections
  //  vs the pre-#57 implementation:
  //    - Take-trophy now restricts to WHITE trophies (was offering any
  //      colour, including player-colour trophies).
  //    - Availability includes the actor's own white trophies — "any
  //      trophy hall" per the card text means own + opponents'.
  'mummy-lord':          times(2, chooseOne(
                           { label: 'Assassinate a white troop', handler: assassinateChoice({ whiteOnly: true }),
                             available: (G, a) => playerCanAssassinate(G, a, { whiteOnly: true }) },
                           { label: 'Take a white trophy from any hall and place it',
                             handler: takeTrophyAndPlace({ count: 1, whiteOnly: true, optional: false }),
                             available: (G) => {
                               // Any player's trophy hall (including the actor's own).
                               for (const p of Object.values(G.players)) {
                                 if ((p.trophyHall.white ?? 0) > 0) return true;
                               }
                               return false;
                             } })),

  // Cost 6 — High Priest of Myrkul: return another player's troop or spy
  //   + eot promote (Undead aspect filter — but Undead aspect varies on
  //   cards in this deck so we leave unrestricted for now).
  // "At end of turn, you may promote any number of Undead cards played
  // this turn." Three nuances vs the default flagEotPromote behavior:
  //   - `optional: true` (printed "you may").
  //   - aspect filter is technically wrong — the card says "Undead" (a
  //     creature type) not an aspect. Until we model creature types,
  //     leave the filter off; the prompt is at least optional so the
  //     player can decline non-Undead promotes manually.
  //   - "any number" should chain prompts as long as eligibles remain
  //     AND the player keeps picking. We don't model that — we queue 1.
  //     Worth a follow-up but doesn't break correctness of single uses.

  'high-priest-of-myrkul': sequence(
                            // fizzleIfNoTargets: true - prevents card from being played when there are
                            //                            no targets and "Play all basic" is selected.
                            returnEnemyTroopOrSpyChoice({ fizzleIfNoTargets: true }),
                            flagEotPromote({ optional: true, typeFilter: 'Undead' })),

  // Cost 7 — Vampire: chooseOne(supplant a troop, promote a card from
  //   discard then +1 VP per 3 promoted cards in inner circle).
  'vampire':             chooseOne(
                           { label: 'Supplant a troop', handler: supplantChoice() },
                           { label: 'Promote from discard + VP-per-3-promoted',
                             // NOT narrowed to promotableDiscardIndices (cf.
                             // Necromancer, #108): unlike Necromancer's, this
                             // option is not a no-op when the discard has
                             // nothing promotable — the "then gain 1 VP for
                             // every 3 cards in your inner circle" half still
                             // applies, and promoteFromDiscardChoice logs why
                             // the picker didn't open (#86).
                             available: (G, a) => G.players[a].discard.length > 0,
                             handler: sequence(
                               promoteFromDiscardChoice({ optional: false }),
                               (ctx => {
                                 const me = ctx.G.players[ctx.actorId];
                                 const vp = Math.floor(me.innerCircle.length / 3);
                                 if (vp > 0) {
                                   me.vp += vp;
                                   Mechanics.log(ctx.G, `P${Number(ctx.actorId) + 1} +${vp} VP from Vampire (${me.innerCircle.length} promoted)`,
                                     { kind: 'vp.gain', payload: { amount: vp, source: 'Vampire' }, side: ctx.actorId });
                                 }
                                 return true;
                               })) }),

  // Cost 7 — Lich: place a spy. "If another player has a troop there,
  //   take 2 trophies from their trophy hall and deploy them."
  //   Restricted to THE qualifying opponent(s). If multiple opponents
  //   have troops at the site, the player picks which one's hall; both
  //   trophies then come from that chosen player.
  //   Unlike Orcus (which prints "deploy them anywhere on the board"),
  //   Lich's deploy uses the plain deploy keyword — so placement is
  //   presence-restricted (restrictToPresence), per rulebook p.12.
  'lich':                sequence(
                           placeSpyAtChosenSite({ followUp: 'opponent-troop' }),
                           (ctx => {
                             interface S { phase: 'check' | 'pick-victim' | 'taking'; victimPid?: string; subState?: unknown }
                             let state = (ctx.handlerState as S | null) ?? { phase: 'check' };
                             const G = ctx.G;
                             const siteId = (G as unknown as { _lastPlacedSpySite?: string })._lastPlacedSpySite;
                             if (!siteId) return true;
                             const me = G.players[ctx.actorId];

                             // Phase 'check': enumerate qualifying victims (opponents with
                             // a troop at the spy site, AND non-empty trophy hall — taking
                             // from an empty hall is a no-op so skip those).
                             if (state.phase === 'check') {
                               const victims = new Set<string>();
                               for (const sp of TROOP_SPACES.filter(t => t.parentSite === siteId)) {
                                 const occ = G.troops[sp.id];
                                 if (!occ || occ === me.color || occ === 'white') continue;
                                 const pid = Object.keys(G.players).find(k => G.players[k].color === occ);
                                 if (!pid) continue;
                                 const p = G.players[pid];
                                 const totalTrophies = Object.values(p.trophyHall).reduce((a, b) => a + b, 0);
                                 if (totalTrophies > 0) victims.add(pid);
                               }
                               const list = [...victims];
                               if (list.length === 0) { ctx.handlerState = null; return true; }
                               if (list.length === 1) {
                                 state = { phase: 'taking', victimPid: list[0], subState: null };
                                 // fall through to taking
                               } else {
                                 // Multi-victim — surface a select-player prompt.
                                 ctx.pendingChoice = {
                                   kind: 'select-player',
                                   prompt: 'Lich: which opponent\'s trophy hall to take from?',
                                   options: list,
                                   optional: true,
                                 };
                                 ctx.paused = true;
                                 ctx.handlerState = { phase: 'pick-victim' };
                                 return false;
                               }
                             }

                             // Phase 'pick-victim' resume.
                             if (state.phase === 'pick-victim') {
                               const pid = ctx.pendingChoice?.response as string | null;
                               ctx.pendingChoice = null;
                               ctx.paused = false;
                               if (!pid) { ctx.handlerState = null; return true; }
                               state = { phase: 'taking', victimPid: pid, subState: null };
                               // fall through to taking
                             }

                             // Phase 'taking': call takeTrophyAndPlace with ownerPid lock.
                             if (state.phase === 'taking' && state.victimPid) {
                               const childCtx = {
                                 ...ctx,
                                 handlerState: state.subState ?? null,
                                 pendingChoice: ctx.pendingChoice,
                                 paused: ctx.paused,
                               };
                               const done = takeTrophyAndPlace({ count: 2, ownerPid: state.victimPid, restrictToPresence: true })(childCtx);
                               if (!done) {
                                 ctx.pendingChoice = childCtx.pendingChoice;
                                 ctx.paused = childCtx.paused;
                                 ctx.handlerState = { ...state, subState: childCtx.handlerState };
                                 return false;
                               }
                               ctx.handlerState = null;
                               return true;
                             }
                             ctx.handlerState = null;
                             return true;
                           })),
});

// Suppress unused-import noise.
void playerCanAssassinate;
void conditionalGrant;
