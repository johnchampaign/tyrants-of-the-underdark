// The black player must not be the dim one.
//
// Reported from the game (#109): the black colour "shows up gray on screen
// [and] is so dull compared to the other colors that it makes it really
// difficult to read the board state." Two things were wrong, and both were the
// same mistake — a surface deciding for itself what a player colour looks like
// instead of asking the palette:
//
//   * the scoreboard chip painted the raw colour NAME, so the black seat's
//     swatch was CSS `black` — a #000 square on a near-black page, i.e. a hole
//     in the scoreboard where every other seat had a bright chip;
//   * black's mid-grey paint has no luminance to spare on the dark surfaces we
//     draw lines on. A control ring in #4a4a4a on the marker's #241638 disc was
//     a ring you had to hunt for, so a city held by black read as one nobody
//     held.
//
// Every other colour in the palette is a saturated mid-tone: it separates from
// the board by HUE, which is why luminance contrast is the wrong yardstick for
// them and why they're all fine with a hairline rim. Black has no hue to spend,
// and no single grey works on both the pale printed board and the near-black
// boxes of the images-off board — so black earns its contrast from a LINE, a
// bright rim, rather than from its fill.
//
// What this pins — deliberately relative, so it states the design rule rather
// than freezing nine hex values:
//
//   1. Every colour a player can pick, and every opponent colour, is in the
//      palette. (The missing-entry bug this file's header describes.)
//   2. On each dark ground we paint on, black's line colour is at least as
//      readable as the weakest mid-tone colour. Black stops being the outlier.
//   3. Black resolves to a light rim that separates from its own fill, and
//      stays far enough from the neutral Underdark token that lifting the fill
//      was never the fix.
//   4. Only black claims the special case. A colour added later inherits the
//      ordinary behaviour unless it opts in.
//
//   npx vite-node scripts/test-player-color-contrast.ts
import { SELECTABLE_COLORS, COLORS } from '../src/game';
import {
  PLAYER_COLOR_HEX, WHITE_TOKEN_HEX, rimHex, needsLightRim, DARK_RIM_HEX,
} from '../src/player-colors';

let ok = true;
const fail = (m: string) => { console.log(`FAIL  ${m}`); ok = false; };
const pass = (m: string) => console.log(`PASS  ${m}`);

/** sRGB hex -> WCAG relative luminance. */
const lum = (hex: string): number => {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255)
    .map(c => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// The dark grounds a player colour gets drawn as a LINE on: the page, the
// images-off site box, and the control marker's disc — which is the darkest,
// and was the one that hid a black-held city.
const GROUNDS: Record<string, string> = {
  'page background': '#140c22',
  'schematic site box': '#18102a',
  'control-marker disc': '#241638',
};

// 1. No colour a player can pick may be missing from the palette.
// COLORS is the four AI seats; SELECTABLE_COLORS is those plus the extras a
// human may pick. Neither includes the neutral 'white', which is board
// furniture rather than a seat and carries its own paint.
const everyColor = [...new Set([...SELECTABLE_COLORS, ...COLORS])];
for (const c of everyColor) {
  if (!PLAYER_COLOR_HEX[c]) fail(`${c} has no PLAYER_COLOR_HEX entry — surfaces fall back to guessing`);
}
if (ok) pass(`all ${everyColor.length} player colours are in the palette`);

// 2. Black's line colour must be no dimmer than the weakest mid-tone. The bar
//    is what the rest of the palette already manages, so this can't fail
//    because of a colour nobody complained about — only because black has
//    slipped back to being the odd one out.
const midTones = Object.keys(PLAYER_COLOR_HEX).filter(c => c !== 'black');
for (const [where, bg] of Object.entries(GROUNDS)) {
  const weakest = midTones
    .map(c => ({ c, r: contrast(rimHex(c), bg) }))
    .reduce((a, b) => (b.r < a.r ? b : a));
  const black = contrast(rimHex('black'), bg);
  if (black < weakest.r) {
    fail(`on the ${where}, black's line (${rimHex('black')}, ${black.toFixed(2)}:1) is dimmer than `
      + `the weakest other colour (${weakest.c}, ${weakest.r.toFixed(2)}:1) — that is exactly the complaint`);
  }
}
if (ok) pass('black draws at least as readably as every other colour on all three dark grounds');

// 3. Black is the colour that needs the rim, and the rim must not impersonate
//    the neutral Underdark token — the one other grey on the board.
if (!needsLightRim('black')) fail('black no longer asks for a light rim — the #109 fix has been undone');
if (rimHex('black') !== DARK_RIM_HEX) fail(`rimHex('black') is ${rimHex('black')}, expected the bright rim ${DARK_RIM_HEX}`);
if (contrast(rimHex('black'), PLAYER_COLOR_HEX.black) < 3) {
  fail(`black's rim ${rimHex('black')} does not separate from its own fill ${PLAYER_COLOR_HEX.black}`);
}
if (contrast(PLAYER_COLOR_HEX.black, WHITE_TOKEN_HEX) < 4.5) {
  fail(`black ${PLAYER_COLOR_HEX.black} is too close to the neutral token ${WHITE_TOKEN_HEX} `
    + `(${contrast(PLAYER_COLOR_HEX.black, WHITE_TOKEN_HEX).toFixed(2)}:1) — lifting the fill is not the fix`);
}
// 4. Only black opts in; a future colour must do so deliberately.
for (const c of Object.keys(PLAYER_COLOR_HEX)) {
  if (c === 'black') continue;
  if (needsLightRim(c)) fail(`${c} unexpectedly claims the dark-colour rim`);
  if (rimHex(c) !== PLAYER_COLOR_HEX[c as keyof typeof PLAYER_COLOR_HEX]) fail(`rimHex('${c}') should be the colour itself`);
}
if (ok) pass('black takes the light rim, stays distinct from the neutral token, and nothing else claims the special case');

// The numbers are the point, so print them.
console.log('\n           fill     line      page    box   disc');
for (const c of Object.keys(PLAYER_COLOR_HEX)) {
  const row = Object.values(GROUNDS).map(bg => contrast(rimHex(c), bg).toFixed(1).padStart(6)).join(' ');
  console.log(`  ${c.padEnd(8)} ${PLAYER_COLOR_HEX[c as keyof typeof PLAYER_COLOR_HEX]}  ${rimHex(c).padEnd(8)} ${row}`);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
