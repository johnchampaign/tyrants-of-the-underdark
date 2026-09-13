// Per-card classification for hand-play ordering. Used by the heuristic AI
// to decide which card in hand to play NEXT, given multiple legal choices.
//
// Categories (lower rank = play earlier):
//
//   1. 'hand'     — mutates the hand visibly: devour-from-hand cost cards
//                   (Marilith, Glabrezu, Mind Flayer, Balor, Demogorgon,
//                   Succubus, Orcus), draw-effect cards (Rather Modar),
//                   and Insane Outcast's discard-to-supply. Play FIRST so
//                   the rest of the hand has maximum flexibility for the
//                   prompts these surface.
//
//   2. 'power'    — pure +power grants and mixed P+I grants. Stockpile
//                   power BEFORE the tactical phase that spends it.
//
//   2. 'other'    — meta effects (end-of-turn promote queues, market /
//                   deck manipulation that doesn't affect THIS turn's
//                   tactical decisions). Bucketed with 'power' since the
//                   timing isn't sensitive.
//
//   3. 'tactical' — anything that touches the board: place / return spy,
//                   supplant, assassinate-via-effect, deploy-via-effect,
//                   move-troop, return-enemy. THE order-sensitive zone.
//                   Per user's notes: this is where careful sequencing
//                   matters (Master of Melee before Advance Scout, etc.).
//
//   4. 'influence' — pure +influence grants. Lock in influence total AFTER
//                    tactical actions are done, BEFORE the recruit step
//                    (which is handled separately, not via card play).
//
// Notes on edge cases:
//   - Mixed-resource cards (Red Wyrmling: +2P +2I) categorize as 'power'
//     since power is needed by the tactical phase that follows.
//   - chooseOne cards classify by the WORST-case option, conservatively —
//     e.g. Blackguard (+2P OR assassinate) is 'tactical' because if the AI
//     picks assassinate, ordering matters.
//   - Cards with devour-from-hand COST gate the rest of their effect on
//     paying — classify as 'hand' regardless of the gated effect's flavor.
//   - Cards with "give outcast to opponent" effects don't mutate OUR hand,
//     so they classify by their resource grant, not as 'hand'.

import { lookupCard } from '../card-data';
import type { CardRef } from '../game';

export type CardCategory = 'hand' | 'power' | 'tactical' | 'influence' | 'other';

const RANK: Record<CardCategory, number> = {
  hand: 1,
  power: 2,
  other: 2,        // bucket with power; timing isn't sensitive
  tactical: 3,
  influence: 4,
};

export function categoryRank(cat: CardCategory): number {
  return RANK[cat];
}

/** Hand-coded classification by effectKey. Built from src/engine/handlers/*.ts.
 *  Any effectKey not in this table falls back to 'other' (mid-priority). */
const TABLE: Record<string, CardCategory> = {
  // ---- Starter / aux-stack cards ----
  'noble':                'influence',
  'soldier':              'power',
  'house-guard':          'power',
  'priestess-of-lolth':   'influence',
  'insane-outcast':       'hand',

  // ---- Drow half-deck ----
  'spy-master':                 'tactical',
  'bounty-hunter':              'power',
  'mercenary-squad':            'tactical',
  'matron-mother':              'other',       // deck-to-discard + promote
  'advocate':                   'influence',   // chooseOne +2I or promote
  'drow-negotiator':            'influence',   // eot + conditional +3I
  'chosen-of-lolth':            'tactical',
  'council-member':             'tactical',
  'infiltrator':                'tactical',
  'information-broker':         'tactical',    // spy or return+draw
  'masters-of-sorcere':         'tactical',
  'spellspinner':               'tactical',
  'advance-scout':              'tactical',    // presence-required supplant
  'blackguard':                 'tactical',    // chooseOne +2P or assassinate
  'deathblade':                 'tactical',
  'doppelganger':               'tactical',
  'inquisitor':                 'tactical',
  'master-of-melee-magthere':   'tactical',
  'weaponmaster':               'tactical',
  'underdark-ranger':           'tactical',

  // ---- Dragons half-deck ----
  'red-wyrmling':       'power',       // +2P +2I, mixed → bias power
  'severin-silrajin':   'power',       // +5P
  'rath-modar':         'hand',        // draw 2 + 2 spies; draw dominates
  'wyrmspeaker':        'influence',
  'enchanter-of-thay':  'tactical',
  'green-wyrmling':     'tactical',
  'watcher-of-thay':    'tactical',
  'blue-wyrmling':      'tactical',
  'cleric-of-laogzed':  'tactical',
  'cult-fanatic':       'tactical',    // +2I + devour market
  'dragon-cultist':     'power',       // chooseOne +2P or +2I → mixed, bias power
  'black-wyrmling':     'tactical',
  'kobold':             'tactical',
  'white-wyrmling':     'tactical',
  'dragonclaw':         'tactical',
  'black-dragon':       'tactical',
  'blue-dragon':        'other',       // eot promote x2
  'green-dragon':       'tactical',
  'red-dragon':         'tactical',
  'white-dragon':       'tactical',

  // ---- Demons half-deck ----
  // give-outcast-to-opponent doesn't mutate OUR hand, so classify by grant.
  'myconid-adult':      'influence',
  'myconid-sovereign':  'other',       // eot + give outcast
  'ghoul':              'power',       // +2P + give outcast each
  'nalfeshnee':         'influence',   // +3I + promote top of deck
  'hezrou':             'tactical',    // move enemy + promote top
  // devour-from-hand cost gates all of these — play while hand is full.
  'marilith':           'hand',
  'glabrezu':           'hand',
  'mind-flayer':        'hand',
  'balor':              'hand',
  'demogorgon':         'hand',
  'orcus':              'hand',
  'succubus':           'hand',
  // gibbering-mouther: deploy + give outcast adjacent → tactical
  'gibbering-mouther':  'tactical',
  'jackalwere':         'tactical',
  'derro':              'tactical',
  'ettin':              'tactical',
  'grazzt':             'tactical',
  'night-hag':          'tactical',
  'vrock':              'tactical',
  // zuggtmoy: devour FROM INNER CIRCLE (not hand) + 3I + eot promote x2
  // → not a hand mutator. Bias influence.
  'zuggtmoy':           'influence',

  // ---- Aberrations half-deck (expansion) ----
  // Theme: forcing opponents to discard from hand. Most cards have a primary
  // tactical effect (assassinate, deploy, supplant, spy) plus a discard rider.
  'elder-brain':          'tactical',   // promote top + play-from-inner-circle
  'ulitharid':            'tactical',   // market manipulation (play+devour)
  'puppeteer':            'influence',  // +2 money + eot promote
  'intellect-devourer':   'tactical',   // or 3 money / or return 2
  'ambassador':           'other',      // eot promote + self-promote-on-discard
  'aboleth':              'hand',       // 2 spies OR draw N (hand-mutating)
  'chuul':                'tactical',   // spy + discard rider
  'brainwashed-slave':    'tactical',   // spy or return-spy chooseOne
  'nothic':               'tactical',   // spy / return-spy with draw + discard
  'cloaker':              'tactical',   // spy / return-spy to assassinate
  'neogi':                'tactical',   // deploy 4 + eot all-discard
  'quaggoth':             'tactical',   // assassinate-white-per-site
  'grimlock':             'tactical',   // deploy 2 + reactive draw
  'death-tyrant':         'tactical',   // assassinate up to 3 + money
  'cranium-rats':         'tactical',   // deploy 2 + discard
  'beholder':             'tactical',   // assassinate + power-per-trophy
  'mindwitness':          'tactical',   // assassinate + discard
  'gauth':                'tactical',   // 2 money / draw + discard
  'spectator':            'power',      // 2 attack 1 money
  'umber-hulk':           'tactical',   // deploy 3 + reactive discard

  // ---- Undead half-deck (expansion) ----
  // Theme: devouring (often self) for triggered effects, plus trophy / promote
  // interactions. Most are tactical.
  'lich':                 'tactical',   // spy + steal-trophies-deploy
  'vampire':              'tactical',   // supplant or promote-from-discard
  'death-knight':         'tactical',   // supplant + VP-per-trophy
  'mummy-lord':           'tactical',   // assassinate + take-trophy
  'high-priest-of-myrkul':'tactical',   // return troop/spy + eot promote-undead
  'revenant':             'tactical',   // assassinate 2 + self-promote-at-trophies
  'banshee':              'tactical',   // spy + +power-if-other-spy
  'vampire-spawn':        'tactical',   // 1 money + return troop/spy
  'conjurer':             'tactical',   // spy / return-spy to recruit
  'necromancer':          'influence',  // 3 money / promote alt
  'cultist-of-myrkul':    'influence',  // 2 money / devour-self for eot promote
  'ravenous-zombies':     'tactical',   // 1 attack + assassinate-white
  'skeletal-horde':       'tactical',   // deploy 2 / devour-self deploy 3
  'wight':                'tactical',   // 2 attack / devour-from-hand supplant
  'ghost':                'tactical',   // spy / return-spy market-recovery
  'carrion-crawler':      'tactical',   // 3 attack + market-devour-replace
  'wraith':               'tactical',   // spy + devour-self assassinate
  'flesh-golem':          'tactical',   // 2 attack + devour-self assassinate
  'ogre-zombie':          'tactical',   // supplant-white-anywhere
  'minotaur-skeleton':    'tactical',   // deploy 3 / devour-self assassinate-white

  // ---- Elemental half-deck ----
  // Focus triggers are commutative (per-aspect chain tally); don't bump category.
  'aerisi-kalinoth':         'tactical',   // spy + auto-recruit
  'air-elemental-myrmidon':  'tactical',
  'fire-elemental-myrmidon': 'power',
  'water-elemental-myrmidon':'tactical',
  'earth-elemental-myrmidon':'influence',
  'imix':                    'power',
  'ogremoch':                'influence',
  'black-earth-cultist':     'influence',  // eot + focus(+2I)
  'crushing-wave-cultist':   'tactical',
  'eternal-flame-cultist':   'tactical',
  'howling-hatred-cultist':  'tactical',
  'air-elemental':           'tactical',
  'earth-elemental':         'tactical',   // includes return-own-troop-or-spy
  'fire-elemental':          'power',      // chooseOne +2P/+2I → mixed, bias power
  'water-elemental':         'tactical',
  'gar-shatterkeel':         'tactical',
  'marlos-urnrayle':         'tactical',   // +1I + eot + auto-recruit
  'olhydra':                 'tactical',
  'vanifer':                 'tactical',
  'yan-c-bin':               'tactical',
};

export function categoryOf(effectKey: string): CardCategory {
  return TABLE[effectKey] ?? 'other';
}

/** Convenience: category for a CardRef. */
export function categoryOfCard(card: CardRef): CardCategory {
  const data = lookupCard(card.deck, card.slot);
  return data ? categoryOf(data.effectKey) : 'other';
}

// ---------------------------------------------------------------------------
// Influence yield
//
// The recruit heuristic scored a card on what it is worth (VP) and what it
// costs — and nothing at all on how much Influence it will generate later.
// Influence does not carry between turns, so affording a 7- or 8-cost card
// means having deliberately built a deck that produces 7 in a single turn.
// A human does that on purpose; the AI had no term for it, so it never built
// the engine and never reached the top of the market. Measured over 259 logged
// games: cards costing 7+ were 4.2% of human purchases and 1.3% of the AI's.
// Reported from BGG — "almost never able to buy cards worth 7-8 Influence".
//
// Parsed from the printed benefit text, whose vocabulary calls Influence
// "money". Two discounts, both deliberate:
//   - an "or ..." branch is worth about half, since taking it forgoes the
//     alternative the card also offers;
//   - a conditional ("if there are 4+ cards promoted, +3 money") likewise,
//     since it pays only when the condition holds.
// Guaranteed grants count in full and stack.

const INFLUENCE_RE = /\+(\d+)\s*money/;

/** Influence this card is expected to add to a turn, in the AI's valuation.
 *  Not a rules quantity — a heuristic estimate with the discounts above. */
export function influenceYieldOf(card: CardRef): number {
  const data = lookupCard(card.deck, card.slot);
  let guaranteed = 0;
  let branch = 0;
  for (const raw of data?.benefits ?? []) {
    const text = raw.trim().toLowerCase();
    const m = INFLUENCE_RE.exec(text);
    if (!m) continue;
    const amount = Number(m[1]);
    const conditional = text.startsWith('or') || text.startsWith('if') || text.includes(' if ');
    if (conditional) branch = Math.max(branch, amount);
    else guaranteed += amount;
  }
  return guaranteed + 0.5 * branch;
}
