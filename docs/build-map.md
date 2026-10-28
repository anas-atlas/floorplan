# Build map

The build map is Atlas DevShop's addition to this fork. It keeps one JSON file per feature build in `~/build-maps/` (or `BUILD_MAP_DIR`). Agents update it through the `bm` CLI, and the owner reads it, answers and leaves notes on a local page at http://127.0.0.1:4330.

It ships as a second skill in this plugin, next to Floorplan, in `skills/build-map/`:

```
skills/build-map/
  SKILL.md               what agents do with the map (triggers on build, fix, QA and deploy work)
  references/writing-guide.md
  scripts/
    bm.cjs               the CLI agents use
    lib.cjs              the map store: one JSON per feature, atomic writes, a lock
    server.cjs           the owner's page on 127.0.0.1:4330
    open.cjs             bm open: start or reuse the page
    health.cjs           bm health and the Health row
    repos.cjs            which checkout a map belongs to, and the CLAUDE.local.md pointer
    code.cjs             the link to the repo's Floorplan map
    shim.cjs             bm install-shim (~/.local/bin/bm)
    template.json        a new, empty map
  assets/index.html      the page
  tests/                 run with Floorplan's tests by npm test
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

`bm open` starts the page on http://127.0.0.1:4330 (or reuses it) and opens it. It listens on 127.0.0.1 only; `--host` stays an explicit opt-in. It checks Host and Origin on every request, as before, and the routes that read code or start a process also need a token made at launch and given only to the page.

On a map:

- **Health** lists what is wrong, stale or stuck (also `bm health`). Board cards count the important ones.
- **Since you last looked:** modules changed since you last opened the map get a green ring; the card says New.
- **Code map** tab, when the map is linked to a repo: each module matched by name to a file on the repo's Floorplan map, what that file uses and what uses it (imports, plus names found in Apex, triggers, Flows and components), a warning when the code map lags the branch, and the Floorplan map itself, opened on that file. Its Ask bar runs on Floorplan's own server with Floorplan's token; the build map page never runs Claude. A `code` link on each module in the Build view goes straight there.

## Linking a map to its repo

There is no repo field on a map. When an agent runs `bm` inside a checkout whose branch is the map's branch, the checkout is remembered in `.repos.json`, its CLAUDE.local.md gets the pointer block, and every module change rewrites one task in `<repo>/floorplan/recent-work.json` (marked `"source": "build-map:<map>"`, other tasks kept) and rebuilds the code map in the background, so both pages light up the same files. Maps on main or master, or with no branch, are linked with `bm here <map>` run in the repo.

Modules point at code by name: use the class, component, Flow or object name as the module id. `bm code <map>` shows what matched.

## Upstream merges

Monthly: fetch upstream on a branch, take only releases at least two weeks old, run `npm test` (both suites), then merge and bump to the next `-atlas.N`.

## Changes to upstream files

Everything Atlas adds lives in `skills/build-map/` and in `docs/` pages that upstream doesn't have (`docs/build-map.md`, `docs/atlas-install.md`). These are the only upstream files we edit, so a merge from upstream can only conflict here:

| File | What we changed |
|---|---|
| `.claude-plugin/plugin.json` | name `atlas-floorplan`, version `0.1.5-atlas.N`, author, homepage, description |
| `.claude-plugin/marketplace.json` | marketplace and plugin name `atlas-floorplan`, owner Atlas DevShop |
| `README.md` | a one-line Atlas note under the title, the version badge, the install commands |
| `CHANGELOG.md` | one entry per Atlas release, on top |
| `tests/release.test.mjs` | accepts the `-atlas.N` version suffix (and the badge's escaped dash) |
