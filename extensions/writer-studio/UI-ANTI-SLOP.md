# VSwriter Studio: visual rules

Rules for everything in `media/` and `themes/`. They exist so the VSwriter sidebar
reads as a small desktop tool that one person built on purpose, in the manner of
iA Writer, Bear or Sublime Text around 2022, and never as generated SaaS chrome.

Written 23 November 2026 for 0.1 and revised the same day for 0.2 (four tabs,
stances, the reading context strip, the outline and skeletons). The 0.2 patterns
have their own section below. Sources are listed at the end.

## What the research says

Generated interfaces look alike because a model left without direction picks the
most probable value for every decision. The first wave of defaults (2023 to 2025)
was indigo and purple gradients, Inter on white, a centred hero with a pill badge,
three identical rounded feature cards, glass blur, glow, emoji as icons and a
sparkle on anything a model touched. The second wave (2025 to 2026) replaced the
palette and kept the habit: warm cream with a serif and a terracotta accent, or
near-black with one acid accent, or a broadsheet of hairlines with zero radius.

Two findings shape the rules below.

1. A single trait proves little. Han Kim's measurement of 202 hand-built sites
   found purple accents on a third of them and Inter or a system face on a
   quarter. What separated them from generated pages was a designed focus state,
   a radius hierarchy, a real type system and hover, focus and active states on
   every control. The tell is a stack of defaults with nothing designed on top.
2. A ban list moves the default one step along. Ban purple and cream arrives.
   Each choice here is therefore tied to something true about VSwriter, and the ban
   list is kept as a cheap check that catches regressions.

VSwriter's brief asks for warm paper, a serif and a terracotta accent, which is the
second-wave look. The brief wins, and the reasons are specific to this product:
the editor already sets prose in `"Iowan Old Style", Charter, Georgia, serif`
(see `patches/user/writer-ide.patch`), and the panel shows the writer's own
sentences beside passages from printed readings. To keep the look earned:

- The panel stylesheet holds no colour values at all. Every colour comes from
  the active theme, so the panel is warm only when the writer chose a warm theme.
- Terracotta in VSwriter Paper is a dark brick, `#9a4a31`, used for Markdown
  headings, the cursor and progress. It appears on no button and no background.
- Hairlines separate things that are separate (two answers, two bookmarks, two
  kinds of flag). Nothing is ruled for decoration.

## Rules

### Colour

- `media/panel.css` contains no hex, `rgb()` or `hsl()` values. Use `--vscode-*`
  variables, with a second variable as the fallback. `color-mix()` on a theme
  variable is allowed for hairlines and hover washes.
- No gradients of any kind, on any surface, in any file.
- No purple, indigo, violet, fuchsia, cyan or neon green in the themes. Every
  colour with saturation above 0.5 in `themes/*.json` sits between hue 0 and 50
  (brick, ochre, amber). Slate and sage stay below that saturation.
- Two accents per theme. Paper: brick and slate. Ink: ochre and sage.
- Severity uses the theme's error, warning and info colours and always carries a
  word ("2 warnings"). Colour alone never carries meaning.
- Body text keeps a contrast ratio of 4.5 or more against its surface. Syntax
  marks that are meant to recede (asterisks, brackets, heading hashes) keep 3 or
  more. Measured values are in the table at the end.
- High-contrast themes get `--vscode-contrastBorder` for every rule.

### Type

- Three roles and three faces. Serif (`"Iowan Old Style", Charter, Georgia,
  serif`) for the writer's words, the question and verbatim reading text. The
  host UI face (`--vscode-font-family`) for controls, headings and notes.
  Monospace for locators only: page citations, line numbers, file names,
  timestamps, key names and the counts on an outline row.
- A heading from the writer's draft is the writer's words, so the outline sets
  it in the serif. A whole citation used as a one-line locator, as in the
  reading context strip, is monospace. In a full bookmark row the author is a
  name and stays in the UI face.
- No web fonts and no `@font-face`. No Inter, Geist or Space Grotesk by name.
- Five sizes: 11 (locators), 12 (notes, small headings), 13 (controls),
  14 to 15 (prose), 16 (the question). Add a sixth only with a reason.
- Sentence case everywhere. No `text-transform: uppercase`, no letter-spaced
  eyebrow labels above headings.
- One word is never italicised, coloured or bolded for effect inside a heading.

### Shape and surface

- Lists are rows divided by 1px rules. No cards, no boxes inside boxes.
- Radius: 2px on controls (buttons, stance buttons, the answer field, key caps,
  hover rows) and 0 on everything else. No pills, no circles around icons.
- No `box-shadow` (the one `box-shadow: none` resets the host's `kbd` style).
  No `backdrop-filter`, no `filter`, no blur, no glow, no translucent panels.
- No coloured stripe down the side of an item. The one left rule in the panel is
  the 1px quotation rule on a `blockquote`, which is what that mark means.
- Spacing varies with relationship: 3 to 6px inside an item, 10 to 14px between
  items, 22px between sections. One padding value on everything is a tell.

### Motion

- No `transition`, `animation`, `@keyframes` or `transform`. States change at
  once, the way native desktop controls do. Nothing fades in, slides up, lifts
  or scales on hover.
- Every control has a designed hover, active, focus-visible and disabled state.
  Focus is a 1px outline in `--vscode-focusBorder`.

### Icons and ornament

- No emoji in the interface, the copy, headings or file names.
- No sparkle, wand, star, robot, brain, lightning bolt or chat bubble. The panel
  uses no icons at all. The one icon in the extension is `media/writer-icon.svg`:
  a margin rule, a nib and the line being written, drawn by hand on a 24px grid
  with 1.5px strokes in `currentColor`.
- No arrows appended to button or link text. No middle dots joining metadata:
  an outline row reads `P1  185w  3 src  2 quotes`, each count its own span,
  set apart by 10px of space. Several gaps on one line are joined by commas.
  No decorative numbering; a count is shown only where it counts something.
- No illustration, no mascot, no empty-state artwork.

### Copy

- A button says what it does: "Save answer", "Open beside draft", "Create the
  three files". The same action keeps the same name everywhere. One short form
  is allowed: the reading context strip says "Open", because the citation sits
  beside it on the same line, and its accessible name is still "Open beside
  draft" with the citation.
- The same thing keeps the same noun. Saved answers are "answers" in the
  Interview tab and in the outline tally ("2 answers").
- Empty states say what is missing and what to do next, in one or two sentences.
- No product adjectives (seamless, powerful, smart, magic, effortless), no
  exclamation marks, and no label that calls a feature AI or names a model.
- The interface follows the same prose rules the linter enforces: no negative
  parallelism, no em dashes, no stock vocabulary.
- The panel never writes prose for the writer. A cue or a stance opens a
  sentence and stops. A skeleton places labelled slots and no sentences.

### Code

- No framework, no bundler, no build step, no dependency, no CDN. Three files:
  `panel.html`, `panel.css`, `panel.js`.
- The CSP is `default-src 'none'` with styles from the extension and one
  nonce-bound script. No inline styles, no inline handlers, no remote requests.
- Workspace text reaches the page through `textContent` and `createElement`
  only. `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` and
  `eval` do not appear in `panel.js`.
- The writer's unsaved answer is never discarded: it survives hiding the
  sidebar, and it is cleared only after the saved text comes back from the
  extension. Choosing a stance adds to typed text on a new line and never
  replaces it.
- Every field added to the state message after 0.1 is optional in `panel.js`.
  A host that omits one gets the panel without that region, never an error.

## Patterns added in 0.2

Each one reuses a rule above. None adds a colour, a size, a radius or an icon.

- **Tab bar, four tabs.** One line at every width from 222px up. The bar gives
  up space in a fixed order, measured in headless Chromium with the system UI
  face and counts of up to two digits each:

  | Sidebar width | Tab type | "Coax & Lint" | Counts |
  | --- | --- | --- | --- |
  | 373px and wider | 13px | full name | shown |
  | 327 to 372px | 13px | "Lint" | shown |
  | 291 to 326px | 12px | "Lint" | shown |
  | 222 to 290px | 12px | "Lint" | hidden |

  Below 222px the bar wraps to a second line and still never scrolls sideways.
  The counts outrank the first words of the last tab because a count is live
  information and the name is not. The Outline count is the number of
  paragraphs that still have a gap, and the tab's tooltip says so in words.
- **Stances.** Up to three plain bordered buttons under the question, labelled
  "Start from a stance:". Short ones share a line and a long one wraps inside
  its own border. They are the ordinary `.btn` and carry no icon and no fill.
- **Reading context.** One or two passages between a top and a bottom rule,
  directly above the answer field. It is a strip: no side borders, no fill, no
  radius. Each passage is the usual `blockquote` with its 1px quotation rule,
  cut at a word boundary near 180 characters with a horizontal ellipsis that
  marks the cut. The full passage and the reason stay in the Bookmarks tab.
- **Outline rows.** One row per paragraph, divided by rules. The row is a
  borderless button with the same hover wash as a flag row. It holds a
  monospace line of counts, one serif line of the paragraph's opening cut by
  the layout, and, where something is missing, a line of plain words in the
  theme's warning colour.
- **Skeleton rows.** Name and "Insert" on one line, the description across the
  full width beneath, rows divided by rules. "Insert" is disabled, with a note
  saying why, while no Markdown draft is open.
- **Wide tokens.** A path or an unbroken string wider than the sidebar breaks
  inside the word. Nothing in the panel may cause a sideways scroll at 230px.

## Check before committing

Run from `extensions/writer-studio`. Each command should print nothing.

```sh
# colour literals, gradients, shadow, blur, motion, remote assets in the stylesheet
grep -nE '#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|gradient\(|backdrop-filter|filter:|transform:|transition|animation|@keyframes|@import|@font-face|url\(|text-transform|letter-spacing' media/panel.css
grep -n 'box-shadow' media/panel.css | grep -v 'box-shadow: none'
grep -n 'border-radius' media/panel.css | grep -v 'border-radius: 2px'

# unsafe DOM writes and remote requests in the script and markup
grep -nE 'innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|https?://' media/panel.js media/panel.html

# emoji, sparkles, arrows and middle dots anywhere in the shipped assets
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{1F000}-\x{1FAFF}\x{2600}-\x{27BF}\x{2B00}-\x{2BFF}\x{2190}-\x{21FF}\x{00B7}]/' media/* themes/*

# themes: valid JSON, same keys in both, and no saturated colour outside hue 0-50
python3 - <<'EOF'
import json, colorsys
a, b = (json.load(open('themes/writer-%s.json' % n)) for n in ('paper', 'ink'))
assert list(a['colors']) == list(b['colors']), 'themes define different keys'
for t in (a, b):
    for v in list(t['colors'].values()) + [r['settings'].get('foreground', '') for r in t['tokenColors']]:
        if not v.startswith('#'): continue
        r, g, bl = (int(v[i:i + 2], 16) / 255 for i in (1, 3, 5))
        h, l, s = colorsys.rgb_to_hls(r, g, bl)
        if s > 0.5 and 0.15 < l < 0.85 and not h * 360 <= 50: print(t['name'], v, round(h * 360))
EOF
```

## Measured contrast

Computed with the WCAG 2 formula on 23 November 2026.

| Pair | VSwriter Paper | VSwriter Ink |
| --- | --- | --- |
| Text on editor | 15.3 | 13.6 |
| Text on sidebar | 14.3 | 12.8 |
| Secondary text on sidebar | 6.2 | 6.6 |
| Link on sidebar | 5.8 | 7.2 |
| Button label on button | 11.2 | 8.6 |
| Inactive tab label | 4.9 | 4.8 |
| Placeholder on input | 4.7 | 4.8 |
| Markdown heading on editor | 5.8 | 7.7 |
| Block quote on editor | 6.4 | 8.3 |
| Faintest syntax mark on editor | 3.1 | 3.1 |

## Sources

Read for this note. Search results and summaries were treated as leads; the rules
above keep only what applied to a sidebar inside an editor.

- Anthropic, `frontend-design` skill, version 1.1.1 (local plugin copy): the
  five clusters current generated design falls into, and the guidance on copy.
- Han Kim, "The Tells: A Measurable Taxonomy of the AI-Generated Design Look",
  IOV Labs draft, June 2026, with `github.com/hankimis/ai-design-tells`: the 27
  tells, the 202-site comparison and the craft-credit finding.
- "AI Slop in 2026: A Field Guide to the AI-Generated Web", sailop.com, April
  2026: the Tailwind palette, Inter and Geist, Lucide sparkle, `rounded-2xl`.
- "Anti-vibe-coded UI", ayeeye.net, revised October 2026: first and second wave
  lists, and the point that a ban list alone moves the default.
- `github.com/claudiusararu/unslop-ui-skill`, `TELLS.md`: glass, orbs, icon
  chips, the shadcn card default.
- badhtml.com, "AI-Slop Website Design", and design.yaps.ai, "Anti-slop
  principles": coloured side borders, nested cards, mechanical spacing.
- VS Code documentation: Webview API guide (theming variables, CSP, sanitising
  workspace text) and the Webview UX guidelines.
