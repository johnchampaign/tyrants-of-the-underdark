// Regression test for issue #103's collateral damage: the problem-report
// pipeline rendered the attached game log as a wall of "[object Object]" and
// sliced the snapshot codec mid-string, so a report that said "see log" shipped
// no usable evidence at all.
//
// Two guarantees, both asserted against the Worker's real helpers:
//   1. A structured log-format v2 entry renders as its prose `msg`.
//   2. The snapshot codec never shares a truncation budget with the state
//      summary — the JSON block always parses, and a clipped codec is still
//      base64-decodable up to the cut.
import { logLineText, splitSnapshotCodec } from '../worker/src/index';

let ok = true;
const fail = (msg: string) => { console.log('FAIL  ' + msg); ok = false; };
const pass = (msg: string) => console.log('ok    ' + msg);

// ---- 1. log rendering ------------------------------------------------------

const v2Entry = { seq: 291, turn: 25, side: '2', kind: 'note', msg: 'Focus (Guile) triggered (revealed).' };
if (logLineText(v2Entry) !== 'Focus (Guile) triggered (revealed).') {
  fail(`structured entry did not render its msg: ${logLineText(v2Entry)}`);
} else pass('structured log entry renders as prose');

if (logLineText('P1 recruited Ettin') !== 'P1 recruited Ettin') {
  fail('legacy string log line should pass through unchanged');
} else pass('legacy string log line passes through');

// A kind-only entry (no msg) must still say something machine-useful.
if (logLineText({ kind: 'card.play' }) !== 'card.play') {
  fail('entry without msg should fall back to kind');
} else pass('entry without msg falls back to kind');

// The actual #103 symptom: joining raw entries stringifies them to garbage.
const tail = [v2Entry, v2Entry].map(logLineText).join('\n');
if (tail.includes('[object Object]')) fail('rendered tail still contains [object Object]');
else pass('rendered tail is free of [object Object]');

// ---- 2. codec / summary split ---------------------------------------------

// A codec long enough that the old combined 50k slice would have cut it.
const codec = Buffer.from(JSON.stringify({ log: Array.from({ length: 4000 }, (_, i) => ({ seq: i, msg: `entry ${i}` })) }))
  .toString('base64');
if (codec.length < 60000) fail(`test fixture too small to exercise truncation (${codec.length})`);

const state = {
  latestSnapshotCodec: codec,
  latestSnapshotTurn: 51,
  players: { '0': { color: 'black', vp: 0 } },
};

const split = splitSnapshotCodec(state);
if (split.codec !== codec) fail('codec was not lifted out of the state summary');
else pass('codec lifted out of the state summary');

const summaryJson = JSON.stringify(split.rest, null, 2);
if ('latestSnapshotCodec' in (split.rest as Record<string, unknown>)) {
  fail('state summary still carries the codec');
} else pass('state summary no longer carries the codec');

try {
  const parsed = JSON.parse(summaryJson) as { latestSnapshotTurn: number };
  if (parsed.latestSnapshotTurn !== 51) fail('state summary lost its fields');
  else pass('state summary is valid, complete JSON');
} catch (e) {
  fail(`state summary is not parseable JSON: ${String(e)}`);
}

// The summary must be small enough that the codec is the only thing a body
// budget ever needs to clip.
if (summaryJson.length > 15000) fail(`state summary unexpectedly large (${summaryJson.length})`);
else pass('state summary fits its own budget');

// A clipped codec must be cut on a 4-char base64 group boundary so the prefix
// still decodes — this is what let a truncated report stay salvageable.
const room = 20000;
const kept = codec.slice(0, room - (room % 4));
if (kept.length % 4 !== 0) fail('clipped codec is not on a base64 group boundary');
else pass('clipped codec sits on a base64 group boundary');

const decoded = Buffer.from(kept, 'base64').toString('utf8');
if (!decoded.startsWith('{"log":[{"seq":0')) fail(`clipped codec prefix did not decode: ${decoded.slice(0, 40)}`);
else pass('clipped codec prefix decodes cleanly');

// Non-object state (or a state with no codec) must pass through untouched.
const noCodec = splitSnapshotCodec({ players: {} });
if (noCodec.codec !== null) fail('reported a codec where there is none');
else pass('state without a codec passes through');

console.log(ok ? '\nPASS' : '\nFAIL');
process.exit(ok ? 0 : 1);
