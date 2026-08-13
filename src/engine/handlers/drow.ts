// Drow half-deck handlers.
//
// Approach: pure-resource cards land cleanly with `grant`. Cards that need targeting
// (assassinate which troop, supplant which space, return which troop/spy) are stubbed
// pending the targeted-action UI/AI hooks. Choose-one cards are stubbed too — we'll
// add a `chooseOne` helper once the UI can surface multi-option prompts.

import { grant, flagEotPromote, placeSpyAtChosenSite, sequence, registerAll,
         assassinateChoice, deployChoice, supplantChoice, chooseOne, times,
         returnOwnSpyChoice, supplantAtLastReturnedSpySite, moveEnemyTroopChoice,
         conditionalGrant, moveDeckToDiscard, promoteFromDiscardChoice,
         returnEnemyTroopOrSpyChoice, ifAnotherPlayerTroopAtLastPlacedSpySite,
         playerHasOwnSpy, playerCanAssassinate } from '../handler-helpers';

registerAll({
  'spy-master':           placeSpyAtChosenSite(),
  'bounty-hunter':        grant({ power: 3 }),
  'mercenary-squad':      deployChoice({ count: 3 }),
  'matron-mother':        sequence(moveDeckToDiscard(), promoteFromDiscardChoice()),

  'advocate':             chooseOne(
                            { label: '+2 Influence',                        handler: grant({ influence: 2 }) },
                            { label: 'Promote a card you played this turn', handler: flagEotPromote() }),
  'drow-negotiator':      sequence(
                            flagEotPromote(),
                            conditionalGrant(
                              (G, pid) => G.players[pid].innerCircle.length >= 4,
                              grant({ influence: 3 }),
                              'inner circle has 4+ cards')),
// fizzleIfNoTargets: true - prevents card from being played when there are
//                            no targets and "Play all basic" is selected.
  'chosen-of-lolth':      sequence(returnEnemyTroopOrSpyChoice({ fizzleIfNoTargets: true }), flagEotPromote()),
  'council-member':       sequence(moveEnemyTroopChoice({ count: 2, optional: true }), flagEotPromote()),

  'infiltrator':          sequence(placeSpyAtChosenSite({ followUp: 'opponent-troop' }), ifAnotherPlayerTroopAtLastPlacedSpySite(grant({ power: 1 }))),
  'information-broker':   chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → draw 3', handler: sequence(returnOwnSpyChoice(), grant({ draw: 3 })), available: playerHasOwnSpy }),
  'masters-of-sorcere':   chooseOne(
                            { label: 'Place 2 spies', handler: sequence(placeSpyAtChosenSite(), placeSpyAtChosenSite()) },
                            { label: 'Return a spy → +4 Power', handler: sequence(returnOwnSpyChoice(), grant({ power: 4 })), available: playerHasOwnSpy }),
  'spellspinner':         chooseOne(
                            { label: 'Place a spy', handler: placeSpyAtChosenSite() },
                            { label: 'Return a spy → supplant at that site', handler: sequence(returnOwnSpyChoice(), supplantAtLastReturnedSpySite()), available: playerHasOwnSpy }),

  'advance-scout':        supplantChoice({ whiteOnly: true }),
  'blackguard':           chooseOne(
                            { label: '+2 Power', handler: grant({ power: 2 }) },
                            { label: 'Assassinate', handler: assassinateChoice(),
                              available: (G, a) => playerCanAssassinate(G, a) }),
  'deathblade':           assassinateChoice({ count: 2 }),
  'doppelganger':         supplantChoice(),
  'inquisitor':           chooseOne(
                            { label: '+2 Influence', handler: grant({ influence: 2 }) },
                            { label: 'Assassinate', handler: assassinateChoice(),
                              available: (G, a) => playerCanAssassinate(G, a) }),
  'master-of-melee-magthere': chooseOne(
                            { label: 'Deploy 4 troops', handler: deployChoice({ count: 4 }) },
                            { label: 'Supplant white anywhere', handler: supplantChoice({ whiteOnly: true, anywhere: true }) }),
  'weaponmaster':         times(3, chooseOne(
                            { label: 'Deploy a troop', handler: deployChoice({ count: 1 }) },
                            { label: 'Assassinate a white troop', handler: assassinateChoice({ whiteOnly: true }),
                              available: (G, a) => playerCanAssassinate(G, a, { whiteOnly: true }) })),
  'underdark-ranger':     assassinateChoice({ count: 2, whiteOnly: true }),
});
