// The online API on John's Linode: server/production.ts in Node, behind the
// Cloudflare tunnel as https://tyrants-api.johnchampaign.com (the Pages
// Function functions/api/[[path]].ts forwards there). No per-request CPU limit
// here, so AI_MAX_STEPS lets one request play a whole AI turn. Bundled to one
// file by `npm run build:api` and shipped by scripts/deploy-api.sh.
//
// Env (/etc/tyrants-api.env on the Linode, never committed): TyrantsEnv —
// SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, RATINGS_INGEST_KEY, SITE_URL,
// AI_MAX_STEPS, optional RESEND_KEY/RESEND_FROM — plus PORT (default 8394).
import { createServer, type IncomingMessage } from 'node:http';
import { handleTyrantsApi, type TyrantsEnv } from './production';

const env = process.env as unknown as TyrantsEnv;
const port = Number(process.env.PORT ?? 8394);
const origin = env.SITE_URL ?? 'https://tyrants-online.pages.dev';

/** Node request → Fetch Request, at the PUBLIC origin so anything that reads
 *  new URL(request.url).origin builds the right links */
async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) headers.append(k, one);
  }
  const chunks: Buffer[] = [];
  if (req.method !== 'GET' && req.method !== 'HEAD') for await (const c of req) chunks.push(c as Buffer);
  return new Request(new URL(req.url ?? '/', origin), {
    method: req.method,
    headers,
    ...(chunks.length ? { body: Buffer.concat(chunks) } : {}),
  });
}

const http = createServer(async (req, res) => {
  try {
    const r = req.url === '/api/health'
      ? new Response(JSON.stringify({ ok: true }), { headers: { 'content-type': 'application/json' } })
      : await handleTyrantsApi(await toRequest(req), env);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    res.writeHead(r.status, headers);
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('tyrants api', req.method, req.url, e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal error' }));
  }
});
http.listen(port, '127.0.0.1', () => console.log(`Tyrants API on 127.0.0.1:${port}, links at ${origin}`));
