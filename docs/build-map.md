# Build map

The build map is Atlas DevShop's addition to this fork. It keeps one JSON file per feature build in `~/build-maps/` (or `BUILD_MAP_DIR`). Agents update it through the `bm` CLI, and the owner reads it, answers and leaves notes on a local page at http://127.0.0.1:4330.

## Changes to upstream files

Everything Atlas adds lives in `skills/build-map/` and in `docs/` pages that upstream doesn't have (`docs/build-map.md`, `docs/atlas-install.md`). These are the only upstream files we edit, so a merge from upstream can only conflict here:

| File | What we changed |
|---|---|
| `.claude-plugin/plugin.json` | name `atlas-floorplan`, version `0.1.5-atlas.N`, author, homepage, description |
| `.claude-plugin/marketplace.json` | marketplace and plugin name `atlas-floorplan`, owner Atlas DevShop |
| `README.md` | a one-line Atlas note under the title, the version badge, the install commands |
| `CHANGELOG.md` | one entry per Atlas release, on top |
| `tests/release.test.mjs` | accepts the `-atlas.N` version suffix (and the badge's escaped dash) |
