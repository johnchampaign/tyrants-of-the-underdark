# Tyrants of the Underdark

An unofficial, fan-made digital port of the deck-building / area-control board game
*Tyrants of the Underdark* (original 2016 edition by Wizards of the Coast). Built
with TypeScript, React, and [boardgame.io](https://boardgame.io). Play hot-seat
(one human seat plus configurable AI opponents — random or heuristic — for 2-, 3-,
and 4-player games) or async online multiplayer against other humans.

## Play it

→ **<https://tyrants-online.pages.dev/>**

→ **Source code:** <https://github.com/johnchampaign/tyrants-of-the-underdark>

No account or download required — just open the URL. The site serves both the
hot-seat game and online multiplayer.

> The old GitHub Pages URL (`johnchampaign.github.io/tyrants-of-the-underdark`)
> now redirects here. It was static-only and could never host the online lobby
> backend, so the canonical site moved to Cloudflare Pages.

## Deploying

The canonical deployment is the **Cloudflare Pages** project `tyrants-online`.
It serves the static client *and* the online-multiplayer lobby backend, which
runs as Cloudflare Pages Functions under `functions/api/*` (GitHub Pages is
static-only and can't host that — hence the move).

The project is **not** git-connected, so deploys are manual. Use the gated
deploy path, which runs the **AI-drive sweep first** and refuses to ship if it
finds a bug that would wedge a live game:

```sh
npm run ship
```

That runs every gate in `npm run ci` except the typecheck (AI-drive sweep,
online-path integration, legacy-codec rewind, and the standalone regression
suite), then `npm run build` and `npx wrangler pages deploy dist
--project-name tyrants-online --branch main`. See the `ship` script in
`package.json` for the exact chain. If you ever need the raw steps:

```sh
npm run build
npx wrangler pages deploy dist --project-name tyrants-online --branch main
```

> **Don't skip the sweep.** The `test:ai-drive` gate is what caught (and now
> guards against) the forced-discard crash that locked online vs-AI games at
> "Red is taking their turn". CI (`.github/workflows/ci.yml`) runs the same
> sweep on every push/PR, so a wedging bug dies in the pipeline — `npm run ship`
> is the local mirror of that gate for the manual deploy.

`--branch` must match the branch set as **Production** in the Cloudflare
dashboard (Workers & Pages → tyrants-online → Settings → Builds & deployments),
which is **`main`**. Deploying any other branch produces a throwaway *preview*
that never reaches `tyrants-online.pages.dev`.

Pushes to `main` no longer deploy the app to GitHub Pages — that workflow
(`.github/workflows/deploy.yml`) now only publishes a redirect to the Cloudflare
site.

### Backends (don't lose track of these)

- **Supabase** (online game state + bug reports): `tyrants-online`'s
  `SUPABASE_URL` points at the **`boardgame framework`** project,
  ref **`nuvhxfrqutbfcvozfwrn`** — SQL editor:
  `https://supabase.com/dashboard/project/nuvhxfrqutbfcvozfwrn/sql/new`.
  (Rebellion is a *separate* Supabase project, `oyjhintjodzpipfwupxj` — not
  used by Tyrants.) `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are stored as
  Pages **secrets**, so their values can't be read back from the dashboard or
  API — only overwritten.
- **Relay worker** (`tyrants-relay`, separate Cloudflare project): files GitHub
  issues (holds `GITHUB_TOKEN`), uploads game logs + report screenshots to the
  `game-logs` branch, and serves `/report-status`. Online bug reports are
  forwarded to it server-side by the framework's `ReportForwarder`
  (`src/online/githubIssueForwarder.ts`). Deploy separately: `cd worker &&
  npx wrangler deploy`.

### Bumping the framework (`digital-boardgame-framework`)

When upgrading the framework dep, **apply any schema changes to the Supabase
project as part of the same rollout** — the `GameServer` writes against the
new schema immediately on deploy, so a lagging DB silently 500s online play.
Diff the framework's `supabase/schema.sql` and apply the new statements (they're
written `… if not exists`, safe to re-run) to `nuvhxfrqutbfcvozfwrn` before/with
the Pages deploy. (Concretely: `0.4.0` added `dbf_reports.category` — missing it
made every online report 500 with "Could not find the 'category' column".)

### First-run image download (one time, ~25 MB)

The first time you load the page you'll be asked whether to import card and board
images. These art assets are owned by Wizards of the Coast and aren't redistributed
from this repo. The importer fetches them from the original publisher-uploaded
images hosted on imgur (the same set used by the public Tabletop Simulator workshop
mod), slices the deck sheets into individual cards in your browser, and stores
everything in IndexedDB so subsequent loads are instant.

If you'd rather not download the art, **click "Skip — play with placeholders"** on
the import dialog (or toggle "Images: off" in the header at any time). The game
runs in a no-images schematic mode: cards are rendered as text panels showing the
same name, cost, aspect, and effect text; the map is drawn as a node-and-edge
diagram with site cards and route lines. Gameplay is fully identical between modes;
only the visuals change.

## Local development

```bash
npm install
npm run dev              # http://localhost:5173
```

### Tests

```bash
npm run ci               # typecheck + every gate below
npm run test:suite       # just the standalone scripts/test-*.ts regressions (~30s)
```

`scripts/` holds one focused regression script per past bug. `npm run test:suite`
**discovers them** (`scripts/test-*.ts` and `verify-*.ts`) rather than reading a
hand-maintained list, so a new one is covered the moment you add it — nothing to
remember in `package.json`. The few exclusions, each with its reason, live in the
`SKIP` map at the top of `scripts/run-suite.mjs`; those are the heavyweight gates
that already have their own CI step (`test:ai-drive`, `test:online-path`,
`test:legacy-codec`).

The discovery is deliberate. These scripts used to be invoked only by hand, and
`test-promote-discard.ts` sat broken for months after the log-format v2 migration
— it still asserted against `G.log` as `string[]` and died on
`l.includes is not a function` instead of reporting a failure. Nothing noticed,
because nothing ran it.

### Adding a field to `TyrantsState`

Every persisted state is a base64 codec: the localStorage autosave, each entry
in the Game Log tab's rewind list, and every `snapshots[].codec` in the public
`logs/*.json` corpus (all of which are `schemaVersion: 1`). `loadState` wipes
`G` and re-assigns only what the codec carried, so **a field you add today comes
back `undefined` for every codec written before today** — and the Board reads
plenty of state unguarded, so an unbackfilled field blanks the page on rewind.

So: whenever you add a field to `TyrantsState` or `PlayerData`, add a matching
default to **`backfillLegacyState` in `src/game.ts`**. That one function is run
by `loadState`, `undo`, and `turn.onBegin`, and it is the only place these
defaults should live.

`npm run test:legacy-codec` is the gate. It replays every snapshot codec in
three published logs through the real `loadState` move, server-renders the real
`<Board>` over each result in both view modes, scores it, and finally checks
field-for-field parity against a freshly-initialized state — so a forgotten
backfill fails in CI instead of in front of a player.

The dev build also supports the optional `npm run extract-assets` flow if you have
the [TTS Workshop mod 881660322](https://steamcommunity.com/sharedfiles/filedetails/?id=881660322)
installed locally — it pulls images out of the mod's cached files and writes them
to `assets/`. This is only needed if you want to work on art/calibration tooling;
the in-app importer covers normal use.

## Assets (copyright)

Card art, board art, and tokens are property of Wizards of the Coast and are **not**
redistributed here. To populate `assets/cards/`, `assets/board/`, etc. locally:

1. Subscribe to and download [TTS Workshop mod 881660322](https://steamcommunity.com/sharedfiles/filedetails/?id=881660322) (Tabletop Simulator).
2. `npm run extract-assets` — pulls images out of the mod's cached files and writes
   them to `assets/`. See `scripts/extract-assets.mjs` for details.

The JSON data files (`assets/card-data.json`, `assets/site-positions-ocr.json`,
`assets/slot-positions-auto.json`) are derived configuration and **are** committed.

## Developer mode

The eight calibration / verification tabs (`calibrate`, `routes`, `cards`, `costs`,
`text`, `sites`, `edges`, `slots`) are hidden by default. Append `?dev=1` to the URL
to enable them; the flag persists in `localStorage`. A small "hide dev tabs" button
appears in dev mode to switch back.

## Headless AI training harness

```bash
npm run sim -- --games 50                      # 1 heuristic vs 3 random, default
npm run sim -- --games 100 \
    --p1 heuristic --p2 heuristic \
    --p3 random --p4 random
```

Outputs per-game JSON to `training-logs/<timestamp>/`. Each game is a self-contained
record: full move trace, per-turn state codecs, turn logs, final scores. Used as the
foundation for future AI training work; see `docs/` and the "Public game-log repo"
section below.

## Reporting bugs

Click **"Report a problem"** in the header. The dialog captures the current game
state codec, recent log lines, and your description, then files a GitHub Issue on
`johnchampaign/tyrants-of-the-underdark`. If GitHub isn't configured in your
environment (see `.env.example`), the report is saved locally to
`training-logs/problem-reports/<timestamp>.json` so feedback isn't lost.

## Public game-log repo

Completed games — both browser playthroughs and headless sim runs — can be published
to the public `logs/` directory on the main repo for AI training datasets. The flow
goes through a Cloudflare Worker (see `worker/`) so the GitHub token lives only in
Worker secrets, never in client builds. Per-log SHA256 deduplication keeps the repo
size manageable.

## Project layout

```
src/                   React + boardgame.io app
  ai/                  Random and heuristic decision-makers
  components/          UI: MapView, NewGameDialog, GameLog, CardCalibration, etc.
  data/                Sites, routes, troop-spaces, card data accessor
  engine/              Card-effect handlers, map state, scoring, registry
  game.ts              boardgame.io Game definition
  App.tsx              Top-level shell (Client, header, tabs, modals)
scripts/               Asset extraction, OCR, headless sim, calibration tools
assets/                Data JSONs (committed) + extracted art (gitignored)
worker/                Cloudflare Worker — relay for bug reports and game logs
docs/                  Rules notes, design docs
training-logs/         Local development outputs (gitignored)
```


## Feedback & contributions

The most useful thing you can send is an **in-game problem report** — the report
button inside the game. Filed while you're playing, it captures the game state and
context that make an issue reproducible, which helps far more than a code change.

**Pull requests generally won't be merged.** This is a solo-maintained project, and
reviewing and integrating outside code costs more than it saves. If you open a PR,
it'll be read as a well-specified bug report or feature request and implemented here
rather than merged — so it's a fine way to *describe* a change you'd like, just
please don't expect it to land as-is.

**The whole codebase is MIT-licensed** — fork it and do whatever you want: change
the rules, reskin it, build and ship your own version. No permission needed; that's
the point of the license.
