// Giving up (#111), through the REAL server path: GameServer + the production
// snapshot codec + a serializing file store — what the Worker runs. The unit
// test (test-concede.ts) calls the adapter directly, which cannot show whether
// the framework honours allowsOutOfTurn or whether the create route records
// bot seats. This does.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GameServer } from 'digital-boardgame-framework/server';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { tyrantsAdapter, initialBgioState, type BgioState, type TyrantsAction, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../src/online/snapshotCodec';
import { tyrantsControllers } from '../src/online/aiControllers';
import { handleApi } from '../server/handlers';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};
const tokenOf = (url: string) => url.split('as=')[1]!;
const concede: TyrantsAction = { kind: 'concede' };
const all3 = { activeSections: ['left', 'center', 'right'] as Array<'left' | 'center' | 'right'> };

const roots: string[] = [];
function makeServer() {
  const root = mkdtempSync(join(tmpdir(), 'totu-concede-'));
  roots.push(root);
  return new GameServer<BgioState, TyrantsAction, PlayerId>({
    adapter: tyrantsAdapter, codec: snapshotCodec(), store: new FsStore(root),
    aiControllers: tyrantsControllers, snapshotHistory: 20,
    gameUrl: (g, t) => `http://test/${g}?as=${t}`,
  });
}

async function main() {
  // ---- two people; the one NOT on turn gives up ----
  {
    const server = makeServer();
    const { gameId, invites } = await server.createGame({ initialState: initialBgioState(2), players: ['0', '1'] as PlayerId[] });
    const t0 = tokenOf(invites['0' as PlayerId]), t1 = tokenOf(invites['1' as PlayerId]);
    const v0 = await server.fetch(gameId, t0);
    const waitingTok = v0.yourTurn ? t1 : t0;
    const onTurnSeat = v0.yourTurn ? '0' : '1';
    let err = '';
    try { await server.submit(gameId, waitingTok, concede); } catch (e) { err = String((e as Error).message ?? e); }
    check('server accepts a concession from the player NOT on turn', err === '');
    if (err) console.log('   rejected with:', err);
    const after = await server.fetch(gameId, t0);
    check('server: the game is over', after.gameOver === true);
    const res = tyrantsAdapter.result!(after.view as BgioState);
    check('server: the player on turn is the winner', !!res && res.winners.join() === onTurnSeat);
  }

  // ---- one person against three server AIs ----
  {
    const server = makeServer();
    const { gameId, invites } = await server.createGame({
      initialState: initialBgioState(4, { ...all3, botSeats: ['1', '2', '3'] }),
      players: ['0', '1', '2', '3'] as PlayerId[],
      ai: { '1': 'standard', '2': 'standard', '3': 'standard' } as never,
    });
    const me = tokenOf(invites['0' as PlayerId]);
    let err = '';
    try { await server.submit(gameId, me, concede); } catch (e) { err = String((e as Error).message ?? e); }
    check('server: the only person vs three AIs can give up', err === '');
    check('server: ...and the table ends rather than bots playing on', (await server.fetch(gameId, me)).gameOver === true);
  }

  // ---- two people and two AIs: the server's bot takes the seat ----
  // The case that needed framework 0.50 (adapter.serverDrivenSeats): the game
  // must go on for the other person, with the conceded seat played at once on
  // each of its turns — never left waiting for the daily sweep.
  {
    const root = mkdtempSync(join(tmpdir(), 'totu-concede-'));
    roots.push(root);
    const store = new FsStore(root);
    const server = new GameServer<BgioState, TyrantsAction, PlayerId>({
      adapter: tyrantsAdapter, codec: snapshotCodec(), store,
      aiControllers: tyrantsControllers, gameUrl: (g, t) => `http://test/${g}?as=${t}`,
    });
    const { gameId, invites } = await server.createGame({
      initialState: initialBgioState(4, { ...all3, botSeats: ['2', '3'] }),
      players: ['0', '1', '2', '3'] as PlayerId[],
      ai: { '2': 'standard', '3': 'standard' } as never,
    });
    const me = tokenOf(invites['0' as PlayerId]);
    const other = tokenOf(invites['1' as PlayerId]);
    const actorNow = async () => tyrantsAdapter.currentActor((await server.fetch(gameId, other)).view as BgioState);

    let err = '';
    try { await server.submit(gameId, me, concede); } catch (e) { err = String((e as Error).message ?? e); }
    check('server: giving up is accepted while another person is still playing', err === '');
    const v = await server.fetch(gameId, other);
    check('server: ...the game carries on', !v.gameOver);
    check('server: ...the seat is recorded as given up', ((v.view as BgioState).G.forfeitedSeats ?? []).join() === '0');
    check('server: ...the bot played it at once — the table rests on the other person', (await actorNow()) === '1');
    const meta = await store.getGameMeta(gameId);
    check('server: ...and the seat keeps its identity (still in the rating)', !(meta?.identities?.['0'] ?? '').startsWith('ai:'));

    // The other person plays two full rounds. Every time the table comes to
    // rest it must be on them: the given-up seat is played as soon as it's up.
    const start = (v.view as BgioState).ctx.turn as number;
    let heldUp = false, turn = start;
    for (let i = 0; i < 400 && turn < start + 8; i++) {
      const cur = await server.fetch(gameId, other);
      const st = cur.view as BgioState;
      turn = st.ctx.turn as number;
      if (cur.gameOver) break;
      const actor = tyrantsAdapter.currentActor(st);
      if (actor !== '1') { heldUp = true; break; }
      const legal = await server.legalActions(gameId, other);
      if (!legal.length) break;
      await server.submit(gameId, other, legal[0]);
    }
    check(`server: two more rounds (turn ${start} → ${turn}), never waiting on the given-up seat`, !heldUp && turn >= start + 8);
  }

  // ---- the real create route records bot seats ----
  {
    const server = makeServer();
    const r = await handleApi(server as never, 'POST', '/api/games', new URLSearchParams(), { numPlayers: 2, ai: { '1': 'standard' } });
    const body = r.body as { gameId: string; invites: Record<string, string> };
    check('create route: responds OK', r.status === 200 && !!body.gameId);
    const v = await server.fetch(body.gameId, tokenOf(body.invites['0']));
    check('create route: the AI seat is recorded in the game state', ((v.view as BgioState).G.botSeats ?? []).join() === '1');
  }
}

main()
  .catch(e => { console.log('FAIL  threw:', e); ok = false; })
  .finally(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
    console.log(ok ? '\nALL CONCEDE SERVER TESTS PASSED' : '\nFAILURES PRESENT');
    process.exit(ok ? 0 : 1);
  });
