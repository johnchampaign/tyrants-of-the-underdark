// Demons half-deck handlers.
//
// Theme: many cards have a "devour-from-hand" optional cost gating a powerful effect,
// and many give Insane Outcasts to opponents. Full implementation needs:
//   - A "devour a card in hand" PendingChoice flow
//   - Opponent-targeting for "give insane outcast to each opponent"

import { grant, sequence, registerAll, flagEotPromote,
         assassinateChoice, deployChoice, supplantChoice, chooseOne,
         devourFromHandCost, placeSpyAtChosenSite, assassinateAtLastPlacedSpySite,
         returnOwnSpyChoice, moveEnemyTroopChoice, promoteTopOfDeck,
         giveOutcastToEachOpponent, giveOutcastToChosenOpponent,
         devourFromInnerCircleCost, recruitOutcastToSelf, takeTrophyAndPlace,
         giveOutcastToOpponentAdjacentToLastDeploy, returnAnySpiesAndSupplantAtEach, playerHasUsefulSpyForSupplant,
         playerHasOwnSpy, playerCanAssassinate } from '../handler-helpers';

registerAll({
  'myconid-adult':        sequence(grant({ influence: 2 }), giveOutcastToChosenOpponent()),
  'myconid-sovereign':    sequence(flagEotPromote(), giveOutcastToChosenOpponent()),
  'ghoul':                sequence(grant({ power: 2 }), giveOutcastToEachOpponent()),
  'nalfeshnee':           sequence(grant({ influence: 3 }), promoteTopOfDeck()),
  'hezrou':               sequence(moveEnemyTroopChoice(), promoteTopOfDeck()),

  'marilith':             devourFromHandCost(grant({ power: 5 })),
  'glabrezu':             devourFromHandCost(assassinateChoice({ count: 2 })),
  'mind-flayer':          devourFromHandCost(chooseOne(
                            { label: '+3 Influence', handler: grant({ influence: 3 }) },
                            { label: 'Assassinate a troop', handler: assassinateChoice(),
                              available: (G, a) => playerCanAssassinate(G, a) })),
  'balor':                devourFromHandCost(sequence(
                            supplantChoice({ whiteOnly: true, anywhere: true }),
                            deployChoice({ count: 1 }))),

  'gibbering-mouther':    sequence(deployChoice({ count: 2 }), giveOutcastToOpponentAdjacentToLastDeploy()),
  'jackalwere':           chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → +2 Power +2 Influence', handler: sequence(returnOwnSpyChoice(), grant({ power: 2, influence: 2 })), available: playerHasOwnSpy }),

  'derro':                sequence(supplantChoice({ whiteOnly: true, anywhere: true }), recruitOutcastToSelf()),
  'ettin':                chooseOne(
                            { label: 'Deploy 3 troops', handler: deployChoice({ count: 3 }) },
                            { label: 'Assassinate 2 white troops', handler: assassinateChoice({ count: 2, whiteOnly: true }),
                              available: (G, a) => playerCanAssassinate(G, a, { whiteOnly: true }) }),
  'grazzt':               chooseOne(
                            { label: 'Place 2 spies', handler: sequence(placeSpyAtChosenSite(), placeSpyAtChosenSite()) },
                            { label: 'Return any number of your spies (supplant at each site)',
                              handler: returnAnySpiesAndSupplantAtEach(),
                              available: playerHasUsefulSpyForSupplant }),
  'demogorgon':           devourFromHandCost(sequence(
                            supplantChoice({ whiteOnly: true, anywhere: false }),
                            supplantChoice({ whiteOnly: true, anywhere: false }),
                            giveOutcastToEachOpponent({ count: 2 }))),
  'orcus':                devourFromHandCost(sequence(
                            assassinateChoice({ count: 2 }),
                            takeTrophyAndPlace({ count: 2 }))),

  'night-hag':            chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → draw 2', handler: sequence(returnOwnSpyChoice(), grant({ draw: 2 })), available: playerHasOwnSpy }),
  'succubus':             devourFromHandCost(sequence(
                            placeSpyAtChosenSite({ followUp: 'assassinate' }),
                            assassinateAtLastPlacedSpySite())),
  'vrock':                chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → +5 Power', handler: sequence(returnOwnSpyChoice(), grant({ power: 5 })), available: playerHasOwnSpy }),
  // "promote up to 2 other cards played this turn" — "up to" makes both
  // promotes optional.
  'zuggtmoy':             devourFromInnerCircleCost(sequence(
                            grant({ influence: 3 }),
                            flagEotPromote({ count: 2, optional: true }))),
});
