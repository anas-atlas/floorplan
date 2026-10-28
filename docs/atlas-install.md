# Install atlas-floorplan

One plugin with two skills: **Floorplan** (a map of a codebase) and the **build map** (a local page where agents keep a feature build's status and you answer and approve). Everything runs on your own laptop; your maps stay on it.

## You need

- The Claude desktop app (Code tab), or Claude Code in a terminal
- [Node.js 18 or newer](https://nodejs.org): check with `node --version`
- Git

## 1. Add the marketplace (once, in a terminal)

```bash
claude plugin marketplace add anas-atlas/floorplan
```

## 2. Install the plugin

In the desktop app: open the **Code** tab, click **+**, choose **Add plugins**, find **atlas-floorplan** and install it.

Or in a terminal:

```bash
claude plugin install atlas-floorplan@atlas-floorplan
```

Start a new session afterwards: skills load when a session starts.

## 3. Put `bm` on your PATH (once)

In a new session, ask Claude: **"install the bm shim"**. It runs `bm install-shim`, which writes a small `bm` launcher to `~/.local/bin` that always runs the installed plugin's CLI, so plugin updates need nothing more. Or run it yourself:

```bash
node "$(ls -d ~/.claude/plugins/cache/atlas-floorplan/atlas-floorplan/*/ | tail -1)skills/build-map/scripts/bm.cjs" install-shim
```

If it says `~/.local/bin` is not on your PATH, add `export PATH="$HOME/.local/bin:$PATH"` to `~/.zshrc` and open a new terminal.

## 4. Check it

```bash
bm list
```

```bash
bm open
```

`bm list` prints your maps (none yet on a new laptop). `bm open` opens the build map page at http://127.0.0.1:4330.

## Using it

- **Build maps:** at the start of a feature build, Claude asks whether the work gets a map, then keeps it updated. You read and answer on the page. Maps are files in `~/build-maps/`; they never go into a repo.
- **Code maps:** in a client repo, ask Claude **"make me a floorplan of this app"**. Once a repo has one, its build maps get a **Code map** tab that shows each module on the code.
- Name modules after their code (the Apex class, LWC, Flow or object), so the Code map tab can find them.

## Updating

```bash
claude plugin marketplace update atlas-floorplan
```

Then update **atlas-floorplan** from the Code tab's plugin list (or `claude plugin update atlas-floorplan@atlas-floorplan`) and start a new session.

## If something is off

| What you see | What to do |
|---|---|
| `bm: command not found` | Step 3, then open a new terminal |
| `bm open` says port 4330 is in use | An older build map page is running. Stop it (`lsof -iTCP:4330` shows its process) and run `bm open` again |
| No Code map tab on a map | Run `bm here <map>` inside the repo, and make sure the repo has a floorplan |
| "The code map lags the branch" | Ask Claude in the repo to "update the floorplan" |

More: [Build map](build-map.md), [Floorplan's getting started](getting-started.md).
