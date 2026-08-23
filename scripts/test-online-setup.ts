// The online create endpoint must honour the same setup choices as solo.
//
// It used to accept only numPlayers and ai, so initialBgioState never received
// halfDecks and every online game silently fell through to the engine default
// pair — elemental, demons and the expansion decks had never once been playable
// online (reported from BGG: "you always play the same game variation").
//
//   npx vite-node scripts/test-online-setup.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameServer } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { handleApi } from '../server/handlers';
import { tyrantsAdapter, type BgioState, type TyrantsAction, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../src/online/snapshotCodec';
import { tyrantsControllers } from '../src/online/aiControllers';
import { decodeRow } from '../server/sweep';

let ok = true;
const fail = (m: string) => { console.log(`FAIL  ${m}`); ok = false; };
const pass = (m: string) => console.log(`PASS  ${m}`);

const root = mkdtempSync(join(tmpdir(), 'totu-setup-'));
const store = new FsStore(root);
const codec = snapshotCodec();
const server = new GameServer<BgioState, TyrantsAction, PlayerId>({
  adapter: tyrantsAdapter, codec, store,
  aiControllers: tyrantsControllers,
  gameUrl: (g, t) => `http://test/${g}?as=${t}`,
});
const Q = new URLSearchParams();
const create = (body: unknown) => handleApi(server, 'POST', '/api/games', Q, body);
const stateOf = async (gameId: string) =>
  decodeRow(codec, (await store.getLatest(gameId))!.state, tyrantsAdapter.schemaVersion ?? 1)!;
const decksIn = (G: BgioState['G']) => {
  const seen = new Set<string>();
  for (const c of [...G.market.deck, ...G.market.row]) if (c) seen.add(c.deck);
  return [...seen].sort();
};

try {
  // ---- chosen decks are the decks you get ----
  {
    const r = await create({ numPlayers: 2, halfDecks: ['elemental', 'demons'] });
    if (r.status !== 200) { fail(`create rejected a valid half-deck pair: ${JSON.stringify(r.body)}`); }
    else {
      const { gameId } = r.body as { gameId: string };
      const decks = decksIn((await stateOf(gameId)).G);
      if (decks.join(',') !== 'demons,elemental') fail(`asked for elemental+demons, market holds ${decks.join('+')}`);
      else pass(`market is built from the chosen half-decks (${decks.join(' + ')})`);
    }
  }

  // ---- the creator's colour is honoured ----
  {
    const r = await create({ numPlayers: 2, humanColor: 'teal' });
    const { gameId } = r.body as { gameId: string };
    const G = (await stateOf(gameId)).G;
    if (G.players['0'].color !== 'teal') fail(`asked for teal, seat 0 is ${G.players['0'].color}`);
    else pass('seat 0 gets the colour the creator picked');
    if (G.players['1'].color === 'teal') fail('another seat was given the creator’s colour too');
    else pass(`the other seat takes a classic colour (${G.players['1'].color})`);
  }

  // ---- every seat's colour can be set, not just the host's ----
  {
    const r = await create({ numPlayers: 4, seatColors: ['teal', 'yellow', 'pink', 'green'] });
    if (r.status !== 200) { fail(`create rejected valid seatColors: ${JSON.stringify(r.body)}`); }
    else {
      const G = (await stateOf((r.body as { gameId: string }).gameId)).G;
      const got = ['0', '1', '2', '3'].map(p => G.players[p].color);
      if (got.join(',') !== 'teal,yellow,pink,green') fail(`seat colours came out as ${got.join(',')}`);
      else pass(`every seat gets the colour the host chose (${got.join(', ')})`);
    }
  }

  // ---- omitting setup still works (existing clients) ----
  {
    const r = await create({ numPlayers: 2 });
    if (r.status !== 200) fail('a create with no setup fields was rejected — old clients would break');
    else {
      const decks = decksIn((await stateOf((r.body as { gameId: string }).gameId)).G);
      pass(`create without setup still works, defaulting to ${decks.join(' + ')}`);
    }
  }

  // ---- bad input is refused, not silently ignored ----
  for (const [label, body] of [
    ['one deck', { numPlayers: 2, halfDecks: ['drow'] }],
    ['the same deck twice', { numPlayers: 2, halfDecks: ['drow', 'drow'] }],
    ['a deck that does not exist', { numPlayers: 2, halfDecks: ['drow', 'wyverns'] }],
    ['a colour that is not selectable', { numPlayers: 2, humanColor: 'chartreuse' }],
    // Two seats on one colour would make the board unreadable.
    ['two seats sharing a colour', { numPlayers: 2, seatColors: ['red', 'red'] }],
    ['seatColors of the wrong length', { numPlayers: 4, seatColors: ['red', 'blue'] }],
  ] as Array<[string, unknown]>) {
    const r = await create(body);
    if (r.status !== 422) fail(`${label} was accepted (HTTP ${r.status}) instead of refused`);
    else pass(`refuses ${label}`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
