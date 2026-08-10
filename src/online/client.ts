// Browser-side API client for online multiplayer. Imports ONLY from the
// framework's /client and the adapter types — never /server. The browser
// bundle must not pull in the server barrel (node:fs).

import type { GameClientApi, MessagingClientApi } from 'digital-boardgame-framework/client';
import type { BgioState, TyrantsAction, PlayerId } from '../adapter/tyrantsAdapter';
import { AI_VERSION } from '../ai-version';

const delay = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

/** AbortSignal that fires after `ms`. Hand-rolled (vs AbortSignal.timeout) so
 *  the caller can clear the timer once the request settles. */
function timeoutSignal(ms: number): { signal: AbortSignal; clear: () => void } {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException('request deadline exceeded', 'TimeoutError')), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

/** Capture an anomalous API response (HTML where JSON was expected, or a 5xx)
 *  into a small localStorage ring buffer + the console, so a recurrence of the
 *  "weird error message" lock (#89) is definitively recorded. The `cf-ray`
 *  lets the maintainer correlate the exact request with Cloudflare's logs; the
 *  build stamp shows whether the client was stale. Best-effort — never throws. */
function logApiAnomaly(entry: Record<string, unknown>): void {
  try {
    const KEY = 'totu.api-anomaly-log';
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as unknown[]) : [];
    arr.push({ ...entry, clientBuild: AI_VERSION });
    if (arr.length > 30) arr.splice(0, arr.length - 30);
    localStorage.setItem(KEY, JSON.stringify(arr));
  } catch { /* localStorage full / unavailable — non-fatal */ }
  try { console.warn('[totu api anomaly]', { ...entry, clientBuild: AI_VERSION }); } catch { /* ignore */ }
}

/** Fetch an /api endpoint expecting JSON, resilient to the transient windows
 *  (a mid-deploy SPA-fallback, a Cloudflare Function cold-start, a Supabase
 *  blip) where a request briefly gets HTML / a 5xx / a dropped connection
 *  instead of reaching a healthy Function. Two failure classes, handled
 *  differently by side-effect safety:
 *
 *   - IDEMPOTENT reads (state poll, legal actions, chat list) have no side
 *     effect, so a transient failure of ANY kind — HTML, 5xx, or a network
 *     throw — is safe to retry hard. We back off across several attempts so a
 *     blip is absorbed inside the single call and the player never sees a
 *     scary banner for a hiccup that self-heals a second later.
 *   - NON-IDEMPOTENT writes (submit, report, claim) might have applied
 *     server-side before failing, so a blind retry could double-apply. We only
 *     retry the HTML case — an HTML body proves the request got the SPA
 *     fallback and never hit the Function, so it had no side effect.
 *
 *  Every anomaly (HTML or 5xx) is captured via logApiAnomaly for diagnosis.
 *
 *  Every attempt also carries a DEADLINE (#102): a request that HANGS (a
 *  stalled connection, a Function stuck on a dead upstream) never resolves and
 *  never rejects, which is worse than failing — useGame pauses polling while a
 *  submit is in flight, so a hung submit froze the whole session with no error,
 *  no retry, and no chance for the server's stranded-AI-turn self-heal to run.
 *  The abort turns a hang into a normal rejection: reads retry, writes surface
 *  the error and useGame re-syncs to the authoritative state (which resumes
 *  polling → the next poll self-heals a stranded AI turn server-side). */
async function apiJson(
  doFetch: (signal: AbortSignal) => Promise<Response>,
  opts: { idempotent?: boolean } = {},
): Promise<any> {
  // Idempotent reads get a backoff ladder (~0/0.4/0.9/1.6/2.6s ≈ 5.5s total),
  // long enough to ride out a deploy or cold-start window. Writes get the
  // single cautious HTML retry only.
  const backoff = opts.idempotent ? [400, 500, 700, 1000] : [800];
  // A state read is NOT always cheap: fetching a game whose AI seat is mid-turn
  // makes the server finish that turn before answering — the exact work the
  // 60s write budget was sized for. Giving the read a shorter deadline meant a
  // slow AI turn was aborted client-side, which kills the Function mid-run, so
  // nothing persisted and the next poll started over: a stall that could never
  // resolve itself, with a frozen board and no button to press (#104). Reads
  // now get the same budget as writes.
  const timeoutMs = 60_000;
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt <= backoff.length; attempt++) {
    const t = timeoutSignal(timeoutMs);
    let r: Response;
    let text: string;
    try {
      r = await doFetch(t.signal);
      text = await r.text(); // body read hangs too on a stalled response — keep it under the deadline
    } catch (netErr: any) {
      // Network-level failure (connection dropped, DNS, offline) or deadline
      // exceeded. No complete response reached us, so a read definitely had no
      // side effect — retry it. A write might have applied server-side, so it
      // surfaces the error instead; useGame re-syncs on submit failure.
      const timedOut = netErr?.name === 'TimeoutError' || netErr?.name === 'AbortError';
      logApiAnomaly({ t: Date.now(), networkError: String(netErr?.message ?? netErr), timedOut, attempt });
      lastErr = new Error(timedOut
        ? 'The server is taking too long to respond. Reconnecting…'
        : 'Lost connection to the server. Reconnecting…');
      // A blown DEADLINE is not a blip to ride out: the server was still working
      // when we gave up, and an immediate retry just starts a second copy of
      // that work competing with the first. The poll loop is the retry — let it
      // come back in a couple of seconds instead. Ordinary network failures
      // (nothing running server-side) still use the ladder.
      if (opts.idempotent && !timedOut && attempt < backoff.length) { await delay(backoff[attempt]); continue; }
      throw lastErr;
    } finally {
      t.clear();
    }

    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (r.ok && data !== null) return data;

    const isHtml = data === null && /^\s*</.test(text);
    // An empty/whitespace body ("Unexpected end of JSON input") means the
    // Function returned nothing — a cold-start / mid-deploy artifact where the
    // request never produced a real response. Like the HTML SPA-fallback case,
    // it proves no complete server-side result, so it's safe to retry even for
    // a write (worst case on a create is one unused game, not a double-apply).
    const isEmpty = data === null && text.trim() === '';
    const noServerResult = isHtml || isEmpty;
    const transient = noServerResult || r.status >= 500;
    if (transient) {
      logApiAnomaly({
        t: Date.now(),
        status: r.status,
        contentType: r.headers.get('content-type'),
        cfRay: r.headers.get('cf-ray'),
        cfCache: r.headers.get('cf-cache-status'),
        isHtml,
        isEmpty,
        bodySnippet: text.slice(0, 80),
        attempt,
      });
      // Reads retry on any transient; writes retry only the cases that prove no
      // complete server-side result (HTML SPA-fallback or an empty body).
      const mayRetry = opts.idempotent ? true : noServerResult;
      if (mayRetry && attempt < backoff.length) { await delay(backoff[attempt]); continue; }
    }

    lastErr = new Error(
      (data && data.error)
        || (noServerResult
          ? 'The server was briefly unavailable. Reconnecting…'
          : `Server error (HTTP ${r.status}). Please reload and try again.`),
    );
    throw lastErr;
  }
  throw lastErr ?? new Error('Server error. Please reload and try again.');
}

export interface Invites {
  gameId: string;
  invites: Record<PlayerId, string>;
}

// Create a new game with a player count (2-4). Returns one invite URL per seat.
// Optional `ai` maps seat ids ('0'..'3') to a difficulty key ('random' |
// 'standard'); those seats become server-driven, rated AI opponents.
export async function createGame(
  numPlayers: number,
  ai?: Partial<Record<PlayerId, string>>,
): Promise<Invites> {
  // Routed through apiJson so a transient blip (empty body / SPA-fallback HTML
  // during a cold-start or mid-deploy) is retried instead of failing instantly
  // with a cryptic "Unexpected end of JSON input". Not marked idempotent — a
  // create has a side effect — but apiJson still retries the no-server-result
  // cases (empty/HTML), which are the ones that didn't reach the Function.
  return apiJson((signal) => fetch('/api/games', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ numPlayers, ...(ai ? { ai } : {}) }),
    signal,
  }));
}

// Lightweight status read for the lobby's "games in progress" list. Returns
// { deleted: true } if the game no longer exists.
export async function fetchStatus(
  gameId: string,
  token: string,
): Promise<
  | { deleted: true }
  | { deleted?: false; yourTurn: boolean; gameOver: boolean; turn: number; you: PlayerId }
> {
  const t = timeoutSignal(20_000);
  let r: Response;
  try {
    r = await fetch(`/api/games/${gameId}?as=${encodeURIComponent(token)}`, { signal: t.signal });
  } finally {
    t.clear();
  }
  if (r.status === 404) return { deleted: true };
  const data: any = await r.json();
  if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
  return data;
}

// End a game server-side (token-gated). 404 is treated as success (already gone).
export async function deleteGame(gameId: string, token: string): Promise<void> {
  const t = timeoutSignal(20_000);
  try {
    const r = await fetch(`/api/games/${gameId}?as=${encodeURIComponent(token)}`, { method: 'DELETE', signal: t.signal });
    if (!r.ok && r.status !== 404) throw new Error(`delete failed: ${r.status}`);
  } finally {
    t.clear();
  }
}

// Attach the player's hub identity to their seat (ranked attribution).
// Best-effort: a failure just leaves the seat unattributed (casual play).
export async function claimSeat(gameId: string, token: string, identityToken: string): Promise<void> {
  const t = timeoutSignal(20_000);
  try {
    await fetch(`/api/games/${gameId}/claim?as=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identityToken }),
      signal: t.signal,
    });
  } catch { /* ignore — ranked attribution is optional */ } finally {
    t.clear();
  }
}

// Per-(game, token) client the useGame hook consumes.
export function makeClient(
  gameId: string, token: string, getIdentityToken?: () => string | undefined,
): GameClientApi<BgioState, TyrantsAction> {
  const base = `/api/games/${gameId}`;
  const q = `?as=${encodeURIComponent(token)}`;
  // COALESCE overlapping state reads. useGame polls on a fixed 2s interval with
  // no in-flight guard, so a fetch that takes longer than the interval (a poll
  // that has to finish a stranded AI turn server-side) stacks up: within 20s a
  // dozen requests are all running the same expensive turn and racing to write
  // the same snapshot, which makes a slow turn slower and can never converge
  // (#104). A state read has no side effect from the caller's point of view, so
  // handing every overlapping caller the same in-flight promise is exact —
  // they'd each have asked for the same thing.
  let inFlight: Promise<any> | null = null;
  const fetchState = (): Promise<any> => {
    if (inFlight) return inFlight;
    const shared: Promise<any> = apiJson(
      (signal) => fetch(`${base}${q}`, { signal }),
      { idempotent: true },
    ).finally(() => { if (inFlight === shared) inFlight = null; });
    inFlight = shared;
    return shared;
  };
  return {
    fetch: fetchState,
    submit: (action) =>
      apiJson((signal) => fetch(`${base}/submit${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, identityToken: getIdentityToken?.() }),
        signal,
      })),
    legalActions: () => apiJson((signal) => fetch(`${base}/legal${q}`, { signal }), { idempotent: true }),
    report: (body) =>
      apiJson((signal) => fetch(`${base}/report${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      })),
  };
}

// In-game chat transport for the framework's ChatPanel/useMessages. Both calls
// hit /api/games/:id/chat (auth-gated by the token; the server stamps the seat)
// and return the refreshed ChatMessage[].
export function makeMessagingClient(gameId: string, token: string): MessagingClientApi {
  const base = `/api/games/${gameId}/chat`;
  const q = `?as=${encodeURIComponent(token)}`;
  return {
    listMessages: () => apiJson((signal) => fetch(`${base}${q}`, { signal }), { idempotent: true }),
    postMessage: (body) =>
      apiJson((signal) => fetch(`${base}${q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body }),
        signal,
      })),
  };
}
