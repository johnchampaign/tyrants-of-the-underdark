// Persistence codec for the online GameServer.
//
// The framework's GameServer persists the FULL boardgame.io state object
// (`{ G, ctx, plugins, ... }`) as a snapshot after EVERY action. Tyrants' `G`
// carries heavy *transient* fields that would balloon every persisted snapshot:
//
//   - G.undoStack   — an array of codec strings, each a FULL pre-action state
//                     copy (states-within-states). The biggest single win.
//   - G.snapshots   — an array of per-turn-start codec strings, also full
//                     nested states. Grows one entry per turn for the whole game.
//   - _undo/_redo   — boardgame.io's OWN undo history: one full {G, ctx, plugins}
//                     copy per move, cleared only at a turn boundary. Not part of
//                     `G`, so the two strips above never reached it (#104).
//
// This codec wraps jsonCodec semantics but strips those two fields from `G`
// before serializing, and re-initializes them to their empty defaults (`[]`) on
// decode so the reducer (which pushes onto them in turn.onBegin /
// pushUndoSnapshot) tolerates a freshly-loaded state.
//
// SAFETY (verified against src/game.ts):
//   - undoStack: cleared to [] at every turn.onBegin (line ~515) and only ever
//     pushed to; the `undo` move is excluded from the online action vocabulary,
//     so no online code path reads prior entries. Reset to [] on load is safe.
//   - snapshots: turn.onBegin does `G.snapshots.push(...)`, so the field MUST be
//     a non-null array on load (undefined would throw). We restore []. Past
//     entries are only read by `loadState` (a dev/local-only move, not exposed
//     online), so dropping them does not affect online play or replay.
//
// NOT stripped:
//   - log / turnLogs: measured small relative to undoStack/snapshots (see
//     scripts/roundtrip-check.ts size report). turnLogs powers the per-turn
//     summary modal players actually read. `log` is now structured entries
//     capped at LOG_CAP (500) by src/engine/log.ts, and G.turnLogStart is
//     seq-based, so trimming is safe. Both left intact here.
//
// This file is ADDITIVE: it does not touch the engine, game.ts moves, the UI,
// or the hotseat client. It only changes what the SERVER writes to storage.

import { type Codec } from 'digital-boardgame-framework';
import type { BgioState } from '../adapter/tyrantsAdapter';

/** Build a codec that strips heavy transient `G` fields before persisting and
 *  restores their empty defaults on load. Drop-in replacement for
 *  `jsonCodec<BgioState>()` at every GameServer construction site. */
export function snapshotCodec(): Codec<BgioState> {
  return {
    encode: (state) => {
      // Shallow-clone the top-level state and the `G` we mutate, so we never
      // disturb the live in-memory object the caller still holds.
      const G = state.G as unknown as Record<string, unknown>;
      const stripped: Record<string, unknown> = {
        ...G,
        undoStack: [],
        snapshots: [],
      };
      // Also drop boardgame.io's OWN undo history (#104). Each `_undo` entry is
      // a full copy of G — including a `snapshots` array this codec strips from
      // the top level but cannot reach inside the copies — so it defeated the
      // whole point of the stripping above: on the report that surfaced this,
      // `_undo` was 198 KB of a 294 KB snapshot, two thirds of every write.
      // Nothing online reads it (the adapter never dispatches UNDO/REDO and now
      // builds its reducer with `disableUndo`), so it is pure ballast.
      return JSON.stringify({ ...state, G: stripped, _undo: [], _redo: [] });
    },
    decode: (raw) => {
      const parsed = JSON.parse(raw) as BgioState;
      const G = parsed.G as unknown as Record<string, unknown>;
      // Re-initialize the stripped fields to their empty defaults so the
      // reducer's turn.onBegin push / pushUndoSnapshot see a real array.
      if (!Array.isArray(G.undoStack)) G.undoStack = [];
      if (!Array.isArray(G.snapshots)) G.snapshots = [];
      // Snapshots written before the fix still carry a fat `_undo`; drop it on
      // load so an existing game gets cheap again immediately rather than only
      // after its next write. bgio needs the fields to exist as arrays.
      parsed._undo = [];
      parsed._redo = [];
      return parsed;
    },
  };
}
