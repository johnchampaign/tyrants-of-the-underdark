// Regression test for #107: Mummy Lord's "take a white troop from any trophy
// hall and deploy it anywhere on the board".
//
// The trophy picker built the option list WITHOUT the whiteOnly filter but
// resolved the player's response against a list built WITH it. Two visible
// bugs fell out of that mismatch: every colour was offered (the card says
// white only), and picking an option resolved to the wrong entry — or to
// nothing at all, so the card silently did nothing.
import { takeTrophyAndPlace } from '../src/engine/handler-helpers';
import { TROOP_SPACES } from '../src/data/troop-spaces';

let ok = true;
const check = (label: string, cond: boolean) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}`);
  if (!cond) ok = false;
};

// Trophy halls modelled on the reporter's game (#107): several players hold a
// mix of white and player-colour trophies.
function makeG() {
  const troops: Record<string, string | null> = {};
  for (const t of TROOP_SPACES) troops[t.id] = null;
  troops['menzoberranzan:0'] = 'blue'; // one occupied space, to prove it's excluded
  return {
    players: {
      '0': { color: 'blue', trophyHall: { black: 0, red: 0, orange: 0, blue: 0, white: 3 } },
      '1': { color: 'black', trophyHall: { black: 0, red: 0, orange: 2, blue: 0, white: 2 } },
      '2': { color: 'red', trophyHall: { black: 1, red: 0, orange: 0, blue: 0, white: 4 } },
      '3': { color: 'orange', trophyHall: { black: 3, red: 0, orange: 0, blue: 0, white: 0 } },
    },
    troops,
    log: [] as string[],
    cardsPlayedThisTurn: [],
  } as any;
}

function makeCtx(G: any) {
  return {
    G,
    card: { deck: 'undead', slot: 25, name: 'Mummy Lord', image: '' },
    actorId: '0',
    pendingChoice: null as any,
    paused: false,
    handlerState: null as any,
  } as any;
}

// 1. The offered list is white-only.
{
  const G = makeG();
  const ctx = makeCtx(G);
  const done = takeTrophyAndPlace({ count: 1, whiteOnly: true, optional: false })(ctx);
  const options: string[] = ctx.pendingChoice?.options ?? [];
  check('prompt opens', done === false && options.length > 0);
  check('every offered trophy is white', options.every(o => o.includes('white')));
  check('no player-colour trophies offered (#107)',
    !options.some(o => /black|orange|red|blue/.test(o)));
  // P1 white ×3, P2 white ×2, P3 white ×4 — P4 has none.
  check('one entry per hall holding white trophies', options.length === 3);
}

// 2. Picking an entry resolves to THAT entry and opens the placement picker.
{
  const G = makeG();
  const ctx = makeCtx(G);
  takeTrophyAndPlace({ count: 1, whiteOnly: true, optional: false })(ctx);
  const options: string[] = ctx.pendingChoice.options;
  const idx = options.findIndex(o => o.startsWith("P3 hall")); // last white entry
  check('P3 white trophy is offered', idx >= 0);
  ctx.pendingChoice.response = idx;
  const done = takeTrophyAndPlace({ count: 1, whiteOnly: true, optional: false })(ctx);
  check('picking the last white entry opens the placement picker (#107)',
    done === false && ctx.pendingChoice?.kind === 'select-troop-space');
  check('placement prompt names the white trophy',
    String(ctx.pendingChoice?.prompt ?? '').includes('white'));
  check('occupied spaces are not offered',
    !(ctx.pendingChoice.options as string[]).includes('menzoberranzan:0'));

  // 3. Placing it moves a WHITE token out of P3's hall onto the board.
  const spaceId = (ctx.pendingChoice.options as string[])[0];
  ctx.pendingChoice.response = spaceId;
  const done2 = takeTrophyAndPlace({ count: 1, whiteOnly: true, optional: false })(ctx);
  check('placement completes', done2 === true);
  check('a white token now sits on the chosen space', G.troops[spaceId] === 'white');
  check("P3's white trophies went 4 -> 3", G.players['2'].trophyHall.white === 3);
  check('no other colour was taken', G.players['2'].trophyHall.black === 1);
}

console.log(ok ? '\nALL MUMMY-LORD TROPHY TESTS PASSED' : '\nTESTS FAILED');
process.exit(ok ? 0 : 1);
