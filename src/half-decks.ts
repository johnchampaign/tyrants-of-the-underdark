// The market half-decks a game can be built from.
//
// Lives here rather than inside App.tsx so the online lobby can offer the same
// choice the solo/hotseat setup dialog does. Until it did, the online create
// endpoint took no deck argument at all and every online game silently fell
// through to the default pair — so elemental, demons and the expansion decks
// had never once been playable online (reported from BGG: "you always play the
// same game variation").

export type HalfDeck = 'drow' | 'dragons' | 'elemental' | 'demons' | 'aberrations' | 'undead';

export const HALF_DECKS: HalfDeck[] = ['drow', 'dragons', 'elemental', 'demons', 'aberrations', 'undead'];

/** Half-decks introduced in the Aberrations & Undead expansion. Setup screens
 *  group these under their own header so unfamiliar players can see which decks
 *  are base-game and which need the expansion. Game logic treats all six
 *  identically. */
export const EXPANSION_HALF_DECKS: ReadonlySet<HalfDeck> = new Set<HalfDeck>(['aberrations', 'undead']);

export const isHalfDeck = (v: unknown): v is HalfDeck =>
  typeof v === 'string' && (HALF_DECKS as string[]).includes(v);
