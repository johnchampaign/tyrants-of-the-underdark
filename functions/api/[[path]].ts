// Cloudflare Pages Function — production path for the online multiplayer API.
// Catches all /api/* requests and delegates to the same handleApi router the
// Vite dev middleware uses (true dev/prod parity). LOCAL DEV does not use this
// file — it's here for a later manual deploy to a SEPARATE Supabase + Pages
// project. It coexists with the existing worker/ (the GitHub bug-report relay),
// which serves different paths.
//
// NOTE: imports the Workers-SAFE server barrel (no node:fs). FsStore lives at
// digital-boardgame-framework/server/node and is NEVER imported here.

import { GameServer, SupabaseStore, ResendNotifier, NoopNotifier, verifyIdentityToken, type Jwks } from 'digital-boardgame-framework/server';
import { createClient } from '@supabase/supabase-js';
import { tyrantsAdapter, type BgioState, type TyrantsAction, type PlayerId } from '../../src/adapter/tyrantsAdapter';
import { snapshotCodec } from '../../src/online/snapshotCodec';
import { GitHubIssueForwarder } from '../../src/online/githubIssueForwarder';
import { tyrantsControllers } from '../../src/online/aiControllers';
import { handleApi } from '../../server/handlers';

interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  RESEND_KEY?: string;
  RESEND_FROM?: string;
  SITE_URL?: string;
  /** Relay worker base URL (holds GITHUB_TOKEN); its /problem-report files the
   *  issue. Defaults to the public relay so no Pages secret is required. */
  RELAY_URL?: string;
  /** Shared secret matching the hub's RATINGS_INGEST_KEY. When set, finished
   *  games auto-report to the hub's /ratings/record (ranked play). */
  RATINGS_INGEST_KEY?: string;
}

const DEFAULT_RELAY = 'https://tyrants-relay.johnchampaign.workers.dev';
const HUB = 'https://games-hub-5vo.pages.dev';

// Module-scoped caches — persist across requests within a warm isolate.
let _supabase: ReturnType<typeof createClient> | null = null;
let _jwks: Jwks | undefined;
let _jwksAt = 0;

/** Hub public verification keys, fetched once and cached for an hour. */
async function getJwks(): Promise<Jwks> {
  if (!_jwks || Date.now() - _jwksAt > 3_600_000) {
    _jwks = (await (await fetch(`${HUB}/id/jwks`)).json()) as Jwks;
    _jwksAt = Date.now();
  }
  return _jwks;
}

export const onRequest: PagesFunction<Env> = async (ctx) => {
  const { request, env } = ctx;
  const url = new URL(request.url);

  if (!_supabase) {
    _supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);
  }

  const notifier = env.RESEND_KEY
    ? new ResendNotifier({ apiKey: env.RESEND_KEY, from: env.RESEND_FROM ?? 'games@example.com' })
    : new NoopNotifier();

  const site = env.SITE_URL ?? url.origin;
  const relay = (env.RELAY_URL ?? DEFAULT_RELAY).replace(/\/$/, '');
  // Held separately so the abandoned-seat sweep can reach them: it reads and
  // decodes snapshot rows directly, which GameServer keeps private.
  const store = new SupabaseStore(_supabase);
  const codec = snapshotCodec();
  const server = new GameServer<BgioState, TyrantsAction, PlayerId>({
    snapshotHistory: 20,   // cap per-game snapshot history (framework >=0.32)
    adapter: tyrantsAdapter,
    codec,
    store,
    // Server-driven, rated AI opponents (random + single-ply heuristic). The
    // deep-search lookahead AI is deliberately NOT wired here — it would blow
    // the Worker per-move CPU budget. See src/online/aiControllers.ts.
    aiControllers: tyrantsControllers,
    notifier,
    // Server-side report forward: stored report -> relay /problem-report ->
    // GitHub issue. The relay holds the GitHub token; this Function does not.
    forwarder: new GitHubIssueForwarder({ endpoint: `${relay}/problem-report` }),
    gameUrl: (gameId, token) => `${site}/play/${gameId}?as=${token}`,
    // Best-effort play counter: createGame fires an 'online' beacon to the
    // games hub. Never throws or blocks gameplay.
    playBeacon: { appId: 'tyrants' },
    // Ranked play: verify hub identity tokens (claimSeat) against the hub JWKS,
    // and auto-report each finished game to the hub for Glicko-2 ratings.
    verifyIdentity: async (t) => verifyIdentityToken(t, await getJwks()),
    ...(env.RATINGS_INGEST_KEY
      ? { ratings: { game: 'tyrants', ingestKey: env.RATINGS_INGEST_KEY } }
      : {}),
  });

  let body: unknown = undefined;
  if (request.method === 'POST') {
    try { body = await request.json(); } catch { body = {}; }
  }

  const result = await handleApi(server, request.method, url.pathname, url.searchParams, body,
    { store, codec, controllers: tyrantsControllers });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { 'Content-Type': 'application/json' },
  });
};
