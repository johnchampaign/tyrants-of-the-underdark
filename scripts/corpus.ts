// Shared loader for the logged-game corpus.
//
// Every uploaded game carries a full encoded state at each turn boundary plus
// the final scores, which makes each (position, seat) pair a labelled
// prediction problem. Both the evaluator benchmark and the weight fitter read
// through here so they agree on exactly which games are usable — otherwise
// "fitted beats baseline" could just mean the two were scored on different
// games.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TyrantsState } from '../src/game';

interface Snap { turn: number; playerId: string; color: string; codec: string }
interface RawLog {
  game: {
    scores?: Record<string, { total: number }>;
    snapshots?: Snap[];
    turnLogs?: { lines: string[] }[];
  };
}

export interface Position {
  /** Which log this came from — the unit a train/test split must respect. */
  gameId: string;
  G: TyrantsState;
  seats: string[];
  finals: number[];
  /** 0 at the opening, 1 at the final turn. */
  progress: number;
}

export interface Corpus {
  positions: Position[];
  games: number;
  gameIds: string[];
  skipped: { noSnapshots: number; codecLoaded: number; undecodable: number };
}

export function loadCorpus(logsDir = 'logs'): Corpus {
  const positions: Position[] = [];
  const skipped = { noSnapshots: 0, codecLoaded: 0, undecodable: 0 };
  const gameIds: string[] = [];

  for (const f of readdirSync(logsDir).filter(n => n.endsWith('.json'))) {
    let log: RawLog;
    try { log = JSON.parse(readFileSync(join(logsDir, f), 'utf-8')) as RawLog; }
    catch { skipped.undecodable++; continue; }
    const g = log.game;
    const snaps = g?.snapshots;
    if (!snaps || snaps.length < 2 || !g.scores) { skipped.noSnapshots++; continue; }
    // A game resumed from a pasted codec has snapshots belonging to a DIFFERENT
    // game than its final scores, so every label before the load is wrong.
    if ((g.turnLogs ?? []).some(t => (t.lines ?? []).some(l => l.includes('state loaded from codec')))) {
      skipped.codecLoaded++; continue;
    }
    const seats = Object.keys(g.scores).sort();
    const finals = seats.map(s => g.scores![s].total);
    gameIds.push(f);
    for (let i = 0; i < snaps.length; i++) {
      let G: TyrantsState;
      try { G = JSON.parse(Buffer.from(snaps[i].codec.trim(), 'base64').toString('utf-8')) as TyrantsState; }
      catch { skipped.undecodable++; continue; }
      positions.push({ gameId: f, G, seats, finals, progress: i / (snaps.length - 1) });
    }
  }
  return { positions, games: gameIds.length, gameIds, skipped };
}

/** Final margin for one seat: its score minus the MEAN of the others. Matches
 *  the framing stateValue already uses, so a model fitted on this target is
 *  learning the quantity the evaluator is asked to produce. */
export function finalMargin(finals: number[], seatIdx: number): number {
  if (finals.length < 2) return finals[seatIdx] ?? 0;
  const others = finals.filter((_, i) => i !== seatIdx);
  return finals[seatIdx] - others.reduce((a, b) => a + b, 0) / others.length;
}
