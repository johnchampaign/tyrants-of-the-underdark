// Structured game log (framework log-format v2) — the single choke point.
//
// Every log write in the engine routes through `logEvent` (usually via
// `Mechanics.log`). Entries are framework `GameLogEntry` objects: a stable
// `seq`, the game turn, the acting seat (`side`), a machine-readable `kind`
// with a structured `payload`, and the human-readable prose in `msg` (which
// is what the UI renders). See docs/log-events.md for the kind registry.

import { appendGameLog, upgradeProseLog, type GameLogEntry } from 'digital-boardgame-framework';
import type { TyrantsState } from '../game';

/** In-state log cap — appendGameLog trims to the most recent LOG_CAP entries.
 *  Turn-slice bookkeeping (G.turnLogStart) is seq-based, so trimming is safe. */
export const LOG_CAP = 500;

export interface LogMeta {
  /** Event id, e.g. 'power.gain', 'troop.deploy'. Defaults to 'note'. */
  kind?: string;
  /** Structured event data — amounts, sources, site/card ids. */
  payload?: unknown;
  /** Acting seat ('0'..'3'). Defaults to G.logSide (stamped at turn start).
   *  Pass null explicitly for neutral/public events. */
  side?: string | null;
}

/** Upgrade a legacy `string[]` log (old snapshots / local saves / mid-game
 *  online states) to structured entries in place. Idempotent; also handles
 *  mixed arrays defensively. */
export function ensureStructuredLog(G: TyrantsState): void {
  const log = G.log as unknown as Array<GameLogEntry | string>;
  if (!Array.isArray(log)) { (G as { log: GameLogEntry[] }).log = []; return; }
  if (!log.some(e => typeof e === 'string')) return;
  if (log.every(e => typeof e === 'string')) {
    G.log = upgradeProseLog(log as string[]);
    return;
  }
  // Mixed (shouldn't happen, but never crash the renderer): wrap strings,
  // re-stamp seq monotonically by position.
  G.log = log.map((e, i) =>
    typeof e === 'string'
      ? { seq: i, turn: 0, kind: 'legacy', msg: e }
      : { ...e, seq: i });
}

/** Append one structured entry. `msg` is the prose the UI shows (identical to
 *  the old string lines); `meta` adds the machine-readable kind/payload/side. */
export function logEvent(G: TyrantsState, msg: string, meta?: LogMeta): void {
  ensureStructuredLog(G);
  appendGameLog(G.log, {
    turn: G.logTurn ?? 0,
    side: meta && 'side' in meta ? meta.side : (G.logSide ?? null),
    kind: meta?.kind ?? 'note',
    msg,
    ...(meta?.payload !== undefined ? { payload: meta.payload } : {}),
  }, LOG_CAP);
}

/** The seq the NEXT appended entry will get — used by turn.onBegin to mark
 *  where a turn's log slice starts (indexes shift under the cap; seq doesn't). */
export function nextLogSeq(G: TyrantsState): number {
  ensureStructuredLog(G);
  const last = G.log[G.log.length - 1];
  return last ? last.seq + 1 : 0;
}

/** Prose rendering of an entry (or a legacy string, for old saves). */
export function logLineText(e: GameLogEntry | string): string {
  return typeof e === 'string' ? e : (e.msg ?? e.kind);
}
