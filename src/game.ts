import type { Game } from 'boardgame.io';
import { INVALID_MOVE } from 'boardgame.io/core';
import './engine/handlers'; // register handlers
import { CardRegistry } from './engine/registry';
import { Mechanics } from './engine/mechanics';
import { logEvent, ensureStructuredLog, nextLogSeq, logLineText } from './engine/log';
import { appendGameLog, type GameLogEntry } from 'digital-boardgame-framework';
import { lookupCard, cardsInDeck } from './card-data';
import type { EffectContext, PendingChoice } from './engine/types';
import { SITES } from './data/sites';
import { TROOP_SPACES, sitesSpaces } from './data/troop-spaces';
import { ROUTES } from './data/routes';
import { deployTroop, assassinateTroop, hasPresence, returnSpy, payHeldMarkerEffectsAtTurnStart } from './engine/map-state';
import { ensureSpiesLeftInitialized, applyEotInnerCircleVp } from './engine/handler-helpers';

// The four canonical seat colours from the printed game, plus extras we offer
// human players who want something different. The AI seats only ever use the
// canonical four — see COLORS / SELECTABLE_COLORS below.
export type Color =
  | 'black' | 'red' | 'orange' | 'blue'
  | 'purple' | 'green' | 'teal' | 'pink' | 'yellow';

/** Power cost of the base-action assassinate and return-enemy-spy moves
 *  (rulebook p.10). Hardcoded engine-side in the move handlers; the UI
 *  gating + AIs reference this constant to keep them in sync. Don't lower
 *  the heuristic AI's `powerThresholdForAssassinate` below this — the
 *  engine will reject the move as INVALID and the AI will burn a turn. */
export const BASE_ACTION_POWER_COST = 3;

export interface CardRef {
  deck: string;
  slot: number;
  name: string;
  image: string;
}

export interface PlayerData {
  color: Color;
  deck: CardRef[];
  hand: CardRef[];
  discard: CardRef[];
  innerCircle: CardRef[];
  cardsPlayed: CardRef[];
  /** Per-color count of captured tokens. Orcus moves specific colored tokens out,
   *  so we keep the source color around (we don't aggregate non-white into one
   *  "enemy" bucket). Black Dragon's scoring rider reads `.white`. */
  // Keyed by the killed troop's colour (+ 'white' for neutrals). Counts are
  // added on demand, so extra human colours need no special init.
  trophyHall: Record<string, number>;
  /** Troops remaining in your barracks (start 40, rulebook p.2). When 0, deploys give 1 VP. */
  barracksLeft: number;
  /** Spy figures left in your supply (start 5, rulebook). When 0, a "place
   *  a spy" effect either skips entirely or lets you return one of your
   *  already-placed spies to the supply and place it elsewhere. */
  spiesLeft: number;
  power: number;
  influence: number;
  vp: number;
}

export function totalTrophies(p: PlayerData): number {
  return Object.values(p.trophyHall).reduce((s, n) => s + n, 0);
}

/** Sum of all non-white (i.e. opponent-color) trophies. */
export function enemyTrophies(p: PlayerData): number {
  let s = 0;
  for (const [c, n] of Object.entries(p.trophyHall)) if (c !== 'white') s += n;
  return s;
}

/** Increment the trophy hall slot for `color` (or 'white'). */
export function addTrophy(p: PlayerData, color: Color | 'white'): void {
  p.trophyHall[color] = (p.trophyHall[color] ?? 0) + 1;
}

export interface ControlMarker {
  siteId: string;
  /** Color currently holding the marker, or null if on the board. */
  holder: Color | null;
  /** Last-computed face of the chit at end-of-turn scoring. Kept for save
   *  back-compat and audit logs; the live UI derives the displayed face from
   *  hasTotalControl() against G.troops directly, so this field doesn't drive
   *  rendering. */
  side: 'control' | 'total-control';
  /** Per-turn bonus when the holder has plain control. Every printed marker
   *  gives +1 influence on this face (the spider-web icon). */
  controlInfluence: number;
  controlVp: number;
  /** Per-turn bonus when the holder has total control. All seven markers give
   *  +1 influence + N VP on this face — N varies per site (Araumycos = 3,
   *  Menzoberranzan = 2, every other = 1). Verified by reading both faces
   *  from the scripted TTS mod (2745860709). */
  totalControlInfluence: number;
  totalControlVp: number;
}

/** Printed per-site values for both faces of each control marker. Sourced
 *  directly from assets/tokens/<site>-control.jpg and -total-control.jpg. */
const MARKER_VALUES: Record<string, {
  controlInfluence: number; controlVp: number;
  totalControlInfluence: number; totalControlVp: number;
}> = {
  gauntlgrym:     { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 },
  menzoberranzan: { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 2 },
  araumycos:      { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 3 },
  chchitl:        { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 },
  phaerlin:       { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 },
  sszuraassnee:   { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 },
  tsenviilyq:     { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 },
};

export interface TyrantsState {
  market: {
    deck: CardRef[];
    row: (CardRef | null)[];
  };
  /** Permanent recruitable stacks separate from the rotating market row.
   *  Rulebook components: 15 House Guards, 15 Priestesses of Lolth. Each
   *  player may recruit from these any number of times (until the stack
   *  empties) for the printed cost; both decrement when recruited but
   *  emptying them does NOT trigger end-of-game (only the market deck
   *  emptying or a player's barracks emptying does). Insane Outcasts are
   *  tracked separately by the card handlers that hand them out — not a
   *  player-recruitable stack. */
  auxStacks: { houseGuards: number; priestesses: number };
  players: Record<string, PlayerData>;
  /** Structured game log (framework log-format v2). Legacy saves carried
   *  string[] here — ensureStructuredLog upgrades them on load/turn start. */
  log: GameLogEntry[];
  /** Turn number stamped onto log entries (set at turn.onBegin). */
  logTurn?: number;
  /** Acting seat stamped onto log entries (set at turn.onBegin). */
  logSide?: string | null;
  /** Set while an effect is awaiting a player/AI choice. */
  pendingChoice: (PendingChoice & { playerId: string; cardKey: string }) | null;
  /** Opaque per-card state preserved across resumptions of the same effect. */
  pausedHandlerState: unknown;

  // -- Map state --
  /** What occupies each troop space. null = empty. */
  troops: Record<string, Color | 'white' | null>;
  /** Spies present at each site (by player color). */
  spies: Record<string, Color[]>;
  /** Current controller of each site (recomputed by Mechanics on mutation). */
  siteControl: Record<string, Color | null>;
  /** Site-control markers (rulebook p.11). */
  controlMarkers: Record<string, ControlMarker>;

  /** True while players are picking their starting-site deploys (rulebook p.4 step 11). */
  setupPhase: boolean;

  /** Per-turn tally of card aspects played by the current player. Reset each turn.
   *  Used by the Focus keyword to detect "another card of this aspect this turn." */
  turnAspectsPlayed: Record<string, number>;

  /** SiteIds of control-marker sites that have already paid out their
   *  control-side influence bonus to the current player this turn. Prevents
   *  flipping control on/off mid-turn from farming repeated +1 influence
   *  from the same marker. Cleared each turn at onBegin. */
  markerInfluenceGrantedThisTurn: string[];
  /** SiteIds whose TOTAL-control bonus has been paid this turn. If a marker
   *  was paid at control-only level earlier in the turn and the player
   *  later upgrades to TC (e.g. spy on site got cleared by another effect),
   *  payMarkerEffect pays the delta and adds the marker here. Without this
   *  separate ledger, the TC VP bonus is silently skipped — the "I had TC
   *  at end of turn but got no VP" bug. Cleared each turn at onBegin. */
  markerTcGrantedThisTurn: string[];

  /** Color of the player whose turn it currently is. Mirrors
   *  G.players[ctx.currentPlayer].color so engine code that doesn't get ctx
   *  (notably recomputeSiteControl in map-state.ts) can still know who's
   *  acting. Set in turn.onBegin, cleared at turn.onEnd. */
  activeTurnColor: Color | null;

  /** Cards played by the current player this turn (in order). Reset each turn.
   *  Used by end-of-turn promote-a-played-card effects. */
  cardsPlayedThisTurn: CardRef[];

  /** Log SEQ marker for the start of the current turn (seq-based, not an
   *  index, so the log cap can trim old entries without corrupting slices). */
  turnLogStart: number;
  /** Captured per-turn log slices. Each entry is one completed turn. */
  turnLogs: Array<{ turn: number; playerId: string; color: Color; lines: string[] }>;
  /** Per-turn-start state snapshots (codec strings). One per turn since game start.
   *  Use loadState to rewind to any of these. */
  snapshots: Array<{ turn: number; playerId: string; color: Color; codec: string }>;

  /** Within-turn undo stack: codec snapshots captured BEFORE each undoable
   *  action this turn. The `undo` move pops the last one. Cleared at turn
   *  start and — crucially — whenever an action reveals hidden information
   *  (drawing a card, refilling the market, looking at the top of a deck):
   *  you may undo freely until you learn something new, then that becomes a
   *  one-way door. Peeled from encodeSnapshot so codecs don't nest. */
  undoStack: string[];

  /** Queue of end-of-turn "promote another card played this turn" effects. Each entry
   *  is the card that triggered the promotion (so the picker can exclude it from the
   *  eligible list). Drained during the endTurn prompt loop. */
  /** Triggers waiting on an end-of-turn "promote a played card" prompt.
   *  Most entries are bare CardRef (any-played-card promote, e.g. Earth
   *  Elemental Myrmidon). Entries with `aspectFilter` set restrict the
   *  eligible options to played cards of that aspect — the Air / Fire /
   *  Water Myrmidons all restrict to 'Obedience' per their printed text.
   *  `optional` tracks whether the printed text says "you may promote" —
   *  default is mandatory ("if possible") when the word "may" is absent.
   *  This follows the community consensus reading on BGG thread 1712589;
   *  the actual designers (Peter Lee / Rodney Thompson / Andrew Veen)
   *  haven't ruled on it publicly. */
  pendingEotPromotions: Array<EotPromoteTrigger>;
  /** End-of-turn "gain 1 VP per N cards in your inner circle" grants, queued by
   *  cards whose VP is awarded at end of turn AFTER their promotes resolve
   *  (Blue Dragon: "At end of turn, promote up to 2…, then gain 1 VP for every 3
   *  cards in your inner circle"). Drained in turn.onEnd, once the inner-circle
   *  count is final. Reset each turn. */
  pendingEotInnerCircleVp: Array<{ playerId: string; perN: number; source: string }>;
  /** Persistent pile of every card that Mechanics.devour has consumed
   *  this game. Aberrations/Undead expansion mechanics reference it
   *  (Ghost's "top of devoured" recovery). Older saves don't have it;
   *  turn.onBegin backfills to []. */
  devouredPile: CardRef[];

  /** Turn number at which the end-game trigger fired (deploy-last-troop or market empty).
   *  The game ends at the end of the round containing this turn (rulebook p.14). */
  endGameTriggeredAtTurn: number | null;

  /** Set by deployStartingTroop before it calls events.endTurn(); read+cleared in onEnd
   *  to skip the regular turn-end cleanup (discard hand, redraw, site-VP gain). */
  _endingSetupTurn?: boolean;
  /** True when this state is driven by the ONLINE adapter (stamped at setup by
   *  tyrantsAdapter, backfilled on decode for games created before the flag
   *  existed). Undo is unusable online — redactState zeroes G.undoStack for
   *  every viewer and OnlinePlay stubs undo/redo/loadState — so capturing undo
   *  restore-points server-side is pure waste (#104 follow-up). */
  _online?: boolean;

  /** Player ID (as a string seat index) chosen at setup to act first. Drives
   *  turn.order.first; the human is always seated at "0" but doesn't necessarily
   *  go first. */
  firstPlayerId: string;

  /** Site IDs that are part of THIS game (rulebook p.5 player-count rules:
   *  2P uses only the center section, 3P uses center + one outer, 4P uses
   *  all three). Sites outside this set never appear in troops/siteControl
   *  /controlMarkers and should be hidden from the map render. */
  activeSites: string[];

  /** Which sections are in play this game ('left' | 'center' | 'right'). */
  activeSections: string[];
}

// Canonical seat order — AI seats always draw from these four, and a game with
// no colour pick uses them in order (keeps old saves / training comparable).
export const COLORS: Color[] = ['black', 'red', 'orange', 'blue'];
// Everything a human may pick for their own seat: the canonical four plus extras.
export const SELECTABLE_COLORS: Color[] = [
  ...COLORS, 'purple', 'green', 'teal', 'pink', 'yellow',
];
const HAND_SIZE = 5;
// Max per-turn state snapshots kept for the hotseat "Load turn" rewind. Bounds
// the persisted state size (each snapshot is a full state codec). See onBegin.
const SNAPSHOT_CAP = 20;

function toCardRef(deck: string, slot: number): CardRef {
  const c = lookupCard(deck, slot);
  if (!c) throw new Error(`Unknown card ${deck}::${slot}`);
  return { deck, slot, name: c.name, image: c.image };
}

/** Queued end-of-turn promote trigger. `aspectFilter` restricts the
 *  eligible options to played cards of that aspect (Myrmidons). `optional`
 *  flips the prompt from mandatory (default — RAW for "promote..." without
 *  "may") to declinable. */
export type EotPromoteTrigger = CardRef & {
  aspectFilter?: string;
  typeFilter?: string;
  optional?: boolean;
};

/** Order the queued end-of-turn promote triggers so the player is offered them
 *  in a sensible sequence: mandatory first, then mandatory-with-aspect
 *  (Obedience), then optional-with-type (Undead), then plain optional. Lets the
 *  player selectively decline the lower-priority optional ones if desired. */
function sortPendingEotPromotions(G: TyrantsState): void {
  const getPriority = (item: EotPromoteTrigger): number => {
    // Bucket 1: Not optional and NO aspect
    if (!item.optional && item.aspectFilter !== 'Obedience') return 1;
    // Bucket 2: Not optional WITH aspect
    if (!item.optional && item.aspectFilter === 'Obedience') return 2;
    // Bucket 3: Optional WITH type
    if (item.optional && item.typeFilter === 'Undead') return 3;
    // Bucket 4: Optional with NO type and NO aspect
    return 4;
  };
  // Sort ascending by priority score (1 comes before 2, etc.)
  G.pendingEotPromotions.sort((a, b) => getPriority(a) - getPriority(b));
}

// Two of four half-decks make the market for a game (rulebook "first game" suggests Drow + Dragons).
// Each half-deck has 40 cards total (one entry per slot in card-data covers the printed
// physical copies — Advance Scout has 3 slots because there are 3 physical Advance
// Scouts in the deck). Don't multiply by the `rarity` field — that's the slot count,
// not a per-slot duplicator. Multiplying produced a ~190-card market deck instead of
// the printed 80 (40+40), reported as issue #31.
/** Indices of cards in G.cardsPlayedThisTurn that are eligible promote
 *  targets for the given EoT trigger. Always excludes the trigger card
 *  itself ("another card played this turn"). When the trigger carries
 *  an aspectFilter (Air/Fire/Water Myrmidons → 'Obedience'), also
 *  restricts to cards of that aspect. When the trigger carries
 *  a typeFilter (High Priest of Myrkul → 'Undead'), also
 *  restricts to cards of that aspect. */
function eotEligibleIndices(
  G: TyrantsState,
  trigger: CardRef & { aspectFilter?: string; typeFilter?: string; },
): number[] {
  const out: number[] = [];
  for (let i = 0; i < G.cardsPlayedThisTurn.length; i++) {
    const c = G.cardsPlayedThisTurn[i];
    if (c.deck === trigger.deck && c.slot === trigger.slot) continue;
    if (trigger.aspectFilter) {
      const data = lookupCard(c.deck, c.slot);
      if (data?.aspect !== trigger.aspectFilter) continue;
    }
    if (trigger.typeFilter) {
      const data = lookupCard(c.deck, c.slot);
      if (data?.type!== trigger.typeFilter) continue;
    }
    out.push(i);
  }
  return out;
}

function buildMarketDeck(rng: () => number, halfDecks: string[] = ['drow', 'dragons']): CardRef[] {
  // Per build-card-data: each card-data entry's `rarity` field equals "how
  // many physical copies of this card the market deck should contain FROM
  // THIS SLOT." For base half-decks the data has multiple slots per unique
  // card name (Advance Scout: slots 0/1/2, rarity=1 each) so 1×3 = 3 copies.
  // For expansion half-decks the TTS sheet has one slot per unique card
  // (Cranium Rats: slot 14, rarity=3) so 3×1 = 3 copies. Net: 40 cards per
  // half-deck either way, 80 total. The pre-#31 bug came from
  // double-counting (slot multiplicity × CSV count); build-card-data now
  // derives rarity = csvCount / slotCount so this multiplication is correct.
  const deck: CardRef[] = [];
  for (const half of halfDecks) {
    for (const c of cardsInDeck(half)) {
      const n = Math.max(1, c.rarity ?? 1);
      for (let i = 0; i < n; i++) deck.push(toCardRef(half, c.slot));
    }
  }
  return shuffle(deck, rng);
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function startingDeck(): CardRef[] {
  // 7 Nobles + 3 Soldiers, per rulebook p.4.
  const starter = cardsInDeck('starter-1');
  const noble = starter.find(c => /noble/i.test(c.name));
  const soldier = starter.find(c => /soldier/i.test(c.name));
  if (!noble || !soldier) throw new Error('Starter deck missing Noble or Soldier');
  const nobleRef = toCardRef(noble.deck, noble.slot);
  const soldierRef = toCardRef(soldier.deck, soldier.slot);
  return [...Array(7).fill(nobleRef), ...Array(3).fill(soldierRef)];
}

/** Encode the game state to a base64 JSON codec string, excluding the snapshots
 *  field itself to keep the payload small and prevent recursion. */
function encodeSnapshot(G: TyrantsState): string {
  const snapshots = G.snapshots; // peel off
  (G as { snapshots?: unknown }).snapshots = undefined;
  // Also peel turnLogs to keep snapshots small; they can be regenerated by replay.
  const turnLogs = G.turnLogs;
  (G as { turnLogs?: unknown }).turnLogs = undefined;
  // Peel the undo stack too — it is itself an array of codec snapshots, so
  // embedding it would nest snapshots-in-snapshots and balloon the payload.
  const undoStack = G.undoStack;
  (G as { undoStack?: unknown }).undoStack = undefined;
  let result: string;
  try {
    const json = JSON.stringify(G);
    // btoa needs ASCII; encode UTF-8 first.
    result = btoa(unescape(encodeURIComponent(json)));
  } finally {
    G.snapshots = snapshots;
    G.turnLogs = turnLogs;
    G.undoStack = undoStack;
  }
  return result;
}

/** Decode a codec string back into a partial state object. Caller is responsible
 *  for assigning fields onto G under Immer. */
function decodeSnapshot(codec: string): Partial<TyrantsState> {
  const json = decodeURIComponent(escape(atob(codec.trim())));
  return JSON.parse(json) as Partial<TyrantsState>;
}

/** Hard cap on retained undo points per turn (well above the per-turn move
 *  ceiling; just a runaway-memory backstop). */
const MAX_UNDO_DEPTH = 100;

/** The only seat that gets an undo history. This is a hot-seat game: the human
 *  always plays seat 0 and the rest are AI, which never undoes. Gating here
 *  keeps AI turns (and all-AI simulations/tournaments) from paying the
 *  per-move snapshot cost. */
const UNDO_SEAT = '0';

/** Capture the current state as an undo restore-point, pushed onto G.undoStack.
 *  Call at the TOP of an undoable move, before it mutates anything. If the
 *  move later reveals hidden info, Mechanics.markInfoRevealed wipes the stack
 *  (including this entry), so the move becomes non-undoable. No-op for non-
 *  human seats. */
function pushUndoSnapshot(G: TyrantsState, currentPlayer: string): void {
  // Online can never use these, so skip before doing any work. Without this,
  // seat 0 (UNDO_SEAT) piled a full state codec per move into G.undoStack
  // server-side — ~22KB a move, ~4x live-state growth over a turn. The codec
  // strips it on write so storage was safe, but the server still built and
  // hauled it every single move.
  if (G._online) return;
  if (currentPlayer !== UNDO_SEAT) return;
  if (!G.undoStack) G.undoStack = [];
  G.undoStack.push(encodeSnapshot(G));
  if (G.undoStack.length > MAX_UNDO_DEPTH) G.undoStack.shift();
}

/** Trigger end-of-game when any player empties their barracks OR the market deck runs out. */
function checkEndGameTriggers(G: TyrantsState, ctx: { turn: number }) {
  if (G.endGameTriggeredAtTurn !== null) return;
  if (G.market.deck.length === 0 || Object.values(G.players).some(p => p.barracksLeft <= 0)) {
    G.endGameTriggeredAtTurn = ctx.turn;
    Mechanics.log(G, `End-of-game triggered (turn ${ctx.turn}). Round will finish.`);
  }
}

export const TyrantsGame: Game<TyrantsState> = {
  name: 'tyrants-of-the-underdark',

  // The game ends after the round containing the trigger turn finishes (rulebook p.14).
  // We compute the last turn number of that round and bail when ctx.turn exceeds it.
  endIf: ({ G, ctx }) => {
    if (G.endGameTriggeredAtTurn === null) return undefined;
    const N = ctx.numPlayers;
    const triggerRound = Math.floor((G.endGameTriggeredAtTurn - 1) / N);
    const lastTurnOfTriggerRound = (triggerRound + 1) * N;
    if (ctx.turn > lastTurnOfTriggerRound) {
      // scoreAll is imported lazily to avoid circular import
      return { ended: true };
    }
    return undefined;
  },

  setup: ({ ctx, random }, setupData?: { halfDecks?: string[]; activeSections?: Array<'left'|'center'|'right'>; humanColor?: Color }) => {
    const rng = () => random!.Number();
    const halfDecks = setupData?.halfDecks?.length === 2 ? setupData.halfDecks : ['drow', 'dragons'];
    // Rulebook p.5: limit the board to the sections in play. 2P = center only,
    // 3P = center + one outer, 4P = all three. Headless sim default = all
    // three so existing tests/training corpus stays comparable.
    const activeSections: Set<string> = new Set(
      setupData?.activeSections && setupData.activeSections.length > 0
        ? setupData.activeSections
        : ['left', 'center', 'right']
    );
    const activeSiteSet = new Set(
      SITES.filter(s => activeSections.has(s.section)).map(s => s.id)
    );
    const activeRouteSet = new Set(
      ROUTES.filter(r => activeSiteSet.has(r.a) && activeSiteSet.has(r.b)).map(r => r.id)
    );
    const isActiveSpace = (ts: typeof TROOP_SPACES[number]): boolean => {
      if (ts.parentSite) return activeSiteSet.has(ts.parentSite);
      if (ts.parentRoute) return activeRouteSet.has(ts.parentRoute);
      return false;
    };
    // Seat → colour. The human is always seat 0; if they picked a colour, put
    // it first and let the AI seats take the remaining colours in order. No
    // pick → the default seat order (black, red, orange, blue).
    const colorOrder: Color[] = setupData?.humanColor
      ? [setupData.humanColor, ...COLORS.filter(c => c !== setupData.humanColor)]
      : COLORS;
    const players: Record<string, PlayerData> = {};
    for (let i = 0; i < ctx.numPlayers; i++) {
      const deck = shuffle(startingDeck(), rng);
      const hand = deck.splice(0, HAND_SIZE);
      players[String(i)] = {
        color: colorOrder[i],
        deck,
        hand,
        discard: [],
        innerCircle: [],
        cardsPlayed: [],
        trophyHall: { black: 0, red: 0, orange: 0, blue: 0, white: 0 },
        barracksLeft: 40,
        spiesLeft: 5,
        power: 0,
        influence: 0,
        vp: 0,
      };
    }
    const marketDeck = buildMarketDeck(rng, halfDecks);
    const row = marketDeck.splice(0, 6).map(c => c as CardRef | null);
    while (row.length < 6) row.push(null);

    // Initial map state. Only spaces in active sections get an entry — sites
    // and routes outside the player-count's allowed sections are absent from
    // G.troops entirely, so they never appear as valid targets for moves or
    // card effects.
    const troops: Record<string, Color | 'white' | null> = {};
    for (const ts of TROOP_SPACES) {
      if (!isActiveSpace(ts)) continue;
      troops[ts.id] = ts.startsWithWhite ? 'white' : null;
    }

    const controlMarkers: Record<string, ControlMarker> = {};
    for (const s of SITES) {
      if (!activeSiteSet.has(s.id)) continue;
      if (s.hasControlMarker) {
        const v = MARKER_VALUES[s.id] ?? { controlInfluence: 1, controlVp: 0, totalControlInfluence: 1, totalControlVp: 1 };
        controlMarkers[s.id] = {
          siteId: s.id, holder: null, side: 'control',
          controlInfluence: v.controlInfluence,
          controlVp: v.controlVp,
          totalControlInfluence: v.totalControlInfluence,
          totalControlVp: v.totalControlVp,
        };
      }
    }

    // Randomly choose who acts first. Re-log it so the player can see who
    // got the start in their game.
    const firstSeat = Math.floor(rng() * ctx.numPlayers);
    const startLog = `Game started. P${firstSeat + 1} (${colorOrder[firstSeat]}) goes first.`;

    return {
      firstPlayerId: String(firstSeat),
      market: { deck: marketDeck, row },
      // Permanent stacks per rulebook components (page 2): 15 of each.
      auxStacks: { houseGuards: 15, priestesses: 15 },
      players,
      log: appendGameLog<string>([], { turn: 0, side: String(firstSeat), kind: 'game.start', msg: startLog, payload: { firstSeat } }),
      pendingChoice: null,
      pausedHandlerState: null,
      troops,
      spies: {},
      siteControl: Object.fromEntries(SITES.filter(s => activeSiteSet.has(s.id)).map(s => [s.id, null])),
      activeSites: [...activeSiteSet],
      activeSections: [...activeSections],
      controlMarkers,
      setupPhase: true,
      turnAspectsPlayed: {},
      cardsPlayedThisTurn: [],
      pendingEotPromotions: [],
      pendingEotInnerCircleVp: [],
      devouredPile: [],
      markerInfluenceGrantedThisTurn: [],
      markerTcGrantedThisTurn: [],
      activeTurnColor: null,
      turnLogStart: 0,
      turnLogs: [],
      snapshots: [],
      undoStack: [],
      endGameTriggeredAtTurn: null,
    };
  },

  turn: {
    minMoves: 0,
    maxMoves: 50,
    // Randomize who acts first. The seat order beyond that is the default
    // sequential cycle (0 → 1 → ... → N-1 → 0). G.firstPlayerId is picked once
    // in setup and persists through the game.
    order: {
      first: ({ G, ctx }) => {
        const n = ctx.numPlayers;
        const idx = Number(G.firstPlayerId ?? '0');
        return Number.isFinite(idx) && idx >= 0 && idx < n ? idx : 0;
      },
      next: ({ ctx }) => (ctx.playOrderPos + 1) % ctx.numPlayers,
    },
    onBegin: ({ G, ctx }) => {
      // Legacy saves (and old online snapshots not yet migrated) carry a
      // string[] log — upgrade before anything reads/writes entries.
      ensureStructuredLog(G);
      G.logTurn = ctx.turn;
      G.logSide = ctx.currentPlayer;
      // Mark where this turn's log entries begin (by seq) so onEnd can slice them out.
      G.turnLogStart = nextLogSeq(G);
      logEvent(G, `Turn: P${Number(ctx.currentPlayer) + 1} (${G.players[ctx.currentPlayer].color})`,
        { kind: 'turn.start', payload: { player: ctx.currentPlayer, color: G.players[ctx.currentPlayer].color }, side: ctx.currentPlayer });
      G.cardsPlayedThisTurn = [];
      G.pendingEotPromotions = [];
      G.pendingEotInnerCircleVp = [];
      // Undo history is per-turn — you can't undo back into a prior player's turn.
      G.undoStack = [];
      G.activeTurnColor = G.players[ctx.currentPlayer].color;
      // Backfill spiesLeft for every player whose state predates the spy-
      // supply field (legacy saves). Safe to call every turn — idempotent
      // once the field is a real number. Also covers AI players that the
      // place-spy handlers might never touch directly.
      for (const pid of Object.keys(G.players)) {
        ensureSpiesLeftInitialized(G, G.players[pid].color);
      }
      // Backfill auxStacks for legacy saves (added with the recruit-stacks
      // feature). Idempotent once the field exists. Setting to the rulebook
      // values assumes nobody recruited from these stacks in the saved
      // game, which is true for any state from before this commit.
      if (!G.auxStacks) {
        G.auxStacks = { houseGuards: 15, priestesses: 15 };
      }
      // Reset the per-turn marker-influence ledger so the current player can
      // claim the bonus once per marker this turn, either from markers they
      // already hold (below) or from markers they take control of during the
      // turn (granted live by Mechanics.claimMarkerInfluenceIfControlled).
      G.markerInfluenceGrantedThisTurn = [];
      // Backfill on legacy saves loaded before this field existed.
      G.markerTcGrantedThisTurn = [];
      if (!G.devouredPile) G.devouredPile = [];

      // Per-turn marker effect for chits the active player held coming into
      // this turn. Pays both the influence (cobweb) and any VP printed on
      // whichever side is currently up (control or total-control). Mid-turn
      // marker grabs are handled live inside recomputeSiteControl, both
      // sharing the once-per-marker-per-turn ledger so a player who already
      // got the effect this turn can't double-dip.
      payHeldMarkerEffectsAtTurnStart(G, G.players[ctx.currentPlayer].color);
      // Capture a snapshot of the game state at turn start (excluding the snapshots
      // field itself to prevent recursive bloat). loadState can rewind here.
      G.snapshots.push({
        turn: ctx.turn,
        playerId: ctx.currentPlayer,
        color: G.players[ctx.currentPlayer].color,
        codec: encodeSnapshot(G),
      });
      // Bound the snapshot history. Each snapshot is a full state codec, so an
      // uncapped array grows the persisted state every turn — in online games
      // (where bgio's turn counter can balloon well past the real turn count)
      // this bloated the stored state until a write exceeded platform limits and
      // the game locked up. Keep only the most recent SNAPSHOT_CAP turns; that's
      // ample for the hotseat "Load turn" rewind, and online never uses
      // snapshots at all (loadState is a no-op there).
      if (G.snapshots.length > SNAPSHOT_CAP) {
        G.snapshots.splice(0, G.snapshots.length - SNAPSHOT_CAP);
      }
    },
    onEnd: ({ G, ctx, random }) => {
      // Capture this turn's log slice for the per-turn summary modal. We do this for
      // every turn (including setup deploys) so the human can review what happened.
      const lines = G.log.filter(e => typeof e !== 'string' && e.seq >= G.turnLogStart).map(logLineText);
      G.turnLogs.push({
        turn: ctx.turn,
        playerId: ctx.currentPlayer,
        color: G.players[ctx.currentPlayer].color,
        lines,
      });

      // Setup deploys end the "turn" purely to advance the seat. They don't trigger the
      // rulebook's end-of-turn step — no hand discard, no redraw, no site-VP.
      if (G._endingSetupTurn) {
        G._endingSetupTurn = false;
        return;
      }
      // Award any end-of-turn inner-circle VP (Blue Dragon) now that this turn's
      // promotes have resolved, so the inner-circle count is final.
      applyEotInnerCircleVp(G);
      const p = G.players[ctx.currentPlayer];
      // Site-control markers no longer need an end-of-turn claim or scoring
      // step: per the revised rulebook the chit transfers immediately on
      // control change, returns to the map immediately when control becomes
      // tied, and the per-turn effect (influence + any VP) is paid either at
      // turn start (held-over markers) or live when the marker is taken
      // during the turn. See engine/map-state.ts → recomputeSiteControl /
      // payMarkerEffect / payHeldMarkerEffectsAtTurnStart.

      p.discard.push(...p.hand);
      p.hand = [];
      p.cardsPlayed = [];
      p.power = 0;
      p.influence = 0;
      G.turnAspectsPlayed = {};
      // Refill hand
      for (let i = 0; i < HAND_SIZE; i++) {
        if (p.deck.length === 0) {
          // Use the seeded boardgame.io RNG so reshuffles are deterministic
          // across replays / save-load. Falls back to Math.random only if
          // random is somehow unavailable (e.g. very old saves replayed
          // outside a bgio context).
          p.deck = shuffle(p.discard, random ? () => random.Number() : () => Math.random());
          p.discard = [];
        }
        if (p.deck.length === 0) break;
        p.hand.push(p.deck.shift()!);
      }
      // Safety net for the end-of-game trigger. The per-move calls
      // (deployTroop / recruitFromMarket) miss two paths to an empty barracks:
      // a troop deployed by a CARD EFFECT (the deployChoice handler, e.g.
      // Gibbering Mouther / supplants) never routes through the deploy move,
      // and once barracks is already 0 the deploy move early-returns (converts
      // to VP) before its checkEndGameTriggers call. Either way a player could
      // run out of troops and the game would never end (#78). Re-checking here
      // at every real turn-end guarantees the trigger fires the turn it should.
      checkEndGameTriggers(G, ctx);
      // Done with this player's turn — clear the active-turn marker so that
      // any state mutation in between turns (saves, replays) doesn't
      // accidentally grant influence to a player who isn't currently active.
      G.activeTurnColor = null;
    },
  },

  moves: {
    deployStartingTroop: ({ G, ctx, events }, siteId: string) => {
      if (!G.setupPhase) return INVALID_MOVE;
      const pid = ctx.currentPlayer;
      const site = SITES.find(s => s.id === siteId);
      if (!site || !site.isStartingSite) return INVALID_MOVE;
      // Per rulebook setup p.4: starting sites already claimed by a rival
      // (i.e. containing any non-white troop) are off-limits.
      if (sitesSpaces(siteId).some(sp => G.troops[sp.id] && G.troops[sp.id] !== 'white')) return INVALID_MOVE;
      const space = sitesSpaces(siteId).find(sp => !G.troops[sp.id]);
      if (!space) return INVALID_MOVE;
      const player = G.players[pid];
      const color = player.color;
      if (!deployTroop(G, color, space.id)) return INVALID_MOVE;
      player.barracksLeft -= 1;
      Mechanics.log(G, `P${Number(pid) + 1} deployed starting troop at ${site.name}`,
        { kind: 'troop.deploy', payload: { site: siteId, setup: true }, side: pid });

      // Setup complete once everyone has placed one troop.
      const placed = Object.values(G.troops).filter(t => t && t !== 'white').length;
      if (placed >= ctx.numPlayers) {
        G.setupPhase = false;
        Mechanics.log(G, 'Setup complete — game begins.');
      }
      // Flag this turn-end as part of setup so onEnd skips its regular cleanup
      // (no hand-discard, no end-of-turn VP gain).
      G._endingSetupTurn = true;
      events.endTurn();
    },

    playCard: ({ G, ctx, random }, handIndex: number) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      const pid = ctx.currentPlayer;
      const p = G.players[pid];
      const card = p.hand[handIndex];
      if (!card) return INVALID_MOVE;
      // Clear the per-play fizzle marker (set by devour-from-hand effects that
      // can't pay their cost). The "Play all basic" classifier reads it off a
      // dry-run of this move to avoid auto-playing a card that would fizzle.
      (G as unknown as { _playFizzledNoFood?: boolean })._playFizzledNoFood = false;
      // Undo restore-point captured before any mutation. If this card's effect
      // reveals hidden info (e.g. "draw 2"), markInfoRevealed wipes it again.
      pushUndoSnapshot(G, ctx.currentPlayer);

      p.hand.splice(handIndex, 1);
      logEvent(G, `P${Number(pid) + 1} played ${card.name}`,
        { kind: 'card.play', payload: { card: card.name }, side: pid });

      // Reset the per-card deploy trace; Gibbering Mouther etc. read this to find
      // every space they deployed to during resolution.
      (G as unknown as { _recentDeploySpaces?: string[] })._recentDeploySpaces = [];

      const cardData = lookupCard(card.deck, card.slot);
      // Tally the aspect BEFORE the handler runs so handlers can read the count for Focus.
      if (cardData?.aspect) {
        const key = cardData.aspect.toLowerCase();
        G.turnAspectsPlayed[key] = (G.turnAspectsPlayed[key] ?? 0) + 1;
      }
      const effectKey = cardData?.effectKey ?? '';
      const handler = effectKey ? CardRegistry.get(effectKey) : undefined;

      if (!handler) {
        // No handler yet — drop the card to discard with no effect.
        p.discard.push(card);
        return;
      }

      const ctx2: EffectContext = {
        card,
        actorId: pid,
        G,
        pendingChoice: null,
        paused: false,
        handlerState: null,
        random: random ?? undefined,
      };
      const done = handler(ctx2);
      if (!done && ctx2.pendingChoice) {
        G.pendingChoice = {
          ...ctx2.pendingChoice,
          // Default playerId to the actor — for cross-player prompts the
          // handler should have already set playerId to the target.
          playerId: ctx2.pendingChoice.playerId ?? pid,
          actorId: pid,
          cardKey: `${card.deck}::${card.slot}`,
        };
        G.pausedHandlerState = ctx2.handlerState;
        p.discard.push(card);
        G.cardsPlayedThisTurn.push(card);
        p.cardsPlayed.push(card);
        return;
      }

      // Effect completed. Honor self-eject for Insane Outcast.
      const returnedToSupply = (ctx2.handlerState as { returnedToSupply?: boolean } | null)?.returnedToSupply;
      if (!returnedToSupply) {
        p.discard.push(card);
        G.cardsPlayedThisTurn.push(card);
        p.cardsPlayed.push(card);
      }
    },

    resolveChoice: ({ G, ctx, events, random }, response: unknown) => {
      if (!G.pendingChoice) return INVALID_MOVE;
      // Undo restore-point: each click resolving a prompt is its own step, so
      // undo rewinds one decision at a time (restores the prompt). Wiped if
      // this step reveals hidden info.
      pushUndoSnapshot(G, ctx.currentPlayer);
      const pc = G.pendingChoice;

      // Special handling for the end-of-turn promote-played-card loop. Not tied to a card
      // handler — we promote directly and re-issue the prompt if more remain.
      if (pc.cardKey === '__eot__') {
        const idx = response as number | null;
        G.pendingChoice = null;
        if (idx != null) {
          const playerId = pc.playerId;
          const card = G.cardsPlayedThisTurn[idx];
          if (card) {
            // Remove from the played list by EXACT index (unambiguous even
            // with duplicate same-type cards — #47 / #48). Mechanics.promote
            // no longer touches cardsPlayedThisTurn, so this is the sole
            // removal for the EOT path.
            G.cardsPlayedThisTurn.splice(idx, 1);
            // Remove card played from PlayerData
            const pPlayedIdx = G.players[playerId].cardsPlayed.findIndex(
              c => c.deck === card.deck && c.slot === card.slot
            );
            if (pPlayedIdx >= 0) G.players[playerId].cardsPlayed.splice(pPlayedIdx, 1);

            const di = G.players[playerId].discard.findIndex(
              c => c.deck === card.deck && c.slot === card.slot
            );
            if (di >= 0) G.players[playerId].discard.splice(di, 1);
            Mechanics.promote(G, playerId, card);
          }
        }
        // Consume the trigger we were responding to.
        const consumedTrigger = G.pendingEotPromotions.shift()!;

        // Log when the player declined an optional promote.
        if (idx == null && consumedTrigger.optional) {
          Mechanics.log(G, `(end of turn: ${consumedTrigger.name} promote declined)`);
        }

        // If the consumed trigger was an Undead-type repeating promote (High
        // Priest of Myrkul) AND the player just picked a card (didn't decline),
        // check whether more Undead cards remain eligible. If so, re-insert the
        // same trigger at the FRONT of the queue so it fires again before any
        // other queued promotes.
        if (idx != null && consumedTrigger.typeFilter === 'Undead') {
          const stillEligible = eotEligibleIndices(G, consumedTrigger);
          if (stillEligible.length > 0) {
            G.pendingEotPromotions.unshift(consumedTrigger);
          }
        }

        // Order the queue: mandatory first, then Obedience, then Undead, then
        // optional — so the player can selectively decline lower-priority ones.
        sortPendingEotPromotions(G);

        // Skip any subsequent triggers that have no other cards to promote,
        // logging each one that is silently dropped.
        while (G.pendingEotPromotions.length > 0) {
          const t = G.pendingEotPromotions[0];
          if (eotEligibleIndices(G, t).length > 0) break;
          G.pendingEotPromotions.shift();
          Mechanics.log(G, `(end of turn: ${t.name} promote skipped — no eligible cards)`);
        }
        if (G.pendingEotPromotions.length > 0) {
          const t = G.pendingEotPromotions[0];
          const eligible = eotEligibleIndices(G, t);
          const aspectTag = t.aspectFilter ? ` ${t.aspectFilter}` : '';
          const typeTag = t.typeFilter ? ` ${t.typeFilter}` : '';
          G.pendingChoice = {
            kind: 'select-played-card',
            prompt: `End of turn — promote ${t.typeFilter ? 'as many chosen': (t.optional ? 'an optional' : 'a')}${aspectTag}${typeTag} card played this turn — ${t.optional ? 'you may decline this one' : `${t.name} requires it, so you must promote one`} (triggered by ${t.name}; ${G.pendingEotPromotions.length} remaining).`,
            options: eligible,
            // Mandatory by default; only declinable when the trigger
            // explicitly says so (printed "you may promote..." cards).
            optional: !!t.optional,
            playerId: pc.playerId,
            cardKey: '__eot__',
          };
          return;
        }
        events.endTurn();
        return;
      }

      // The suspended handler's card lives in the ACTOR's discard, which may
      // differ from the responder (pc.playerId) for cross-player prompts
      // (forced discard etc.). Fall back to playerId for legacy self-prompts.
      const actorPid = pc.actorId ?? pc.playerId;
      const p = G.players[actorPid];
      const cardIdx = p.discard.findIndex(c => `${c.deck}::${c.slot}` === pc.cardKey);
      const card = p.discard[cardIdx];
      if (!card) { G.pendingChoice = null; return; }

      const data = lookupCard(card.deck, card.slot);
      const handler = data ? CardRegistry.get(data.effectKey) : undefined;
      if (!handler) { G.pendingChoice = null; return; }

      const ctx2: EffectContext = {
        card, actorId: actorPid, G,
        pendingChoice: { ...pc, response },
        paused: true,
        handlerState: G.pausedHandlerState,
        random: random ?? undefined,
      };
      const done = handler(ctx2);
      if (!done) {
        // Preserve cardKey and the actor (whose handler is still suspended).
        // The handler MAY have set its own playerId on the new pendingChoice
        // when targeting a different player (forced-discard chain over
        // multiple opponents) — honor that, otherwise default to the actor.
        G.pendingChoice = ctx2.pendingChoice
          ? { ...ctx2.pendingChoice,
              playerId: ctx2.pendingChoice.playerId ?? actorPid,
              actorId: actorPid,
              cardKey: pc.cardKey }
          : null;
        G.pausedHandlerState = ctx2.handlerState;
        return;
      }

      G.pendingChoice = null;
      G.pausedHandlerState = null;
      const returnedToSupply = (ctx2.handlerState as { returnedToSupply?: boolean } | null)?.returnedToSupply;
      if (returnedToSupply) {
        p.discard.splice(cardIdx, 1);
        // Also remove from cardsPlayedThisTurn so end-of-turn promote prompts
        // don't list a card that has left play entirely.
        const playedIdx = G.cardsPlayedThisTurn.findIndex(
          c => c.deck === card.deck && c.slot === card.slot
        );
        if (playedIdx >= 0) G.cardsPlayedThisTurn.splice(playedIdx, 1);
        // Remove cards played from PlayerData
        const pPlayedIdx = p.cardsPlayed.findIndex(
          c => c.deck === card.deck && c.slot === card.slot
        );
        if (pPlayedIdx >= 0) p.cardsPlayed.splice(pPlayedIdx, 1);
      }
      // suppress unused-var noise
      void ctx;
    },

    recruitFromMarket: ({ G, ctx }, marketIndex: number) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      const pid = ctx.currentPlayer;
      const card = G.market.row[marketIndex];
      if (!card) return INVALID_MOVE;
      // Recruiting refills the row from the face-down market deck, which
      // reveals a new card — so this push gets wiped by markInfoRevealed and
      // a market buy ends up non-undoable (by design).
      pushUndoSnapshot(G, ctx.currentPlayer);
      const data = lookupCard(card.deck, card.slot);
      const cost = data?.cost ?? 999;
      if (!Mechanics.expendInfluence(G, pid, cost)) return INVALID_MOVE;
      if (!Mechanics.recruitFromMarket(G, pid, marketIndex)) {
        Mechanics.gainInfluence(G, pid, cost);
        return INVALID_MOVE;
      }
      checkEndGameTriggers(G, ctx);
    },

    /** Recruit from a permanent aux stack (House Guards or Priestesses).
     *  Cost comes from card-data.json (House Guard = 3 influence,
     *  Priestess of Lolth = 2 influence). Stack must be non-empty.
     *  Per rulebook, depletion of these stacks does NOT trigger end-of-
     *  game (only the main market deck emptying or a player's barracks
     *  emptying does), so no checkEndGameTriggers call here. */
    recruitFromAuxStack: ({ G, ctx }, stack: 'houseGuards' | 'priestesses') => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      if (stack !== 'houseGuards' && stack !== 'priestesses') return INVALID_MOVE;
      if (G.auxStacks[stack] <= 0) return INVALID_MOVE;
      // Aux stacks are known quantities (no hidden card revealed), so this
      // stays undoable.
      pushUndoSnapshot(G, ctx.currentPlayer);
      const pid = ctx.currentPlayer;
      // The card-data entries live at fixed slots: house-guards/40 and
      // priestesses/43 (one canonical entry each; the stack count comes
      // from G.auxStacks rather than per-slot duplication).
      const ref = stack === 'houseGuards'
        ? { deck: 'house-guards', slot: 40 }
        : { deck: 'priestesses',  slot: 43 };
      const data = lookupCard(ref.deck, ref.slot);
      if (!data) return INVALID_MOVE;
      const cost = data.cost ?? 999;
      if (!Mechanics.expendInfluence(G, pid, cost)) return INVALID_MOVE;
      const cardRef = { deck: ref.deck, slot: ref.slot, name: data.name, image: data.image };
      if (!Mechanics.recruitFromAuxStack(G, pid, stack, cardRef)) {
        Mechanics.gainInfluence(G, pid, cost);
        return INVALID_MOVE;
      }
    },

    deployTroop: ({ G, ctx }, spaceId: string) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      pushUndoSnapshot(G, ctx.currentPlayer);
      const pid = ctx.currentPlayer;
      const p = G.players[pid];
      const color = p.color;
      const hasMapPresence = SITES.some(s => hasPresence(G, color, { site: s.id }));
      const targetSpace = TROOP_SPACES.find(t => t.id === spaceId);
      if (!targetSpace) return INVALID_MOVE;
      // Reject deploys into out-of-play sections: only active-section spaces are
      // keys in G.troops. Must run before expendPower / the barracks-empty→VP
      // conversion below, or a bad target could spend power or mint VP.
      if (!(spaceId in G.troops)) return INVALID_MOVE;
      const targetSite = targetSpace.parentSite;
      const presenceOk = !hasMapPresence || (targetSite ? hasPresence(G, color, { site: targetSite }) : hasPresence(G, color, { space: spaceId }));
      if (!presenceOk) return INVALID_MOVE;

      if (!Mechanics.expendPower(G, pid, 1)) return INVALID_MOVE;
      // Rulebook p.12: if barracks is empty, deploy converts to +1 VP.
      if (p.barracksLeft <= 0) {
        Mechanics.gainVpTokens(G, pid, 1);
        Mechanics.log(G, `P${Number(pid) + 1} barracks empty — deploy converted to +1 VP`);
        return;
      }
      if (!deployTroop(G, color, spaceId)) {
        Mechanics.gainPower(G, pid, 1);
        return INVALID_MOVE;
      }
      p.barracksLeft -= 1;
      Mechanics.log(G, `P${Number(pid) + 1} deployed at ${spaceId} (barracks: ${p.barracksLeft})`,
        { kind: 'troop.deploy', payload: { site: spaceId }, side: pid });
      checkEndGameTriggers(G, ctx);
    },

    assassinateTroop: ({ G, ctx }, spaceId: string) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      pushUndoSnapshot(G, ctx.currentPlayer);
      const pid = ctx.currentPlayer;
      const p = G.players[pid];
      const color = p.color;
      const target = TROOP_SPACES.find(t => t.id === spaceId);
      if (!target) return INVALID_MOVE;
      const enemy = G.troops[spaceId];
      if (!enemy || enemy === color) return INVALID_MOVE;
      const presenceOk = hasPresence(G, color, { site: target.parentSite, space: target.parentRoute ? spaceId : undefined });
      if (!presenceOk) return INVALID_MOVE;

      if (!Mechanics.expendPower(G, pid, BASE_ACTION_POWER_COST)) return INVALID_MOVE;
      const killed = assassinateTroop(G, spaceId);
      if (killed === 'white') p.trophyHall.white += 1;
      else if (killed) p.trophyHall[killed] = (p.trophyHall[killed] ?? 0) + 1;
      Mechanics.log(G, `P${Number(pid) + 1} assassinated ${killed} at ${spaceId}`,
        { kind: 'troop.assassinate', payload: { site: spaceId, target: killed }, side: pid });
    },

    returnEnemySpy: ({ G, ctx }, siteId: string, targetColor: Color) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      pushUndoSnapshot(G, ctx.currentPlayer);
      const pid = ctx.currentPlayer;
      const p = G.players[pid];
      if (p.color === targetColor) return INVALID_MOVE;
      if (!hasPresence(G, p.color, { site: siteId })) return INVALID_MOVE;
      if (!(G.spies[siteId] ?? []).includes(targetColor)) return INVALID_MOVE;
      if (!Mechanics.expendPower(G, pid, BASE_ACTION_POWER_COST)) return INVALID_MOVE;
      if (returnSpy(G, targetColor, siteId)) {
        // Returned spy goes back to ITS OWNER's supply (not yours). Backfill
        // a missing spiesLeft for the owner first (legacy saves predate the
        // spy-supply field, so undefined + 1 would become NaN).
        ensureSpiesLeftInitialized(G, targetColor);
        const ownerPid = Object.keys(G.players).find(k => G.players[k].color === targetColor);
        if (ownerPid) G.players[ownerPid].spiesLeft += 1;
        Mechanics.log(G, `P${Number(pid) + 1} returned ${targetColor} spy from ${siteId}`);
      }
    },

    /** Rewind to a previously captured snapshot. The codec string is whatever the
     *  Game Log tab's "Copy codec" produced. We restore every field except
     *  `snapshots` and `turnLogs` so the history list remains visible. */
    loadState: ({ G }, codec: string) => {
      let parsed: Partial<TyrantsState>;
      try {
        parsed = decodeSnapshot(codec);
      } catch {
        return INVALID_MOVE;
      }
      const keep = { snapshots: G.snapshots, turnLogs: G.turnLogs };
      // Clear out the current state, then assign decoded.
      for (const key of Object.keys(G)) {
        if (key === 'snapshots' || key === 'turnLogs') continue;
        delete (G as unknown as Record<string, unknown>)[key];
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'snapshots' || key === 'turnLogs') continue;
        (G as unknown as Record<string, unknown>)[key] = value;
      }
      G.snapshots = keep.snapshots;
      G.turnLogs = keep.turnLogs;
      // The decoded codec never carries an undo stack (peeled on encode), and
      // loading a saved/rewound state starts a fresh undo history.
      G.undoStack = [];
      // The pasted codec may predate the structured log (string[]).
      ensureStructuredLog(G);
      logEvent(G, '[state loaded from codec]', { kind: 'system', side: null });
    },

    /** Step-by-step within-turn undo. Pops the most recent restore-point off
     *  G.undoStack and reinstates it (the same field-swap loadState uses, but
     *  keeping the rest of the undo stack so you can keep stepping back).
     *  Available only while there is something to undo since the last
     *  hidden-information reveal this turn. */
    undo: ({ G }) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (!G.undoStack || G.undoStack.length === 0) return INVALID_MOVE;
      const codec = G.undoStack[G.undoStack.length - 1];
      let parsed: Partial<TyrantsState>;
      try {
        parsed = decodeSnapshot(codec);
      } catch {
        return INVALID_MOVE;
      }
      // The remaining stack (minus the entry we're restoring) stays valid —
      // those earlier restore-points were all captured after the last reveal.
      const remaining = G.undoStack.slice(0, -1);
      const keep = { snapshots: G.snapshots, turnLogs: G.turnLogs };
      for (const key of Object.keys(G)) {
        if (key === 'snapshots' || key === 'turnLogs') continue;
        delete (G as unknown as Record<string, unknown>)[key];
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (key === 'snapshots' || key === 'turnLogs' || key === 'undoStack') continue;
        (G as unknown as Record<string, unknown>)[key] = value;
      }
      G.snapshots = keep.snapshots;
      G.turnLogs = keep.turnLogs;
      G.undoStack = remaining;
      Mechanics.log(G, 'Undo');
    },

    endTurn: ({ G, ctx, events }) => {
      if (G.setupPhase) return INVALID_MOVE;
      if (G.pendingChoice) return INVALID_MOVE;
      // If end-of-turn promotions are queued, surface a picker over cards played this turn
      // before actually ending the turn. resolveChoice handles the special '__eot__' kind.
      if (G.pendingEotPromotions.length > 0) {
        // Order the queue: mandatory first, then Obedience, then Undead, then
        // optional — so the player can selectively decline lower-priority ones.
        sortPendingEotPromotions(G);

        const trigger = G.pendingEotPromotions[0];
        const eligible = eotEligibleIndices(G, trigger);
        if (eligible.length === 0) {
          // No eligible card to promote (either no other played card, or none
          // matching the trigger's aspectFilter / typeFilter) — drop this trigger
          // and try the next or finish.
          G.pendingEotPromotions.shift();
          Mechanics.log(G, `(end of turn: ${trigger.name} promote skipped — no eligible cards)`);
          while (G.pendingEotPromotions.length > 0) {
            const t = G.pendingEotPromotions[0];
            if (eotEligibleIndices(G, t).length > 0) break;
            G.pendingEotPromotions.shift();
            Mechanics.log(G, `(end of turn: ${t.name} promote skipped — no eligible cards)`);
          }
          if (G.pendingEotPromotions.length === 0) { events.endTurn(); return; }
        }
        const trigger2 = G.pendingEotPromotions[0];
        const eligible2 = eotEligibleIndices(G, trigger2);
        const aspectTag = trigger2.aspectFilter ? ` ${trigger2.aspectFilter}` : '';
        const typeTag = trigger2.typeFilter ? ` ${trigger2.typeFilter}` : '';
        G.pendingChoice = {
          kind: 'select-played-card',
          prompt: `End of turn — promote ${trigger2.typeFilter ? 'as many chosen': (trigger2.optional ? 'an optional' : 'a')}${aspectTag}${typeTag} card played this turn — ${trigger2.optional ? 'you may decline this one' : `${trigger2.name} requires it, so you must promote one`} (triggered by ${trigger2.name}; ${G.pendingEotPromotions.length} remaining).`,
          options: eligible2,
          // See companion site at the top of resolveChoice — mandatory by
          // default, declinable only when the trigger flags itself optional.
          optional: !!trigger2.optional,
          playerId: ctx.currentPlayer,
          cardKey: '__eot__',
        };
        return;
      }
      events.endTurn();
    },
  },
};