# Build map

The build map is Atlas DevShop's addition to this fork. It keeps one JSON file per feature build in `~/build-maps/` (or `BUILD_MAP_DIR`). Agents update it through the `bm` CLI, and the owner reads it, answers and leaves notes on a local page at http://127.0.0.1:4330: the Builds home, and each map as Floorplan's own viewer with a Build panel.

It ships as a second skill in this plugin, next to Floorplan, in `skills/build-map/`:

```
skills/build-map/
  SKILL.md               what agents do with the map (triggers on build, fix, QA and deploy work)
  references/writing-guide.md
  scripts/
    bm.cjs               the CLI agents use
    lib.cjs              the map store: one JSON per feature, atomic writes, a lock
    server.cjs           the owner's page on 127.0.0.1:4330: the Builds home, every map's viewer, the write endpoint
    page.cjs             puts Floorplan's viewer together from the plugin's assets (as build.mjs does)
    ask.cjs              the viewer's Ask bar for every repo (a port of floorplan's serve.mjs)
    open.cjs             bm open: start or reuse the page (--classic: the 0.1.x page)
    classic-server.cjs   the 0.1.x page on 4331, for one release
    health.cjs           bm health and the Health row
    repos.cjs            which checkout a map belongs to, and the CLAUDE.local.md pointer
    code.cjs             the link to the repo's Floorplan map
    shim.cjs             bm install-shim (~/.local/bin/bm)
    template.json        a new, empty map
  assets/home.html       the Builds home
  assets/classic.html    the 0.1.x page, for one release
  tests/                 run with Floorplan's tests by npm test
skills/floorplan/assets/ui/60-build.js   the Build panel and the Feature lens, inside Floorplan's viewer
```

## Where things live

| What | Where | In git? |
|---|---|---|
| Maps | `~/build-maps/<name>.json` (`BUILD_MAP_DIR` overrides) | Never. A test fails if a tracked file here looks like a map |
| Which repo each map belongs to | `~/build-maps/.repos.json` | No |
| The running page | `~/build-maps/.server.json` (pid, port, per-launch token) | No |
| A repo's code map | `<repo>/floorplan/` | No, it ignores itself |
| The pointer for sessions | `<repo>/CLAUDE.local.md`, between `<!-- build-map:start -->` and `<!-- build-map:end -->` | No, added to `.git/info/exclude` |

## The page

`bm open` starts the page on http://127.0.0.1:4330 (or reuses it, restarting it when the plugin brings a newer one) and opens the **Builds home**: every map grouped by stage (Plan, Build, QA and review, Deploy, Complete, Archive), with what waits on you, blockers, health, and whether it has a repo. `bm open <map>` goes straight to one map.

A map opens as **Floorplan's viewer** on its repo's code map, with the **Build panel** open (`ui/60-build.js`). A map with no repo, or whose repo has no floorplan yet, opens in the same viewer with the panel and an empty canvas. The panel shows:

- the stage strip (Grill to Complete), branch, org, rev, tickets and the map's health;
- **Inbox**: the agents' Now lines with who and blocked, your notes, and the note box;
- **Decisions**: the scope, open items with one-click options, then sent and decided;
- **QA**: the latest run, each step with Pass, Fail and Open buttons, and earlier runs;
- **Deploy**: checks and links (local files open read-only, from ~/Documents/Atlas and the maps folder only);
- the modules, each a click from its file on the graph;
- **Activity**: the log, newest first, and the last send.

The **Feature lens** lights up the map's modules on the code graph (matched by name, the same match `bm code` shows) and fades everything else; the parts that hold them say how many. The Build button's count is what waits on you.

Notes, answers and QA verdicts go through one write endpoint, `POST /api/map/<map>/write`, which runs `lib.applyMany`, the code `bm` uses, tagged `you`. It accepts only those ops (drafts, send, order, taking an answer back, QA steps). Notes and answers stay drafts until you press Send, so `bm wait` wakes the agent once per batch. Stages are not moved on the page: agents move them with `bm stage`.

One server answers for every repo: the home, every map's viewer, its Ask bar (`claude -p` in the repo with read-only tools, as Floorplan's own `serve.mjs` does), its flows and its live reload when the code map is rebuilt. It listens on 127.0.0.1 only (`--host` stays an explicit opt-in) and checks Host and Origin on every request. Every API call needs a token made at launch: the home gets it, and each map page gets one derived from it that works for that map only. The page assembles the viewer from the plugin's own `viewer.html` and `ui/*.js` (a test checks it matches what `build.mjs` writes), so a repo built with an older plugin still gets the current panel.

`bm open --classic` opens the 0.1.x page on 127.0.0.1:4331 for one release, then it goes.

## Linking a map to its repo

There is no repo field on a map. When an agent runs `bm` inside a checkout whose branch is the map's branch, the checkout is remembered in `.repos.json`, its CLAUDE.local.md gets the pointer block, and every module change rewrites one task in `<repo>/floorplan/recent-work.json` (marked `"source": "build-map:<map>"`, other tasks kept) and rebuilds the code map in the background, so the code map's Recent work and the Feature lens agree. Maps on main or master, or with no branch, are linked with `bm here <map>` run in the repo.

Modules point at code by name: use the class, component, Flow or object name as the module id. `bm code <map>` shows what matched.

## Upstream merges

Monthly: fetch upstream on a branch, take only releases at least two weeks old, run `npm test` (both suites), then merge and bump to the next `-atlas.N`.

## Changes to upstream files

Everything Atlas adds lives in `skills/build-map/`, in one new file in Floorplan's own feature folder (`skills/floorplan/assets/ui/60-build.js`, which reaches the viewer only through `window.Floorplan` and does nothing outside the build map server), in `tests/page.test.mjs`, and in `docs/` pages that upstream doesn't have (`docs/build-map.md`, `docs/atlas-install.md`). The viewer, `serve.mjs` and `build.mjs` are not edited. These are the only upstream files we edit, so a merge from upstream can only conflict here:

| File | What we changed |
|---|---|
| `.claude-plugin/plugin.json` | name `atlas-floorplan`, version `<upstream>-atlas.N`, author, homepage, description |
| `.claude-plugin/marketplace.json` | marketplace and plugin name `atlas-floorplan`, owner Atlas DevShop |
| `README.md` | a one-line Atlas note under the title, the version badge, the install commands |
| `CHANGELOG.md` | one entry per Atlas release, on top |
| `tests/release.test.mjs` | accepts the `-atlas.N` version suffix (and the badge's escaped dash) |
