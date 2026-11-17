// Regression test: the adapter's legal deploys must stay on the board in play.
//
// 2- and 3-player games use only some board sections; only their spaces are
// keys in G.troops, and the deployTroop move rejects anything else. The
// adapter's legalActions skipped occupied spaces with `if (G.troops[id])`, which
// reads an out-of-play space (undefined) as EMPTY — so it offered deploys onto
// routes leading out of the active sections (e.g. ched-nasad-dekanter:0) and,
// for a player with no map presence, onto every out-of-play space. Submitting
// one failed with "invalid move: deployTroop" (seen on the live API, Nov 2026).
// The heuristic and random AIs already had the `in G.troops` check; the
// adapter didn't. test:online-path never hit it because it builds a 2-player
// game WITHOUT activeSections, i.e. on the full board.
//
// Part 1 (deterministic): after setup on each reduced board, a player with no
// map presence, and one whose presence borders an out-of-play route. Every
// offered deploy must be an in-play space AND be accepted by the engine.
// Part 2 (property): random games on the reduced boards, every seat picking
// uniformly from legalActions; every offered deploy must be in play and every
// chosen action must apply.
import { initialBgioState, tyrantsAdapter, type BgioState, type TyrantsAction, type PlayerId } from '../src/adapter/tyrantsAdapter';
import { TROOP_SPACES } from '../src/data/troop-spaces';
import { ROUTES } from '../src/data/routes';

let ok = true;
const check = (label: string, cond: boolean, detail?: unknown) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${!cond && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!cond) ok = false;
};

// Same mapping as server/handlers.ts activeSectionsFor (the online create path).
const SECTIONS: Record<number, Array<'left' | 'center' | 'right'>> = { 2: ['center'], 3: ['center', 'left'] };

const clone = (s: BgioState): BgioState => JSON.parse(JSON.stringify(s));
const deploysOf = (legal: TyrantsAction[]) =>
  legal.flatMap(a => (a.kind === 'deployTroop' ? [a.spaceId] : []));

/** Play the setup phase (starting-site picks) with each seat's first legal action. */
function afterSetup(numPlayers: number): BgioState {
  let s = initialBgioState(numPlayers, { activeSections: SECTIONS[numPlayers] });
  for (let i = 0; i < 50 && s.G.setupPhase; i++) {
    const actor = tyrantsAdapter.currentActor(s) as PlayerId;
    s = tyrantsAdapter.applyAction(s, tyrantsAdapter.legalActions(s, actor)[0], actor);
  }
  return s;
}

/** Every offered deploy is in play, and the engine accepts each one. */
function checkDeploys(label: string, s: BgioState) {
  const actor = tyrantsAdapter.currentActor(s) as PlayerId;
  const offered = deploysOf(tyrantsAdapter.legalActions(s, actor));
  const offBoard = offered.filter(id => !(id in s.G.troops));
  check(`${label}: some deploys offered`, offered.length > 0);
  check(`${label}: no deploy offered off the active board`, offBoard.length === 0, offBoard);
  const rejected = offered.filter(id => {
    try { tyrantsAdapter.applyAction(s, { kind: 'deployTroop', spaceId: id }, actor); return false; }
    catch { return true; }
  });
  check(`${label}: the engine accepts every offered deploy`, rejected.length === 0, rejected);
}

for (const n of [2, 3]) {
  const base = afterSetup(n);
  check(`${n}p: setup finished`, !base.G.setupPhase);
  const offBoardSpaces = TROOP_SPACES.filter(t => !(t.id in base.G.troops));
  check(`${n}p: the board really is reduced`, offBoardSpaces.length > 0);
  const actor = tyrantsAdapter.currentActor(base) as PlayerId;
  const color = base.G.players[actor].color;

  // No map presence: every empty in-play space is open — and nothing else.
  const bare = clone(base);
  bare.G.players[actor].power = 5;
  for (const id of Object.keys(bare.G.troops)) if (bare.G.troops[id] === color) bare.G.troops[id] = null;
  for (const site of Object.keys(bare.G.spies)) bare.G.spies[site] = (bare.G.spies[site] ?? []).filter(c => c !== color);
  checkDeploys(`${n}p no presence`, bare);

  // Presence at the in-play end of a route that leads off the board.
  const inPlay = (site: string) => site in base.G.siteControl;
  const edge = ROUTES.find(r => inPlay(r.a) !== inPlay(r.b));
  const edgeSite = edge && (inPlay(edge.a) ? edge.a : edge.b);
  const bordering = clone(base);
  bordering.G.players[actor].power = 5;
  const homeSpace = edgeSite && Object.keys(bordering.G.troops).find(id => id.startsWith(`${edgeSite}:`) && !bordering.G.troops[id]);
  if (homeSpace) bordering.G.troops[homeSpace] = color;
  check(`${n}p: found an in-play site bordering an off-board route`, !!homeSpace, { edge: edge?.id, edgeSite });
  checkDeploys(`${n}p presence next to an off-board route`, bordering);
}

// Part 2 — random games on the reduced boards.
const GAMES = Number(process.argv[2] ?? 6);
const STEPS = 1500;
for (const n of [2, 3]) {
  let offBoardOffers = 0, rejected = 0, firstFail: unknown;
  for (let g = 0; g < GAMES; g++) {
    let s = afterSetup(n);
    for (let step = 0; step < STEPS && !tyrantsAdapter.result?.(s); step++) {
      const actor = tyrantsAdapter.currentActor(s) as PlayerId;
      const legal = tyrantsAdapter.legalActions(s, actor);
      if (!legal.length) break;
      const bad = deploysOf(legal).filter(id => !(id in s.G.troops));
      if (bad.length) { offBoardOffers++; firstFail ??= { game: g, step, bad }; }
      const action = legal[Math.floor(Math.random() * legal.length)];
      try { s = tyrantsAdapter.applyAction(s, action, actor); }
      catch (e) { rejected++; firstFail ??= { game: g, step, action, err: String(e) }; break; }
    }
  }
  check(`${n}p random play (${GAMES} games): no off-board deploy ever offered`, offBoardOffers === 0, firstFail);
  check(`${n}p random play (${GAMES} games): every chosen legal action applied`, rejected === 0, firstFail);
}

console.log(ok ? 'ALL LEGAL-DEPLOY TESTS PASSED' : 'LEGAL-DEPLOY TESTS FAILED');
if (!ok) process.exit(1);
