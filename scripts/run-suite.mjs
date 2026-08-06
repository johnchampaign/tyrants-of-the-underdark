// Run every standalone regression script in scripts/ that CI doesn't already
// run as its own step.
//
// Why a discovering runner instead of one npm script per file: scripts/ had
// accumulated ~20 hand-written regression tests that nothing ever executed, so
// they silently rotted against engine changes. `test-promote-discard.ts` had
// been dead since the framework log-format v2 migration (commit a16f42f) —
// it still asserted against `G.log` as `string[]` and crashed on
// `l.includes is not a function` rather than reporting a failure.
//
// Discovering the list at run time means a NEW scripts/test-*.ts is covered the
// moment it's added, with no package.json edit to forget.
//
// Usage: npm run test:suite

import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(scriptsDir, '..');

/** Scripts this runner deliberately does NOT run, and why. Anything not listed
 *  here is picked up automatically. */
const SKIP = new Map([
  // Already separate CI steps — running them twice would double the slowest
  // part of the pipeline.
  ['test-ai-drive', 'own CI step (the wedging-bug gate; several minutes)'],
  ['test-online-path', 'own CI step'],
  ['test-legacy-codec', 'own CI step'],
  // Needs a reachable server / network, so it can't run unattended in CI.
  ['test-chat', 'needs a running online backend'],
]);

const files = readdirSync(scriptsDir)
  .filter(f => /^(test|verify)-.*\.ts$/.test(f))
  .map(f => f.replace(/\.ts$/, ''))
  .sort();

const failures = [];
let ran = 0;

for (const name of files) {
  const skip = SKIP.get(name);
  if (skip) {
    console.log(`SKIP  ${name}  (${skip})`);
    continue;
  }
  const started = Date.now();
  const res = spawnSync('npx', ['vite-node', join('scripts', `${name}.ts`)], {
    cwd: repoRoot,
    encoding: 'utf-8',
    shell: true,
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  ran++;
  // A script passes only if it exits 0 AND printed no FAIL lines — several of
  // them report failures inline and still exit 0 on older revisions.
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  const inlineFails = (out.match(/^FAIL\b/gm) ?? []).length;
  if (res.status === 0 && inlineFails === 0) {
    console.log(`PASS  ${name}  (${secs}s)`);
    continue;
  }
  failures.push(name);
  console.log(`FAIL  ${name}  (${secs}s, exit=${res.status}, ${inlineFails} FAIL line(s))`);
  console.log(out.trimEnd().split('\n').slice(-15).map(l => `        ${l}`).join('\n'));
}

console.log(`\n${failures.length === 0 ? 'ALL PASS' : 'FAILURES'} — ${ran} script(s) run`
  + (failures.length ? `, failed: ${failures.join(', ')}` : ''));
process.exit(failures.length === 0 ? 0 : 1);
