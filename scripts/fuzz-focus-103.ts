// Fuzz check behind in-game report #103 ("buying a card seems to trigger focus").
//
// Runs full AI games on the elemental half-deck and audits every Focus trigger
// in the structured log against the card plays that preceded it in the same
// turn. Two invariants:
//   A. A silent "(chain)" trigger requires >= 2 cards of that aspect already
//      played this turn. If it ever fires on fewer, the aspect tally is being
//      inflated by something that is not a card play — which is exactly what
//      "buying a card triggers focus" would look like.
//   B. No Focus trigger is ever the direct consequence of a recruit: no
//      recruit event may sit between a turn's last card.play and a Focus line.
import { CreateGameReducer, InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { decideHeuristicMove } from '../src/ai/heuristic-ai';
import { lookupCard } from '../src/card-data';

const GAMES = Number(process.argv[2] ?? 12);
const reducer = CreateGameReducer({ game: TyrantsGame as never });

type Store = { G: TyrantsState; ctx: { currentPlayer: string; gameover?: unknown; turn: number } };

interface Entry {
  seq: number; turn: number; kind: string; msg: string;
  payload?: { card?: string; aspect?: string; via?: string };
}

/** Play a game, accumulating every log entry ever appended. G.log itself is
 *  trimmed to the most recent LOG_CAP entries, so reading it at game end loses
 *  the front of every long game — and a turn whose card.play lines were trimmed
 *  would look like a Focus firing out of nowhere. Collect by `seq` after each
 *  move instead, so the audit sees the complete log. */
function playGame(seed: string): Entry[] {
  let st = InitializeGame({
    game: TyrantsGame as never,
    numPlayers: 4,
    setupData: { halfDecks: ['demons', 'elemental'] } as never,
    seed,
  } as never) as unknown as Store;

  const all: Entry[] = [];
  let maxSeq = -1;
  const drain = (G: TyrantsState) => {
    for (const e of G.log as unknown as Entry[]) {
      if (typeof e === 'string') continue;
      if (e.seq > maxSeq) { all.push(e); maxSeq = e.seq; }
    }
  };
  drain(st.G);

  for (let i = 0; i < 40000 && !st.ctx.gameover; i++) {
    const pid = st.ctx.currentPlayer;
    const mv = decideHeuristicMove(st.G, pid);
    if (!mv) break;
    const next = reducer(st as never, {
      type: 'MAKE_MOVE',
      payload: { type: mv.name, args: mv.args ?? [], playerID: pid },
    } as never) as unknown as Store;
    if (next === st) break;
    st = next;
    drain(st.G);
  }
  return all;
}

function aspectOfCardNamed(name: string): string | null {
  // Card names are unique enough across the two half-decks in play; fall back
  // to null when a log line names something we can't resolve (e.g. starters).
  for (const deck of ['demons', 'elemental', 'starter-1', 'house-guards', 'priestesses', 'core']) {
    for (let slot = 0; slot < 60; slot++) {
      const d = lookupCard(deck, slot);
      if (d && d.name === name) return d.aspect ?? null;
    }
  }
  return null;
}

const aspectCache = new Map<string, string | null>();
const aspectOf = (name: string) => {
  if (!aspectCache.has(name)) aspectCache.set(name, aspectOfCardNamed(name));
  return aspectCache.get(name)!;
};

let violationsA = 0, violationsB = 0, chainSeen = 0, revealSeen = 0, turnsAudited = 0;

for (let g = 0; g < GAMES; g++) {
  const log = playGame(`focus-103-${g}`);

  // Group entries by turn, in order.
  const byTurn = new Map<number, Entry[]>();
  for (const e of log) {
    if (!byTurn.has(e.turn)) byTurn.set(e.turn, []);
    byTurn.get(e.turn)!.push(e);
  }

  for (const [turn, entries] of byTurn) {
    turnsAudited++;
    const playedAspects: string[] = [];
    let sinceLastPlay: Entry[] = [];
    for (const e of entries) {
      if (e.kind === 'card.play' && e.payload?.card) {
        const a = aspectOf(e.payload.card);
        if (a) playedAspects.push(a.toLowerCase());
        sinceLastPlay = [];
        continue;
      }
      // Focus outcomes are structured (kind 'card.focus', payload.via), so the
      // audit doesn't ride on the prose wording.
      if (e.kind !== 'card.focus' || !e.payload?.aspect) { sinceLastPlay.push(e); continue; }
      const aspect = e.payload.aspect.toLowerCase();
      const mode = e.payload.via;
      if (mode !== 'chain' && mode !== 'revealed') { sinceLastPlay.push(e); continue; }
      if (mode === 'chain') {
        chainSeen++;
        const n = playedAspects.filter(a => a === aspect).length;
        if (n < 2) {
          violationsA++;
          console.log(`VIOLATION A  game ${g} turn ${turn}: chain Focus (${aspect}) with only ${n} ${aspect} card(s) played`);
          console.log('   turn log:', entries.map(x => x.msg).join(' | '));
        }
      } else {
        revealSeen++;
      }
      const recruitBetween = sinceLastPlay.find(x => x.kind === 'card.recruit');
      if (recruitBetween) {
        violationsB++;
        console.log(`VIOLATION B  game ${g} turn ${turn}: recruit "${recruitBetween.msg}" sits between the card play and Focus (${aspect})`);
      }
      sinceLastPlay.push(e);
    }
  }
}

console.log(`\naudited ${turnsAudited} turns across ${GAMES} games`);
console.log(`focus triggers seen: ${chainSeen} chain, ${revealSeen} revealed`);
console.log(`invariant A (chain needs 2+ same-aspect plays): ${violationsA} violations`);
console.log(`invariant B (no recruit between play and focus): ${violationsB} violations`);
const ok = violationsA === 0 && violationsB === 0 && (chainSeen + revealSeen) > 0;
console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
