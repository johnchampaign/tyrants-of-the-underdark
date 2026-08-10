// Regression test for #104 — "the game is locked, no button to press".
//
// The reported game was stranded at the start of a server-driven AI seat's turn:
// the human's end-of-turn had persisted, the AI's turn had begun, and nothing
// ever moved again. The AI itself was fine (it picks a legal action on that
// exact state in milliseconds); what wasn't fine was how much state the server
// had to haul around to run the turn.
//
// boardgame.io keeps its OWN undo history in `state._undo`: one full copy of
// {G, ctx, plugins} per dispatched move, cleared only at a turn boundary. It
// lives OUTSIDE `G`, so the snapshotCodec's careful stripping of G.undoStack /
// G.snapshots never reached it — and each of those copies carried its own
// `snapshots` array, i.e. exactly the nested full states the codec exists to
// keep out of storage. On the reported snapshot `_undo` was two thirds of the
// persisted bytes, and replaying one AI turn grew the live state ~4x because
// every move appended another copy.
//
// Two guarantees here:
//   1. snapshotCodec drops _undo/_redo on encode AND on decode (so a snapshot
//      written before the fix gets cheap the moment it is loaded).
//   2. The adapter's reducer no longer accumulates _undo, so the state the
//      server clones per move stays flat across a whole turn.
//
// Run: npx vite-node scripts/test-repro-104.ts
import { InitializeGame } from 'boardgame.io/internal';
import { TyrantsGame } from '../src/game';
import { tyrantsAdapter, initialBgioState, type BgioState } from '../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../src/online/snapshotCodec';
import { decideHeuristicMove } from '../src/ai/heuristic-ai';
import type { AiMove } from '../src/ai/random-ai';

let ok = true;
const fail = (msg: string) => { console.log('FAIL  ' + msg); ok = false; };
const pass = (msg: string) => console.log('ok    ' + msg);

const codec = snapshotCodec();
const size = (o: unknown) => JSON.stringify(o).length;

// ---- 1. the codec keeps bgio's undo history out of storage -----------------

// A snapshot as it was written BEFORE the fix: a fat _undo whose entries each
// carry a full G (complete with the nested `snapshots` the codec strips).
const base = initialBgioState(2, { activeSections: ['center'] });
const legacy = {
  ...base,
  _undo: [
    { G: { ...base.G, snapshots: ['x'.repeat(50_000)] }, ctx: base.ctx, plugins: {}, playerID: '0' },
    { G: { ...base.G, snapshots: ['x'.repeat(50_000)] }, ctx: base.ctx, plugins: {}, playerID: '0' },
  ],
  _redo: [{ G: base.G, ctx: base.ctx, plugins: {} }],
} as unknown as BgioState;

const encoded = codec.encode(legacy);
if (encoded.includes('xxxxxxxxxx')) fail('encoded snapshot still carries the _undo payload');
else pass('encode drops bgio _undo/_redo');
if (size(legacy) - encoded.length < 100_000) {
  fail(`encode saved only ${size(legacy) - encoded.length} chars — expected the _undo bulk to go`);
} else pass(`encode shed ${size(legacy) - encoded.length} chars of undo history`);

// Decoding a pre-fix snapshot must shed it too, and must hand bgio real arrays.
const rehydrated = codec.decode(JSON.stringify(legacy));
if (!Array.isArray(rehydrated._undo) || (rehydrated._undo as unknown[]).length !== 0) {
  fail('decode did not clear a legacy _undo');
} else pass('decode clears a legacy _undo');
if (!Array.isArray(rehydrated._redo) || (rehydrated._redo as unknown[]).length !== 0) {
  fail('decode did not clear a legacy _redo');
} else pass('decode clears a legacy _redo');
if (!Array.isArray((rehydrated.G as unknown as { undoStack: unknown }).undoStack)
    || !Array.isArray((rehydrated.G as unknown as { snapshots: unknown }).snapshots)) {
  fail('decode must still restore G.undoStack / G.snapshots as arrays');
} else pass('decode still restores G.undoStack / G.snapshots');

// The codec must not have broken the round-trip it already guaranteed.
if (codec.decode(codec.encode(base)).ctx.currentPlayer !== base.ctx.currentPlayer) {
  fail('codec round-trip lost ctx');
} else pass('codec round-trip still intact');

// ---- 2. a whole turn no longer inflates the state --------------------------

// Play a full turn through the adapter the way the server's AI driver does, and
// watch the size of the state it clones per move. Before the fix this climbed
// by a full copy of G on every single move.
const toAction = (m: AiMove | null) => {
  if (!m) return null;
  const map: Record<string, (a: any[]) => any> = {
    deployStartingTroop: a => ({ kind: 'deployStartingTroop', siteId: a[0] }),
    playCard: a => ({ kind: 'playCard', handIndex: a[0] }),
    recruitFromMarket: a => ({ kind: 'recruitFromMarket', marketIndex: a[0] }),
    recruitFromAuxStack: a => ({ kind: 'recruitFromAuxStack', stack: a[0] }),
    deployTroop: a => ({ kind: 'deployTroop', spaceId: a[0] }),
    assassinateTroop: a => ({ kind: 'assassinateTroop', spaceId: a[0] }),
    returnEnemySpy: a => ({ kind: 'returnEnemySpy', siteId: a[0], targetColor: a[1] }),
    resolveChoice: a => ({ kind: 'resolveChoice', response: a[0] }),
    endTurn: () => ({ kind: 'endTurn' }),
  };
  return map[m.name] ? map[m.name](m.args) : null;
};

// Fast-forward past setup so we're driving a real turn, not troop placement.
let s: BgioState = codec.decode(codec.encode(initialBgioState(2, { activeSections: ['center'] })));
for (let i = 0; i < 400 && s.G.setupPhase; i++) {
  const legal = tyrantsAdapter.legalActions(s, tyrantsAdapter.currentActor(s)!);
  if (!legal.length) break;
  const r = tyrantsAdapter.tryApplyAction!(s, legal[0], tyrantsAdapter.currentActor(s)!);
  if (!r.ok) break;
  s = r.state;
}
if (s.G.setupPhase) fail('could not get past setup — the rest of this test is meaningless');

const startSize = size(s);
let peak = startSize;
let moves = 0;
const actorAtStart = tyrantsAdapter.currentActor(s)!;
for (let i = 0; i < 100; i++) {
  const actor = tyrantsAdapter.currentActor(s);
  if (actor === null || actor !== actorAtStart) break;
  const legal = tyrantsAdapter.legalActions(s, actor);
  if (!legal.length) break;
  const decided = toAction(decideHeuristicMove(s.G as any, actor));
  const chosen = decided && legal.some(a => JSON.stringify(a) === JSON.stringify(decided))
    ? decided : legal[0];
  const r = tyrantsAdapter.tryApplyAction!(s, chosen, actor);
  if (!r.ok) break;
  s = r.state;
  moves++;
  peak = Math.max(peak, size(s));
}
if (moves < 3) fail(`only drove ${moves} moves — not a representative turn`);
else pass(`drove a ${moves}-move turn through the adapter`);

// Allow generous headroom for the turn's real state growth (cards move, the log
// grows); what must NOT happen is a per-move full copy of G piling up.
const growth = peak / startSize;
if (growth > 1.6) {
  fail(`state grew ${growth.toFixed(1)}x over one turn (${startSize} → ${peak}) — undo history is accumulating again`);
} else pass(`state stayed flat over a turn (${growth.toFixed(2)}x: ${startSize} → ${peak})`);

const undoLen = Array.isArray(s._undo) ? (s._undo as unknown[]).length : -1;
if (undoLen > 0) fail(`adapter reducer accumulated ${undoLen} _undo entries`);
else pass('adapter reducer accumulates no _undo entries');

// ---- 3. hotseat is untouched ------------------------------------------------

// The flag must live on the adapter's copy only: a bgio client built from
// TyrantsGame (what hotseat does) still gets its undo stack.
const hotseat = InitializeGame({ game: TyrantsGame, numPlayers: 2 }) as unknown as BgioState;
if (!Array.isArray(hotseat._undo) || (hotseat._undo as unknown[]).length === 0) {
  fail('hotseat lost its boardgame.io undo stack — TyrantsGame was mutated');
} else pass('hotseat still initializes with an undo stack');

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
