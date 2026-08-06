// The in-game "Log (N)" panel on the game tab.
//
// Ordering matters here more than it looks. This panel used to render the log
// REVERSED (newest first) with nothing on screen saying so, while every other
// place the same lines appear — the end-of-turn summary, the Log tab's
// per-turn breakdown, the exported JSON, the body of a problem report — is
// chronological. During a turn in progress the per-turn views have nothing to
// show yet, so this panel is the only way to see what just happened, and a
// reader who assumes top-to-bottom time gets every cause and effect backwards.
// That is what produced in-game report #103: a Focus keyword that had
// legitimately chain-triggered off an earlier card appeared, in this panel, to
// have been caused by a market buy that actually happened afterwards.
//
// So: oldest at the top, newest at the bottom, pinned to the bottom the way a
// chat or console log behaves.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { TyrantsState } from '../game';
import { logLineText } from '../engine/log';
import { CardLogText } from './CardLogText';

export function GameTabLog({ log }: { log: TyrantsState['log'] }) {
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest line in view: on open, and on every append while open.
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  useEffect(() => { if (open) pinToBottom(); }, [open, log.length, pinToBottom]);

  return (
    <details style={{ marginTop: 24 }} open={open}
      onToggle={e => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary style={{ cursor: 'pointer', opacity: 0.7 }}>Log ({log.length})</summary>
      <div style={{ marginTop: 6, fontSize: 11, opacity: 0.55 }}>
        Oldest first — the newest action is at the bottom.
      </div>
      <div ref={scrollRef} style={{
        marginTop: 4, fontSize: 12, opacity: 0.85,
        maxHeight: '40vh', overflowY: 'auto',
        background: '#0c0814', borderRadius: 4, padding: '6px 8px',
      }}>
        {log.length === 0
          ? <div style={{ opacity: 0.5 }}>(no log entries yet)</div>
          : log.map((entry, i) => (
            <div key={i} style={{ padding: '1px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {/* Legacy saves may still hold plain strings — logLineText handles both. */}
              <CardLogText line={logLineText(entry)} />
            </div>
          ))}
      </div>
    </details>
  );
}
