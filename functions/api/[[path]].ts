// Cloudflare Pages Function for /api/* — forwards to the online API on John's
// Linode (server/linode.ts, reached through the Cloudflare tunnel), which runs
// server/production.ts in Node.
// Why: Workers' free plan allows 10 ms of CPU per request. The median Tyrants
// request already used ~8 ms, so busy games and AI turns were being killed
// (Cloudflare 1102) — 491 in one evening, Nov 2026 — even with the AI sliced
// into 3-step requests. Waiting on the fetch below costs no CPU.
//
// When the Linode can't be reached at all (the fetch throws, or Cloudflare
// answers 530: the tunnel or its DNS name is down), the request runs here as
// before — still under the CPU limit, but a working game beats a 502. Only
// those two: a 502/504 may have reached the origin, and replaying a submit
// that already landed would apply it twice.
//
// Env (Pages project settings): production.ts's TyrantsEnv, plus optional
//   TYRANTS_API_ORIGIN  where the API runs (default https://tyrants-api.johnchampaign.com);
//                       'local' runs every request here again — the rollback.

import { handleTyrantsApi, type TyrantsEnv } from '../../server/production';

interface Env extends TyrantsEnv {
  TYRANTS_API_ORIGIN?: string;
}

const API_ORIGIN = 'https://tyrants-api.johnchampaign.com';

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  if (env.TYRANTS_API_ORIGIN === 'local') return handleTyrantsApi(request, env);
  const url = new URL(request.url);
  const target = new URL(url.pathname + url.search, env.TYRANTS_API_ORIGIN || API_ORIGIN);
  const fallback = request.clone();
  try {
    const r = await fetch(new Request(target, request));
    if (r.status !== 530) return r;
  } catch { /* unreachable: fall through */ }
  return handleTyrantsApi(fallback, env);
};
