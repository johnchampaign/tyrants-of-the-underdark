// Repro harness for in-game report #103: "buying a card seems to trigger focus".
// Follow-up from the reporter: "There was no prompt when the card was bought. I
// played the card with the Malice focus then bought a Malice card and that
// triggered the focus."
//
// Drives the real move surface (playCard / resolveChoice / recruitFromMarket)
// through the boardgame.io reducer and watches the log for a Focus trigger that
// appears at or after a recruit.
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';

const reducer = CreateGameReducer({ game: TyrantsGame as never });

type Store = { G: TyrantsState; ctx: { currentPlayer: string; numPlayers: number } };

function makeMove(state: unknown, type: string, args: unknown[], pid: string) {
  return reducer(state as never, {
    type: 'MAKE_MOVE',
    payload: { type, args, playerID: pid, credentials: undefined },
  } as never) as unknown as Store;
}

function fresh(): Store {
  const s = InitializeGame({
    game: TyrantsGame as never,
    numPlayers: 4,
    setupData: { halfDecks: ['demons', 'elemental'] } as never,
  }) as unknown as Store;
  return structuredClone(s);
}

function logText(G: TyrantsState): string[] {
  const raw = (G as unknown as { log: unknown[] }).log ?? [];
  return raw.map(e => (typeof e === 'string' ? e : (e as { msg?: string }).msg ?? JSON.stringify(e)));
}

/** Focus entries that actually granted the bonus — `via: 'none' | 'declined'`
 *  entries are explanatory notes, not triggers. */
function focusTriggers(G: TyrantsState) {
  const raw = (G as unknown as { log: Array<{ kind?: string; payload?: { via?: string } }> }).log ?? [];
  return raw.filter(e => typeof e !== 'string' && e.kind === 'card.focus'
    && (e.payload?.via === 'chain' || e.payload?.via === 'revealed'));
}

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

const MALICE_FOCUS = [
  { slot: 21, name: 'Fire Elemental' },
  { slot: 18, name: 'Eternal Flame Cultist' },
  { slot: 29, name: 'Imix' },
];

// A Malice card to sit in the market row and be bought.
const MALICE_MARKET = { deck: 'elemental', slot: 22, name: 'Fire Elemental', image: '' };
// A neutral non-Malice filler for hand slots so the reveal prompt has no target.
const FILLER = { deck: 'elemental', slot: 34, name: 'Water Elemental', image: '' };

for (const fc of MALICE_FOCUS) {
  const s0 = fresh();
  const G0 = s0.G;
  G0.setupPhase = false;
  const pid = s0.ctx.currentPlayer;
  const me = G0.players[pid];

  const focusCard = { deck: 'elemental', slot: fc.slot, name: fc.name, image: '' };
  // Hand: the focus card + non-Malice filler only, so the reveal path finds
  // nothing eligible and completes silently (matching "there was no prompt").
  me.hand = [focusCard, { ...FILLER }, { ...FILLER }];
  me.deck = Array.from({ length: 10 }, () => ({ ...FILLER }));
  me.influence = 20;
  me.power = 0;
  // Park a buyable Malice card in market slot 0.
  G0.market.row[0] = { ...MALICE_MARKET };

  let st: Store = s0;
  st = makeMove(st, 'playCard', [0], pid);

  // Answer any prompts the card raises until the handler finishes. Every
  // response is the first eligible option; a Focus reveal prompt would show
  // up here and is explicitly flagged.
  let sawRevealPrompt = false;
  let guard = 0;
  while (st.G.pendingChoice && guard++ < 20) {
    const pc = st.G.pendingChoice;
    if (/Focus/i.test(pc.prompt)) sawRevealPrompt = true;
    const opts = pc.options as unknown[] | undefined;
    const resp = opts && opts.length ? (pc.kind === 'choose-one' ? 0 : opts[0]) : null;
    st = makeMove(st, 'resolveChoice', [resp], pid);
  }

  const afterPlay = {
    power: st.G.players[pid].power,
    hand: st.G.players[pid].hand.length,
    influence: st.G.players[pid].influence,
    logLen: logText(st.G).length,
  };
  // A "did not apply" note is expected and fine; what must NOT appear is an
  // actual trigger (via chain or reveal).
  check(`${fc.name}: no Focus trigger from the play alone (single Malice card, no eligible reveal)`,
    focusTriggers(st.G).length === 0 && !sawRevealPrompt);

  // Now buy the Malice card from the market.
  const before = st.G;
  check(`${fc.name}: no prompt is pending at buy time`, !before.pendingChoice);
  st = makeMove(st, 'recruitFromMarket', [0], pid);

  const after = st.G.players[pid];
  const newLines = logText(st.G).slice(afterPlay.logLen);
  const focusAfterBuy = newLines.filter(l => /Focus/.test(l));
  check(`${fc.name}: buying a Malice card logs no Focus trigger`, focusAfterBuy.length === 0);
  check(`${fc.name}: buying a Malice card grants no power`, after.power === afterPlay.power);
  check(`${fc.name}: buying a Malice card draws no card`, after.hand.length === afterPlay.hand);
  check(`${fc.name}: aspect tally untouched by the buy (malice=${st.G.turnAspectsPlayed['malice']})`,
    st.G.turnAspectsPlayed['malice'] === 1);
  if (focusAfterBuy.length) console.log('   log after buy:', newLines.join(' | '));
}

// ---- Same, but with an eligible Malice card in hand so the reveal prompt fires.
{
  const st0 = fresh();
  st0.G.setupPhase = false;
  const pid = st0.ctx.currentPlayer;
  const me = st0.G.players[pid];
  me.hand = [
    { deck: 'elemental', slot: 29, name: 'Imix', image: '' },      // Malice focus, no sub-prompt
    { deck: 'elemental', slot: 22, name: 'Fire Elemental', image: '' }, // eligible reveal target
  ];
  me.deck = Array.from({ length: 10 }, () => ({ ...FILLER }));
  me.influence = 20;
  st0.G.market.row[0] = { ...MALICE_MARKET };

  let st = makeMove(st0, 'playCard', [0], pid);
  check('reveal path: a Focus reveal prompt is raised when hand holds a Malice card',
    !!st.G.pendingChoice && /Focus/i.test(st.G.pendingChoice.prompt));
  console.log('   prompt:', st.G.pendingChoice?.prompt, '| kind:', st.G.pendingChoice?.kind);

  // The reporter said no prompt was up. Decline it and then buy.
  st = makeMove(st, 'resolveChoice', [null], pid);
  const logLen = logText(st.G).length;
  const powerBefore = st.G.players[pid].power;
  st = makeMove(st, 'recruitFromMarket', [0], pid);
  const newLines = logText(st.G).slice(logLen);
  check('reveal path: after declining, buying a Malice card still triggers nothing',
    !newLines.some(l => /Focus/.test(l)) && st.G.players[pid].power === powerBefore);
  console.log('   log after buy:', newLines.join(' | '));
}

// ---- The log must explain every Focus outcome on its own.
// A chain trigger fires with no prompt whatsoever, so its log line is the only
// evidence the player has. #103 was filed because that line named neither the
// card that fired nor the card that enabled it, leaving an unrelated nearby
// recruit as the only visible candidate cause.
{
  const st0 = fresh();
  st0.G.setupPhase = false;
  const pid = st0.ctx.currentPlayer;
  const me = st0.G.players[pid];
  me.hand = [
    { deck: 'elemental', slot: 33, name: 'Vanifer', image: '' },        // Malice, no focus
    { deck: 'elemental', slot: 29, name: 'Imix', image: '' },           // Malice focus
  ];
  me.deck = Array.from({ length: 10 }, () => ({ ...FILLER }));
  me.influence = 20;
  st0.G.market.row[0] = { ...MALICE_MARKET };

  // Play Vanifer first (tallies Malice), answering whatever it prompts.
  let st = makeMove(st0, 'playCard', [0], pid);
  let guard = 0;
  while (st.G.pendingChoice && guard++ < 20) {
    const opts = st.G.pendingChoice.options as unknown[] | undefined;
    const resp = opts && opts.length ? (st.G.pendingChoice.kind === 'choose-one' ? 0 : opts[0]) : null;
    st = makeMove(st, 'resolveChoice', [resp], pid);
  }
  // Buy a Malice card in between, exactly as the reporter described.
  st = makeMove(st, 'recruitFromMarket', [0], pid);
  const logLen = logText(st.G).length;
  // Now play the Malice focus card — this is the legitimate silent chain trigger.
  const imixIdx = st.G.players[pid].hand.findIndex(c => c.name === 'Imix');
  st = makeMove(st, 'playCard', [imixIdx], pid);

  const lines = logText(st.G).slice(logLen);
  const focusLine = lines.find(l => /Focus/.test(l));
  check('chain trigger fires with no prompt at all', !st.G.pendingChoice);
  check('chain trigger is logged', !!focusLine);
  check('chain log line names the card that enabled it (not just "chain")',
    !!focusLine && /Vanifer/.test(focusLine));
  console.log('   chain line:', focusLine);

  const focusEntry = (st.G.log as unknown as Array<{ kind: string; payload?: { via?: string } }>)
    .find(e => typeof e !== 'string' && e.kind === 'card.focus');
  check('chain trigger carries structured kind/payload', focusEntry?.payload?.via === 'chain');

  // The recruit must sit BEFORE the focus line in the stored log — the game-tab
  // panel used to render this reversed, which is what made the buy look causal.
  const all = logText(st.G);
  const recruitIdx = all.findIndex(l => /recruited/.test(l));
  const focusIdx = all.findIndex(l => /Focus/.test(l));
  check('stored log is chronological (recruit precedes the later focus)',
    recruitIdx >= 0 && focusIdx > recruitIdx);
}

// ---- A Focus that does nothing must say so (report #100's silent no-op).
{
  const st0 = fresh();
  st0.G.setupPhase = false;
  const pid = st0.ctx.currentPlayer;
  const me = st0.G.players[pid];
  me.hand = [{ deck: 'elemental', slot: 29, name: 'Imix', image: '' }, { ...FILLER }];
  me.deck = Array.from({ length: 10 }, () => ({ ...FILLER }));

  const st = makeMove(st0, 'playCard', [0], pid);
  const line = logText(st.G).find(l => /Focus/.test(l));
  check('a Focus that cannot apply logs why', !!line && /did not apply/.test(line));
  console.log('   no-op line:', line);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES PRESENT');
process.exit(ok ? 0 : 1);
