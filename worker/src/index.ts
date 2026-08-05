// Tyrants relay — single Cloudflare Worker that routes:
//   POST /problem-report  → creates a GitHub Issue (Issues API)
//   POST /game-log        → SHA256-deduped commit to logs/<hash>.json via Contents API
//
// All GitHub-authenticated calls happen here so the PAT lives only in Worker
// secrets (`GITHUB_TOKEN`). Clients (browser + headless sim) POST plain JSON.
//
// Secrets (set with `wrangler secret put NAME`):
//   GITHUB_TOKEN — fine-grained PAT, Contents + Issues read/write
//   GITHUB_REPO  — "owner/repo" form
//
// Plain vars (in wrangler.toml [vars]):
//   ALLOWED_ORIGIN — CORS Access-Control-Allow-Origin, default "*"

interface Env {
  GITHUB_TOKEN: string;
  GITHUB_REPO: string;
  ALLOWED_ORIGIN?: string;
}

// Game logs and report screenshots are committed to this branch — NOT the
// default (main) — so they never pollute the code history or trigger the
// GitHub Pages deploy. Named to avoid colliding with the logs/ directory.
const LOG_BRANCH = 'game-logs';

// Issue-body budgeting. GitHub hard-caps a body at 65536 chars; stay under it
// with headroom so the codec block below is the only thing that ever gets
// clipped, and clipped on a boundary that still decodes.
const BODY_BUDGET = 60000;
const SUMMARY_BUDGET = 15000;
const SECTION_SEP = '\n\n---\n\n';

/** Prose text for one log entry. The in-game log is a list of framework
 *  log-format v2 entries (objects carrying `msg`), but older clients send
 *  plain strings — accept both. Joining objects directly is what produced a
 *  wall of "[object Object]" in reports and lost the evidence entirely. */
export function logLineText(e: string | { msg?: string; kind?: string } | null | undefined): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') return e.msg ?? e.kind ?? JSON.stringify(e);
  return String(e);
}

/** Split the long base64 snapshot codec out of the state summary so the two
 *  can be size-budgeted (and truncated) independently. */
export function splitSnapshotCodec(state: unknown): { codec: string | null; rest: unknown } {
  if (!state || typeof state !== 'object') return { codec: null, rest: state };
  const rest: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  const raw = rest.latestSnapshotCodec;
  if (typeof raw !== 'string' || raw.length === 0) return { codec: null, rest };
  delete rest.latestSnapshotCodec;
  return { codec: raw, rest };
}

interface ProblemReportPayload {
  description: string;
  expected?: string;
  includeState?: boolean;
  includeLog?: boolean;
  state?: unknown;
  /** Recent log lines. Older clients (and the log-format v2 in-state log) may
   *  send structured entries instead of prose strings, so accept both and
   *  render defensively — a naive join() turns objects into "[object Object]"
   *  and throws away the only evidence a report carries. */
  log?: Array<string | { msg?: string; kind?: string }>;
  meta?: Record<string, unknown>;
  /** Optional auto-captured page screenshot as base64-encoded PNG (no
   *  data-URL prefix). The worker uploads it to screenshots/<sha>.png in
   *  the repo via the Contents API and embeds the raw URL in the issue
   *  body as a markdown image. */
  screenshot?: string;
  /** Optional extra issue labels merged with the base ['bug','from-game'].
   *  Online play sends 'area:multiplayer' for connecting/turn/loading reports
   *  so framework-class bugs are filterable (and routable upstream) at triage. */
  labels?: string[];
}

interface GameLogPayload {
  /** Free-form game record. Whatever the client wants archived. The Worker
   *  treats this opaquely except for hashing. */
  game: unknown;
  /** Optional human-readable label embedded in the commit message (e.g.
   *  "sim:heuristic-vs-random" or "browser-game"). */
  source?: string;
  /** Optional metadata to embed alongside the payload. */
  meta?: Record<string, unknown>;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === 'OPTIONS') return corsResponse(env, 204);

    if (req.method !== 'POST') {
      return jsonResponse(env, { error: 'POST only' }, 405);
    }

    try {
      if (url.pathname === '/problem-report') {
        return await handleProblemReport(req, env);
      }
      if (url.pathname === '/game-log') {
        return await handleGameLog(req, env);
      }
      if (url.pathname === '/report-status') {
        return await handleReportStatus(req, env);
      }
      return jsonResponse(env, { error: `unknown route ${url.pathname}` }, 404);
    } catch (err) {
      return jsonResponse(env, { error: String(err) }, 500);
    }
  },
};

// ---------- /problem-report ----------

async function handleProblemReport(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as ProblemReportPayload;
  const description = (body.description || '').trim();
  if (!description) return jsonResponse(env, { error: 'empty description' }, 400);

  const title = description.split('\n')[0].slice(0, 80) || 'Problem report';
  const sections: string[] = [`**What happened**\n\n${description}`];
  if (body.expected?.trim()) sections.push(`**What I expected**\n\n${body.expected.trim()}`);

  // Upload the auto-captured screenshot first (if any) so we can reference
  // its raw GitHub URL in the issue body. Content-addressable so re-reports
  // of the same view dedup against an existing screenshot. Failures here
  // are non-fatal — the report still files without an image.
  if (body.screenshot && body.screenshot.length > 0) {
    const hash = await sha256Hex(body.screenshot);
    const path = `screenshots/${hash}.png`;
    const ghUrl = `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${path}`;
    // HEAD-style check: GET returns 200 if the file already exists.
    const head = await fetch(`${ghUrl}?ref=${LOG_BRANCH}`, { headers: githubHeaders(env) });
    if (head.status !== 200) {
      const put = await fetch(ghUrl, {
        method: 'PUT',
        headers: githubHeaders(env),
        body: JSON.stringify({
          message: `Screenshot ${hash.slice(0, 12)} (problem report)`,
          content: body.screenshot,
          branch: LOG_BRANCH,
        }),
      });
      if (!put.ok) {
        // 422 / race-condition duplicates: tolerate; otherwise log and
        // continue without the image — the description still files.
        const text = await put.text();
        if (!(put.status === 422 && /sha/i.test(text))) {
          // eslint-disable-next-line no-console
          console.warn(`screenshot upload failed: ${put.status} ${text.slice(0, 200)}`);
        }
      }
    }
    const rawUrl = `https://raw.githubusercontent.com/${env.GITHUB_REPO}/${LOG_BRANCH}/${path}`;
    sections.push(`**Screenshot**\n\n![screenshot](${rawUrl})`);
  }

  if (body.meta) {
    const metaLines = Object.entries(body.meta).map(([k, v]) => `- ${k}: \`${JSON.stringify(v)}\``);
    sections.push(`**Build / context**\n\n${metaLines.join('\n')}`);
  }
  if (body.includeLog && body.log?.length) {
    const tail = body.log.slice(-40).map(logLineText).join('\n');
    sections.push(`**Last ${Math.min(40, body.log.length)} log lines**\n\n\`\`\`\n${tail}\n\`\`\``);
  }
  if (body.includeState && body.state) {
    // The snapshot codec is one very long base64 string; everything else in
    // the state payload is a small summary. Slicing the combined JSON (the
    // old behaviour) cut the codec mid-string, which broke BOTH halves — the
    // block no longer parsed as JSON and the codec no longer decoded. Emit
    // them as separate blocks, each with its own budget.
    const { codec, rest } = splitSnapshotCodec(body.state);
    const summaryJson = JSON.stringify(rest, null, 2);
    const summary = summaryJson.length > SUMMARY_BUDGET
      ? summaryJson.slice(0, SUMMARY_BUDGET) + '\n…(summary truncated)'
      : summaryJson;
    sections.push(`**Game state**\n\n\`\`\`json\n${summary}\n\`\`\``);
    if (codec) {
      // Whatever body budget the sections above left over goes to the codec.
      const room = BODY_BUDGET - sections.join(SECTION_SEP).length - 300;
      if (room < 1000) {
        sections.push('**Snapshot codec** (`latestSnapshotCodec`, base64)\n\n(omitted — no room left in the issue body)');
      } else if (room >= codec.length) {
        sections.push(`**Snapshot codec** (\`latestSnapshotCodec\`, base64)\n\n\`\`\`\n${codec}\n\`\`\``);
      } else {
        // base64 decodes in 4-char groups — cut on a group boundary so the
        // surviving prefix still decodes cleanly.
        const kept = codec.slice(0, room - (room % 4));
        sections.push(
          `**Snapshot codec** (\`latestSnapshotCodec\`, base64)\n\n`
          + `_Truncated: ${kept.length} of ${codec.length} chars. The prefix still decodes._\n\n`
          + `\`\`\`\n${kept}\n\`\`\``);
      }
    }
  }
  const issueBody = sections.join(SECTION_SEP);

  // Base labels + any caller-supplied extras (e.g. 'area:multiplayer' from
  // online play). Sanitize: strings only, deduped, length-capped.
  const extraLabels = Array.isArray(body.labels)
    ? body.labels.filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 50)
    : [];
  const labels = Array.from(new Set(['bug', 'from-game', ...extraLabels]));

  const resp = await fetch(`https://api.github.com/repos/${env.GITHUB_REPO}/issues`, {
    method: 'POST',
    headers: githubHeaders(env),
    body: JSON.stringify({
      title,
      body: issueBody,
      labels,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return jsonResponse(env, { ok: false, error: `GitHub ${resp.status}: ${text.slice(0, 400)}` }, 502);
  }
  const issue = await resp.json() as { html_url: string; number: number };
  return jsonResponse(env, { ok: true, url: issue.html_url, number: issue.number }, 200);
}

// ---------- /report-status ----------
//
// Clients (the in-game app) maintain a localStorage list of issue numbers
// they've filed via /problem-report. On each app load they POST that list
// here and we ask GitHub which of those issues are now closed and have a
// "fix note" comment for the reporter. The dev's workflow is:
//
//   1. App user files a bug → /problem-report opens a GitHub issue.
//   2. Dev investigates, ships a fix.
//   3. Dev posts a comment on the issue whose body starts with the marker
//      `**Fix note:**` (case-insensitive) explaining the cause / fix in
//      user-friendly terms.
//   4. Dev closes the issue.
//   5. Next time the app loads, the user sees a thank-you modal with the
//      explanation. Dismissing it marks it locally as seen so it doesn't
//      pop up again.
//
// The contract intentionally only surfaces CLOSED issues — open issues with
// an in-progress fix note shouldn't pop a "thanks, we fixed it" dialog.

const FIX_NOTE_MARKER_RE = /^\*\*fix note:\*\*\s*/i;

async function handleReportStatus(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as { issueNumbers?: number[] };
  const requested = Array.isArray(body.issueNumbers)
    ? body.issueNumbers.filter(n => typeof n === 'number' && Number.isFinite(n)).slice(0, 50)
    : [];
  const updates: Array<{
    number: number;
    title: string;
    fixNote: string;
    closedAt: string | null;
    commentCreatedAt: string;
    issueUrl: string;
    commentUrl: string;
  }> = [];

  for (const number of requested) {
    // Issue metadata first — cheap, lets us skip comment fetches for issues
    // still open. GitHub returns 404 for repos we can't see; we tolerate it.
    const issueResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${number}`,
      { headers: githubHeaders(env) },
    );
    if (!issueResp.ok) continue;
    const issue = await issueResp.json() as {
      state: string;
      title: string;
      closed_at: string | null;
      html_url: string;
    };
    if (issue.state !== 'closed') continue;

    // Find the first comment that starts with the fix-note marker. Listing
    // issues comments returns oldest-first per the GitHub API, which is
    // what we want — if a dev writes multiple fix notes, the first one wins
    // and the rest are just refinements they can include inline.
    const commentsResp = await fetch(
      `https://api.github.com/repos/${env.GITHUB_REPO}/issues/${number}/comments?per_page=100`,
      { headers: githubHeaders(env) },
    );
    if (!commentsResp.ok) continue;
    const comments = await commentsResp.json() as Array<{
      body: string;
      created_at: string;
      html_url: string;
    }>;
    const fixNoteComment = comments.find(c => FIX_NOTE_MARKER_RE.test(c.body ?? ''));
    if (!fixNoteComment) continue;

    const fixNote = fixNoteComment.body.replace(FIX_NOTE_MARKER_RE, '').trim();
    if (!fixNote) continue;

    updates.push({
      number,
      title: issue.title,
      fixNote,
      closedAt: issue.closed_at,
      commentCreatedAt: fixNoteComment.created_at,
      issueUrl: issue.html_url,
      commentUrl: fixNoteComment.html_url,
    });
  }

  return jsonResponse(env, { updates }, 200);
}

// ---------- /game-log ----------

async function handleGameLog(req: Request, env: Env): Promise<Response> {
  const body = await req.json() as GameLogPayload;
  if (!body.game) return jsonResponse(env, { error: 'missing game payload' }, 400);

  // Hash the *game content* only, so a re-submission of the same game (e.g.,
  // a retry after a network glitch) lands on the same filename and dedups.
  // The published wrapper carries a fresh timestamp every call; including it
  // in the hash would defeat dedup entirely.
  const gameJson = JSON.stringify(body.game);
  const hash = await sha256Hex(gameJson);
  const filename = `${hash.slice(0, 16)}.json`;
  const repoPath = `logs/${filename}`;

  // Existing file with this name → same game already published, no-op.
  const existing = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${repoPath}?ref=${LOG_BRANCH}`,
    { headers: githubHeaders(env) }
  );
  if (existing.status === 200) {
    return jsonResponse(env, {
      ok: true, deduped: true, path: repoPath, hash,
      message: 'already present',
    }, 200);
  }

  // First publish of this content — build the wrapper and PUT it.
  const packaged = {
    publishedAt: new Date().toISOString(),
    source: body.source ?? 'unknown',
    hash,
    meta: body.meta ?? {},
    game: body.game,
  };
  const wrapperJson = JSON.stringify(packaged, null, 2);

  const putResp = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/${repoPath}`,
    {
      method: 'PUT',
      headers: githubHeaders(env),
      body: JSON.stringify({
        message: `log: publish game (${body.source ?? 'unknown'}) ${hash.slice(0, 8)}`,
        content: btoaUtf8(wrapperJson),
        branch: LOG_BRANCH,
      }),
    }
  );

  if (!putResp.ok) {
    const text = await putResp.text();
    return jsonResponse(env, { ok: false, error: `GitHub ${putResp.status}: ${text.slice(0, 400)}` }, 502);
  }
  const result = await putResp.json() as { content?: { html_url?: string; download_url?: string } };
  return jsonResponse(env, {
    ok: true,
    deduped: false,
    path: repoPath,
    hash,
    htmlUrl: result.content?.html_url,
    downloadUrl: result.content?.download_url,
  }, 200);
}

// ---------- helpers ----------

function githubHeaders(env: Env): Record<string, string> {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'tyrants-relay',
  };
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN ?? '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(env: Env, payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(env) },
  });
}

function corsResponse(env: Env, status: number): Response {
  return new Response(null, { status, headers: corsHeaders(env) });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function btoaUtf8(text: string): string {
  // btoa requires ASCII; UTF-8 encode first.
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
