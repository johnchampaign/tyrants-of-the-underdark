// One source of truth for what each player colour looks like.
//
// There were three copies of this: the map's (complete), a trimmed one inside
// App.tsx's end-of-game summary that only knew the classic four, and a third in
// the online lobby's seat swatches. The trimmed copy is what made custom
// colours show up grey in the finished-game trophy table while the tooltip
// still named them correctly — reported from BGG: "summary table is not
// considering custom player colors as valid ones - those are being visually
// replaced by gray... yet showing correct color description when you hover".
//
// Any new surface that paints a player colour should import from here, so a
// colour added to SELECTABLE_COLORS can't be half-supported again.
import type { Color } from './game';

export const PLAYER_COLOR_HEX: Record<Color, string> = {
  // Lifted toward grey so tokens contrast against near-black site boxes.
  black: '#4a4a4a',
  red: '#c2362e',
  orange: '#d97a1d',
  blue: '#2b53b0',
  // Extra colours human players may pick — chosen to stay distinct from each
  // other and from the canonical four against the dark board.
  purple: '#9b5de5',
  green: '#3fa34d',
  teal: '#1fb6b0',
  pink: '#e36bb0',
  yellow: '#d9c520',
};

/** Neutral (Underdark) troops. Not a player colour, but painted alongside them.
 *  Darkened toward light grey so it stands out on white-bordered site boxes. */
export const WHITE_TOKEN_HEX = '#d0d0d0';

/** Paint for any colour string, including ones off the known list. Falls back
 *  to the string itself (CSS names like "purple" resolve) rather than to grey,
 *  so an unknown colour degrades to roughly the right hue instead of becoming
 *  indistinguishable from every other unknown. */
export const colorHex = (c: string): string =>
  PLAYER_COLOR_HEX[c as Color] ?? c;

/** "Teal" — display form of a colour name. */
export const colorName = (c: string): string => c.charAt(0).toUpperCase() + c.slice(1);

// --- Making the black player readable ------------------------------------
//
// Reported from the game (#109): the black colour "shows up gray on screen
// [and] is so dull compared to the other colors that it makes it really
// difficult to read the board state." True, and it's structural rather than a
// matter of taste. Every other colour in the palette is a saturated mid-tone,
// so it separates from the board by HUE. Black has no hue, and the one grey
// that works as a token fill in both render modes is a mid grey — which lands
// at almost exactly the luminance of the blue cavern art the tokens sit on
// (#4a4a4a vs ~#486595 is about 1.5:1). Lightening the fill would collide with
// the neutral Underdark token; darkening it would vanish on the near-black
// boxes of the images-off board.
//
// So black earns its contrast from a LINE rather than from its fill: a bright
// rim and a light halo, which is the same trick the neutral token already uses
// (ring + centre pip) and which survives colour-blindness and the forced
// dark-mode repaint MapView fights elsewhere.

/** True for player colours too dark to be read as a line, a ring or a glow
 *  against the board. Only black — everything else is a mid-tone. */
export const needsLightRim = (c: string): boolean => c === 'black';

/** Bright rim drawn on a dark player's tokens. Matches the page foreground, so
 *  it reads as "outlined", not as a second player colour. */
export const DARK_RIM_HEX = '#e6e1f2';

/** Halo behind a dark player's token: a hairline of true black to bite into
 *  pale board art, then a soft light bloom to lift it off dark art. */
export const DARK_RIM_SHADOW = '0 0 0 1px #000, 0 1px 4px rgba(255,255,255,0.5)';

/** Paint for a ring/border drawn in a player's colour. Same as the fill for
 *  every colour that has luminance to spare; the bright rim for black. */
export const rimHex = (c: string): string =>
  needsLightRim(c) ? DARK_RIM_HEX : colorHex(c);
