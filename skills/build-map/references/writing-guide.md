# Writing on a build map

The owner reads the map, not chat, often on a phone between calls. Everything you write there is read cold, one line at a time. Floorplan's [writing-descriptions.md](../../floorplan/references/writing-descriptions.md) has the same spirit for code maps.

## Modules

- **Id = the code's name.** The class, component, Flow or object exactly as it is in the repo: `OrderSearchService`, `orderSearch LWC`, `Renewal_Reminder_Daily`. The Code map tab finds the file by this name. Use a phrase only for work that is not one file ("Prod evidence (audit trail)").
- `--what`: one line, what it does for the feature, not how. "Finds orders by number, email or phone", not "SOQL with dynamic WHERE".
- `--sub`: 4 or 5 words for the diagram box.
- `--group`: 2 or 3 words naming what the modules do together (Intake, Search, Config and review).
- `--uses`: the module ids it calls or reads. Leave it empty rather than guess.

## Inbox items

- `--short` is the row title: 2 to 4 words the owner can scan ("Email Sam", "First org").
- `--ctx` is one line of why it matters, with the number or name that makes it concrete.
- The question itself is a full sentence that can be answered without opening anything else.
- Options: the recommended one first with `*`, at most 5, each a word or two.

## Now, log and QA

- A Now line is what an agent is doing right now, in the present tense ("Mapping Excel headers to fields"). Close it as soon as it is done.
- A log line is a finished fact: "Committed abc1234: search by order number".
- A QA step name says what was checked ("Search by order number"), its note says what happened when it failed.

## Never

- No double hyphens, no " · " or other dot separators joining two items. One item per line.
- No secrets, tokens, passwords or client personal data (people's names, emails) anywhere on a map.
- No dates or revs in text: the map records them.
