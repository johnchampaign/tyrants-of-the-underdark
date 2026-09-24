// Online "it's your move" alert for players who alt-tab away while opponents
// play. When the game hands control to this seat and the window isn't in
// focus, the tab title blinks and a short soft chime plays; both stop as soon
// as the player comes back to the window.

const FLASH_TEXT = '▶ Your turn! — Tyrants';
const FLASH_MS = 1000;

let stopActive: (() => void) | null = null;

function chime(): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ac = new Ctx();
    const t0 = ac.currentTime;
    // Two rising notes, quiet and short.
    [660, 880].forEach((freq, i) => {
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.18;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.08, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(ac.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    setTimeout(() => { ac.close().catch(() => {}); }, 1000);
  } catch {
    // Audio blocked or unavailable — the title flash still works.
  }
}

/** Call when control has just passed to this seat. No-op if the player is
 *  already looking at the window. */
export function alertYourTurn(): void {
  if (typeof document === 'undefined') return;
  if (document.hasFocus() && !document.hidden) return;
  stopTurnAlert();

  const baseTitle = document.title;
  let on = false;
  const timer = window.setInterval(() => {
    on = !on;
    document.title = on ? FLASH_TEXT : baseTitle;
  }, FLASH_MS);
  document.title = FLASH_TEXT;
  on = true;
  chime();

  const onBack = () => {
    if (document.hidden) return;
    stopTurnAlert();
  };
  window.addEventListener('focus', onBack);
  document.addEventListener('visibilitychange', onBack);

  stopActive = () => {
    window.clearInterval(timer);
    window.removeEventListener('focus', onBack);
    document.removeEventListener('visibilitychange', onBack);
    document.title = baseTitle;
  };
}

/** Stop any running alert and restore the title. */
export function stopTurnAlert(): void {
  const stop = stopActive;
  stopActive = null;
  stop?.();
}
