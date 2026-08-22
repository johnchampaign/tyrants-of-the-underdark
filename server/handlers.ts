// Platform-agnostic API router for Tyrants online multiplayer. Both the Vite
// dev middleware (FsStore) and the Cloudflare Pages Function (SupabaseStore)
// build a GameServer and call this. Keeping routing in one place is what makes
// local dev and production true parity — only the store/notifier differs.
//
// KEY DIFFERENCE from the tic-tac-toe example: createGame accepts a player
// count (2-4) and builds the full boardgame.io initial state for it via the
// adapter's initialBgioState (boardgame.io's InitializeGame under the hood).
// The seats are the bgio seat-index strings '0'..'3'.

import type { GameServer, ReportSubmission, SnapshotStore } from 'digital-boardgame-framework/server';
import type { Codec, PlayerController } from 'digital-boardgame-framework';
import { sweepAbandonedSeats } from './sweep';
import type { BgioState, TyrantsAction, PlayerId } from '../src/adapter/tyrantsAdapter';
import { initialBgioState } from '../src/adapter/tyrantsAdapter';
import { isHalfDeck } from '../src/half-decks';
import { SELECTABLE_COLORS, type Color } from '../src/game';

export interface ApiResult {
  status: number;
  body: unknown;
}

type Server = GameServer<BgioState, TyrantsAction, PlayerId>;

// Map known framework error strings to HTTP status codes.
function errToStatus(message: string): number {
  if (message.includes('not found')) return 404;
  if (message.includes('Invalid token')) return 401;
  if (message.includes('Not your turn')) return 403;
  if (message.includes('Illegal action')) return 422;
  if (message.includes('No snapshot')) return 404;
  if (message.includes('already exists')) return 409; // ConflictError (concurrent write)
  return 500;
}

// Per the rulebook: 2P = center only, 3P = center + one outer, 4P = all three.
function activeSectionsFor(numPlayers: number): Array<'left' | 'center' | 'right'> {
  if (numPlayers <= 2) return ['center'];
  if (numPlayers === 3) return ['center', 'left'];
  return ['left', 'center', 'right'];
}

/** Extra wiring the sweep needs but the plain request routes don't: it reads
 *  and decodes snapshots directly, which the GameServer keeps private. Optional
 *  so existing callers (and the chat test harness) are unaffected — without it
 *  the sweep route simply reports itself unavailable rather than 500ing. */
export interface SweepDeps {
  store: SnapshotStore;
  codec: Codec<BgioState>;
  controllers: Record<string, PlayerController<BgioState, TyrantsAction, PlayerId>>;
}

export async function handleApi(
  server: Server,
  method: string,
  pathname: string,
  query: URLSearchParams,
  body: unknown,
  sweepDeps?: SweepDeps,
): Promise<ApiResult> {
  const segs = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  if (segs[0] !== 'api') return { status: 404, body: { error: 'not found' } };

  const token = query.get('as') ?? '';

  try {
    // ---- games ----
    if (segs[1] === 'games') {
      // POST /api/games  → create. Body: { numPlayers: 2..4, ai?: { <seat>: difficulty } }
      // When `ai` is present, those seats are SERVER-DRIVEN rated AI opponents
      // (framework >=0.37). E.g. { numPlayers: 2, ai: { '1': 'random' } } makes a
      // human-vs-AI game: seat '0' is the human, seat '1' the AI.
      if (segs.length === 2 && method === 'POST') {
        const b = (body ?? {}) as {
          numPlayers?: unknown; ai?: Partial<Record<PlayerId, string>>;
          halfDecks?: unknown; humanColor?: unknown;
        };
        const raw = b.numPlayers;
        const numPlayers = Math.trunc(Number(raw ?? 2));
        if (!Number.isFinite(numPlayers) || numPlayers < 2 || numPlayers > 4) {
          return { status: 422, body: { error: 'numPlayers must be 2, 3, or 4' } };
        }
        // Market half-decks. Until these were accepted here, every online game
        // fell through to the engine default pair, so elemental / demons / the
        // expansion decks had never been playable online at all.
        const rawDecks = Array.isArray(b.halfDecks) ? b.halfDecks : undefined;
        let halfDecks: string[] | undefined;
        if (rawDecks) {
          if (rawDecks.length !== 2 || !rawDecks.every(isHalfDeck) || rawDecks[0] === rawDecks[1]) {
            return { status: 422, body: { error: 'halfDecks must be two different half-deck names' } };
          }
          halfDecks = rawDecks as string[];
        }
        // The creator's own colour (seat 0). Everyone else takes the classic
        // four in seat order, exactly as solo/hotseat does.
        let humanColor: Color | undefined;
        if (b.humanColor !== undefined) {
          if (typeof b.humanColor !== 'string' || !(SELECTABLE_COLORS as string[]).includes(b.humanColor)) {
            return { status: 422, body: { error: 'humanColor is not a selectable colour' } };
          }
          humanColor = b.humanColor as Color;
        }
        const players: PlayerId[] = Array.from({ length: numPlayers }, (_, i) => String(i));
        const r = await server.createGame({
          initialState: initialBgioState(numPlayers, {
            activeSections: activeSectionsFor(numPlayers),
            ...(halfDecks ? { halfDecks } : {}),
            ...(humanColor ? { humanColor } : {}),
          }),
          players,
          ...(b.ai ? { ai: b.ai } : {}),
        });
        return { status: 200, body: r };
      }

      const gameId = segs[2];
      if (!gameId) return { status: 404, body: { error: 'not found' } };

      // GET /api/games/:id  → fetch
      if (segs.length === 3 && method === 'GET') {
        return { status: 200, body: await server.fetch(gameId, token) };
      }
      // DELETE /api/games/:id  → end/clean up the game (token-gated)
      if (segs.length === 3 && method === 'DELETE') {
        await server.deleteGame(gameId, token);
        return { status: 200, body: { ok: true } };
      }
      // GET /api/games/:id/legal
      if (segs[3] === 'legal' && method === 'GET') {
        return { status: 200, body: await server.legalActions(gameId, token) };
      }
      // POST /api/games/:id/submit
      if (segs[3] === 'submit' && method === 'POST') {
        const { action, identityToken } = body as { action: TyrantsAction; identityToken?: string };
        // Attribute this seat from the move's identity (idempotent, race-free —
        // turns are sequential). Best-effort: never block the move.
        if (typeof identityToken === 'string' && identityToken) {
          try { await server.claimSeat(gameId, token, identityToken); } catch { /* attribution optional */ }
        }
        return { status: 200, body: await server.submit(gameId, token, action) };
      }
      // POST /api/games/:id/claim  → attach a hub identity to this seat (ranked).
      // Body: { identityToken }. Best-effort from the client's view: a failure
      // just leaves the seat unattributed (casual). Idempotent server-side.
      if (segs[3] === 'claim' && method === 'POST') {
        const identityToken = (body as { identityToken?: unknown }).identityToken;
        if (typeof identityToken !== 'string' || !identityToken) {
          return { status: 422, body: { error: 'identityToken required' } };
        }
        const verified = await server.claimSeat(gameId, token, identityToken);
        return { status: 200, body: { ok: true, playerId: verified.playerId } };
      }
      // POST /api/games/:id/report
      if (segs[3] === 'report' && method === 'POST') {
        return { status: 200, body: await server.report(gameId, token, body as ReportSubmission) };
      }
      // In-game chat (framework messaging). Both are auth-gated by the token and
      // stamp the sender seat server-side; both return the refreshed message list.
      // GET  /api/games/:id/chat  → list
      if (segs[3] === 'chat' && method === 'GET') {
        return { status: 200, body: await server.listMessages(gameId, token) };
      }
      // POST /api/games/:id/chat  → post { body }, returns refreshed list
      if (segs[3] === 'chat' && method === 'POST') {
        const text = (body as { body?: unknown }).body;
        if (typeof text !== 'string' || text.trim() === '') {
          return { status: 422, body: { error: 'message body required' } };
        }
        return { status: 200, body: await server.postMessage(gameId, token, text) };
      }
    }

    // ---- abandoned-seat sweep ----
    //
    // POST /api/sweep — hands a bot the turns of anyone who has stopped playing,
    // so the rest of the table isn't stuck forever. Idempotent and safe to call
    // often: it only acts on seats that have sat on a turn past the window, and
    // a player who comes back simply resets the clock.
    //
    // Left unauthenticated on purpose: it takes no input, exposes no data, and
    // does nothing a caller could steer — the worst a stranger can do is make an
    // already-overdue bot turn happen sooner. Gating it behind a secret would
    // just mean it never actually runs.
    if (segs[1] === 'sweep' && method === 'POST') {
      if (!sweepDeps) return { status: 501, body: { error: 'sweep not wired on this deployment' } };
      const result = await sweepAbandonedSeats({
        server,
        store: sweepDeps.store,
        codec: sweepDeps.codec,
        controllers: sweepDeps.controllers,
      });
      return { status: 200, body: result };
    }

    // ---- reports (public triage) ----
    if (segs[1] === 'reports') {
      // GET /api/reports
      if (segs.length === 2 && method === 'GET') {
        const unresolved = query.get('unresolved') === '1';
        return { status: 200, body: await server.listReports(unresolved ? { unresolved: true } : undefined) };
      }
      // POST /api/reports/:id/resolve
      if (segs[3] === 'resolve' && method === 'POST') {
        const note = (body as { note?: string }).note ?? '';
        await server.resolveReport(segs[2]!, note);
        return { status: 200, body: { ok: true } };
      }
    }

    return { status: 404, body: { error: 'no route', pathname, method } };
  } catch (e) {
    // Surface a legible message. Supabase/PostgREST throw a PLAIN OBJECT
    // ({ message, details, hint, code }), not an Error — String(e) on that is
    // the useless "[object Object]". Pull .message when present, else stringify.
    const message =
      e instanceof Error ? e.message
      : (e && typeof e === 'object')
        ? ((e as { message?: string }).message ?? JSON.stringify(e))
        : String(e);
    return { status: errToStatus(message), body: { error: message } };
  }
}
