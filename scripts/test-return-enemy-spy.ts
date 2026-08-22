// "Return an enemy spy" must let you choose WHOSE spy — reported from BGG.
//
// With two opponents spying on the same site, the game used to pick for you:
// `arr.find(c => c !== me.color)`, i.e. whichever colour happened to sit first
// in the array. That isn't a shortcut, it's the decision itself — the two spies
// belong to different people, and returning the wrong one can hand the site to
// the player you were trying to block.
//
//   npx vite-node scripts/test-return-enemy-spy.ts
import { InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers';
import { returnEnemySpyChoice } from '../src/engine/handler-helpers';
import { placeSpy, deployTroop } from '../src/engine/map-state';
import { TyrantsGame, type TyrantsState } from '../src/game';

let ok = true;
const fail = (m: string) => { console.log(`FAIL  ${m}`); ok = false; };
const pass = (m: string) => console.log(`PASS  ${m}`);

function fresh(): TyrantsState {
  const init = (InitializeGame({ game: TyrantsGame as never, numPlayers: 4 }) as unknown as { G: TyrantsState }).G;
  const G = structuredClone(init);
  G.setupPhase = false;
  return G;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxFor = (G: TyrantsState): any =>
  ({ G, actorId: '0', card: { deck: 'x', slot: 0 }, handlerState: null, pendingChoice: null, paused: false });

// A site where seat 0 has a troop (presence) and two OTHER players have spies.
/** A site with a FREE troop space (many start occupied by neutral troops), so
 *  seat 0 can actually gain presence there. */
function siteWithFreeSpace(G: TyrantsState): { siteId: string; space: string } {
  for (const siteId of Object.keys(G.siteControl)) {
    const space = Object.keys(G.troops).find(sp => sp.startsWith(`${siteId}:`) && !G.troops[sp]);
    if (space) return { siteId, space };
  }
  throw new Error('no site with a free troop space');
}

function siteWithTwoEnemySpies(G: TyrantsState): string {
  const { siteId, space } = siteWithFreeSpace(G);
  if (!deployTroop(G, G.players['0'].color, space)) throw new Error('could not deploy for presence');
  placeSpy(G, G.players['1'].color, siteId);
  placeSpy(G, G.players['2'].color, siteId);
  return siteId;
}

// ---- it asks, rather than deciding for you ----
{
  const G = fresh();
  const siteId = siteWithTwoEnemySpies(G);
  const h = returnEnemySpyChoice();
  const ctx = ctxFor(G);

  h(ctx);                                   // stage 1: which site?
  if (ctx.pendingChoice?.kind !== 'select-site') fail(`expected a site prompt, got ${ctx.pendingChoice?.kind}`);
  else pass('asks which site first');
  ctx.pendingChoice.response = siteId;

  h(ctx);                                   // stage 2: whose spy?
  if (ctx.pendingChoice?.kind !== 'select-player') {
    fail(`two enemy spies present but no owner prompt (got ${ctx.pendingChoice?.kind ?? 'none'}) — the game chose for the player`);
  } else {
    pass(`asks whose spy: "${ctx.pendingChoice.prompt}"`);
    const opts = ctx.pendingChoice.options as string[];
    if (opts.length !== 2 || !opts.includes('1') || !opts.includes('2')) {
      fail(`owner options wrong: ${JSON.stringify(opts)}`);
    } else pass('both spy owners are offered');

    // Choosing the SECOND one must return that one — the bug returned the first.
    const before2 = G.players['2'].spiesLeft;
    const before1 = G.players['1'].spiesLeft;
    ctx.pendingChoice.response = '2';
    h(ctx);
    const remaining = G.spies[siteId] ?? [];
    if (remaining.includes(G.players['2'].color)) fail('picked P3’s spy but it is still on the site');
    else pass('the chosen spy is the one that left');
    if (!remaining.includes(G.players['1'].color)) fail('the spy that was NOT chosen was removed as well');
    else pass('the other opponent’s spy is untouched');
    if (G.players['2'].spiesLeft !== before2 + 1) fail('returned spy did not go back to its owner’s supply');
    else pass('returned spy went back to its own owner’s supply');
    if (G.players['1'].spiesLeft !== before1) fail('the untouched opponent’s supply changed');
    else pass('the untouched opponent’s supply is unchanged');
  }
}

// ---- with only one enemy spy it should NOT nag ----
{
  const G = fresh();
  const { siteId, space } = siteWithFreeSpace(G);
  deployTroop(G, G.players['0'].color, space);
  placeSpy(G, G.players['1'].color, siteId);

  const h = returnEnemySpyChoice();
  const ctx = ctxFor(G);
  h(ctx);
  ctx.pendingChoice.response = siteId;
  const done = h(ctx);
  if (ctx.pendingChoice?.kind === 'select-player') fail('asked whose spy when there was only one candidate');
  else pass('no owner prompt when there is only one enemy spy');
  if (!done || (G.spies[siteId] ?? []).includes(G.players['1'].color)) fail('the single enemy spy was not returned');
  else pass('the single enemy spy is returned without an extra click');
}

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
