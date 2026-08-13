// Investigation harness for in-game report #105 — "Yan-C-Bin did not
// assassinate a troop."
//
// The reported turn reads:
//     P1 played Yan-C-Bin
//     P1 placed spy at gracklstugh (spies left: 0)
//     (assassinate at gracklstugh: no enemy/white troops to target — skipped)
//
// gracklstugh held exactly one troop at that moment and it was the reporter's
// OWN (black), so per the rulebook ("You can't assassinate your own troops")
// there was nothing legal to hit. This harness pins that down from both sides:
// the skip is correct when the spy's site holds only your troops, and the
// assassinate MUST fire when the site holds an enemy or a white troop.
//
// Run: npx vite-node scripts/test-repro-105.ts
import { InitializeGame } from 'boardgame.io/internal';
import '../src/engine/handlers'; // register handlers
import { CardRegistry } from '../src/engine/registry';
import { TyrantsGame, type TyrantsState } from '../src/game';
import { TROOP_SPACES } from '../src/data/troop-spaces';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

function fresh(): TyrantsState {
  const init = (InitializeGame({ game: TyrantsGame as never, numPlayers: 3 }) as unknown as { G: TyrantsState }).G;
  return structuredClone(init);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctxFor = (G: TyrantsState): any =>
  ({ G, actorId: '0', card: { deck: 'elemental', slot: 39 }, handlerState: null, pendingChoice: null, paused: false });

/** An in-play site with at least two troop spaces. */
function pickSite(G: TyrantsState): string {
  for (const id of Object.keys(G.siteControl)) {
    if (TROOP_SPACES.filter(t => t.parentSite === id).length >= 2) return id;
  }
  throw new Error('no multi-space site in play');
}
const spacesOf = (siteId: string) => TROOP_SPACES.filter(t => t.parentSite === siteId).map(t => t.id);
/** Setup seeds white troops onto the board; clear the test site so each
 *  scenario below starts from a known, empty site. */
const clearSite = (G: TyrantsState, siteId: string) => {
  for (const id of spacesOf(siteId)) delete G.troops[id];
};

/** Play Yan-C-Bin, answering the place-spy prompt with `siteId`. Returns the
 *  pendingChoice the handler is sitting on afterwards (null if it ran to
 *  completion) plus the log lines it wrote. */
function playYanCBin(G: TyrantsState, siteId: string) {
  const h = CardRegistry.get('yan-c-bin')!;
  const ctx = ctxFor(G);
  const logStart = G.log.length;
  const done1 = h(ctx);                        // → "Place a spy at which site?"
  if (done1) throw new Error('yan-c-bin resolved without prompting for a spy site');
  if (ctx.pendingChoice?.kind !== 'select-site') {
    throw new Error(`expected select-site prompt, got ${ctx.pendingChoice?.kind}`);
  }
  const siteOptions = (ctx.pendingChoice.options as string[]) ?? [];
  ctx.pendingChoice.response = siteId;
  const done2 = h(ctx);                        // place the spy, then the assassinate step
  return {
    ctx,
    done: done2,
    siteOptions,
    log: G.log.slice(logStart).map(e => (typeof e === 'string' ? e : (e.msg ?? ''))),
  };
}

const site = pickSite(fresh());
const [spaceA, spaceB] = spacesOf(site);

// ---------- 1. the reported shape: only my own troop at the spy's site ----------
{
  const G = fresh();
  const me = G.players['0'];
  clearSite(G, site);
  G.troops[spaceA] = me.color;              // my own troop — not a legal target
  const r = playYanCBin(G, site);
  check('#105 own-troop-only site: handler completes without an assassinate prompt',
    r.done === true && r.ctx.pendingChoice == null);
  check('#105 own-troop-only site: my troop survives',
    G.troops[spaceA] === me.color);
  check('#105 own-troop-only site: the skip says WHY (the rule), not just "skipped"',
    r.log.some(l => /can't assassinate your own troops/.test(l)));
  check('#105 the spy still lands (the place half of the card is not lost)',
    (G.spies[site] ?? []).includes(me.color));
}

// ---------- 2. an ENEMY troop at the spy's site must be assassinable ----------
{
  const G = fresh();
  const me = G.players['0'];
  const enemy = G.players['1'].color;
  clearSite(G, site);
  G.troops[spaceA] = me.color;
  G.troops[spaceB] = enemy;
  const r = playYanCBin(G, site);
  check('#105 enemy troop present: handler pauses on an assassinate prompt',
    r.done === false && r.ctx.pendingChoice?.kind === 'select-troop-space');
  const opts = (r.ctx.pendingChoice?.options as string[]) ?? [];
  check('#105 enemy troop present: only the enemy space is offered',
    opts.length === 1 && opts[0] === spaceB);
  r.ctx.pendingChoice.response = spaceB;
  const h = CardRegistry.get('yan-c-bin')!;
  h(r.ctx);
  check('#105 enemy troop present: the enemy troop is removed',
    G.troops[spaceB] == null);
  check('#105 enemy troop present: it lands in my trophy hall',
    me.trophyHall[enemy] === 1);
  check('#105 enemy troop present: my own troop is untouched',
    G.troops[spaceA] === me.color);
}

// ---------- 3. a WHITE troop at the spy's site must be assassinable ----------
{
  const G = fresh();
  const me = G.players['0'];
  clearSite(G, site);
  G.troops[spaceB] = 'white';
  const r = playYanCBin(G, site);
  check('#105 white troop present: handler pauses on an assassinate prompt',
    r.done === false && r.ctx.pendingChoice?.kind === 'select-troop-space');
  r.ctx.pendingChoice.response = spaceB;
  CardRegistry.get('yan-c-bin')!(r.ctx);
  check('#105 white troop present: the white troop is removed',
    G.troops[spaceB] == null);
  check('#105 white troop present: it lands in my trophy hall',
    me.trophyHall.white === 1);
}

// ---------- 4. the place-spy picker is not silently narrowing the board ------
// The reporter had four spies already out; every OTHER in-play site (including
// every site holding an enemy troop) must still be offered.
{
  const G = fresh();
  const enemy = G.players['1'].color;
  clearSite(G, site);
  G.troops[spaceB] = enemy;
  const r = playYanCBin(G, site);
  const inPlay = Object.keys(G.siteControl);
  const missing = inPlay.filter(id => !r.siteOptions.includes(id));
  check(`#105 every in-play site is offered as a spy target (missing: ${missing.join(',') || 'none'})`,
    missing.length === 0);
}

// ---------- 5. the spy prompt warns about the follow-up BEFORE you spend it ---
// This is the actual fix for #105: the reporter had no way to tell, at pick
// time, that gracklstugh would waste the assassinate.
{
  // (a) some site on the board has a legal target → prompt says so and the
  //     paying sites come back in `highlight`.
  const G = fresh();
  const me = G.players['0'];
  const enemy = G.players['1'].color;
  clearSite(G, site);
  G.troops[spaceA] = me.color;    // the "gracklstugh" shape — my troop only
  const other = Object.keys(G.siteControl).find(id => id !== site
    && TROOP_SPACES.some(t => t.parentSite === id))!;
  clearSite(G, other);
  G.troops[spacesOf(other)[0]] = enemy;

  const h = CardRegistry.get('yan-c-bin')!;
  const ctx = ctxFor(G);
  h(ctx);
  const pc = ctx.pendingChoice;
  check('#105 place-spy prompt names the follow-up',
    /assassinate a troop there/i.test(pc.prompt as string));
  const hl = (pc.highlight as string[] | undefined) ?? [];
  check('#105 the site with an enemy troop is highlighted', hl.includes(other));
  check('#105 the own-troop-only site is NOT highlighted', !hl.includes(site));
  check('#105 highlight never narrows what is clickable',
    hl.every(id => (pc.options as string[]).includes(id))
      && (pc.options as string[]).includes(site));

  // Picking the un-highlighted site is still perfectly legal — advisory only.
  ctx.pendingChoice.response = site;
  check('#105 an un-highlighted site is still a legal pick', h(ctx) === true);
  check('#105 the spy landed on the un-highlighted site',
    (G.spies[site] ?? []).includes(me.color));
}
{
  // (b) nowhere on the board has a legal target → say that outright.
  const G = fresh();
  for (const id of Object.keys(G.siteControl)) clearSite(G, id);
  const ctx = ctxFor(G);
  CardRegistry.get('yan-c-bin')!(ctx);
  check('#105 with no legal target anywhere, the prompt says so',
    /no site on the board currently has one/i.test(ctx.pendingChoice.prompt as string));
  check('#105 …and highlights nothing',
    ((ctx.pendingChoice.highlight as string[] | undefined) ?? []).length === 0);
}
{
  // (c) a plain place-a-spy card (Spy Master) is untouched: same prompt as
  //     before, no highlight, no behavior change.
  const G = fresh();
  const ctx = ctxFor(G);
  CardRegistry.get('spy-master')!(ctx);
  check('#105 a plain place-a-spy prompt is unchanged',
    ctx.pendingChoice.prompt === 'Place a spy at which site?'
      && ctx.pendingChoice.highlight === undefined);
}

console.log(ok ? '\nALL PASS' : '\nFAILURES');
process.exit(ok ? 0 : 1);
