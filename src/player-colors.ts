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
