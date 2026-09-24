// Regression test for the online "your turn" tab alert (issue #112).
// Stubs the minimal DOM surface the alert touches.
export {};
type L = () => void;
const winL: Record<string, L[]> = {};
const docL: Record<string, L[]> = {};
let focused = false;
const intervals = new Map<number, L>();
let nextId = 1;
const doc = {
  title: 'Tyrants of the Underdark',
  hidden: true,
  hasFocus: () => focused,
  addEventListener: (e: string, f: L) => { (docL[e] ??= []).push(f); },
  removeEventListener: (e: string, f: L) => { docL[e] = (docL[e] ?? []).filter(x => x !== f); },
};
const win = {
  addEventListener: (e: string, f: L) => { (winL[e] ??= []).push(f); },
  removeEventListener: (e: string, f: L) => { winL[e] = (winL[e] ?? []).filter(x => x !== f); },
  setInterval: (f: L) => { const id = nextId++; intervals.set(id, f); return id; },
  clearInterval: (id: number) => { intervals.delete(id); },
};
(globalThis as any).document = doc;
(globalThis as any).window = win;

const { alertYourTurn, stopTurnAlert } = await import('../src/online/turnAlert');
let fails = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { fails++; console.error('FAIL', msg); } else console.log('ok  ', msg); };

// Focused & visible: no alert.
focused = true; doc.hidden = false;
alertYourTurn();
check(doc.title === 'Tyrants of the Underdark' && intervals.size === 0, 'no alert while the player is looking');

// Backgrounded: title flashes.
focused = false; doc.hidden = true;
alertYourTurn();
check(doc.title.includes('Your turn'), 'title shows the alert when backgrounded');
check(intervals.size === 1, 'blink timer running');
[...intervals.values()][0]();
check(doc.title === 'Tyrants of the Underdark', 'blink toggles back to the base title');

// Re-alerting doesn't stack timers or lose the base title.
alertYourTurn();
check(intervals.size === 1, 'second alert replaces the first');

// Coming back stops it.
doc.hidden = false; focused = true;
(winL.focus ?? []).forEach(f => f());
check(doc.title === 'Tyrants of the Underdark' && intervals.size === 0, 'focus restores title and stops blinking');
check((winL.focus ?? []).length === 0 && (docL.visibilitychange ?? []).length === 0, 'listeners removed');

// Explicit stop (e.g. turn passed away again) also restores.
focused = false; doc.hidden = true;
alertYourTurn();
stopTurnAlert();
check(doc.title === 'Tyrants of the Underdark' && intervals.size === 0, 'stopTurnAlert restores title');

if (fails) { console.error(`${fails} failure(s)`); process.exit(1); }
console.log('all turn-alert checks passed');
