---
name: build-map
description: Keep a visual build map up to date for any feature build, and read the answers and notes the owner leaves on it. Use at the start of any build, fix, QA or deploy session, whenever a module is written or committed, a deploy or QA run finishes, a stage changes, something blocks, or you need the owner to decide, approve or hand over something. A map is one JSON file per feature that the owner works from in a local browser page (Inbox, Grill or Quiz, Progress).
---

# Build map

The one place the owner and agents talk during a build. Agents keep it through a CLI; the owner answers in the browser, and every answer or note lands in the map file, so you read it with `show`. Never ask the owner to copy anything into a session.

```bash
BM="node ${CLAUDE_SKILL_DIR}/scripts/bm.cjs"   # or just `bm` once the shim is installed; maps live in ~/build-maps (BUILD_MAP_DIR overrides)
$BM list                         # which maps exist
$BM show <map>                   # read first, every session (about 300 tokens)
$BM show <map> --since <rev>     # only what changed since you last looked
$BM wait <map>                   # run in the background: exits when the owner presses Send
$BM new <map> "Feature name" --branch B --org O --ticket T
$BM help                         # every command
```

Owner's page: `$BM open` starts the page on http://127.0.0.1:4330 (or reuses it) and opens it; `$BM open <map>` opens that map. If `command -v bm` finds nothing, run `$BM install-shim` once: it puts a `bm` command in `~/.local/bin` that always runs this plugin's CLI.

## What the owner sees

A lean console with a step bar (Grill to Complete) and two tabs. **Inbox**: everything you need from them at any step, plus what the build is waiting on (blocked Now lines) and an Inputs list showing which inputs are in. **The step tab**: a view made for the current step, or for any step they click in the bar. Grill: scope, progress, grill questions. Spec: the spec link, agents, modules planned, inputs needed. Build: one lane per agent (`--lane` on modules) with progress. QA: pass, fail and open counts, fails first. Review and Close: whatever you tag with that step. Deploy: sandbox vs prod and checks. Quiz: the quiz link. They move the map with a "Move map to" button in a step's view; treat that as the stage. They never see the log, dates or revs. Write for that: short, one item per thing they must act on.

**Tag things to their step** so each view fills in: `--step <step>` on `decision-add` and `now-add` (review findings with `--step review`, close-out items with `--step close`, sign-off with `--step spec`). Inputs are not a step: ask for each one with `decision-add --kind input` whenever it comes up, at any step, with no `--step` (it lives in the Inbox), and `--lane "Agent 1: import"` on `mod-add` or `mod` for each agent's modules. When you add a module, also set `--uses "A,B"` to the module ids it calls or reads (an LWC uses its Apex controller, the controller uses its objects): the owner's "Generate build diagram" in the Build view draws these as arrows, and nothing is guessed when it is empty. Also give each box a 4 or 5 word subtitle with `--sub`, and declare who uses the build once per map with `$BM actor <map> "Guest visitor" --uses "<the module they enter by>"` (one per kind of user): the diagram puts the actors at the top and draws the data model as a dashed box at the bottom. Put each module in a capability wrapper with `--group "Intake"` (2 or 3 words naming what the modules do together, such as Intake, Classification, Config and review); with no group the wrapper is the module's `--lane`. To change a module id use `$BM mod <map> "<old id>" --rename "<new id>"`, which also updates every `--uses` and actor link; never hand edit ids in the JSON.

## Rules

Writing style for everything you put on a map: [references/writing-guide.md](references/writing-guide.md).

- **Ask before you create a map.** `new` only after the owner says yes to a map for this work. Ask in one line in chat when no map exists; small tasks (a quick fix, a question, a one-off edit) never get one unless they ask. Updating an existing map needs no permission.
- **Read before you write.** `show` lists "NOTES FROM YOU": notes typed in the Inbox, and answers picked on an item (`Decision 2 "...": <answer> | note: <note>`). "Set aside without an answer" means the owner dismissed it: drop it or ask differently. Act on each, then close it: `$BM now-done <map> "<text>"` for a note, `$BM decision <map> 2 --done` for an answer (it stays as the record).
- **Everything you need from the owner is an Inbox item**, made with `decision-add`, never a chat message and never a blocked Now line:
  - `--kind decision` for a choice, `--kind input` for something they must hand over (a file, access, a client answer), `--kind approve` for a yes on your work (an email draft, a plan, a deploy).
  - `--short` is the row title, 2 to 4 words. `--ctx` is one line of why it matters. The full question is the main text.
  - `--opt` per option, up to 5, recommended first with `*`. Add `|icon` only when the icon is obvious (check, send, pause, link, x, mail, file, upload, eye, refresh, clock); otherwise the option shows as a word. With no options, approve gets Approve and Hold, input gets Done, and a decision takes a typed answer.
  - Never join items with " · " or similar dot separators in any text. One item per thing.
- **Grill questions** go in with `--grill`: they show in the Grill tab with the scope (`bm scope`) as context and a "Sources" link if you add one (`bm link <map> Sources "Quote doc" <url>`). Keep the grill lean: only questions whose answer changes the spec.
- **The owner's order is their priority.** `show` lists waiting items in the order they dragged them; work top-down.
- **Answers arrive in batches.** The owner's picks and notes stay drafts on the page until they press Send, and `show` never lists drafts. After you add items and have nothing else to do, wait with `$BM wait <map>` run in the background (Bash `run_in_background`): it exits when the owner presses Send and prints `show`, so you are woken once per batch. Never poll or ask in chat. `show` prints the last send's rev; pass it as `--since` if you start waiting later.
- **Cleanup after a delete.** When `$BM list` starts with CLEANUP WAITING, run `$BM cleanup`: the owner deleted a map and ticked what should go with it. Find the sessions by searching transcripts for the map name and delete them with delete_session (the app asks the owner), delete a branch only if it is merged or the owner says so, then `$BM cleanup-done <map>`.
- **Now is for work in progress and blockers only.** One `now-add` line per agent at most, plus a blocked line for each outside wait; the tool refuses past 5 agent lines and refuses repeats. Close a line with `now-done` as soon as it is finished. Finished results, FYIs, republish notes and review notes go to `$BM log`; anything the owner must answer goes in the Inbox with `decision-add`.
- **Update without being asked** whenever a module is written or committed, a deploy lands, a QA run finishes, the stage changes or something blocks. Batch several edits into one atomic write with `$BM batch <map> '[{...},{...}]'`.
- **Stages:** grill, spec, build, qa, review, deploy, quiz, close, then complete (or archive if shelved). Move a stage only when its exit is true: build to qa when every module is committed; qa onward when the latest run has no fail or open step; deploy is done when every module is in prod. Link the spec as `bm link <map> Spec "spec.md" <url or file path>` (a local file opens read-only from the board; files under ~/Documents/Atlas and the maps folder only) and the quiz as `bm link <map> Quiz "Build quiz" <url>`.
- **Layers are fixed:** Trigger, Service, Domain, Data & config.
- **Name modules after their code.** Use the class, component, Flow or object name as the module id (`OrderSearchService`, `orderSearch LWC`), so the owner's Code map tab links each module to its file on the repo's Floorplan map. Run `$BM code <map>` to see which modules match and whether the code map lags the branch.
- **Work from inside the repo.** When you run `bm` in a checkout whose branch is the map's branch, the map is linked to that repo on its own, the repo's CLAUDE.local.md gets a short pointer to the map, and module changes light up as recent work on its code map. For a map on main or with no branch, run `$BM here <map>` once in the repo.
- **Never** put secrets or credentials in a map, and never edit another feature's map.

## Common updates

```bash
$BM decision-add <map> "Send the inputs email to Sam?" --kind approve --short "Email Sam" --ctx "Draft asks for the 75h OK and the data files" --opt "*Send|send" --opt "Hold|pause" --opt "View|link"
$BM decision-add <map> "Imported or calculated scores?" --grill --short "Scores" --ctx "Scores come from an outside survey, so a formula cannot do them" --opt "*Import" --opt "Calculate" --opt "Ask Sam"
$BM mod-add <map> "Service" "MainService" --what "one line"
$BM mod <map> "MainService" --code committed --deployed sandbox     # code: none|written|committed, deployed: none|sandbox|prod
$BM now-add <map> "Mapping Excel headers to fields"                 # what you are doing right now (Build view)
$BM qa-run <map> --verdict "All passed" --plan <url> --step "Happy path:pass" --step "Edge case:fail:why"
$BM check <map> "Prod check-only validation" pass "66/66"
$BM stage <map> qa
```
