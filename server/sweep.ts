// Abandoned-seat sweep.
//
// Async multiplayer's real failure mode isn't a crash, it's someone quietly
// stopping. Everyone else is then stuck on a turn that never comes, with no
// recourse — the game just sits there. This lets a bot finish that seat so the
// rest of the table can play on.
//
// The obvious way to do that would be to rewrite the seat's identity to the
// framework's `ai:<slug>:<difficulty>` form so its own AI driver picks it up.
// That is exactly wrong here: seat identity is ALSO what the ratings report
// maps through, so overwriting it would erase the walker from the result — and
// abandoning a game you were losing would become the cheapest way to avoid
// recording the loss. Instead we leave identities untouched and play the seat
// ourselves, using the seat's own token. The walker keeps their identity, keeps
// their place in the result, and `forfeitSeat` pins that place to last.
//
// Deliberately idempotent and stateless: re-running is safe, and if the player
// comes back and takes a turn, the clock resets and they simply carry on.
import type { GameServer, SnapshotStore, GameMeta } from 'digital-boardgame-framework/server';
import type { Codec, PlayerController } from 'digital-boardgame-framework';
import { Rng } from 'digital-boardgame-framework';
import type { BgioState, TyrantsAction, PlayerId } from '../src/adapter/tyrantsAdapter';
import { tyrantsAdapter } from '../src/adapter/tyrantsAdapter';

/** How long a seat may sit on its turn before a bot takes over. Async games are
 *  played over days, so this has to be generous — a week is a holiday, not a
 *  walk-out, but two turns in a row at a week each is a dead game. */
export const ABANDON_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

/** Bot difficulty used when finishing an abandoned seat. Deliberately the
 *  weaker of the two: a seat that has forfeited its placing anyway shouldn't
 *  start playing BETTER than the person who left, which would distort the
 *  remaining players' game. */
const TAKEOVER_DIFFICULTY = 'random';

/** Cap the work one sweep will do, so a backlog can't blow a request budget.
 *  Anything left is picked up by the next sweep. */
const MAX_GAMES_PER_SWEEP = 25;
const MAX_MOVES_PER_SEAT = 40;

/** Stored snapshots carry a `v<N>:` schema prefix that the server strips on
 *  read. That splitter is private to the framework, so mirror it here — decoding
 *  a raw row with the bare codec otherwise dies on the prefix. Only the current
 *  schema is handled: an older row is left for the server's own migrate path
 *  rather than half-migrated here. */
const SNAPSHOT_VERSION_RE = /^v(\d+):/;
const SCHEMA_VERSION = tyrantsAdapter.schemaVersion ?? 1;
export function decodeRow(codec: Codec<BgioState>, raw: string, schemaVersion: number): BgioState | null {
  const m = SNAPSHOT_VERSION_RE.exec(raw);
  const version = m ? Number(m[1]) : 1;
  const inner = m ? raw.slice(m[0].length) : raw;
  if (version !== schemaVersion) return null;
  return codec.decode(inner);
}

export interface SweepResult {
  scanned: number;
  /** Seats newly marked as forfeited this sweep. */
  forfeited: number;
  /** Moves played on behalf of abandoned seats. */
  movesPlayed: number;
  /** Games where a takeover was attempted but errored (logged, never thrown). */
  errored: number;
}

/** A seat is human unless the framework recorded it as one of its own AI seats.
 *  Unattributed seats (casual, never signed in) are humans too — they're the
 *  ones most likely to wander off. */
function isHumanSeat(meta: GameMeta, seat: string): boolean {
  const identity = meta.identities?.[seat];
  return !identity || !identity.startsWith('ai:');
}

export async function sweepAbandonedSeats(opts: {
  server: GameServer<BgioState, TyrantsAction, PlayerId>;
  store: SnapshotStore;
  codec: Codec<BgioState>;
  controllers: Record<string, PlayerController<BgioState, TyrantsAction, PlayerId>>;
  olderThanMs?: number;
  nowMs?: number;
}): Promise<SweepResult> {
  const olderThanMs = opts.olderThanMs ?? ABANDON_AFTER_MS;
  const now = opts.nowMs ?? Date.now();
  const out: SweepResult = { scanned: 0, forfeited: 0, movesPlayed: 0, errored: 0 };

  // Maintain the inactivity clock (and mark finished games resolved). This is
  // the only per-turn timestamp the framework keeps: it restarts whenever the
  // turn advances, so `reminder.since` is "when the current turn began being
  // waited on". It only emails seats that have an address recorded.
  await opts.server.sweepTurnReminders({ olderThanMs, nowMs: now });

  const games = await opts.store.listActiveGames();
  for (const meta of games.slice(0, MAX_GAMES_PER_SWEEP)) {
    out.scanned++;
    try {
      const latest = await opts.store.getLatest(meta.gameId);
      if (!latest) continue;

      const r = meta.reminder;
      // No clock yet, or the turn moved since we last looked → not abandoned.
      // (sweepTurnReminders above has just (re)started it for next time.)
      if (!r || r.turn !== latest.turn) continue;
      if (now - new Date(r.since).getTime() < olderThanMs) continue;

      let state = decodeRow(opts.codec, latest.state, SCHEMA_VERSION);
      if (!state) continue;   // older schema — leave it to the server's migrate path
      let actor = tyrantsAdapter.currentActor(state);
      if (actor === null) continue;                  // game over
      if (!isHumanSeat(meta, actor)) continue;       // already a bot seat
      const token = meta.tokens[actor];
      if (!token) continue;                          // nothing to act with

      // Record the forfeit first, so the placing is pinned even if the
      // takeover moves fail partway through. Idempotent server-side.
      const alreadyForfeited = (state.G.forfeitedSeats ?? []).includes(actor);
      if (!alreadyForfeited) {
        await opts.server.submit(meta.gameId, token, { kind: 'forfeitSeat', seat: actor });
        out.forfeited++;
      }

      // Play the seat until the turn passes to someone else (or the game ends).
      const ctrl = opts.controllers[TAKEOVER_DIFFICULTY] ?? Object.values(opts.controllers)[0];
      if (!ctrl) continue;
      const abandonedSeat = actor;
      for (let i = 0; i < MAX_MOVES_PER_SEAT; i++) {
        const fresh = await opts.store.getLatest(meta.gameId);
        if (!fresh) break;
        const decoded = decodeRow(opts.codec, fresh.state, SCHEMA_VERSION);
        if (!decoded) break;
        state = decoded;
        actor = tyrantsAdapter.currentActor(state);
        if (actor === null || actor !== abandonedSeat) break;  // turn passed / game over
        const legal = tyrantsAdapter.legalActions(state, actor);
        if (!legal.length) break;
        // Deterministic per-game/turn seed, so re-running a sweep replays the
        // same choices instead of re-rolling the abandoned seat's game.
        let seed = 0;
        for (const ch of `${meta.gameId}:${fresh.turn}:${i}`) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
        const rng = new Rng(seed);
        const action = await ctrl.selectAction({ state, actor, adapter: tyrantsAdapter, rng });
        if (!action) break;
        await opts.server.submit(meta.gameId, token, action);
        out.movesPlayed++;
      }
    } catch (e) {
      out.errored++;
      // A single bad game must never abort the sweep for everyone else.
      // eslint-disable-next-line no-console
      console.error(`[sweep] ${meta.gameId}:`, e);
    }
  }
  return out;
}
