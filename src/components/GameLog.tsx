// Game log + state-codec viewer/loader.
// Lists every turn captured so far (snapshot + log lines) and offers a paste box for
// rewinding to an arbitrary saved state.

import { useState } from 'react';
import type { TyrantsState } from '../game';
import { CardLogText } from './CardLogText';

interface Props {
  G: TyrantsState;
  onLoad: (codec: string) => void;
}

type TurnLog = TyrantsState['turnLogs'][number];
type Snapshot = TyrantsState['snapshots'][number];

export function GameLog({ G, onLoad }: Props) {
  const [pasted, setPasted] = useState('');
  const [expandedTurn, setExpandedTurn] = useState<number | null>(null);
  // Rewind needs snapshots, which redaction strips online. No snapshots at all
  // means the whole load-a-codec affordance is meaningless here, so hide it
  // rather than offering a box that can never do anything.
  const canRewind = G.snapshots.length > 0;

  // List the UNION of turns we know about, from either source.
  //
  // Neither alone is enough. Snapshots are stripped from every online view by
  // redactState (they're full state codecs, so they'd leak hidden information),
  // so keying on them made this tab permanently empty online — the one place
  // you could review what an opponent did said "no turns recorded yet" forever
  // (reported from BGG: "you are not able to review what happened prior your
  // turn once you click OK"). But turnLogs isn't enough either: the local save
  // codec peels it, so after a page reload a hotseat game has snapshots and no
  // prose, and keying on turnLogs would drop the rewind controls entirely.
  //
  // So: take every turn either side knows about. Prose shows when there is
  // prose; the codec buttons show when there is a snapshot.
  const byTurn = new Map<number, { turn: number; log?: TurnLog; snapshot?: Snapshot }>();
  for (const log of G.turnLogs) byTurn.set(log.turn, { turn: log.turn, log });
  for (const snapshot of G.snapshots) {
    const at = byTurn.get(snapshot.turn);
    if (at) at.snapshot = snapshot;
    else byTurn.set(snapshot.turn, { turn: snapshot.turn, snapshot });
  }
  const entries = [...byTurn.values()].sort((a, b) => b.turn - a.turn);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
  }

  function downloadAll() {
    const payload = {
      exportedAt: new Date().toISOString(),
      log: G.log,
      turnLogs: G.turnLogs,
      snapshots: G.snapshots,
      players: Object.fromEntries(Object.entries(G.players).map(([pid, p]) => [pid, { color: p.color, vp: p.vp }])),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tyrants-log-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ padding: 8 }}>
      <div style={{ marginBottom: 12, fontSize: 12, opacity: 0.85 }}>
        Each entry below is one turn — click one to read what happened. Newest turns first.
        {canRewind && <> The codec is a base64 snapshot of the game at that turn's start:
        copy one, paste it into the box below and click <b>Load</b> to rewind to that state.</>}
      </div>

      {canRewind && <div style={{ marginBottom: 16, display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <textarea
          value={pasted}
          onChange={e => setPasted(e.target.value)}
          placeholder="Paste a codec here to load..."
          rows={3}
          style={{ flex: 1, padding: 6, fontFamily: 'monospace', fontSize: 11, background: '#0c0814', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4 }}
        />
        <button
          onClick={() => {
            if (!pasted.trim()) return;
            if (!confirm('Load this state? Current game progress will be replaced.')) return;
            onLoad(pasted.trim());
            setPasted('');
          }}
          disabled={!pasted.trim()}
          style={{ padding: '8px 16px', background: '#5a3380', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer' }}
        >
          Load state
        </button>
      </div>}

      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
        <div style={{ fontSize: 12, opacity: 0.7, flex: 1 }}>
          {entries.length} turn{entries.length === 1 ? '' : 's'} captured.
        </div>
        <button onClick={downloadAll}
          style={{ fontSize: 12, padding: '4px 10px', background: '#3a2055', color: '#fff', border: 'none', borderRadius: 3, cursor: 'pointer' }}>
          Download full log (JSON)
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {entries.map(({ turn, snapshot, log }) => {
          const isOpen = expandedTurn === turn;
          const who = log ?? snapshot;
          return (
            <div key={turn} style={{ background: '#1a1228', borderRadius: 4, padding: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  onClick={() => setExpandedTurn(isOpen ? null : turn)}
                  style={{ cursor: 'pointer', fontSize: 13, flex: 1 }}>
                  {isOpen ? '▾' : '▸'} Turn {turn}
                  {who && <> · P{Number(who.playerId) + 1} ({who.color})</>}
                  {log && <span style={{ opacity: 0.6, marginLeft: 8, fontSize: 11 }}>· {log.lines.length} actions</span>}
                </span>
                {snapshot && <>
                  <button onClick={() => copy(snapshot.codec)} style={{ fontSize: 11, padding: '2px 8px' }}>
                    Copy codec
                  </button>
                  <button onClick={() => { if (confirm(`Load turn ${snapshot.turn}? Current progress replaced.`)) onLoad(snapshot.codec); }}
                    style={{ fontSize: 11, padding: '2px 8px', background: '#3a2055', color: '#fff', border: 'none', borderRadius: 3 }}>
                    Load
                  </button>
                </>}
              </div>
              {isOpen && (
                <div style={{ marginTop: 8, fontSize: 12 }}>
                  {log ? (<>
                    <div style={{ opacity: 0.7, marginBottom: 4 }}>Actions during this turn:</div>
                    {log.lines.length === 0
                      ? <div style={{ opacity: 0.5 }}>(no actions logged)</div>
                      : log.lines.map((l, i) => <div key={i} style={{ padding: '1px 0', opacity: 0.9 }}><CardLogText line={l} /></div>)
                    }
                  </>) : (
                    <div style={{ opacity: 0.5 }}>(turn in progress, or its actions were not kept in this saved game)</div>
                  )}
                  {snapshot && <details style={{ marginTop: 6 }}>
                    <summary style={{ cursor: 'pointer', fontSize: 11, opacity: 0.6 }}>codec ({snapshot.codec.length} chars)</summary>
                    <pre style={{ marginTop: 4, padding: 6, background: '#0c0814', borderRadius: 3, fontSize: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                      {snapshot.codec}
                    </pre>
                  </details>}
                </div>
              )}
            </div>
          );
        })}
        {entries.length === 0 && <div style={{ opacity: 0.6, fontSize: 12 }}>No turns recorded yet — play a turn to populate.</div>}
      </div>
    </div>
  );
}
