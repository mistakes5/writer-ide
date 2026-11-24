# Anti-slop notes

Engineering note for `writer-studio`, 23 November 2026. It records which AI-writing and AI-code markers the extension checks or avoids, where each rule comes from, and what the linter leaves to the writer's judgment.

## Sources

- Billy's voice guide, `/Users/admin/Downloads/billy-system-prompt3.md`, Sections 4, 5 and 7, including the explicit bans of 27 October 2026 on claim + self-commentary tails and abstract recasting.
- The essay interview skill, `/Users/admin/.codex/skills/essay-interview-writing/SKILL.md`: append-only `raw-answers.md`, one concrete question per turn, the writer develops the position.
- Wikipedia, "Signs of AI writing" (project page, read 23 November 2026). Useful for dated vocabulary eras and for its caution that the list is descriptive. It now files em dashes under historical indicators, and lists "Y rather than X" as a frequent recent construction.
- Ben Rombaut, "Eleven Families of AI Code Slop" (June 2026): annotation noise and structural bloat, "new helpers and files must pay rent immediately".
- Hidekazu Konishi, code review anti-pattern catalog (May 2026): single-implementation interfaces, parameters with one value, speculative generality.
- CodeBust, "Verbose Boilerplate": comments that restate the next line, defensive null ladders, `try { } catch (e) { throw e }` ceremony.

These are field observations. A flag marks a sentence to reread, and no rule here proves who wrote a sentence.

## Prose markers checked by `src/core/slopLinter.ts`

| Code | Severity | What it matches | Source |
| --- | --- | --- | --- |
| `negative-parallelism` | warning | "not just/only/merely/simply", "not X, but Y", "rather than X, Y", "it's not X, it's Y", and the two-sentence "X is not the issue. Y is the issue" | Guide 7.3, Wikipedia |
| `hedge-verb` | warning | "suggests", "suggesting", "align(s/ed/ing) with" | Guide 5 banned list, task brief |
| `em-dash` | error | `—`, a spaced en dash, `--` between words | Guide 4 and 7.1 (his total ban) |
| `semicolon` | warning | `;` at parenthesis depth zero, so `(Mellamphy 2021: 20; Carlson 2015: 424)` passes | Guide 4 (zero semicolons in his corpus) |
| `ai-vocabulary` | warning | `delve`, `tapestry`, `multifaceted`, `nuance`, `foster`, `leverage`, `underscore`, `navigate`, `landscape`, `pivotal`, `intricate`, `testament`, `realm`, `paradigm`, `robust`, `streamline`, `holistic`, with their inflections | Guide 5, Wikipedia vocabulary eras |
| `wide-page-range` | warning | Author-Date citations covering more than 3 pages, such as `(Surname 2021: 11-27)` | Task brief, guide 8.3 (anchored claims) |
| `unverified-quote` | warning | text inside `“ ”` or `" "` longer than 25 characters that no indexed reading contains | Guide 8.6 (verify before shipping) |
| `self-commentary` | info | ", and that is what/why ...", ", which is why it matters" | Guide 7, 27 Oct 2026 |
| `abstract-recasting` | info | "becomes / turns into / is transformed into / serves as / functions as + a/an/the noun" | Guide 7, 27 Oct 2026 |

Scope rules, all covered by tests:

- Front matter, fenced code, inline code, link targets, URLs, HTML comments, table rules and horizontal rules are skipped.
- Block quotes and text inside quotation marks are skipped by the style rules, because they hold source wording. The quotation check still reads them.
- `raw-answers.md`, `interview-state.md` and `source-map.md` are never linted. The answer bank stays verbatim, and the notes files are working material.
- Quote checking runs only when readings are loaded, so an empty index cannot produce a wall of false alarms.

Self-commentary and abstract recasting sit at info level on purpose. The guide says to judge the whole construction, and "the bill becomes law" is an ordinary factual sentence. The regex finds candidates, the writer decides.

## Prose markers left to the writer

Rhetoric that a regex cannot judge stays in the interview and assembly checklist (guide Section 9): verdict placement, short-sentence drumbeats, rule-of-three habits, elegant variation, vague attributions, passive voice that hides the actor, distributed hedges and negative framing that carries no paired contrast. A pattern list for these would flag most honest sentences.

## The extension's own text

Every string the extension shows passes `analyzeDocument()`. The tests lint the ten interview questions, every bookmark reason built from the real 3390F library, and every coaxing starter.

- Questions ask for the writer's position, case, mechanism, objection, limit or source tension. None of them proposes an answer.
- Bookmark reasons name the words the writer and the passage share, quoted from the writer's answer exactly ("You wrote "human in the loop" in your answer to ..."). Inferred page numbers and PDF-position fallbacks say so in the reason.
- Coaxing starters quote at most 14 of the writer's own words and ask for the next sentence. They never write the paragraph.

## Code markers avoided

| Marker | What this extension does instead |
| --- | --- |
| Framework or dependency for a small job | Zero runtime dependencies. Node `fs`, `path`, `crypto` and the `vscode` API. Bun builds and tests. |
| Interface or factory with one implementation | Four plain modules plus `extension.ts`. `ReadingsIndex` and `WorkflowStore` are the only classes, each because it holds state. |
| Dependency-injection containers | The vscode namespace is passed as a function argument to the two registration helpers. That is the whole mechanism, and it keeps the core testable under plain `bun test`. |
| Comments that restate code | Comments explain decisions: why offsets carry to unmarked pages, why workspace files only count inside a `readings` folder, why the answer file is opened in append mode. |
| Defensive ladders | Input is checked at the trust boundary only: messages from the webview, and `openReading` paths, which must belong to an indexed reading. |
| Options objects with one caller | Tunables are named constants beside the code that uses them (`CHUNK_CHARS`, `MAX_CITED_PAGES`, `RECENCY_DECAY`). |
| Mass-produced tests | One table of real cases per rule, real library files for the index and citations, one integration test that drives `activate()` through the full webview protocol. |
| SaaS sparkle copy | Status and error messages state the fact and the next step: "open the assignment folder first", "No indexed reading contains this wording". |

## Known limits

- The stemmer is a short suffix list. It is applied identically to readings and answers, which matters more than linguistic accuracy, but "process" and "processes" still stem apart.
- Bookmarks rank by BM25 with a bonus for shared word pairs. Two passages that make the same argument in different vocabulary will not match. Shared words show topic overlap, and the writer still has to read the passage.
- Printed pages come from page-foot numbers and running heads. Pages between markers are counted from the nearest marker and tagged as inferred. A chapter with its own numbering gets its own offset only where at least two pages agree.
- The Knowledge Library file for Carlson is the 2018 book entry, while its page heads (416-431) match the 2015 journal article. Citation hovers say when the cited year differs from the local copy.
