// Problem-report modal. Captures a user description + (optionally) the current
// game state and recent log lines, then POSTs to the vite-side endpoint
// `/__report-problem` which either files a GitHub Issue or writes the report
// to disk. Patterned after the Innovation port's BugReportDialog (modal form +
// markdown body + GitHub Issues API).

import { useState } from 'react';
import type { TyrantsState } from '../game';
import type { OnlineReportCategory } from '../App';
import { recordFiledReport } from '../bug-report-tracker';
import { relayBaseUrl } from '../relay-url';
import { logLineText } from '../engine/log';

/** Player-friendly symptom buckets shown only in online mode. The label maps
 *  to a coarse area so triage can route framework-class bugs upstream:
 *  'multiplayer' adds the `area:multiplayer` issue label. */
const ONLINE_CATEGORIES: { value: OnlineReportCategory; label: string }[] = [
  { value: 'game', label: 'Cards, rules, or scoring' },
  { value: 'multiplayer', label: 'Turns, joining, or loading' },
  { value: 'other', label: 'Something else' },
];

interface Props {
  G: TyrantsState;
  ctxInfo: { turn: number; currentPlayer: string; gameover?: unknown };
  config?: { numPlayers: number; halfDecks: string[]; aiStyles: string[] };
  /** Auto-captured page screenshot, base64-encoded PNG without the data-URL
   *  prefix. Captured by App.tsx BEFORE this dialog mounts so it shows the
   *  game state behind the modal, not the modal itself. May be null when
   *  capture failed (CORS taint, etc.); dialog renders fine without it. */
  screenshotBase64?: string | null;
  /** ONLINE only: when provided (set by OnlinePlay via BoardModeContext), the
   *  report is submitted directly to the framework report store (Supabase
   *  dbf_reports, version-tagged via clientBuild) and this dialog shows a
   *  "filed as <id>" confirmation. When undefined (hotseat), submit() runs the
   *  existing GitHub/relay flow unchanged. Returns the framework report id. */
  onlineSubmit?: (
    message: string,
    opts?: { category?: OnlineReportCategory },
  ) => Promise<string>;
  onClose: () => void;
}

interface SubmitResult {
  ok: boolean;
  url?: string;
  number?: number;
  filePath?: string;
  note?: string;
  error?: string;
}

/** GitHub repo to file issues against when no relay is configured (or the
 *  relay submit fails). Kept in sync with the source repo. */
const FALLBACK_REPO = 'johnchampaign/tyrants-of-the-underdark';

/** True when we should expect the relay POST to succeed: either a remote
 *  relay URL is configured, or we're on a dev host where the Vite middleware
 *  at /__report-problem is available. On production GH Pages with no relay
 *  configured, the fetch will hit a 404 / index.html and the JSON parse will
 *  fail — better to surface the GitHub-fallback path immediately. */
function relayAvailable(): boolean {
  // relayBaseUrl() is defined in production (defaults to the public relay) and
  // in dev only when explicitly overridden; otherwise dev relies on the local
  // Vite middleware at /__report-problem.
  if (relayBaseUrl()) return true;
  const host = typeof location !== 'undefined' ? location.hostname : '';
  return host === 'localhost' || host === '127.0.0.1';
}

/** Build a GitHub "new issue" URL with title and body prefilled so the user
 *  can submit the report by hand when the API path is unavailable. Body is
 *  truncated to keep the URL under GitHub's practical limit (~8KB). */
function githubIssueUrl(args: {
  description: string;
  expected?: string;
  meta: Record<string, unknown>;
  stateSummary?: string;
  logTail?: string[];
}): string {
  const lines: string[] = [];
  lines.push(args.description.trim());
  if (args.expected?.trim()) {
    lines.push('', '**Expected:**', args.expected.trim());
  }
  lines.push('', '**Meta:**', '```json', JSON.stringify(args.meta, null, 2), '```');
  if (args.stateSummary) {
    lines.push('', '**State (truncated):**', '```json', args.stateSummary, '```');
  }
  if (args.logTail && args.logTail.length) {
    lines.push('', '**Recent log:**', '```', ...args.logTail, '```');
  }
  // Keep the body to ~6000 chars after URL-encoding overhead. Encoded
  // length is roughly 3x for JSON, so target ~2000 chars of raw text.
  let body = lines.join('\n');
  const MAX = 2000;
  if (body.length > MAX) {
    body = body.slice(0, MAX) + '\n\n…[truncated — paste full state in a comment after creating the issue]';
  }
  const title = args.description.trim().slice(0, 80).replace(/\s+/g, ' ');
  const params = new URLSearchParams({ title, body });
  return `https://github.com/${FALLBACK_REPO}/issues/new?${params.toString()}`;
}

export function ProblemReportDialog({ G, ctxInfo, config, screenshotBase64, onlineSubmit, onClose }: Props) {
  const [description, setDescription] = useState('');
  const [expected, setExpected] = useState('');
  const [includeState, setIncludeState] = useState(true);
  const [includeLog, setIncludeLog] = useState(true);
  // Default on so the screenshot is sent unless the user explicitly opts
  // out (e.g. their screen contains something they don't want public).
  // Disabled entirely when capture failed (screenshotBase64 == null).
  const [includeScreenshot, setIncludeScreenshot] = useState(true);
  const [category, setCategory] = useState<OnlineReportCategory>('game');
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  async function submit() {
    if (!description.trim() || submitting) return;
    setSubmitting(true);
    setResult(null);

    // ONLINE path: submit straight to the framework report store. The server
    // auto-attaches the authoritative game snapshot and version-tags the report
    // via clientBuild (set in OnlinePlay). No GitHub token, no relay, no
    // screenshot/state payload — the snapshot lives server-side. Hotseat
    // (onlineSubmit undefined) skips this and runs the GitHub flow below.
    if (onlineSubmit) {
      try {
        const expectedSuffix = expected.trim()
          ? `\n\nExpected: ${expected.trim()}`
          : '';
        const reportId = await onlineSubmit(description.trim() + expectedSuffix, { category });
        // Single write: the server stored the report (with this exact game
        // state) and forwards it to the issue tracker server-side.
        setResult({
          ok: true,
          note: `Thanks — filed as ${reportId}. We saved this exact game state so we can replay it.`,
        });
      } catch (err) {
        setResult({ ok: false, error: String(err) });
      } finally {
        setSubmitting(false);
      }
      return;
    }

    // The state we attach is a slim view (full G is huge). The base64 codec of
    // the most recent turn-start snapshot is the most useful single artifact:
    // it lets the dev replay from the exact turn the bug happened on.
    const latestSnapshot = G.snapshots[G.snapshots.length - 1];
    const state = includeState ? {
      latestSnapshotCodec: latestSnapshot?.codec,
      latestSnapshotTurn: latestSnapshot?.turn,
      latestSnapshotPlayer: latestSnapshot?.playerId,
      pendingChoice: G.pendingChoice,
      pausedHandlerState: G.pausedHandlerState,
      players: Object.fromEntries(Object.entries(G.players).map(([pid, p]) => [pid, {
        color: p.color, vp: p.vp, power: p.power, influence: p.influence,
        barracksLeft: p.barracksLeft, hand: p.hand.map(c => c.name),
        deckSize: p.deck.length, discardSize: p.discard.length,
        innerCircleSize: p.innerCircle.length, trophyHall: p.trophyHall,
      }])),
      troops: Object.fromEntries(Object.entries(G.troops).filter(([, v]) => v != null)),
      spies: Object.fromEntries(Object.entries(G.spies).filter(([, arr]) => arr.length > 0)),
      siteControl: Object.fromEntries(Object.entries(G.siteControl).filter(([, v]) => v != null)),
      controlMarkers: Object.fromEntries(Object.entries(G.controlMarkers).filter(([, m]) => m.holder != null)),
      // Image-retry diagnostics: stamped by the Card component every time
      // an <img> errors or loads with naturalWidth=0. Helps us tell whether
      // the retry escalation is firing during iPad image-cache bug reports.
      imageRetryLog: (() => {
        try {
          const raw = localStorage.getItem('totu.img-retry-log');
          return raw ? JSON.parse(raw) : [];
        } catch { return null; }
      })(),
    } : undefined;

    const meta = {
      userAgent: navigator.userAgent,
      turn: ctxInfo.turn,
      currentPlayer: ctxInfo.currentPlayer,
      gameover: ctxInfo.gameover ?? null,
      ...(config && {
        numPlayers: config.numPlayers,
        halfDecks: config.halfDecks,
        aiStyles: config.aiStyles,
      }),
    };

    // No relay configured AND we're not running on a dev host where the
    // /__report-problem Vite middleware would catch it: skip the fetch
    // entirely and open a GitHub Issues page with the report prefilled.
    // The user submits the issue themselves (one click, requires being
    // logged in to GitHub). This is the fallback that lets iPad / static-
    // hosting users file bugs without any backend.
    if (!relayAvailable()) {
      const url = githubIssueUrl({
        description: description.trim(),
        expected: expected.trim(),
        meta,
        stateSummary: includeState && state ? JSON.stringify(state, null, 2).slice(0, 1500) : undefined,
        logTail: includeLog ? G.log.slice(-20).map(logLineText) : undefined,
      });
      window.open(url, '_blank', 'noopener');
      setResult({
        ok: true,
        url,
        note: 'Opened a prefilled GitHub Issues tab. Sign in to GitHub and click "Submit new issue" to complete.',
      });
      setSubmitting(false);
      return;
    }

    // Relay path: POST to either the configured Cloudflare Worker
    // (production) or the Vite middleware at /__report-problem (dev).
    const relayUrl = relayBaseUrl();
    const submitUrl = relayUrl ? `${relayUrl}/problem-report` : '/__report-problem';

    try {
      const resp = await fetch(submitUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          expected: expected.trim() || undefined,
          includeState,
          includeLog,
          state,
          log: includeLog ? G.log : undefined,
          meta,
          screenshot: includeScreenshot && screenshotBase64 ? screenshotBase64 : undefined,
        }),
      });
      const data = (await resp.json().catch(() => null)) as SubmitResult | null;
      if (data && typeof data === 'object' && 'ok' in data) {
        setResult(data);
        // Stash the issue number locally so the next app load can poll the
        // relay for a "fix note" comment and pop the thank-you modal once
        // this report is resolved. Only fires on relay-success (the GitHub-
        // redirect fallback below doesn't yield a number we can track).
        if (data.ok && typeof data.number === 'number') {
          recordFiledReport({
            number: data.number,
            title: description.trim().slice(0, 80),
          });
        }
      } else {
        // Relay responded but body wasn't JSON (e.g. GH Pages 404 HTML).
        // Fall back to the GitHub URL path so the user has a working route.
        const url = githubIssueUrl({
          description: description.trim(),
          expected: expected.trim(),
          meta,
          stateSummary: includeState && state ? JSON.stringify(state, null, 2).slice(0, 1500) : undefined,
          logTail: includeLog ? G.log.slice(-20).map(logLineText) : undefined,
        });
        window.open(url, '_blank', 'noopener');
        setResult({
          ok: true,
          url,
          note: 'Relay returned an unexpected response, so we opened a prefilled GitHub Issues tab instead. Sign in to GitHub and click "Submit new issue" to complete.',
        });
      }
    } catch (err) {
      setResult({ ok: false, error: String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      width: '100vw', height: '100dvh', background: 'rgba(0,0,0,0.7)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 2000,
    }}>
      <div style={{
        background: '#1a1228', color: '#e6e1f2',
        border: '2px solid #3a2055', borderRadius: 6,
        padding: 24, width: 560, maxWidth: '95vw', maxHeight: '90vh', overflowY: 'auto',
      }}>
        <h2 style={{ marginTop: 0 }}>Report a problem</h2>
        <p style={{ fontSize: 12, opacity: 0.75, marginTop: -4 }}>
          Describe what happened. The current game state and recent log lines can be attached
          so the dev can replay the exact situation. Submits a GitHub issue (or saves locally
          if GitHub isn't configured).
        </p>

        <label style={{ display: 'block', marginTop: 12, fontSize: 12, opacity: 0.85 }}>
          What happened? <span style={{ color: '#ff8888' }}>*</span>
        </label>
        <textarea
          value={description}
          onChange={e => setDescription(e.target.value)}
          rows={4}
          placeholder="e.g. I played Spellspinner, picked Return-a-spy + supplant, and the supplant didn't fire at chchitl..."
          autoFocus
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 6,
            background: '#0c0814', color: '#e6e1f2', border: '1px solid #3a2055',
            borderRadius: 4, fontFamily: 'inherit', fontSize: 13, resize: 'vertical',
          }}
        />

        <label style={{ display: 'block', marginTop: 12, fontSize: 12, opacity: 0.85 }}>
          What did you expect to happen? <span style={{ opacity: 0.5 }}>(optional)</span>
        </label>
        <textarea
          value={expected}
          onChange={e => setExpected(e.target.value)}
          rows={2}
          style={{
            width: '100%', boxSizing: 'border-box', marginTop: 4, padding: 6,
            background: '#0c0814', color: '#e6e1f2', border: '1px solid #3a2055',
            borderRadius: 4, fontFamily: 'inherit', fontSize: 13, resize: 'vertical',
          }}
        />

        {/* ONLINE: a coarse symptom bucket. 'Turns, joining, or loading' maps to
            the framework area (area:multiplayer label) so those reports can be
            routed upstream at triage; the rest are game-area by default. */}
        {onlineSubmit && (
          <div style={{ marginTop: 16 }}>
            <label style={{ display: 'block', fontSize: 12, opacity: 0.85, marginBottom: 4 }}>
              What's it about?
            </label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {ONLINE_CATEGORIES.map(c => (
                <button key={c.value} type="button" onClick={() => setCategory(c.value)}
                  style={{
                    padding: '6px 12px', cursor: 'pointer', borderRadius: 4, fontSize: 12,
                    background: category === c.value ? '#5a3380' : '#2a1840',
                    color: '#e6e1f2', border: '1px solid #3a2055',
                  }}>{c.label}</button>
              ))}
            </div>
          </div>
        )}

        {/* Attachment toggles only apply to the hotseat GitHub/relay path. Online
            reports carry the authoritative server snapshot automatically, so
            these checkboxes would be no-ops there — hide them. */}
        {!onlineSubmit && (
          <div style={{ marginTop: 16, display: 'flex', gap: 16, fontSize: 12, flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeState} onChange={e => setIncludeState(e.target.checked)} />
              Include game state (codec + player summary)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
              <input type="checkbox" checked={includeLog} onChange={e => setIncludeLog(e.target.checked)} />
              Include log (last 40 lines)
            </label>
            {screenshotBase64 && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={includeScreenshot} onChange={e => setIncludeScreenshot(e.target.checked)} />
                Include screenshot
              </label>
            )}
          </div>
        )}

        {!onlineSubmit && screenshotBase64 && includeScreenshot && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>Screenshot preview (will be attached):</div>
            <img src={`data:image/png;base64,${screenshotBase64}`} alt="Captured screenshot"
              style={{
                display: 'block', maxWidth: '100%', maxHeight: 200,
                border: '1px solid #3a2055', borderRadius: 4,
              }} />
          </div>
        )}

        {result && (
          <div style={{
            marginTop: 16, padding: 10, borderRadius: 4,
            background: result.ok ? 'rgba(80, 200, 120, 0.15)' : 'rgba(200, 80, 80, 0.15)',
            border: `1px solid ${result.ok ? '#5a9b6f' : '#9b5a5a'}`,
            fontSize: 13,
          }}>
            {result.ok ? (
              <>
                <div><b>Report submitted.</b></div>
                {result.url && (
                  <div style={{ marginTop: 6 }}>
                    Issue: <a href={result.url} target="_blank" rel="noreferrer" style={{ color: '#9bd' }}>{result.url}</a>
                  </div>
                )}
                {result.filePath && (
                  <div style={{ marginTop: 4, opacity: 0.7 }}>Saved locally: <code>{result.filePath}</code></div>
                )}
                {result.note && <div style={{ marginTop: 4, opacity: 0.7 }}>{result.note}</div>}
              </>
            ) : (
              <>
                <div><b>Submission failed.</b></div>
                <div style={{ marginTop: 4, opacity: 0.85, wordBreak: 'break-word' }}>{result.error}</div>
                {result.filePath && (
                  <div style={{ marginTop: 4, opacity: 0.7 }}>Saved locally anyway: <code>{result.filePath}</code></div>
                )}
              </>
            )}
          </div>
        )}

        <div style={{ marginTop: 20, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onClose} disabled={submitting}
            style={{ padding: '8px 16px', background: '#2a1840', color: '#e6e1f2', border: '1px solid #3a2055', borderRadius: 4, cursor: submitting ? 'not-allowed' : 'pointer' }}>
            {result?.ok ? 'Close' : 'Cancel'}
          </button>
          {!result?.ok && (
            <button onClick={submit} disabled={!description.trim() || submitting}
              style={{
                padding: '8px 16px', background: '#5a3380', color: '#fff',
                border: 'none', borderRadius: 4,
                cursor: !description.trim() || submitting ? 'not-allowed' : 'pointer',
                opacity: !description.trim() || submitting ? 0.5 : 1,
              }}>
              {submitting ? 'Submitting…' : 'Submit'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
