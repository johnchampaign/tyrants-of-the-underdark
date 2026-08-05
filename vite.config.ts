import { defineConfig, loadEnv, type Plugin, type Connect } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { GameServer, NoopNotifier, verifyIdentityToken, type Jwks } from 'digital-boardgame-framework/server';
import { versionStamp } from 'digital-boardgame-framework/vite';
import { FsStore } from 'digital-boardgame-framework/server/node';
import { tyrantsAdapter, type BgioState, type TyrantsAction, type PlayerId } from './src/adapter/tyrantsAdapter';
import { handleApi } from './server/handlers';
import { snapshotCodec } from './src/online/snapshotCodec';
import { GitHubIssueForwarder } from './src/online/githubIssueForwarder';
import { tyrantsControllers } from './src/online/aiControllers';

// Dev API for online multiplayer: the same handleApi router the Cloudflare
// Function uses, backed by FsStore + NoopNotifier so local dev needs no cloud
// accounts. Snapshots land in .dev-store/. This is ADDITIVE — it coexists with
// the existing liveLogPlugin and only intercepts /api/* requests. FsStore
// (node:fs) is fine here: this code only ever runs in the Vite dev server.
function onlineApiPlugin(): Plugin {
  const store = new FsStore('./.dev-store');
  let jwks: Jwks | undefined; let jwksAt = 0;
  const getJwks = async (): Promise<Jwks> => {
    if (!jwks || Date.now() - jwksAt > 3_600_000) {
      jwks = (await (await fetch('https://games-hub-5vo.pages.dev/id/jwks')).json()) as Jwks;
      jwksAt = Date.now();
    }
    return jwks;
  };
  function makeServer(origin: string) {
    return new GameServer<BgioState, TyrantsAction, PlayerId>({
      adapter: tyrantsAdapter,
      codec: snapshotCodec(),
      store,
      // Dev parity: same server-driven AI controllers as the Pages Function.
      aiControllers: tyrantsControllers,
      notifier: new NoopNotifier(),
      // Dev parity: verify hub identity tokens for claimSeat. Ratings auto-report
      // is left OFF in dev (no ingest key) so local games don't hit the real
      // leaderboard.
      verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
      // Dev parity: forward to the LOCAL /__report-problem middleware (files a
      // GitHub issue if TOTU_BUGREPORT_TOKEN/REPO are set, else writes to disk).
      // No GitHub token needed on the Pages project.
      forwarder: new GitHubIssueForwarder({ endpoint: `${origin}/__report-problem` }),
      gameUrl: (id, token) => `${origin}/play/${id}?as=${token}`,
      // Best-effort play counter (dev parity with the Pages Function).
      playBeacon: { appId: 'tyrants' },
    });
  }
  return {
    name: 'totu-online-api',
    configureServer(server: { middlewares: Connect.Server }) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url || !req.url.startsWith('/api/')) return next();

        const origin = `http://${req.headers.host ?? 'localhost:5173'}`;
        const url = new URL(req.url, origin);

        let body: unknown = undefined;
        if (req.method === 'POST') {
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const raw = Buffer.concat(chunks).toString('utf8');
          try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
        }

        const result = await handleApi(
          makeServer(origin),
          req.method ?? 'GET',
          url.pathname,
          url.searchParams,
          body,
        );
        res.statusCode = result.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result.body));
      });
    },
  };
}

/** Best-effort git short SHA injected as __AI_VERSION__ at build time so
 *  every game log published from this build is stamped with the exact code
 *  that produced it. Falls back to 'unknown' if git isn't available
 *  (e.g. building from a tarball or in a CI without checkout). */
function readGitSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

// Dev-only middleware: the running app POSTs its log/snapshots JSON to
// /__save-log on every state change. The handler writes it to a known path
// (training-logs/live.json) so the developer (or an assistant) can read the
// current game state without manual copy/paste.
function liveLogPlugin(): Plugin {
  return {
    name: 'live-log-writer',
    configureServer(server) {
      const outDir = path.resolve(__dirname, 'training-logs');
      const outFile = path.join(outDir, 'live.json');
      mkdirSync(outDir, { recursive: true });
      const clicksFile = path.join(outDir, 'clicks.jsonl');
      server.middlewares.use('/__log-click', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            JSON.parse(body); // validate
            appendFileSync(clicksFile, body + '\n');
            res.statusCode = 204; res.end();
          } catch (err) {
            res.statusCode = 400; res.end(String(err));
          }
        });
      });
      // Problem-report endpoint. Accepts a JSON payload from the in-game
      // "Report a problem" dialog and either:
      //   - Files a GitHub Issue against the configured repo (when both
      //     TOTU_BUGREPORT_TOKEN and TOTU_BUGREPORT_REPO env vars are set), or
      //   - Falls back to writing the report to disk under
      //     training-logs/problem-reports/<timestamp>.json so the user doesn't
      //     lose feedback when GitHub isn't configured.
      // Returns { ok: true, url? , filePath? } as JSON.
      const reportsDir = path.join(outDir, 'problem-reports');
      mkdirSync(reportsDir, { recursive: true });
      const token = process.env.TOTU_BUGREPORT_TOKEN;
      const repo = process.env.TOTU_BUGREPORT_REPO; // e.g. "johnchampaign/tyrants-of-the-underdark"
      server.middlewares.use('/__report-problem', async (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', async () => {
          let body: {
            description: string;
            expected?: string;
            includeState?: boolean;
            includeLog?: boolean;
            state?: unknown;
            // Structured log-format v2 entries or legacy prose strings — the
            // dev path mirrors the Worker and renders both (see worker/src/index.ts).
            log?: Array<string | { msg?: string; kind?: string }>;
            meta?: Record<string, unknown>;
            labels?: string[];
          };
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch { res.statusCode = 400; res.end('bad json'); return; }

          const description = (body.description || '').trim();
          if (!description) { res.statusCode = 400; res.end('empty description'); return; }

          const title = description.split('\n')[0].slice(0, 80) || 'Problem report';
          const sections: string[] = [`**What happened**\n\n${description}`];
          if (body.expected?.trim()) sections.push(`**What I expected**\n\n${body.expected.trim()}`);
          if (body.meta) {
            const metaLines = Object.entries(body.meta).map(([k, v]) => `- ${k}: \`${JSON.stringify(v)}\``);
            sections.push(`**Build / context**\n\n${metaLines.join('\n')}`);
          }
          if (body.includeLog && body.log?.length) {
            const tail = body.log.slice(-40)
              .map(e => (typeof e === 'string' ? e : (e?.msg ?? e?.kind ?? JSON.stringify(e))))
              .join('\n');
            sections.push(`**Last ${Math.min(40, body.log.length)} log lines**\n\n\`\`\`\n${tail}\n\`\`\``);
          }
          if (body.includeState && body.state) {
            // Keep the long base64 codec out of the JSON block so a size cut
            // can never leave behind unparseable JSON (see the Worker for the
            // full rationale).
            const st = body.state as Record<string, unknown>;
            const codec = typeof st?.latestSnapshotCodec === 'string' ? st.latestSnapshotCodec : null;
            const rest = codec ? { ...st, latestSnapshotCodec: undefined } : body.state;
            const summaryJson = JSON.stringify(rest, null, 2);
            const summary = summaryJson.length > 15000
              ? summaryJson.slice(0, 15000) + '\n…(summary truncated)'
              : summaryJson;
            sections.push(`**Game state**\n\n\`\`\`json\n${summary}\n\`\`\``);
            if (codec) {
              const room = 60000 - sections.join('\n\n---\n\n').length - 300;
              if (room < 1000) {
                sections.push('**Snapshot codec** (`latestSnapshotCodec`, base64)\n\n(omitted — no room left in the issue body)');
              } else if (room >= codec.length) {
                sections.push(`**Snapshot codec** (\`latestSnapshotCodec\`, base64)\n\n\`\`\`\n${codec}\n\`\`\``);
              } else {
                const kept = codec.slice(0, room - (room % 4));
                sections.push(
                  '**Snapshot codec** (`latestSnapshotCodec`, base64)\n\n'
                  + `_Truncated: ${kept.length} of ${codec.length} chars. The prefix still decodes._\n\n`
                  + `\`\`\`\n${kept}\n\`\`\``);
              }
            }
          }
          const issueBody = sections.join('\n\n---\n\n');

          // Always also write to disk for safety.
          const stamp = new Date().toISOString().replace(/[:.]/g, '-');
          const filePath = path.join(reportsDir, `report-${stamp}.json`);
          writeFileSync(filePath, JSON.stringify({
            title, description, expected: body.expected, meta: body.meta,
            log: body.log, state: body.state, writtenAt: new Date().toISOString(),
          }, null, 2));

          if (!token || !repo) {
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              ok: true,
              filePath: path.relative(__dirname, filePath),
              note: 'GitHub not configured (TOTU_BUGREPORT_TOKEN / TOTU_BUGREPORT_REPO unset). Report saved locally.',
            }));
            return;
          }

          try {
            const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
              method: 'POST',
              headers: {
                'Accept': 'application/vnd.github+json',
                'Authorization': `Bearer ${token}`,
                'X-GitHub-Api-Version': '2022-11-28',
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                title,
                body: issueBody,
                labels: Array.from(new Set([
                  'bug', 'from-game',
                  ...((Array.isArray(body.labels) ? body.labels : [])
                    .filter((l): l is string => typeof l === 'string' && l.length > 0 && l.length <= 50)),
                ])),
              }),
            });
            if (!resp.ok) {
              const text = await resp.text();
              res.statusCode = 502;
              res.setHeader('content-type', 'application/json');
              res.end(JSON.stringify({
                ok: false,
                error: `GitHub ${resp.status}: ${text.slice(0, 400)}`,
                filePath: path.relative(__dirname, filePath),
              }));
              return;
            }
            const issue = await resp.json() as { html_url: string; number: number };
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              ok: true,
              url: issue.html_url,
              number: issue.number,
              filePath: path.relative(__dirname, filePath),
            }));
          } catch (err) {
            res.statusCode = 502;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              ok: false,
              error: String(err),
              filePath: path.relative(__dirname, filePath),
            }));
          }
        });
      });

      // Local fallback for the auto-publish flow on ctx.gameover. When the
      // client hasn't set VITE_TOTU_RELAY_URL, completed games land here on
      // disk instead of being pushed to the public logs/ repo. Writes one
      // JSON file per game into training-logs/published-locally/.
      const publishLocallyDir = path.join(outDir, 'published-locally');
      mkdirSync(publishLocallyDir, { recursive: true });
      server.middlewares.use('/__publish-game-log', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const filePath = path.join(publishLocallyDir, `${body.source || 'game'}-${stamp}.json`);
            writeFileSync(filePath, JSON.stringify(body, null, 2));
            res.statusCode = 200;
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({
              ok: true,
              filePath: path.relative(__dirname, filePath),
              note: 'VITE_TOTU_RELAY_URL unset — game saved locally.',
            }));
          } catch (err) {
            res.statusCode = 400; res.end(String(err));
          }
        });
      });

      server.middlewares.use('/__save-log', (req, res) => {
        if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
        const chunks: Buffer[] = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            // Validate it parses; rewrite pretty.
            const parsed = JSON.parse(body);
            writeFileSync(outFile, JSON.stringify(parsed, null, 2));
            res.statusCode = 204;
            res.end();
          } catch (err) {
            res.statusCode = 400;
            res.end(String(err));
          }
        });
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  // Load .env (and .env.<mode>) into process.env so the bug-report middleware
  // can see TOTU_BUGREPORT_TOKEN / TOTU_BUGREPORT_REPO at runtime. Vite's
  // default behavior only exposes VITE_-prefixed vars to the client, which we
  // explicitly don't want for the token. The third arg `''` disables the
  // VITE_ prefix filter so we get every var defined in the .env files.
  const env = loadEnv(mode, process.cwd(), '');
  for (const k of Object.keys(env)) {
    if (process.env[k] === undefined) process.env[k] = env[k];
  }
  return {
    // The canonical deployment is Cloudflare Pages (tyrants-online), which
    // serves the app at root, so the base is '/'. (GitHub Pages, which served
    // under /<repo-name>/, is retired — it now only publishes a redirect.)
    // Override with VITE_BASE_PATH if you ever deploy under a sub-path again.
    base: mode === 'production' ? (env.VITE_BASE_PATH || '/') : '/',
    // versionStamp: emit dist/version.json stamped with the same git SHA as
    // __AI_VERSION__, so the in-app <UpdateBanner> can detect new deploys.
    plugins: [react(), liveLogPlugin(), onlineApiPlugin(), versionStamp({ buildId: readGitSha() })],
    server: { port: 5173, open: false },
    // dedupe react/react-dom so the file-linked framework (built against React 18)
    // shares THIS app's single React 19 copy. Without this there are two React
    // instances and framework hooks (useGame) throw "Cannot read properties of
    // null (reading 'useState')".
    resolve: { alias: { '@': path.resolve(__dirname, 'src') }, dedupe: ['react', 'react-dom'] },
    publicDir: 'assets',
    // Stamp build-time identity into the bundle. Game logs include this in
    // their `aiVersion` field so we can later correlate strategic behavior
    // to specific code versions. JSON.stringify wraps in quotes so the
    // define replaces a literal identifier with a string literal at parse time.
    define: {
      __AI_VERSION__: JSON.stringify(readGitSha()),
      __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    },
  };
});
