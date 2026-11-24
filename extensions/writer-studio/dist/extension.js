var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};

// src/extension.ts
var exports_extension = {};
__export(exports_extension, {
  deactivate: () => deactivate,
  activate: () => activate
});
module.exports = __toCommonJS(exports_extension);
var crypto5 = __toESM(require("crypto"));
var fs8 = __toESM(require("fs"));
var os3 = __toESM(require("os"));
var path8 = __toESM(require("path"));
var vscode = __toESM(require("vscode"));

// src/core/citationNav.ts
var YEAR = "(?:1[89]|20)\\d{2}";
var GROUP = new RegExp(`\\(([^()]*?\\b${YEAR}[a-z]?\\b[^()]*)\\)`, "g");
var NAME = "\\p{Lu}[\\p{L}'’-]+";
var ONE = new RegExp(`^(?:(?:[Ss]ee|[Cc]f\\.|e\\.g\\.,?)\\s+)?(${NAME}(?:\\s+${NAME})?)` + `(?:\\s+(?:and|&)\\s+${NAME}|\\s+et al\\.)?,?\\s+(${YEAR})[a-z]?` + `(?:\\s*[:,]\\s*(?:pp?\\.\\s*)?(\\d{1,4})(?:\\s*[-–]\\s*(\\d{1,4}))?)?$`, "u");
function expandRangeEnd(start, endText) {
  const end = Number(endText);
  if (end >= start || endText.length >= String(start).length) {
    return end;
  }
  const head = String(start).slice(0, String(start).length - endText.length);
  return Number(head + endText);
}
function parseCitations(text) {
  const out = [];
  for (const group of text.matchAll(GROUP)) {
    const inner = group[1];
    let offset = group.index + 1;
    for (const part of inner.split(";")) {
      const lead = part.length - part.trimStart().length;
      const trimmed = part.trim();
      const m = ONE.exec(trimmed);
      if (m) {
        const pageStart = m[3] ? Number(m[3]) : null;
        out.push({
          surname: m[1],
          year: m[2],
          pageStart,
          pageEnd: m[4] && pageStart !== null ? expandRangeEnd(pageStart, m[4]) : pageStart,
          start: offset + lead,
          end: offset + lead + trimmed.length,
          text: trimmed
        });
      }
      offset += part.length + 1;
    }
  }
  return out;
}
function citationAt(lineText, character) {
  return parseCitations(lineText).find((c) => character >= c.start && character <= c.end) ?? null;
}
function resolveCitation(index, c) {
  const docs = index.findDocs(c.surname);
  if (!docs.length) {
    return null;
  }
  const sameYear = docs.filter((d) => d.year === c.year);
  const pool = sameYear.length ? sameYear : docs;
  const notes = [];
  const yearNote = (d) => {
    if (d.year !== c.year) {
      notes.push(`The local copy is dated ${d.year}. You cited ${c.year}, so check that the page numbers come from the same edition.`);
    }
  };
  if (c.pageStart === null) {
    yearNote(pool[0]);
    return { doc: pool[0], passages: pool[0].passages.slice(0, 1), notes };
  }
  for (const doc of pool) {
    const passages = index.passagesOnPage(doc, c.pageStart);
    if (passages.length) {
      yearNote(doc);
      const kind = passages[0].pageKind;
      if (kind === "inferred") {
        notes.push(`Page ${c.pageStart} carries no printed number in the extraction. It is counted from the nearest printed page.`);
      } else if (kind === "pdf") {
        notes.push(`This reading has no printed page numbers, so page ${c.pageStart} was read as the PDF position.`);
      }
      return { doc, passages, notes };
    }
  }
  yearNote(pool[0]);
  notes.push(`Page ${c.pageStart} is outside the pages in the local copy.`);
  return { doc: pool[0], passages: [], notes };
}
var HOVER_CHARS = 1200;
function escapeMarkdown(s) {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, "\\$&");
}
function formatHover(c, r, fileLink) {
  if (!r) {
    return escapeMarkdown(`No indexed reading has an author named ${c.surname}.`);
  }
  const parts = [];
  const page = c.pageStart === null ? "" : c.pageEnd !== c.pageStart ? `, pp. ${c.pageStart}-${c.pageEnd}` : `, p. ${c.pageStart}`;
  parts.push(`**${escapeMarkdown(`${r.doc.author} ${r.doc.year}${page}`)}**  
${escapeMarkdown(r.doc.title)}`);
  let used = 0;
  for (const p of r.passages) {
    if (used >= HOVER_CHARS) {
      break;
    }
    const text = p.text.length > HOVER_CHARS - used ? p.text.slice(0, HOVER_CHARS - used) + " [...]" : p.text;
    used += text.length;
    parts.push(`> ${escapeMarkdown(text)}

[${escapeMarkdown(`line ${p.line}`)}](${fileLink(p)})`);
  }
  for (const note of r.notes) {
    parts.push(`*${escapeMarkdown(note)}*`);
  }
  return parts.join(`

`);
}
function registerCitationNav(vscode, getIndex) {
  const selector = { language: "markdown" };
  const lookup = (doc, pos) => {
    const index = getIndex();
    const c = index ? citationAt(doc.lineAt(pos.line).text, pos.character) : null;
    return index && c ? { c, r: resolveCitation(index, c) } : null;
  };
  const fileLink = (p) => vscode.Uri.file(p.filePath).with({ fragment: `L${p.line}` }).toString();
  const hover = vscode.languages.registerHoverProvider(selector, {
    provideHover(doc, pos) {
      const found = lookup(doc, pos);
      if (!found) {
        return;
      }
      const md = new vscode.MarkdownString(formatHover(found.c, found.r, fileLink));
      return new vscode.Hover(md, new vscode.Range(pos.line, found.c.start, pos.line, found.c.end));
    }
  });
  const definition = vscode.languages.registerDefinitionProvider(selector, {
    provideDefinition(doc, pos) {
      const found = lookup(doc, pos);
      const target = found?.r?.passages[0];
      if (!target) {
        return;
      }
      return new vscode.Location(vscode.Uri.file(target.filePath), new vscode.Position(target.line - 1, 0));
    }
  });
  return vscode.Disposable.from(hover, definition);
}

// src/core/readingsIndex.ts
var import_fs = require("fs");
var os = __toESM(require("os"));
var path = __toESM(require("path"));
var STOPWORDS = new Set(("a about above after again against all am an and any are as at be because been before being below between both but by " + "can cannot could did do does doing down during each few for from further had has have having he her here hers herself " + "him himself his how i if in into is it its itself let me more most my myself no nor not of off on once only or other " + "ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there " + "these they this those through to too under until up very was we were what when where which while who whom why with would " + "you your yours yourself yourselves also just like really thing things kind kinda sort actually basically honestly maybe " + "probably lot lots way ways make makes made get gets got say says said gonna going even much many well still yet one ones " + "two will dont doesnt isnt cant wont thats etc ibid page pages think thought something someone people").split(/\s+/));
var SUFFIXES = [
  ["ational", "ate"],
  ["izations", "ize"],
  ["ization", "ize"],
  ["ations", "ate"],
  ["ation", "ate"],
  ["nesses", ""],
  ["ness", ""],
  ["ments", ""],
  ["ment", ""],
  ["ingly", ""],
  ["ings", ""],
  ["ing", ""],
  ["edly", ""],
  ["ies", "y"],
  ["ied", "y"],
  ["ed", ""],
  ["ly", ""],
  ["s", ""]
];
function stem(word) {
  let w = word;
  if (w.length > 4) {
    for (const [suffix, replacement] of SUFFIXES) {
      if (w.endsWith(suffix) && !(suffix === "s" && w.endsWith("ss")) && w.length - suffix.length + replacement.length >= 3) {
        w = w.slice(0, w.length - suffix.length) + replacement;
        break;
      }
    }
  }
  if (w.length > 3 && w.endsWith("e")) {
    w = w.slice(0, -1);
  }
  return w;
}
function joinHyphens(s) {
  return s.replace(/(\p{L})-\s(\p{L})/gu, "$1$2");
}
var WORD = /\p{L}[\p{L}'’]*(?:-\s\p{L}[\p{L}'’]*)*/gu;
function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(WORD)) {
    const word = m[0].toLowerCase().replace(/-\s/g, "").replace(/['’]s$/, "").replace(/['’]/g, "");
    if (word.length < 3 || STOPWORDS.has(word)) {
      continue;
    }
    out.push({ stem: stem(word), surface: word, start: m.index, end: m.index + m[0].length });
  }
  return out;
}
function normalizeForMatch(s) {
  return joinHyphens(s.toLowerCase()).replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}
var UNIT_HEADING = /^## (PDF page|EPUB section|Text section) (\d+)\b/;
var TRANSCRIPT_TIME = /^\*\*\[(\d{1,2}:\d{2}:\d{2})/;
var PLAIN_PAGE_MARKER = /^\s*\[?\s*(?:p\.|page)\s*(\d{1,4})\s*\]?\s*$/i;
var PRINTED_NUMBER = [/^(\d{1,4})$/, /^(\d{1,4})\s{2,}\S/, /\S\s{2,}(\d{1,4})$/];
var SKIP_LINE = /^(?:<|\[View original|- \[|---|\*Visual content|> Source limits|Copyright ©|#)/;
var SKIP_ANYWHERE = /This content downloaded from|jstor\.org\/(?:terms|stable)|^This is a formatted primary-text extraction/i;
var AUTHOR_SKIP = new Set(["week", "lecture", "required", "supplemental", "optional", "current", "syllabus", "chapter", "the", "notes"]);
var MIN_PASSAGE_CHARS = 40;
var CHUNK_CHARS = 420;
function detectPrintedNumber(line) {
  const t = line.trim();
  if (t.length > 90) {
    return null;
  }
  for (const re of PRINTED_NUMBER) {
    const m = re.exec(t);
    if (m) {
      const n = Number(m[1]);
      return n >= 1 ? n : null;
    }
  }
  return null;
}
function parseAuthor(title) {
  if (/^Lecture \d{4}-\d{2}-\d{2}/.test(title)) {
    return { author: "Lecture", surnames: ["Lecture"] };
  }
  const name = "[\\p{Lu}][\\p{L}'’-]+";
  const comma = new RegExp(`^(${name}(?: ${name})?),`, "u").exec(title);
  if (comma) {
    const surnames = [comma[1]];
    const authorPart = title.split(/\.\s+["“\p{Lu}]/u)[0];
    for (const m of authorPart.matchAll(new RegExp(`\\band (?:${name}\\.? )+?(${name})(?=[,.]|$)`, "gu"))) {
      surnames.push(m[1]);
    }
    return { author: comma[1], surnames };
  }
  for (const segment of title.split(/\s+[—–]\s+/)) {
    const s = segment.trim();
    if (/\d/.test(s) || AUTHOR_SKIP.has(s.split(" ")[0].toLowerCase())) {
      continue;
    }
    const people = s.split(/ and /);
    if (people.every((p) => new RegExp(`^${name}(?: (?:${name}|\\p{Lu}\\.))*$`, "u").test(p))) {
      const surnames = people.map((p) => p.split(" ").pop());
      return { author: surnames[0], surnames };
    }
    break;
  }
  for (const word of title.split(/[\s_-]+/)) {
    if (/^\p{Lu}\p{Ll}+$/u.test(word) && !AUTHOR_SKIP.has(word.toLowerCase())) {
      return { author: word, surnames: [word] };
    }
  }
  return { author: title.slice(0, 40), surnames: [] };
}
function parseYear(title) {
  const paren = /\((\d{4})\)/.exec(title) ?? /\b(1[89]\d{2}|20\d{2})\b/.exec(title);
  return paren ? paren[1] : "n.d.";
}
function splitUnits(lines) {
  const units = [];
  for (let i = 0;i < lines.length; i++) {
    const m = UNIT_HEADING.exec(lines[i]);
    if (m) {
      if (units.length) {
        units[units.length - 1].end = i;
      }
      units.push({ kind: m[1] === "PDF page" ? "pdf" : "section", num: Number(m[2]), start: i + 1, end: lines.length, candidates: [], printed: null, printedKind: null });
    }
  }
  if (!units.length) {
    let start = 0;
    if (lines[0]?.trim() === "---") {
      const close = lines.indexOf("---", 1);
      start = close > 0 ? close + 1 : 0;
    }
    units.push({ kind: "none", num: 0, start, end: lines.length, candidates: [], printed: null, printedKind: null });
  }
  return units;
}
function assignPrintedPages(units, lines) {
  const pdfUnits = units.filter((u) => u.kind === "pdf");
  if (!pdfUnits.length) {
    return;
  }
  const offsetCounts = new Map;
  for (const u of pdfUnits) {
    for (let i = u.start;i < u.end; i++) {
      const n = detectPrintedNumber(lines[i]);
      if (n !== null) {
        u.candidates.push(n);
      }
    }
    for (const offset of new Set(u.candidates.map((n) => n - u.num))) {
      offsetCounts.set(offset, (offsetCounts.get(offset) ?? 0) + 1);
    }
  }
  const unitsWithCandidates = pdfUnits.filter((u) => u.candidates.length).length;
  const kept = [];
  pdfUnits.forEach((u, index) => {
    let best = null;
    for (const n of u.candidates) {
      const offset = n - u.num;
      const count = offsetCounts.get(offset);
      if ((count >= 2 || unitsWithCandidates === 1) && (best === null || count > offsetCounts.get(best))) {
        best = offset;
      }
    }
    if (best !== null) {
      u.printed = u.num + best;
      u.printedKind = "printed";
      kept.push({ index, offset: best });
    }
  });
  if (!kept.length) {
    return;
  }
  const single = kept.every((k) => k.offset === kept[0].offset);
  pdfUnits.forEach((u, index) => {
    if (u.printed !== null) {
      return;
    }
    let offset = null;
    if (single) {
      offset = kept[0].offset;
    } else {
      const prev = [...kept].reverse().find((k) => k.index < index);
      const next = kept.find((k) => k.index > index);
      if (prev && next && prev.offset === next.offset) {
        offset = prev.offset;
      } else if (prev && index - prev.index <= 2) {
        offset = prev.offset;
      } else if (next && next.index - index <= 2) {
        offset = next.offset;
      }
    }
    if (offset !== null && u.num + offset >= 1) {
      u.printed = u.num + offset;
      u.printedKind = "inferred";
    }
  });
}
function pageLabel(kind, printed, pdf) {
  switch (kind) {
    case "printed":
    case "inferred":
      return String(printed);
    case "pdf":
      return `PDF ${pdf}`;
    case "section":
      return `section ${pdf}`;
    default:
      return "";
  }
}
function chunkLine(line) {
  const spans = [];
  const sentenceEnd = /[.!?]+["”’)\]]*\s+/g;
  let start = 0;
  let m;
  while (m = sentenceEnd.exec(line)) {
    const end = m.index + m[0].length;
    if (end - start >= CHUNK_CHARS) {
      spans.push([start, end]);
      start = end;
    }
  }
  if (start < line.length) {
    if (spans.length && line.length - start < MIN_PASSAGE_CHARS * 2) {
      spans[spans.length - 1][1] = line.length;
    } else {
      spans.push([start, line.length]);
    }
  }
  return spans.map(([s, e]) => line.slice(s, e).trim());
}
function parseReading(filePath, content, docIndex = 0) {
  const lines = content.split(/\r?\n/);
  const titleLine = lines.find((l) => /^# /.test(l));
  const title = titleLine ? titleLine.slice(2).trim() : path.basename(filePath).replace(/\.(md|txt)$/i, "");
  const { author, surnames } = parseAuthor(title);
  const doc = { filePath, title, author, surnames, year: parseYear(title), passages: [] };
  const units = splitUnits(lines);
  assignPrintedPages(units, lines);
  const base = path.basename(filePath).replace(/\.(md|txt)$/i, "");
  for (const u of units) {
    let plainPrinted = null;
    let clock = null;
    for (let i = u.start;i < u.end; i++) {
      const line = lines[i];
      if (u.kind === "none") {
        const marker = PLAIN_PAGE_MARKER.exec(line);
        if (marker) {
          plainPrinted = Number(marker[1]);
          continue;
        }
      }
      const time = TRANSCRIPT_TIME.exec(line);
      if (time) {
        clock = time[1];
      }
      const trimmed = line.trim();
      if (trimmed.length < MIN_PASSAGE_CHARS || SKIP_LINE.test(trimmed) || SKIP_ANYWHERE.test(trimmed) || detectPrintedNumber(trimmed) !== null) {
        continue;
      }
      let kind;
      let printed = null;
      if (u.kind === "pdf") {
        kind = u.printedKind ?? "pdf";
        printed = u.printed;
      } else if (u.kind === "section") {
        kind = "section";
      } else {
        kind = plainPrinted !== null ? "printed" : "none";
        printed = plainPrinted;
      }
      const pdf = u.kind === "none" ? null : u.num;
      chunkLine(line).forEach((text, k) => {
        if (text.length < MIN_PASSAGE_CHARS) {
          return;
        }
        doc.passages.push({
          id: `${base}:${i + 1}:${k}`,
          doc: docIndex,
          filePath,
          line: i + 1,
          page: clock && kind !== "pdf" ? clock : pageLabel(kind, printed, pdf),
          pageKind: kind,
          printedPage: printed,
          pdfPage: pdf,
          text
        });
      });
    }
  }
  return doc;
}
var EXCLUDED_DIRS = new Set(["archive", "aliases", "working notes", "node_modules"]);
var EXCLUDED_FILES = new Set(["readme.md", "agents.md", "claude.md", "changelog.md", "raw-answers.md", "interview-state.md", "source-map.md"]);
var WORKSPACE_READING_DIR = /^(readings?|sources?|knowledge library)$/i;
var MAX_FILE_BYTES = 20 * 1024 * 1024;
function expandHome(p) {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(1)) : p;
}
async function walk(dir, out, inReadingDir, workspaceMode) {
  let entries;
  try {
    entries = await import_fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name.toLowerCase())) {
        await walk(full, out, inReadingDir || WORKSPACE_READING_DIR.test(entry.name), workspaceMode);
      }
    } else if (/\.(md|txt)$/i.test(entry.name) && !EXCLUDED_FILES.has(entry.name.toLowerCase())) {
      if (!workspaceMode || inReadingDir) {
        out.push(full);
      }
    }
  }
}
var K1 = 1.2;
var B = 0.75;
var RECENCY_DECAY = 0.85;
var ANSWERS_CONSIDERED = 8;
var CANDIDATES_PER_ANSWER = 40;
var MAX_PER_READING = 2;
var MAX_PHRASE_GAP_WORDS = 2;
var NOTE_PENALTY = 0.35;
var NOTE_LINE = /^\s*(?:\d{1,3}\.\s|\[\d{1,3}\])/;
function looksLikeNotes(text) {
  return NOTE_LINE.test(text) || (text.match(/\b(?:19|20)\d{2}\b/g) ?? []).length >= 3;
}

class ReadingsIndex {
  docs = [];
  passages = [];
  postings = new Map;
  lengths = [];
  totalLength = 0;
  normalized = [];
  static async build(readingDirs, workspaceDirs = []) {
    const files = [];
    for (const dir of readingDirs) {
      await walk(expandHome(dir), files, true, false);
    }
    for (const dir of workspaceDirs) {
      await walk(dir, files, false, true);
    }
    const index = new ReadingsIndex;
    for (const file of [...new Set(files)].sort()) {
      try {
        const stat = await import_fs.promises.stat(file);
        if (stat.size <= MAX_FILE_BYTES) {
          index.add(file, await import_fs.promises.readFile(file, "utf8"));
        }
      } catch {}
    }
    return index;
  }
  get size() {
    return this.passages.length;
  }
  add(filePath, content) {
    const doc = parseReading(filePath, content, this.docs.length);
    this.docs.push(doc);
    this.normalized.push(normalizeForMatch(content));
    for (const p of doc.passages) {
      const idx = this.passages.length;
      this.passages.push(p);
      const tokens = tokenize(p.text);
      this.lengths.push(tokens.length);
      this.totalLength += tokens.length;
      const tf = new Map;
      for (const t of tokens) {
        tf.set(t.stem, (tf.get(t.stem) ?? 0) + 1);
      }
      for (const [term, count] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push(idx, count);
      }
    }
    return doc;
  }
  idf(term) {
    const df = (this.postings.get(term)?.length ?? 0) / 2;
    const n = this.passages.length;
    return Math.log(1 + (n - df + 0.5) / (df + 0.5));
  }
  containsQuote(quote) {
    const fragments = quote.split(/\.\s?\.\s?\.|…|\[\s*\.\.\.\s*\]/).map(normalizeForMatch).filter((f) => f.length >= 12);
    if (!fragments.length) {
      return true;
    }
    return this.normalized.some((text) => fragments.every((f) => text.includes(f)));
  }
  findDocs(surname) {
    const want = normalizeForMatch(surname);
    return this.docs.filter((d) => d.surnames.some((s) => {
      const have = normalizeForMatch(s);
      return have === want || have.split(" ")[0] === want;
    }));
  }
  passagesOnPage(doc, page) {
    const printed = doc.passages.filter((p) => p.printedPage === page);
    return printed.length ? printed : doc.passages.filter((p) => p.pageKind === "pdf" && p.pdfPage === page);
  }
  searchPassages(text, limit = 30) {
    const terms = [...new Set(tokenize(text).map((t) => t.stem))];
    if (!terms.length || !this.passages.length) {
      return [];
    }
    const avgLength = this.totalLength / this.passages.length;
    const scores = new Map;
    const hits = new Map;
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) {
        continue;
      }
      const idf = this.idf(term);
      for (let i = 0;i < list.length; i += 2) {
        const p = list[i];
        const tf = list[i + 1];
        scores.set(p, (scores.get(p) ?? 0) + idf * tf * (K1 + 1) / (tf + K1 * (1 - B + B * this.lengths[p] / avgLength)));
        hits.set(p, (hits.get(p) ?? 0) + 1);
      }
    }
    const need = Math.min(2, terms.length);
    return [...scores.entries()].filter(([p]) => hits.get(p) >= need).sort((a, b) => b[1] - a[1]).slice(0, limit).map(([p]) => this.passages[p]);
  }
  docOf(passage) {
    return this.docs[passage.doc];
  }
  scoreAnswer(answer, weight) {
    const tokens = tokenize(answer.text);
    const surface = new Map;
    for (const t of tokens) {
      if (!surface.has(t.stem)) {
        surface.set(t.stem, t.surface);
      }
    }
    if (surface.size < 2) {
      return [];
    }
    const avgLength = this.totalLength / Math.max(1, this.passages.length);
    const scores = new Map;
    const shared = new Map;
    for (const term of surface.keys()) {
      const list = this.postings.get(term);
      if (!list) {
        continue;
      }
      const idf = this.idf(term);
      for (let i = 0;i < list.length; i += 2) {
        const p = list[i];
        const tf = list[i + 1];
        const norm = tf * (K1 + 1) / (tf + K1 * (1 - B + B * this.lengths[p] / avgLength));
        scores.set(p, (scores.get(p) ?? 0) + idf * norm);
        let terms = shared.get(p);
        if (!terms) {
          terms = [];
          shared.set(p, terms);
        }
        terms.push(term);
      }
    }
    const candidates = [...scores.entries()].filter(([p]) => shared.get(p).length >= 2).sort((a, b) => b[1] - a[1]).slice(0, CANDIDATES_PER_ANSWER);
    const bigrams = [];
    for (let i = 1;i < tokens.length; i++) {
      const between = answer.text.slice(tokens[i - 1].end, tokens[i].start).trim();
      if (between.split(/\s+/).length > MAX_PHRASE_GAP_WORDS || /[.!?;:,]/.test(between)) {
        continue;
      }
      bigrams.push({
        key: tokens[i - 1].stem + " " + tokens[i].stem,
        phrase: answer.text.slice(tokens[i - 1].start, tokens[i].end).replace(/\s+/g, " "),
        bonus: (this.idf(tokens[i - 1].stem) + this.idf(tokens[i].stem)) / 2
      });
    }
    return candidates.map(([p, score]) => {
      const passageTokens = tokenize(this.passages[p].text);
      const passageBigrams = new Set;
      for (let i = 1;i < passageTokens.length; i++) {
        passageBigrams.add(passageTokens[i - 1].stem + " " + passageTokens[i].stem);
      }
      let phrase = null;
      let bestBonus = 0;
      let bonus = 0;
      for (const bg of bigrams) {
        if (passageBigrams.has(bg.key)) {
          bonus += bg.bonus;
          if (bg.bonus > bestBonus) {
            bestBonus = bg.bonus;
            phrase = bg.phrase;
          }
        }
      }
      const terms = shared.get(p);
      const coverage = Math.sqrt(terms.length / surface.size);
      const sharedSurface = terms.sort((a, b) => this.idf(b) - this.idf(a)).map((t) => surface.get(t));
      const penalty = looksLikeNotes(this.passages[p].text) ? NOTE_PENALTY : 1;
      return { passage: p, score: (score + bonus) * coverage * weight * penalty, answer, shared: sharedSurface, phrase };
    });
  }
  matchBookmarks(rawAnswers, maxResults = 6) {
    if (!this.passages.length || !rawAnswers.length) {
      return [];
    }
    const recent = rawAnswers.slice(-ANSWERS_CONSIDERED).reverse();
    const best = new Map;
    recent.forEach((answer, k) => {
      for (const m of this.scoreAnswer(answer, Math.pow(RECENCY_DECAY, k))) {
        const prev = best.get(m.passage);
        if (!prev || m.score > prev.score) {
          best.set(m.passage, m);
        }
      }
    });
    const perReading = new Map;
    const results = [];
    for (const m of [...best.values()].sort((a, b) => b.score - a.score)) {
      const p = this.passages[m.passage];
      const doc = this.docs[p.doc];
      const work = doc.author + " " + doc.year;
      const used = perReading.get(work) ?? 0;
      if (used >= MAX_PER_READING) {
        continue;
      }
      perReading.set(work, used + 1);
      results.push({
        id: p.id,
        author: doc.author,
        year: doc.year,
        page: p.page,
        filePath: p.filePath,
        line: p.line,
        excerpt: p.text,
        reason: explainMatch(m, p),
        score: Math.round(m.score * 100) / 100
      });
      if (results.length >= maxResults) {
        break;
      }
    }
    return results;
  }
}
function shortPrompt(prompt) {
  return prompt.length > 70 ? prompt.slice(0, 67).replace(/\s+\S*$/, "") + "..." : prompt;
}
function listWords(words) {
  if (words.length <= 1) {
    return words.join("");
  }
  return words.slice(0, -1).join(", ") + " and " + words[words.length - 1];
}
function explainMatch(m, p) {
  const where = `your answer to "${shortPrompt(m.answer.prompt)}"`;
  let reason;
  if (m.phrase) {
    const inPhrase = new Set(tokenize(m.phrase).map((t) => t.surface));
    const others = m.shared.filter((w) => !inPhrase.has(w)).slice(0, 3);
    reason = `You wrote "${m.phrase}" in ${where}, and this passage uses the same words together.`;
    if (others.length) {
      reason += ` It also mentions ${listWords(others)}.`;
    }
  } else {
    reason = `This passage uses ${listWords(m.shared.slice(0, 4))}, which you used in ${where}.`;
  }
  reason = reason.charAt(0).toUpperCase() + reason.slice(1);
  if (p.pageKind === "inferred") {
    reason += " The page number is counted from the nearest printed page number in this reading.";
  } else if (p.pageKind === "pdf") {
    reason += " This reading prints no page number here, so the page shown is the PDF position.";
  }
  return reason;
}

// src/core/skeletons.ts
var SKELETONS = [
  {
    id: "body-triangulate",
    label: "Body paragraph (3 sources)",
    description: "Your claim, three quoted sources with a line each, and a bridge.",
    slots: [
      "[Claim: one sentence, in your own words, that this paragraph proves.]",
      '[Source 1: "quote" (Author Year: page). One sentence on what it shows.]',
      '[Source 2: "quote" (Author Year: page). One sentence on what it adds.]',
      '[Source 3: "quote" (Author Year: page). One sentence on where it differs.]',
      "[Bridge: one sentence, in your own words, on what this sets up next.]"
    ]
  },
  {
    id: "caveat-tradeoff",
    label: "Caveat and trade-off",
    description: "The tension, the strongest evidence against you, and why your claim still holds.",
    slots: [
      "[Tension: one sentence naming where your claim meets resistance.]",
      '[Counter-evidence: "quote" (Author Year: page). The strongest point against you.]',
      "[Trade-off: one sentence on what your position costs and why it still holds.]"
    ]
  },
  {
    id: "synthesis-bridge",
    label: "Synthesis and transition",
    description: "Joins two loose notes into one point and hands it to the next section.",
    slots: [
      "[Note A: the first idea, in a few words.]",
      "[Note B: the second idea, in a few words.]",
      "[Link: one sentence on what A and B show together.]",
      "[Next: one sentence on the question this leaves for the next section.]"
    ]
  }
];
var SKELETON_OPTIONS = SKELETONS.map(({ id, label, description }) => ({ id, label, description }));
function getSkeletonText(id) {
  const s = SKELETONS.find((k) => k.id === id);
  return s ? s.slots.join(`
`) : null;
}
var SLOT = /\[[A-Z][\w -]{0,30}:[^\]\n]*\](?!\()/g;
function planSkeletonInsert(lines, cursorLine, skeleton) {
  const blank = (i) => !lines[i]?.trim();
  let at = Math.min(Math.max(0, cursorLine), Math.max(0, lines.length - 1));
  while (at < lines.length && !blank(at)) {
    at++;
  }
  if (at >= lines.length) {
    const last = lines.length - 1;
    return { line: last, character: lines[last].length, text: `

` + skeleton, firstSlotLine: last + 2 };
  }
  const before = at > 0 && !blank(at - 1) ? `
` : "";
  return { line: at, character: 0, text: before + skeleton + `
`, firstSlotLine: at + (before ? 1 : 0) };
}

// src/core/argumentOutline.ts
var TARGET_SOURCES = 3;
var SHORT_WORDS = 80;
var LONG_WORDS = 250;
var PREVIEW_CHARS = 75;
var MIN_QUOTE_CHARS = 15;
var MAX_MATCHED_ANSWERS = 3;
var HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
var BACK_MATTER = /^(?:bibliography|references|works cited|sources|reference list|sources cited)$/i;
var INTRO = /\b(?:intro|introduction)\b/i;
var CONCLUSION = /\b(?:conclusion|conclusions|concluding)\b/i;
var RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
var TABLE = /^\s*\|/;
var FENCE = /^\s*(```|~~~)/;
var COMMENT = /<!--[\s\S]*?-->/g;
var QUOTE = /“([^”]+)”|"([^"]+)"/g;
var COUNTER = /\b(?:yet|however|although|though|caveat|limit|limits|limited|limitation|limitations|objection|objections|trade-?offs?|trade offs?)\b/i;
var NARRATIVE = /(\p{Lu}[\p{L}'’-]+)(?:\s+(?:and|&)\s+\p{Lu}[\p{L}'’-]+|\s+et al\.)?\s+\(((?:1[89]|20)\d{2})[a-z]?(?:\s*[:,][^()]*)?\)/gu;
function splitParagraphs(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let heading = "(Opening)";
  let current = null;
  let inFence = false;
  let inComment = false;
  const flush = () => {
    if (current) {
      out.push(current);
      current = null;
    }
  };
  let i = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, k) => k > 0 && l.trim() === "---");
    i = close > 0 ? close + 1 : 0;
  }
  for (;i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }
    if (inComment) {
      if (line.includes("-->")) {
        inComment = false;
      }
      continue;
    }
    if (line.includes("<!--") && !line.slice(line.indexOf("<!--")).includes("-->")) {
      inComment = true;
      if (!line.slice(0, line.indexOf("<!--")).trim()) {
        continue;
      }
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      heading = h[2].replace(/[*_`]/g, "").trim() || heading;
      if (BACK_MATTER.test(heading)) {
        break;
      }
      continue;
    }
    if (!line.trim() || RULE.test(line) || TABLE.test(line) || /^\s*>/.test(line)) {
      flush();
      continue;
    }
    if (current) {
      current.text += `
` + line;
    } else {
      current = { line: i + 1, heading, text: line };
    }
  }
  flush();
  return out;
}
function proseOf(text) {
  return text.replace(COMMENT, " ").replace(SLOT, " ").replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "").replace(/[*_`]+/g, "").replace(/\s+/g, " ").trim();
}
function countWords(prose) {
  return (prose.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}
function preview(prose) {
  if (prose.length <= PREVIEW_CHARS) {
    return prose;
  }
  const cut = prose.slice(0, PREVIEW_CHARS - 3);
  const space = cut.lastIndexOf(" ");
  return (space > PREVIEW_CHARS / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "") + "...";
}
function distinctSources(prose) {
  const keys = new Set;
  for (const c of parseCitations(prose)) {
    keys.add(`${c.surname.toLowerCase()} ${c.year}`);
  }
  for (const m of prose.matchAll(NARRATIVE)) {
    keys.add(`${m[1].toLowerCase()} ${m[2]}`);
  }
  return keys.size;
}
function quoteCount(prose) {
  let n = 0;
  for (const m of prose.matchAll(QUOTE)) {
    if ((m[1] ?? m[2]).trim().length >= MIN_QUOTE_CHARS) {
      n++;
    }
  }
  return n;
}
function matchAnswers(prose, answers) {
  const words = new Set(tokenize(prose).map((t) => t.stem));
  const scored = [];
  answers.forEach((a, order) => {
    const stems = new Set(tokenize(a.text).map((t) => t.stem));
    let shared = 0;
    for (const s of stems) {
      if (words.has(s)) {
        shared++;
      }
    }
    if (shared >= Math.min(3, Math.max(2, stems.size - 1))) {
      scored.push({ id: a.id, shared, order });
    }
  });
  return scored.sort((x, y) => y.shared - x.shared || y.order - x.order).slice(0, MAX_MATCHED_ANSWERS).map((s) => s.id);
}
function analyzeOutline(text, rawAnswers = []) {
  const nodes = [];
  for (const p of splitParagraphs(text)) {
    const prose = proseOf(p.text);
    const slots = (p.text.match(SLOT) ?? []).length;
    if (!prose && !slots) {
      continue;
    }
    const words = countWords(prose);
    const sources = distinctSources(prose);
    const quotes = quoteCount(prose);
    const node = {
      index: nodes.length + 1,
      line: p.line,
      heading: p.heading,
      preview: prose ? preview(prose) : "(empty skeleton)",
      words,
      distinctSources: sources,
      quoteCount: quotes,
      hasCounterMove: COUNTER.test(prose),
      gaps: [],
      matchedAnswerIds: prose ? matchAnswers(prose, rawAnswers) : []
    };
    const framing = INTRO.test(p.heading) || CONCLUSION.test(p.heading);
    if (slots) {
      node.gaps.push(slots === 1 ? "1 slot to fill" : `${slots} slots to fill`);
    }
    if (!framing && sources < TARGET_SOURCES) {
      node.gaps.push(`${sources}/${TARGET_SOURCES} sources`);
    }
    if (!framing && quotes === 0) {
      node.gaps.push("no direct quote");
    }
    if (words > 0 && words < SHORT_WORDS) {
      node.gaps.push(`under ${SHORT_WORDS} words`);
    } else if (words > LONG_WORDS) {
      node.gaps.push(`over ${LONG_WORDS} words, consider splitting`);
    }
    nodes.push(node);
  }
  const body = nodes.filter((n) => !INTRO.test(n.heading) && !CONCLUSION.test(n.heading));
  if (body.length >= 3 && !nodes.some((n) => n.hasCounterMove)) {
    body[body.length - 1].gaps.push("no caveat or objection in the draft yet");
  }
  return nodes;
}
function paragraphAtLine(items, line) {
  let found = null;
  for (const n of items) {
    if (n.line <= line) {
      found = n;
    }
  }
  return found;
}
function metaLine(n) {
  const quotes = n.quoteCount === 1 ? "1 quote" : `${n.quoteCount} quotes`;
  return `${n.words}w · ${n.distinctSources} src · ${quotes}`;
}

class ArgumentOutlineTreeProvider {
  vscode;
  changed;
  onDidChangeTreeData;
  outline = [];
  uri;
  constructor(vscode) {
    this.vscode = vscode;
    this.changed = new vscode.EventEmitter;
    this.onDidChangeTreeData = this.changed.event;
  }
  update(outline, uri) {
    this.outline = outline;
    this.uri = uri;
    this.changed.fire(undefined);
  }
  get nodes() {
    return this.outline;
  }
  getChildren(element) {
    if (element) {
      return element.kind === "heading" ? element.nodes.map((node) => ({ kind: "paragraph", node })) : [];
    }
    const groups = [];
    for (const node of this.outline) {
      const last = groups[groups.length - 1];
      if (last && last.heading === node.heading) {
        last.nodes.push(node);
      } else {
        groups.push({ kind: "heading", heading: node.heading, nodes: [node] });
      }
    }
    if (groups.length === 1 && groups[0].heading === "(Opening)") {
      return groups[0].nodes.map((node) => ({ kind: "paragraph", node }));
    }
    return groups;
  }
  getTreeItem(element) {
    const vscode = this.vscode;
    if (element.kind === "heading") {
      const item2 = new vscode.TreeItem(element.heading, vscode.TreeItemCollapsibleState.Expanded);
      const open = element.nodes.reduce((sum, n2) => sum + n2.gaps.length, 0);
      item2.description = open ? `${element.nodes.length} ¶ · ${open} gaps` : `${element.nodes.length} ¶`;
      return item2;
    }
    const n = element.node;
    const item = new vscode.TreeItem(`P${n.index}  ${n.preview}`, vscode.TreeItemCollapsibleState.None);
    item.description = metaLine(n) + (n.gaps.length ? ` · ${n.gaps.join(" · ")}` : "");
    item.tooltip = [
      `P${n.index} · line ${n.line} · ${n.heading}`,
      metaLine(n),
      n.hasCounterMove ? "Has a caveat or objection." : "",
      n.gaps.length ? `Gaps: ${n.gaps.join(", ")}` : "No gaps.",
      n.matchedAnswerIds.length ? `Linked to ${n.matchedAnswerIds.length} of your answers.` : ""
    ].filter(Boolean).join(`
`);
    item.iconPath = new vscode.ThemeIcon(n.gaps.length ? "circle-outline" : "pass");
    item.command = { command: "writerStudio.jumpToLine", title: "Go to paragraph", arguments: [n.line, this.uri] };
    return item;
  }
}

// src/core/companion.ts
var import_child_process = require("child_process");
var crypto = __toESM(require("crypto"));
var fs = __toESM(require("fs"));
var os2 = __toESM(require("os"));
var path2 = __toESM(require("path"));
var JEV_URL = "https://api.typesafe.ai/v1/systemone";
var JEV_MODEL = "jev-1.14.0";
var MIN_WORDS = 15;
var MAX_CHARS = 90000;
function paragraphAt(text, line) {
  const lines = text.split(/\r?\n/);
  let start = line;
  let end = line;
  while (start > 0 && lines[start - 1].trim())
    start--;
  while (end < lines.length - 1 && lines[end + 1].trim())
    end++;
  return lines.slice(start, end + 1).join(" ").trim();
}
function fold(s) {
  return s.replace(/[‘’‚′]/g, "'").replace(/[“”„″]/g, '"').replace(/[‐‑–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}
function verify(items, pages) {
  const folded = pages.map(fold);
  const out = [];
  for (const item of items) {
    const q = fold(item.quote).replace(/^["'.,\s]+|["'.,\s]+$/g, "");
    if (q.split(" ").length < 4)
      continue;
    const at = folded[item.page - 1]?.includes(q) ? item.page - 1 : folded.findIndex((p) => p.includes(q));
    if (at >= 0)
      out.push({ ...item, page: at + 1 });
  }
  return out;
}
function parseSuggestions(raw) {
  const m = raw.match(/\[[\s\S]*\]/);
  if (!m)
    return [];
  try {
    const arr = JSON.parse(m[0]);
    return (Array.isArray(arr) ? arr : []).filter((x) => x && typeof x.quote === "string" && Number.isInteger(x.page)).map((x) => ({
      page: x.page,
      quote: x.quote.trim(),
      stance: x.stance === "complicates" ? "complicates" : "supports",
      why: typeof x.why === "string" ? x.why.trim() : ""
    }));
  } catch {
    return [];
  }
}
function buildPrompt(paragraph, fileName, pages) {
  let body = "";
  for (let i = 0;i < pages.length && body.length < MAX_CHARS; i++) {
    body += `
[[PDF PAGE ${i + 1}]]
${pages[i]}
`;
  }
  return [
    "A writer is drafting the paragraph below with the reading beside it.",
    "Find up to 4 passages in the reading that bear on what the paragraph argues: 2 or 3 that support it and at least 1 that complicates, qualifies or challenges it, if the reading has one.",
    "Copy each quote exactly as it appears in the page text, 8 to 40 words, from a single page. Never paraphrase inside a quote.",
    'Return ONLY a JSON array: [{"page": <PDF PAGE number>, "quote": "...", "stance": "supports" | "complicates", "why": "<one plain sentence on how it bears on the paragraph>"}]',
    "",
    `PARAGRAPH:
${paragraph}`,
    "",
    `READING (${fileName}):${body}`
  ].join(`
`);
}
function run(cmd, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = import_child_process.execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: `${process.env.PATH ?? ""}:/opt/homebrew/bin:/usr/local/bin:${os2.homedir()}/.local/bin:${os2.homedir()}/.bun/bin` } }, (err, stdout, stderr) => err ? reject(new Error(stderr?.toString().slice(0, 300) || err.message)) : resolve(stdout.toString()));
    child.stdin?.end(input ?? "");
  });
}
var cachedKey;
async function typesafeKey() {
  if (cachedKey !== undefined)
    return cachedKey;
  if (process.env.TYPESAFE_API_KEY)
    return cachedKey = process.env.TYPESAFE_API_KEY;
  try {
    cachedKey = (await run("/usr/bin/security", ["find-generic-password", "-a", os2.userInfo().username, "-s", "TYPESAFE_API_KEY", "-w"], undefined, 8000)).trim() || null;
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}
async function ideaProbability(paragraph) {
  const key = await typesafeKey();
  if (!key)
    return null;
  const body = {
    model: JEV_MODEL,
    state: { draft: { paragraph } },
    questions: {
      idea: {
        type: "choice",
        instructions: "Does `draft.paragraph` develop an idea, argument or claim that a course reading could support, complicate or challenge? Notes to self, headings, logistics and plain statements of what the writer will do are not.",
        criteria: { idea: "Develops an idea, argument or claim that sources could bear on", other: "Heading, note to self, logistics or no arguable content" }
      }
    }
  };
  const res = await fetch(JEV_URL, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  if (!res.ok)
    throw new Error(`Jev ${res.status}`);
  const json = await res.json();
  return json.answers?.idea?.probabilities?.idea ?? null;
}
function claudeBinary() {
  const candidates = [path2.join(os2.homedir(), ".local/bin/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  return candidates.find((c) => fs.existsSync(c)) ?? "claude";
}
async function askClaude(model, prompt, usable) {
  let out = await run(claudeBinary(), ["-p", "--model", model, "--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--setting-sources", ""], prompt, 180000).catch((e) => String(e.message));
  const omp = path2.join(os2.homedir(), ".bun/bin/omp");
  if (!usable(out) && fs.existsSync(omp)) {
    out = await run(omp, ["-p", prompt, "--model", `anthropic/${model}`, "--no-tools", "--thinking", "off", "--system-prompt", "Answer exactly in the format requested."], undefined, 180000);
  }
  return out;
}
async function findPassages(model, prompt) {
  const out = await askClaude(model, prompt, (o) => /\[[\s\S]*\]/.test(o));
  return { items: parseSuggestions(out), raw: out };
}

class Companion {
  vscode;
  deps;
  timer;
  seen = new Map;
  texts = new Map;
  status;
  subs = [];
  running = 0;
  constructor(vscode, deps) {
    this.vscode = vscode;
    this.deps = deps;
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.subs.push(this.status, vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)), vscode.window.onDidChangeActiveTextEditor((e) => e && void this.openReadingBeside(e.document)), vscode.window.tabGroups.onDidChangeTabs((e) => {
      for (const tab of e.closed) {
        const uri = tab.input?.uri;
        if (uri)
          this.besideDone.delete(uri.toString());
      }
      for (const tab of [...e.opened, ...e.changed]) {
        const input = tab.input;
        const overDraft = tab.group.tabs.some((t) => t.input?.uri?.path.endsWith(".md") && !/\/(readings?|sources?)\//i.test(t.input.uri.path));
        if (input?.viewType === "writerStudio.pdfReader" && tab.isActive && overDraft) {
          vscode.commands.executeCommand("workbench.action.moveEditorToRightGroup");
        }
      }
    }));
    const first = vscode.window.activeTextEditor;
    if (first)
      this.openReadingBeside(first.document);
  }
  besideDone = new Set;
  async openReadingBeside(doc) {
    const vscode = this.vscode;
    if (!vscode.workspace.getConfiguration("writerStudio").get("splitScreenDefault", true) || !this.deps.isDraft(doc))
      return;
    if (this.besideDone.has(doc.uri.toString()) || this.deps.pdf.openUris().length)
      return;
    this.besideDone.add(doc.uri.toString());
    const pdfs = await vscode.workspace.findFiles("**/*.pdf", "**/{node_modules,.git}/**", 50);
    const newest = pdfs.map((u) => ({ u, t: fs.statSync(u.fsPath, { throwIfNoEntry: false })?.mtimeMs ?? 0 })).sort((a, b) => b.t - a.t)[0];
    if (newest) {
      await vscode.commands.executeCommand("vscode.openWith", newest.u, "writerStudio.pdfReader", { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
    }
  }
  config() {
    return this.vscode.workspace.getConfiguration("writerStudio.companion");
  }
  schedule(doc) {
    if (!this.config().get("enabled", true) || !this.deps.isDraft(doc))
      return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(doc), this.config().get("pauseMs", 2500));
  }
  say(text, tooltip) {
    this.status.text = text;
    this.status.tooltip = tooltip;
    text ? this.status.show() : this.status.hide();
  }
  async check(doc) {
    const editor = this.vscode.window.visibleTextEditors.find((e) => e.document === doc);
    const pdfUri = this.deps.pdf.openUris()[0];
    if (!editor || !pdfUri) {
      if (editor)
        this.deps.log("companion: no PDF open beside the draft, skipping");
      return;
    }
    const paragraph = paragraphAt(doc.getText(), editor.selection.active.line);
    if (paragraph.split(/\s+/).length < MIN_WORDS || paragraph.startsWith("#"))
      return;
    const key = crypto.createHash("sha1").update(pdfUri.toString() + `
` + paragraph).digest("hex");
    const cached = this.seen.get(key);
    if (cached) {
      this.deps.pdf.suggest(pdfUri, cached);
      return;
    }
    const seq = ++this.running;
    const fileName = path2.basename(pdfUri.fsPath);
    try {
      this.say("$(loading~spin) VSwriter: reading your paragraph");
      const p = await ideaProbability(paragraph).catch((err) => {
        this.deps.log(`companion: Jev unavailable (${err.message}); searching anyway`);
        return null;
      });
      const threshold = this.config().get("ideaThreshold", 0.6);
      if (p !== null && p < threshold) {
        this.deps.log(`companion: Jev idea=${p.toFixed(2)} < ${threshold}, no search`);
        this.seen.set(key, []);
        if (seq === this.running)
          this.say("");
        return;
      }
      if (seq !== this.running)
        return;
      this.say(`$(loading~spin) VSwriter: finding passages in ${fileName}`, p === null ? "Jev unavailable" : `Jev idea probability ${p.toFixed(2)}`);
      let pages = this.texts.get(pdfUri.toString());
      if (!pages?.some((t) => t.trim())) {
        pages = await this.deps.pdf.extractText(pdfUri);
        this.texts.set(pdfUri.toString(), pages);
      }
      if (!pages.some((t) => t.trim())) {
        this.say("VSwriter: this PDF has no selectable text");
        return;
      }
      const t0 = Date.now();
      const { items: proposed, raw } = await findPassages(this.config().get("model", "claude-sonnet-5-5"), buildPrompt(paragraph, fileName, pages));
      if (!proposed.length)
        this.deps.log(`companion: no passages parsed from model output: ${raw.slice(0, 400)}`);
      const verified = verify(proposed, pages);
      this.deps.log(`companion: idea=${p?.toFixed(2) ?? "n/a"} proposed=${proposed.length} verified=${verified.length} in ${Date.now() - t0} ms`);
      this.seen.set(key, verified);
      if (seq !== this.running)
        return;
      this.deps.pdf.suggest(pdfUri, verified);
      this.say(verified.length ? `$(book) ${verified.length} passages in ${fileName}` : `VSwriter: no verified passages in ${fileName}`);
    } catch (err) {
      this.deps.log(`companion: ${err.message}`);
      if (seq === this.running)
        this.say("$(warning) VSwriter: passage search failed", err.message);
    }
  }
  dispose() {
    clearTimeout(this.timer);
    this.subs.forEach((s) => s.dispose());
  }
}

// src/core/assistant.ts
var fs3 = __toESM(require("fs"));

// src/core/workflowStore.ts
var crypto2 = __toESM(require("crypto"));
var fs2 = __toESM(require("fs"));
var path3 = __toESM(require("path"));
var RAW_ANSWERS = "raw-answers.md";
var INTERVIEW_STATE = "interview-state.md";
var SOURCE_MAP = "source-map.md";
var CURATED_QUESTIONS = [
  {
    question: "In one sentence, what do you think is true here that a reader might push back on?",
    options: [
      { label: "It works worse than claimed", seed: "It works worse than its defenders claim, because " },
      { label: "It works better than feared", seed: "It works better than its critics fear, because " },
      { label: "The usual explanation misses something", seed: "The usual explanation misses the real cause, which is " }
    ]
  },
  {
    question: "Which case, event or example made you think that? Name it and say what happened.",
    options: [
      { label: "A case from the readings", seed: "The case from the readings that convinced me is " },
      { label: "Something I saw myself", seed: "I saw this happen when " },
      { label: "A recent news event", seed: "The event that made me think this was " }
    ]
  },
  {
    question: "Walk through how it happens: who does what, and what follows from it?",
    options: [
      { label: "It starts with a decision", seed: "It starts when someone decides to " },
      { label: "It starts with a rule", seed: "It starts with a rule that " },
      { label: "It starts with an incentive", seed: "It starts because someone gains by " }
    ]
  },
  {
    question: "Who gains from the outcome you described, and how do they gain?",
    options: [
      { label: "Those already in charge", seed: "The people already in charge gain because " },
      { label: "Those with less power", seed: "The people with less power gain because " },
      { label: "Nobody gains very much", seed: "Nobody gains much from this, because " }
    ]
  },
  {
    question: "What is the strongest point someone who disagrees with you would make? Put it in their words.",
    options: [
      { label: "They have contrary evidence", seed: "They would point to evidence that " },
      { label: "They see a hidden cost", seed: "They would say my view ignores the cost of " },
      { label: "They blame a different cause", seed: "They would say the real cause is " }
    ]
  },
  {
    question: "Answer that objection. Which part of it is wrong, and which part do you accept?",
    options: [
      { label: "The objection mostly fails", seed: "The objection fails mainly because " },
      { label: "The objection is partly right", seed: "The objection is right that " },
      { label: "Right facts, wrong conclusion", seed: "The facts in the objection hold, yet the conclusion " }
    ]
  },
  {
    question: "Where does your claim stop holding? Name a case it leaves out.",
    options: [
      { label: "A different place", seed: "My claim stops holding in " },
      { label: "A different time period", seed: "My claim held less well when " },
      { label: "A different group of people", seed: "My claim leaves out people who " }
    ]
  },
  {
    question: "What does your position cost the people it affects, and is that cost worth paying?",
    options: [
      { label: "The cost is worth paying", seed: "The cost is worth paying because " },
      { label: "The cost is too high", seed: "The cost is too high because " },
      { label: "It depends who pays", seed: "Whether the cost is worth it depends on " }
    ]
  },
  {
    question: "Which reading pushes back hardest on your view, and on what exact point?",
    options: [
      { label: "It disputes my facts", seed: "The reading that disputes my facts is " },
      { label: "It disputes my reasoning", seed: "The reading that rejects my reasoning is " },
      { label: "It weighs things differently", seed: "The reading that weighs things differently is " }
    ]
  },
  {
    question: "Pick one author you agree with. Which claim of theirs supports you, and where do you go further than they do?",
    options: [
      { label: "I extend their claim", seed: "I take their claim further by arguing that " },
      { label: "I apply it elsewhere", seed: "I apply their claim to " },
      { label: "I accept only part", seed: "I accept their point that " }
    ]
  }
];
var QUESTIONS = CURATED_QUESTIONS.map((q) => q.question);
function optionsFor(question) {
  return CURATED_QUESTIONS.find((q) => q.question === question)?.options ?? [];
}
var RAW_ANSWERS_HEADER = `# Raw answers

Append-only answer bank. Each entry keeps the question and the answer exactly as written.
Edits and drafts belong in other files.

`;
var INTERVIEW_STATE_TEMPLATE = `# Interview state

## Assignment
- Requirements:
- Length:
- Due:

## Sources
- Assigned readings (path, scope, read in full?):
- Access gaps:

## Working thesis
Open until the answers settle it.

## Outline and word budget

## Coverage
| Section | Point | Support | Your interpretation | Connection | Status |
| --- | --- | --- | --- | --- | --- |

## Current paragraph

## Ideas
- Accepted:
- Revised:
- Rejected:

## Parked tangents

## Draft status

## Remaining gaps

## Next move
`;
var SOURCE_MAP_TEMPLATE = `# Source map

One row per claim. Page numbers come from the original reading.

| Claim | Your interpretation | Source (Author Year: page) | File and line |
| --- | --- | --- | --- |
`;
var ENTRY = /^<!-- writer-answer id="([^"]+)" ts="([^"]+)" -->\n### [^\n]*\n\nQuestion: ([^\n]*)\n\n/gm;
function parseRawAnswers(content) {
  const heads = [...content.matchAll(ENTRY)];
  return heads.map((m, k) => {
    const bodyStart = m.index + m[0].length;
    const bodyEnd = k + 1 < heads.length ? heads[k + 1].index : content.length;
    const body = content.slice(bodyStart, bodyEnd);
    return { id: m[1], timestamp: m[2], prompt: m[3], text: body.endsWith(`

`) ? body.slice(0, -2) : body.replace(/\n$/, "") };
  });
}

class WorkflowStore {
  root;
  constructor(root) {
    this.root = root;
  }
  file(name) {
    return path3.join(this.root, name);
  }
  isReady() {
    return [RAW_ANSWERS, INTERVIEW_STATE, SOURCE_MAP].every((name) => fs2.existsSync(this.file(name)));
  }
  init() {
    const created = [];
    const templates = [
      [RAW_ANSWERS, RAW_ANSWERS_HEADER],
      [INTERVIEW_STATE, INTERVIEW_STATE_TEMPLATE],
      [SOURCE_MAP, SOURCE_MAP_TEMPLATE]
    ];
    fs2.mkdirSync(this.root, { recursive: true });
    for (const [name, template] of templates) {
      try {
        fs2.writeFileSync(this.file(name), template, { flag: "wx" });
        created.push(name);
      } catch (err) {
        if (err.code !== "EEXIST") {
          throw err;
        }
      }
    }
    return created;
  }
  readAnswers() {
    try {
      return parseRawAnswers(fs2.readFileSync(this.file(RAW_ANSWERS), "utf8"));
    } catch {
      return [];
    }
  }
  appendAnswer(prompt, text, now = new Date) {
    const answer = {
      id: crypto2.randomBytes(4).toString("hex"),
      timestamp: now.toISOString(),
      prompt: prompt.replace(/\s+/g, " ").trim(),
      text
    };
    if (!fs2.existsSync(this.file(RAW_ANSWERS))) {
      fs2.writeFileSync(this.file(RAW_ANSWERS), RAW_ANSWERS_HEADER, { flag: "wx" });
    }
    const entry = `<!-- writer-answer id="${answer.id}" ts="${answer.timestamp}" -->
### ${answer.timestamp}

Question: ${answer.prompt}

${text}

`;
    fs2.appendFileSync(this.file(RAW_ANSWERS), entry, "utf8");
    return answer;
  }
}
function pickQuestion(answers, cursor) {
  const asked = new Set(answers.map((a) => a.prompt));
  for (let k = 0;k < QUESTIONS.length; k++) {
    const q = QUESTIONS[(cursor + k) % QUESTIONS.length];
    if (!asked.has(q)) {
      return q;
    }
  }
  return QUESTIONS[cursor % QUESTIONS.length];
}
var PHRASE_WORDS = 14;
function sentences(text) {
  return (text.match(/[^.!?\n]+[.!?]*/g) ?? []).map((s) => s.trim()).filter((s) => s.split(/\s+/).length >= 3);
}
function quotePhrase(sentence) {
  const words = sentence.replace(/[.!?]+$/, "").split(/\s+/);
  return words.length > PHRASE_WORDS ? words.slice(0, PHRASE_WORDS).join(" ") + " ..." : words.join(" ");
}
function overlap(a, b) {
  const bs = new Set(tokenize(b).map((t) => t.stem));
  return new Set(tokenize(a).map((t) => t.stem).filter((s) => bs.has(s))).size;
}
function citeLabel(b) {
  return b.page ? `${b.author} (${b.year}: ${b.page})` : `${b.author} (${b.year})`;
}
function buildCoaxingStarters(rawAnswers, bookmarks, offset = 0) {
  const usable = rawAnswers.filter((a) => sentences(a.text).length);
  if (!usable.length) {
    return { heading: "Answer a question first. Starters are built from your own words.", starters: [], basedOnAnswerId: null };
  }
  const answer = usable[usable.length - 1 - offset % usable.length];
  const own = sentences(answer.text);
  const opening = own[0];
  const starters = [`Start from your own line: "${quotePhrase(opening)}". Write the next sentence about the case that made you say it.`];
  const bookmark = bookmarks.find((b) => overlap(b.excerpt, answer.text) >= 2) ?? bookmarks[0];
  if (bookmark) {
    const closest = [...own].sort((x, y) => overlap(y, bookmark.excerpt) - overlap(x, bookmark.excerpt))[0];
    starters.push(`Put ${citeLabel(bookmark)} next to "${quotePhrase(closest)}". Say in one sentence whether the passage backs you or cuts against you.`);
  } else if (own.length > 1) {
    starters.push(`You also wrote "${quotePhrase(own[own.length - 1])}". Write the sentence that explains how that happens.`);
  } else {
    starters.push(`Write the sentence that explains how "${quotePhrase(opening)}" happens: who acts, and what follows.`);
  }
  return { heading: `From your answer to "${answer.prompt}"`, starters, basedOnAnswerId: answer.id };
}
var FEATURED = 2;
var FEATURE_POOL = 6;
function buildQuestionContext(question, rawAnswers, readingsIndex) {
  const context = { question, options: optionsFor(question), featuredBookmarks: [] };
  if (!readingsIndex || !rawAnswers.length) {
    return context;
  }
  const pool = readingsIndex.matchBookmarks(rawAnswers, FEATURE_POOL);
  const ranked = pool.map((b, rank) => ({ b, key: pool.length - rank + overlap(question, b.excerpt) * 0.5 })).sort((x, y) => y.key - x.key).map((x) => x.b);
  const authors = new Set;
  for (const b of ranked) {
    if (context.featuredBookmarks.length >= FEATURED) {
      break;
    }
    if (!authors.has(b.author + b.year)) {
      authors.add(b.author + b.year);
      context.featuredBookmarks.push(b);
    }
  }
  return context;
}

// src/core/assistant.ts
var OPENING = "What are you writing? Tell me in a sentence or two, and paste the assignment prompt if there is one.";
var START = "<!-- vswriter-assistant:start -->";
var END = "<!-- vswriter-assistant:end -->";
var HISTORY_TURNS = 12;
var DRAFT_CHARS = 8000;
function readState(store) {
  let text = "";
  try {
    text = fs3.readFileSync(store.file(INTERVIEW_STATE), "utf8");
  } catch {}
  const block = text.includes(START) ? text.slice(text.indexOf(START), text.indexOf(END)) : "";
  const section = (name) => block.match(new RegExp(`## ${name}\\n([\\s\\S]*?)(?=\\n## |$)`))?.[1].trim() ?? "";
  const phase = section("Phase") === "interview" ? "interview" : "define";
  return { phase, brief: section("Brief"), question: section("Current question") || OPENING };
}
function writeState(store, s) {
  const file = store.file(INTERVIEW_STATE);
  const old = fs3.existsSync(file) ? fs3.readFileSync(file, "utf8") : `# Interview state
`;
  const block = `${START}
## Phase
${s.phase}

## Brief
${s.brief || "(not defined yet)"}

## Current question
${s.question}
${END}`;
  const next = old.includes(START) && old.includes(END) ? old.slice(0, old.indexOf(START)) + block + old.slice(old.indexOf(END) + END.length) : `${old.trimEnd()}

${block}
`;
  fs3.writeFileSync(file, next, "utf8");
}
function transcript(store, state) {
  const turns = [];
  for (const a of store.readAnswers()) {
    if (a.prompt)
      turns.push({ role: "assistant", text: a.prompt });
    turns.push({ role: "writer", text: a.text });
  }
  turns.push({ role: "assistant", text: state.question });
  return turns;
}
function draftExcerpt(draft) {
  if (!draft || !draft.text.trim())
    return "(no draft written yet)";
  const lines = draft.text.split(/\r?\n/);
  lines[draft.line] = `>>> ${lines[draft.line] ?? ""}`;
  const text = lines.join(`
`);
  if (text.length <= DRAFT_CHARS)
    return text;
  const at = text.indexOf(">>> ");
  const from = Math.max(0, Math.min(at - DRAFT_CHARS / 2, text.length - DRAFT_CHARS));
  return `…${text.slice(from, from + DRAFT_CHARS)}…`;
}
function buildPrompt2(state, history, draft, readings) {
  const talk = history.slice(-HISTORY_TURNS).map((t) => `${t.role === "writer" ? "WRITER" : "YOU"}: ${t.text}`).join(`

`);
  return [
    "You are the writing assistant inside VSwriter, an editor for essays. You help a writer think and write in their own words. You never write their sentences or paragraphs for them.",
    "",
    "Work in two phases.",
    "DEFINE: learn what they are writing before anything else. In order of importance: the kind of piece and its prompt, what they think so far (their tentative answer), the readings they must use, the length. Ask about the reader or due date only when it changes the writing. Ask only for what is still missing; use what the draft and file list already show. As soon as you know the piece, the prompt and their tentative answer, write the brief and move to INTERVIEW.",
    "INTERVIEW: read the draft, especially the paragraph marked >>> (where the cursor is). Ask the single question that fills the most important gap in what they are writing now: the point of the paragraph, the evidence or example, their own interpretation, or how it connects to the argument. Quote their words back when it helps. Name a specific reading when it bears on the question. If a paragraph has what it needs, say so briefly and move to the next one.",
    "",
    "When every paragraph the essay needs has its point, evidence and their interpretation, say the interview is done and suggest the Mind map button above the chat.",
    "Rules: exactly one question per message, never two joined together. Plain words. Under 70 words. Acknowledge their answer in a short clause first when it adds something. Never draft text for them.",
    "",
    'Return ONLY JSON: {"reply": "<your message>", "phase": "define" or "interview", "brief": "<3-6 markdown bullets defining the piece, or empty string if unchanged>"}',
    "",
    `PHASE NOW: ${state.phase}`,
    `BRIEF: ${state.brief || "(not defined yet)"}`,
    `READINGS IN THE FOLDER: ${readings.length ? readings.join("; ") : "(none)"}`,
    "",
    `CONVERSATION:
${talk}`,
    "",
    `DRAFT${draft ? ` (${draft.name})` : ""}:
${draftExcerpt(draft)}`
  ].join(`
`);
}
function extractJson(raw, accept) {
  const fenced = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  for (const text of [...fenced, raw]) {
    const ends = [];
    for (let i = text.length - 1;i >= 0; i--)
      if (text[i] === "}")
        ends.push(i);
    for (let a = text.indexOf("{");a >= 0; a = text.indexOf("{", a + 1)) {
      for (const b of ends) {
        if (b <= a)
          break;
        try {
          const v = JSON.parse(text.slice(a, b + 1));
          if (accept(v))
            return v;
        } catch {}
      }
    }
  }
  return null;
}
var isReply = (v) => !!v && typeof v.reply === "string" && v.reply.trim() !== "";
function parseReply(raw, state) {
  const j = extractJson(raw, isReply);
  if (!j)
    return null;
  const brief = typeof j.brief === "string" && j.brief.trim() ? j.brief.trim() : state.brief;
  return { phase: j.phase === "interview" ? "interview" : state.phase, brief, question: j.reply.trim() };
}
async function respond(store, text, draft, readings, ask) {
  store.init();
  const state = readState(store);
  store.appendAnswer(state.question, text);
  const raw = await ask(buildPrompt2(state, transcript(store, state).slice(0, -1), draft, readings));
  const next = parseReply(raw, state);
  if (!next)
    throw new Error(`the assistant's reply could not be read: ${raw.slice(0, 200)}`);
  writeState(store, next);
  return next;
}
function buildMindMapPrompt(state, history, draft) {
  const talk = history.map((t) => `${t.role === "writer" ? "WRITER" : "ASSISTANT"}: ${t.text}`).join(`

`);
  return [
    "Turn this writer's interview into a mind map of their essay, in Mermaid mindmap syntax.",
    "Root: the essay's question in a few words. First branches: their answer to it and each main idea. Under each idea: the evidence they named (reading and page when given) and their own interpretation.",
    "Use the writer's own words wherever possible. At most 8 words per node. Plain text only in nodes: no brackets, parentheses or quotation marks. Indent with two spaces per level.",
    "Return ONLY the Mermaid code, starting with the line: mindmap",
    "",
    `BRIEF:
${state.brief || "(not defined)"}`,
    "",
    `INTERVIEW:
${talk}`,
    "",
    `DRAFT:
${draftExcerpt(draft)}`
  ].join(`
`);
}
function parseMindMap(raw) {
  const body = raw.match(/```(?:mermaid)?\s*([\s\S]*?)```/)?.[1] ?? raw;
  const lines = body.split(`
`);
  const start = lines.findIndex((l) => l.trim() === "mindmap");
  if (start < 0)
    return null;
  const nodes = lines.slice(start + 1).filter((l) => l.trim()).map((l) => {
    const indent = l.match(/^\s*/)[0];
    return indent + l.trim().replace(/^root\s*/, "").replace(/[()[\]{}"]/g, "").replace(/^[-*]\s*/, "");
  }).filter((l) => l.trim());
  return nodes.length >= 2 ? ["mindmap", ...nodes].join(`
`) : null;
}

// src/core/straighten.ts
function wordDiff(a, b) {
  const x = a.split(/(\s+)/).filter((t) => t !== "");
  const y = b.split(/(\s+)/).filter((t) => t !== "");
  const n = x.length, m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i2 = n - 1;i2 >= 0; i2--)
    for (let j2 = m - 1;j2 >= 0; j2--)
      L[i2][j2] = x[i2] === y[j2] ? L[i2 + 1][j2 + 1] + 1 : Math.max(L[i2 + 1][j2], L[i2][j2 + 1]);
  const ops = [];
  const push = (kind, text) => {
    const last = ops[ops.length - 1];
    if (last && last.kind === kind)
      last.text += text;
    else
      ops.push({ kind, text });
  };
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      push("same", x[i]);
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) {
      push("del", x[i]);
      i++;
    } else {
      push("ins", y[j]);
      j++;
    }
  }
  while (i < n)
    push("del", x[i++]);
  while (j < m)
    push("ins", y[j++]);
  return ops;
}
function buildPrompt3(passage, feedback) {
  return [
    "Straighten this passage from a writer's draft, as lightly as possible. It is their writing, not yours.",
    '- Carry out the notes they left for themselves (a bracketed or parenthetical instruction, TODO, "check", "??") and then remove those notes. Make each change as small as the note allows.',
    "- Fix only clear errors: spelling, capital letters, punctuation, a sentence that does not parse.",
    "- Keep their words, rhythm, tone and opinions everywhere else, even where you would write it differently.",
    '- Where they marked a place to continue (an arrow like ---> or >>>, "...", "continue"), replace the marker with at most one short sentence that carries their thought on in their voice.',
    "- Never change a fact or a claim. When something needs checking, leave it and say so in notes.",
    'Return ONLY JSON: {"text": "<the straightened passage>", "notes": ["<one short line per change made or fact to check>"]}',
    "",
    `PASSAGE:
${passage}`,
    ...feedback ? ["", `YOUR LAST VERSION:
${feedback.previous}`, "", `THE WRITER REPLIED: ${feedback.reply}`, "Revise your version to follow their reply, still as lightly as possible."] : []
  ].join(`
`);
}
var isStraightened = (v) => !!v && typeof v.text === "string" && v.text.trim() !== "";
function parse(raw) {
  const j = extractJson(raw, isStraightened);
  if (!j)
    return null;
  const notes = Array.isArray(j.notes) ? j.notes.filter((n) => typeof n === "string" && n.trim() !== "").map((n) => n.trim()) : [];
  return { text: j.text.trim(), notes };
}
var pending;
function straightenLine(uri) {
  return pending && pending.uri === uri ? pending.range.start.line : undefined;
}
var short = (note) => note.length > 60 ? `${note.slice(0, 57)}…` : note;
function registerStraighten(vscode, model, log, changed = () => {}) {
  let busy = false;
  const lensChanged = new vscode.EventEmitter;
  const removed = vscode.window.createTextEditorDecorationType({
    textDecoration: "line-through",
    color: new vscode.ThemeColor("disabledForeground"),
    backgroundColor: new vscode.ThemeColor("diffEditor.removedTextBackground")
  });
  const added = vscode.window.createTextEditorDecorationType({});
  const insertColor = new vscode.ThemeColor("diffEditor.insertedTextBackground");
  const paint = () => {
    for (const editor of vscode.window.visibleTextEditors) {
      const mine = pending && editor.document.uri.toString() === pending.uri;
      if (!mine || !pending) {
        editor.setDecorations(removed, []);
        editor.setDecorations(added, []);
        continue;
      }
      const doc = editor.document;
      let at = doc.offsetAt(pending.range.start);
      const dels = [];
      const ins = [];
      for (const op of wordDiff(pending.original, pending.text)) {
        if (op.kind === "ins") {
          ins.push({
            range: new vscode.Range(doc.positionAt(at), doc.positionAt(at)),
            hoverMessage: `✦ Straighten adds: ${op.text.trim()}`,
            renderOptions: { before: { contentText: op.text, backgroundColor: insertColor, color: new vscode.ThemeColor("editor.foreground") } }
          });
          continue;
        }
        if (op.kind === "del")
          dels.push(new vscode.Range(doc.positionAt(at), doc.positionAt(at + op.text.length)));
        at += op.text.length;
      }
      editor.setDecorations(removed, dels);
      editor.setDecorations(added, ins);
    }
  };
  const clear = () => {
    pending = undefined;
    paint();
    lensChanged.fire();
    changed();
  };
  const target = (editor) => {
    if (!editor.selection.isEmpty)
      return new vscode.Range(editor.selection.start, editor.selection.end);
    const doc = editor.document;
    let a = editor.selection.active.line, b = a;
    if (!doc.lineAt(a).text.trim())
      return;
    while (a > 0 && doc.lineAt(a - 1).text.trim())
      a--;
    while (b < doc.lineCount - 1 && doc.lineAt(b + 1).text.trim())
      b++;
    return new vscode.Range(a, 0, b, doc.lineAt(b).text.length);
  };
  const propose = async (editor, range, original, feedback) => {
    if (busy)
      return;
    busy = true;
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: "$(sparkle) Straightening" }, async () => parse(await askClaude(model(), buildPrompt3(original, feedback), (o) => /"text"\s*:/.test(o))));
      if (!result) {
        vscode.window.showWarningMessage("VSwriter: Straighten got no usable answer. Try again.");
        return;
      }
      if (result.text === original.trim()) {
        vscode.window.showInformationMessage("VSwriter: nothing to straighten here.");
        clear();
        return;
      }
      pending = { uri: editor.document.uri.toString(), version: editor.document.version, range, original, text: result.text, notes: result.notes };
      log(`straighten: ${result.notes.length} notes, ${wordDiff(original, result.text).filter((o) => o.kind !== "same").length} changes`);
      paint();
      lensChanged.fire();
      changed();
    } catch (err) {
      log(`straighten: ${err.message}`);
      vscode.window.showWarningMessage(`VSwriter: Straighten failed (${err.message.slice(0, 120)}).`);
    } finally {
      busy = false;
    }
  };
  const lenses = {
    onDidChangeCodeLenses: lensChanged.event,
    provideCodeLenses(doc) {
      if (!pending || doc.uri.toString() !== pending.uri)
        return [];
      const at = new vscode.Range(pending.range.start, pending.range.start);
      const items = [
        new vscode.CodeLens(at, { title: "$(check) Accept", command: "writerStudio.straighten.accept" }),
        new vscode.CodeLens(at, { title: "$(close) Deny", command: "writerStudio.straighten.deny" }),
        new vscode.CodeLens(at, { title: "$(reply) Reply", command: "writerStudio.straighten.reply" })
      ];
      for (const note of pending.notes.slice(0, 4))
        items.push(new vscode.CodeLens(at, { title: `$(sparkle) ${short(note)}`, tooltip: note, command: "" }));
      return items;
    }
  };
  return [
    removed,
    added,
    lensChanged,
    vscode.languages.registerCodeLensProvider({ language: "markdown" }, lenses),
    vscode.window.onDidChangeVisibleTextEditors(paint),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (pending && e.document.uri.toString() === pending.uri && e.contentChanges.some((c) => c.range.intersection(pending.range) || c.range.end.isBefore(pending.range.start)))
        clear();
    }),
    vscode.commands.registerCommand("writerStudio.straighten", async () => {
      const editor = vscode.window.activeTextEditor;
      const range = editor && target(editor);
      if (!editor || !range) {
        vscode.window.showInformationMessage("VSwriter: put the cursor in a paragraph, or select a passage, to straighten it.");
        return;
      }
      await propose(editor, range, editor.document.getText(range));
    }),
    vscode.commands.registerCommand("writerStudio.straighten.accept", async () => {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === pending?.uri);
      if (!pending || !editor)
        return;
      const { range, text } = pending;
      clear();
      await editor.edit((edit) => edit.replace(range, text));
    }),
    vscode.commands.registerCommand("writerStudio.straighten.deny", clear),
    vscode.commands.registerCommand("writerStudio.straighten.reply", async () => {
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === pending?.uri);
      if (!pending || !editor)
        return;
      const reply = await vscode.window.showInputBox({ prompt: "What should Straighten do differently?", placeHolder: 'e.g. keep "speed of light", only fix the fire metaphor' });
      if (!reply?.trim())
        return;
      const { range, original, text } = pending;
      await propose(editor, range, original, { previous: text, reply });
    })
  ];
}

// src/core/nudge.ts
var fs4 = __toESM(require("fs"));
var path4 = __toESM(require("path"));
function buildNudgePrompt(state, history, mindMap, draft) {
  const talk = history.map((t) => `${t.role === "writer" ? "WRITER" : "ASSISTANT"}: ${t.text}`).join(`

`);
  return [
    "A writer has stalled on the paragraph marked >>> in their draft. Give them one or two short speech bubbles to get them moving again.",
    "Each bubble is one of:",
    '- recall: remind them of something THEY said in the interview that bears on this paragraph. Put their exact words in "quote", copied character for character from a WRITER line, and say in a few words why it fits here.',
    "- raise: one question that opens the next step for this paragraph: its point, an example, their reading of the evidence, or the link to the next idea. Use the mind map to see what is still unwritten.",
    "Rules: under 35 words per bubble. Plain words. Never write a sentence for their essay or suggest wording. Prefer recall when their own words fit.",
    'Return ONLY JSON: {"bubbles": [{"kind": "recall" or "raise", "text": "...", "quote": "..."}]}',
    "",
    `BRIEF:
${state.brief || "(not defined)"}`,
    "",
    `INTERVIEW:
${talk || "(none yet)"}`,
    "",
    `MIND MAP:
${mindMap || "(none yet)"}`,
    "",
    `DRAFT (${draft.name}):
${draftExcerpt(draft)}`
  ].join(`
`);
}
var squash = (s) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ").trim();
var isRaw = (v) => !!v && Array.isArray(v.bubbles);
function parseNudge(raw, writerAnswers) {
  const j = extractJson(raw, isRaw);
  if (!j)
    return [];
  const said = squash(writerAnswers.join(`
`));
  const out = [];
  for (const b of j.bubbles) {
    const { kind, text, quote } = b ?? {};
    if (typeof text !== "string" || !text.trim())
      continue;
    if (kind === "recall") {
      if (typeof quote !== "string" || quote.trim().length < 4 || !said.includes(squash(quote)))
        continue;
      out.push({ kind, text: text.trim(), quote: quote.trim() });
    } else if (kind === "raise") {
      out.push({ kind, text: text.trim() });
    }
  }
  return out.slice(0, 2);
}
function bubbleMarkdown(b) {
  return b.kind === "recall" ? `You said: *"${b.quote}"*

${b.text}` : b.text;
}
function readMindMap(root) {
  try {
    return fs4.readFileSync(path4.join(root, "mind-map.md"), "utf8").match(/```mermaid\n([\s\S]*?)```/)?.[1].trim() ?? "";
  } catch {
    return "";
  }
}
var COOLDOWN_MS = 120000;
var STALE_MS = 300000;
function registerNudges(vscode, host) {
  const controller = vscode.comments.createCommentController("writerStudio.nudge", "VSwriter");
  controller.options = { prompt: "Answer in your own words…", placeHolder: "Rough is fine. Saved to your interview." };
  const threads = new Set;
  let lastEdit = 0;
  let lastNudge = 0;
  let nudged = new Set;
  let busy = false;
  const author = { name: "VSwriter ✦" };
  const comment = (body, name = author.name) => ({
    body: new vscode.MarkdownString(body),
    mode: vscode.CommentMode.Preview,
    author: { name }
  });
  const clearAll = () => {
    for (const t of threads)
      t.dispose();
    threads.clear();
  };
  const paragraphEnd = (doc, line) => {
    let b = line;
    while (b < doc.lineCount - 1 && doc.lineAt(b + 1).text.trim())
      b++;
    return b;
  };
  const paragraphText = (doc, line) => {
    let a = line;
    while (a > 0 && doc.lineAt(a - 1).text.trim())
      a--;
    return doc.getText(new vscode.Range(a, 0, paragraphEnd(doc, line), 1e6));
  };
  const nudge = async (editor, manual) => {
    if (busy)
      return;
    const ctx = host.context();
    if (!ctx) {
      if (manual)
        vscode.window.showInformationMessage("VSwriter: open a writing folder first.");
      return;
    }
    const doc = editor.document;
    const line = editor.selection.active.line;
    const key = paragraphText(doc, line);
    busy = true;
    lastNudge = Date.now();
    nudged.add(key);
    try {
      const draft = { name: path4.basename(doc.fileName), text: doc.getText(), line };
      const prompt = buildNudgePrompt(ctx.state, ctx.history, readMindMap(ctx.root), draft);
      const bubbles = parseNudge(await host.ask(prompt), ctx.answers);
      host.log(`nudge: ${bubbles.map((b) => b.kind).join(", ") || "nothing usable"}${manual ? " (asked)" : ""}`);
      if (!bubbles.length) {
        if (manual)
          vscode.window.showInformationMessage("VSwriter: no nudge came back. Try again in a moment.");
        return;
      }
      if (!manual && Date.now() - lastEdit < 3000)
        return;
      clearAll();
      const end = paragraphEnd(doc, line);
      const endCol = doc.lineAt(end).text.length;
      for (const b of bubbles) {
        const thread = controller.createCommentThread(doc.uri, new vscode.Range(end, endCol, end, endCol), [comment(bubbleMarkdown(b))]);
        thread.label = b.kind === "recall" ? "From your interview" : "Something to think about";
        thread.canReply = true;
        thread.contextValue = "writerStudio.nudge";
        thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        threads.add(thread);
      }
    } catch (err) {
      host.log(`nudge: ${err.message}`);
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(() => {
    const seconds = host.stuckSeconds();
    const editor = vscode.window.activeTextEditor;
    if (!seconds || !editor || !host.isDraft(editor.document))
      return;
    const now = Date.now();
    if (!lastEdit || now - lastEdit < seconds * 1000 || now - lastEdit > STALE_MS || now - lastNudge < COOLDOWN_MS || threads.size)
      return;
    if (nudged.has(paragraphText(editor.document, editor.selection.active.line)))
      return;
    nudge(editor, false);
  }, 5000);
  timer.unref?.();
  return [
    controller,
    { dispose: () => {
      clearInterval(timer);
      clearAll();
    } },
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!e.contentChanges.length || !host.isDraft(e.document))
        return;
      lastEdit = Date.now();
      if (threads.size && [...threads].some((t) => t.uri.toString() === e.document.uri.toString() && !t.comments.some((c) => c.author.name !== author.name)))
        clearAll();
    }),
    vscode.workspace.onDidOpenTextDocument(() => {
      nudged = new Set;
    }),
    vscode.commands.registerCommand("writerStudio.nudge", () => {
      const editor = vscode.window.activeTextEditor;
      if (editor)
        nudge(editor, true);
    }),
    vscode.commands.registerCommand("writerStudio.nudge.reply", (reply) => {
      const text = reply.text.trim();
      if (!text)
        return;
      const asked = reply.thread.comments[0]?.body;
      host.saveReply(typeof asked === "string" ? asked : asked?.value ?? "", text);
      reply.thread.comments = [...reply.thread.comments, comment(text, "You"), comment("Saved to your interview. Keep going.")];
      reply.thread.canReply = false;
    }),
    vscode.commands.registerCommand("writerStudio.nudge.dismiss", (thread) => {
      if (thread) {
        thread.dispose();
        threads.delete(thread);
      } else {
        clearAll();
      }
    })
  ];
}

// src/core/pdfEditor.ts
var crypto4 = __toESM(require("crypto"));
var fs6 = __toESM(require("fs"));
var path6 = __toESM(require("path"));

// src/core/pdfStore.ts
var crypto3 = __toESM(require("crypto"));
var fs5 = __toESM(require("fs"));
var path5 = __toESM(require("path"));
var NOTES_DIR = path5.join(".vswriter", "pdf-notes");
var HIGHLIGHT_COLORS = ["ochre", "sage", "brick"];
var FORMAT_VERSION = 1;
var MAX_TEXT = 20000;
var MAX_NOTE = 5000;
var MAX_LABEL = 200;
var MAX_RECTS = 400;
var BLOCK_QUOTE_WORDS = 100;
function emptyAnnotations(pdf) {
  return { version: FORMAT_VERSION, pdf, highlights: [], bookmarks: [] };
}
function pdfKey(pdfPath, workspaceDir) {
  if (workspaceDir) {
    const rel = path5.relative(workspaceDir, pdfPath);
    if (rel && !rel.startsWith("..") && !path5.isAbsolute(rel)) {
      return rel.split(path5.sep).join("/");
    }
  }
  return path5.resolve(pdfPath);
}
function slugify(text, max = 48) {
  const slug = text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/, "");
  return slug;
}
function notesDir(workspaceDir, globalStorageDir) {
  return workspaceDir ? path5.join(workspaceDir, NOTES_DIR) : path5.join(globalStorageDir, "pdf-notes");
}
function annotationsPath(pdfPath, workspaceDir, globalStorageDir) {
  const key = pdfKey(pdfPath, workspaceDir);
  const hash = crypto3.createHash("sha1").update(key).digest("hex").slice(0, 8);
  const slug = slugify(path5.basename(pdfPath).replace(/\.pdf$/i, "")) || "pdf";
  return path5.join(notesDir(workspaceDir, globalStorageDir), `${slug}-${hash}.json`);
}
function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}
function round(n) {
  return Math.round(n * 1e5) / 1e5;
}
function sanitizeRects(rects) {
  if (!Array.isArray(rects)) {
    return [];
  }
  const out = [];
  for (const r of rects.slice(0, MAX_RECTS)) {
    const { x, y, w, h } = r ?? {};
    if (![x, y, w, h].every((v) => typeof v === "number" && Number.isFinite(v))) {
      continue;
    }
    const cx = clamp01(x);
    const cy = clamp01(y);
    const cw = Math.min(clamp01(w), 1 - cx);
    const ch = Math.min(clamp01(h), 1 - cy);
    if (cw > 0 && ch > 0) {
      out.push({ x: round(cx), y: round(cy), w: round(cw), h: round(ch) });
    }
  }
  return out;
}
function validPage(page) {
  return typeof page === "number" && Number.isInteger(page) && page >= 1 && page <= 1e5;
}
function str(value, max) {
  return typeof value === "string" ? value.slice(0, max) : "";
}
function isoOr(value, fallback) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : fallback;
}
function newId() {
  return crypto3.randomBytes(6).toString("hex");
}
var byPage = (a, b) => a.page - b.page || a.createdAt.localeCompare(b.createdAt);
function sanitizeHighlight(raw, now) {
  const h = raw ?? {};
  const text = str(h.text, MAX_TEXT);
  if (!validPage(h.page) || !text.trim()) {
    return null;
  }
  return {
    id: typeof h.id === "string" && h.id ? h.id.slice(0, 64) : newId(),
    page: h.page,
    text,
    note: str(h.note, MAX_NOTE),
    color: HIGHLIGHT_COLORS.includes(h.color) ? h.color : "ochre",
    rects: sanitizeRects(h.rects),
    createdAt: isoOr(h.createdAt, now)
  };
}
function sanitizeBookmark(raw, now) {
  const b = raw ?? {};
  if (!validPage(b.page)) {
    return null;
  }
  return {
    id: typeof b.id === "string" && b.id ? b.id.slice(0, 64) : newId(),
    page: b.page,
    label: str(b.label, MAX_LABEL).trim() || `Page ${b.page}`,
    createdAt: isoOr(b.createdAt, now)
  };
}
function parseAnnotations(json, pdf, now = new Date) {
  const raw = JSON.parse(json);
  const stamp = now.toISOString();
  const highlights = (Array.isArray(raw.highlights) ? raw.highlights : []).map((h) => sanitizeHighlight(h, stamp)).filter((h) => h !== null);
  const bookmarks = [];
  for (const entry of Array.isArray(raw.bookmarks) ? raw.bookmarks : []) {
    const b = sanitizeBookmark(entry, stamp);
    if (b && !bookmarks.some((o) => o.page === b.page)) {
      bookmarks.push(b);
    }
  }
  return { version: FORMAT_VERSION, pdf: typeof raw.pdf === "string" ? raw.pdf : pdf, highlights: highlights.sort(byPage), bookmarks: bookmarks.sort(byPage) };
}
function loadPdfAnnotations(file, pdf) {
  let json;
  try {
    json = fs5.readFileSync(file, "utf8");
  } catch {
    return emptyAnnotations(pdf);
  }
  try {
    return parseAnnotations(json, pdf);
  } catch {
    const aside = `${file.replace(/\.json$/, "")}.unreadable-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    try {
      fs5.renameSync(file, aside);
    } catch {}
    return emptyAnnotations(pdf);
  }
}
function savePdfAnnotations(file, data) {
  fs5.mkdirSync(path5.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs5.writeFileSync(tmp, JSON.stringify(data, null, "\t") + `
`, "utf8");
  fs5.renameSync(tmp, file);
}
function addHighlight(data, input, now = new Date, id = newId()) {
  const highlight = sanitizeHighlight({ ...input, id, createdAt: now.toISOString() }, now.toISOString());
  if (!highlight) {
    return data;
  }
  return { ...data, highlights: [...data.highlights, highlight].sort(byPage) };
}
function deleteHighlight(data, id) {
  return { ...data, highlights: data.highlights.filter((h) => h.id !== id) };
}
function updateHighlightNote(data, id, note) {
  return { ...data, highlights: data.highlights.map((h) => h.id === id ? { ...h, note: str(note, MAX_NOTE) } : h) };
}
function toggleBookmark(data, page, label, now = new Date, id = newId()) {
  if (!validPage(page)) {
    return data;
  }
  if (data.bookmarks.some((b) => b.page === page)) {
    return { ...data, bookmarks: data.bookmarks.filter((b) => b.page !== page) };
  }
  const bookmark = sanitizeBookmark({ id, page, label, createdAt: now.toISOString() }, now.toISOString());
  return { ...data, bookmarks: [...data.bookmarks, bookmark].sort(byPage) };
}
function deleteBookmark(data, id) {
  return { ...data, bookmarks: data.bookmarks.filter((b) => b.id !== id) };
}
var COURSE_PREFIX = /^(?:(?:week|wk|w)\s*\d+|required|suggested|supplemental|optional|syllabus|lecture\s*\d*|r\d{2,4})\s*(?:[—–_-]+\s*|\s+)/i;
var NOT_AUTHOR = new Set([
  "the",
  "a",
  "an",
  "week",
  "lecture",
  "chapter",
  "part",
  "volume",
  "vol",
  "issue",
  "report",
  "annual",
  "notes",
  "reading",
  "readings",
  "draft",
  "final",
  "version",
  "scan",
  "edition",
  "spring",
  "summer",
  "fall",
  "autumn",
  "winter",
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december"
]);
var SURNAME = "(?:(?:van|von|de|der|den|da|di|du|le|la)\\s+)*\\p{Lu}[\\p{L}'’]+(?:-\\p{Lu}[\\p{L}'’]+)?";
var AUTHOR_YEAR = new RegExp(`^(${SURNAME})(?:,\\s*(?:\\p{Lu}[\\p{L}.]*\\s*){1,3})?` + `(?:[\\s_]+(et[\\s_]*al\\.?|(?:and|&)[\\s_]+${SURNAME}))?` + `[\\s_,.()\\[\\]—–-]*((?:1[89]|20)\\d{2})[a-z]?(?!\\d)`, "u");
function inferCitation(fileName) {
  let stem2 = path5.basename(fileName).replace(/\.pdf$/i, "").trim();
  for (let guard = 0;guard < 6 && COURSE_PREFIX.test(stem2); guard++) {
    stem2 = stem2.replace(COURSE_PREFIX, "");
  }
  const m = AUTHOR_YEAR.exec(stem2);
  if (!m || NOT_AUTHOR.has(m[1].toLowerCase())) {
    return null;
  }
  const extra = m[2]?.replace(/_/g, " ");
  let author = m[1];
  if (extra && /^et/i.test(extra)) {
    author += " et al.";
  } else if (extra) {
    author += " " + extra.replace(/^&/, "and").replace(/\s+/g, " ");
  }
  return { author, year: m[3] };
}
function pdfStem(fileName) {
  return path5.basename(fileName).replace(/\.pdf$/i, "");
}
function citationFor(page, fileName) {
  const c = inferCitation(fileName);
  return c ? `(${c.author} ${c.year}: p. ${page})` : `(${pdfStem(fileName)}, PDF p. ${page})`;
}
function cleanSelection(text) {
  return text.replace(/­/g, "").replace(/(\p{Ll})-[ \t]*\r?\n\s*(\p{Ll})/gu, "$1$2").replace(/\s+/g, " ").trim();
}
function formatQuoteForDraft(text, page, fileName) {
  const quote = cleanSelection(text);
  const cite = citationFor(page, fileName);
  if (quote.split(" ").length >= BLOCK_QUOTE_WORDS) {
    return `> ${quote} ${cite}`;
  }
  return `"${quote.replace(/"/g, "'").replace(/“/g, "‘").replace(/”/g, "’")}" ${cite}`;
}
function cell(text) {
  return text.replace(/\|/g, "\\|");
}
function sourceMapRow(text, page, fileName) {
  const c = inferCitation(fileName);
  const source = c ? `${c.author} ${c.year}: p. ${page}` : "";
  return `| "${cell(cleanSelection(text))}" |  | ${cell(source)} | ${cell(path5.basename(fileName))}, PDF p. ${page} |`;
}
var TABLE_HEADER = SOURCE_MAP_TEMPLATE.split(`
`).filter((l) => l.startsWith("|")).join(`
`);
function appendHighlightToSourceMap(workspaceDir, text, page, fileName) {
  const file = path5.join(workspaceDir, SOURCE_MAP);
  const row = sourceMapRow(text, page, fileName);
  let existing = null;
  try {
    existing = fs5.readFileSync(file, "utf8");
  } catch {}
  if (existing === null) {
    fs5.writeFileSync(file, SOURCE_MAP_TEMPLATE + row + `
`, { encoding: "utf8", flag: "wx" });
    return row;
  }
  const endsInTable = /(?:^|\n)\|[^\n]*\|[ \t]*\n?$/.test(existing);
  const lead = existing.length === 0 || existing.endsWith(`
`) ? "" : `
`;
  const chunk = endsInTable ? lead + row + `
` : `${lead}
${TABLE_HEADER}
${row}
`;
  fs5.appendFileSync(file, chunk, "utf8");
  return row;
}

// src/core/pdfEditor.ts
var PDF_VIEW_TYPE = "writerStudio.pdfReader";
var PDF_TEMPLATE = "pdf.html";
var PDF_PLACEHOLDERS = ["{{CSP_SOURCE}}", "{{NONCE}}", "{{PDF_CSS_URI}}", "{{PDF_JS_URI}}", "{{PDF_WORKER_URI}}", "{{PDF_APP_URI}}"];
function fillTemplate(template, values) {
  let html = template;
  for (const key of PDF_PLACEHOLDERS) {
    html = html.split(key).join(values[key]);
  }
  return html;
}
var MISSING_TEMPLATE = "<!DOCTYPE html><html><body><p>media/pdf.html is missing from the extension.</p></body></html>";
var isStr = (v) => typeof v === "string";
var isPage = (v) => typeof v === "number" && Number.isInteger(v) && v >= 1;
function parsePdfMessage(raw) {
  const m = raw ?? {};
  switch (m.type) {
    case "pdfReady":
      return { type: "pdfReady" };
    case "pdfText":
      return typeof m.reqId === "number" && Array.isArray(m.pages) && m.pages.every(isStr) ? { type: "pdfText", reqId: m.reqId, pages: m.pages } : null;
    case "addHighlight": {
      const h = m.highlight ?? {};
      if (!isPage(h.page) || !isStr(h.text) || !h.text.trim() || !HIGHLIGHT_COLORS.includes(h.color)) {
        return null;
      }
      return {
        type: "addHighlight",
        highlight: { page: h.page, text: h.text, note: isStr(h.note) ? h.note : "", color: h.color, rects: Array.isArray(h.rects) ? h.rects : [] }
      };
    }
    case "deleteHighlight":
    case "deleteBookmark":
      return isStr(m.id) ? { type: m.type, id: m.id } : null;
    case "updateHighlightNote":
      return isStr(m.id) && isStr(m.note) ? { type: "updateHighlightNote", id: m.id, note: m.note } : null;
    case "toggleBookmark":
      return isPage(m.page) ? { type: "toggleBookmark", page: m.page, label: isStr(m.label) ? m.label : "" } : null;
    case "sendToDraft":
    case "appendToSourceMap":
      return isPage(m.page) && isStr(m.text) && m.text.trim() ? { type: m.type, text: m.text, page: m.page, fileName: isStr(m.fileName) ? m.fileName : "" } : null;
    default:
      return null;
  }
}
var OPENERS = /[\s([{“‘"'—–-]/;
function padQuote(quote, before, after) {
  if (quote.startsWith("> ")) {
    const lead2 = before.trim() ? `

` : "";
    const tail2 = after.trim() ? `

` : "";
    return lead2 + quote + tail2;
  }
  const lead = before && !OPENERS.test(before.slice(-1)) ? " " : "";
  const tail = after && /^[\p{L}\p{N}]/u.test(after) ? " " : "";
  return lead + quote + tail;
}

class PdfReaderProvider {
  vscode;
  deps;
  open = new Map;
  pendingPage = new Map;
  textRequests = new Map;
  nextReq = 1;
  openUris() {
    return [...this.open.keys()].map((k) => this.vscode.Uri.parse(k));
  }
  extractText(uri, timeoutMs = 15000) {
    const entry = this.open.get(uri.toString());
    if (!entry) {
      return Promise.resolve([]);
    }
    const reqId = this.nextReq++;
    return new Promise((resolve2) => {
      const timer = setTimeout(() => {
        this.textRequests.delete(reqId);
        resolve2([]);
      }, timeoutMs);
      this.textRequests.set(reqId, (pages) => {
        clearTimeout(timer);
        resolve2(pages);
      });
      this.post(entry, { type: "pdfExtractText", reqId });
    });
  }
  suggest(uri, items) {
    const entry = this.open.get(uri.toString());
    if (entry) {
      this.post(entry, { type: "pdfSuggest", items });
    }
  }
  lastTextEditor;
  constructor(vscode, deps) {
    this.vscode = vscode;
    this.deps = deps;
  }
  trackEditor(editor) {
    if (editor && ["file", "untitled"].includes(editor.document.uri.scheme ?? "file")) {
      this.lastTextEditor = editor;
    }
  }
  workspaceDirFor(uri) {
    const folders = this.vscode.workspace.workspaceFolders ?? [];
    const inside = folders.find((f) => !path6.relative(f.uri.fsPath, uri.fsPath).startsWith(".."));
    return (inside ?? folders[0])?.uri.fsPath;
  }
  notesFileFor(uri) {
    return annotationsPath(uri.fsPath, this.workspaceDirFor(uri), this.deps.globalStorageDir);
  }
  openCustomDocument(uri) {
    return { uri, dispose: () => {
      return;
    } };
  }
  resolveCustomEditor(document, panel) {
    const { vscode } = this;
    const uri = document.uri;
    const id = uri.toString();
    const workspaceDir = this.workspaceDirFor(uri);
    const entry = { panel, notesFile: this.notesFileFor(uri), key: pdfKey(uri.fsPath, workspaceDir) };
    this.open.set(id, entry);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.deps.extensionUri,
        vscode.Uri.joinPath(uri, ".."),
        ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri)
      ]
    };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((raw) => this.handle(uri, raw));
    panel.onDidDispose(() => {
      if (this.open.get(id) === entry) {
        this.open.delete(id);
      }
    });
  }
  html(webview) {
    const media = this.vscode.Uri.joinPath(this.deps.extensionUri, "media");
    const file = this.vscode.Uri.joinPath(media, PDF_TEMPLATE).fsPath;
    if (!fs6.existsSync(file)) {
      return MISSING_TEMPLATE;
    }
    const asUri = (...parts) => webview.asWebviewUri(this.vscode.Uri.joinPath(media, ...parts)).toString();
    return fillTemplate(fs6.readFileSync(file, "utf8"), {
      "{{CSP_SOURCE}}": webview.cspSource,
      "{{NONCE}}": crypto4.randomBytes(16).toString("hex"),
      "{{PDF_CSS_URI}}": asUri("pdf.css"),
      "{{PDF_JS_URI}}": asUri("vendor", "pdf.min.mjs"),
      "{{PDF_WORKER_URI}}": asUri("vendor", "pdf.worker.min.mjs"),
      "{{PDF_APP_URI}}": asUri("pdf.js")
    });
  }
  goToPage(uri, page) {
    if (!isPage(page)) {
      return;
    }
    const entry = this.open.get(uri.toString());
    if (entry) {
      this.post(entry, { type: "pdfGoToPage", page });
    } else {
      this.pendingPage.set(uri.toString(), page);
    }
  }
  post(entry, message) {
    entry.panel.webview.postMessage(message);
  }
  load(entry) {
    return loadPdfAnnotations(entry.notesFile, entry.key);
  }
  mutate(entry, change) {
    const before = this.load(entry);
    const after = change(before);
    if (after !== before) {
      savePdfAnnotations(entry.notesFile, after);
    }
    this.post(entry, { type: "pdfData", highlights: after.highlights, bookmarks: after.bookmarks });
  }
  async handle(uri, raw) {
    const entry = this.open.get(uri.toString());
    const msg = parsePdfMessage(raw);
    if (!entry || !msg) {
      return;
    }
    const fileName = path6.basename(uri.fsPath);
    switch (msg.type) {
      case "pdfText": {
        this.textRequests.get(msg.reqId)?.(msg.pages);
        this.textRequests.delete(msg.reqId);
        break;
      }
      case "pdfReady": {
        const data = this.load(entry);
        const initialPage = this.pendingPage.get(uri.toString());
        this.pendingPage.delete(uri.toString());
        this.post(entry, {
          type: "pdfInit",
          fileName,
          pdfUri: entry.panel.webview.asWebviewUri(uri).toString(),
          highlights: data.highlights,
          bookmarks: data.bookmarks,
          ...initialPage ? { initialPage } : {}
        });
        break;
      }
      case "addHighlight":
        this.mutate(entry, (d) => addHighlight(d, msg.highlight));
        break;
      case "deleteHighlight":
        this.mutate(entry, (d) => deleteHighlight(d, msg.id));
        break;
      case "updateHighlightNote":
        this.mutate(entry, (d) => updateHighlightNote(d, msg.id, msg.note));
        break;
      case "toggleBookmark":
        this.mutate(entry, (d) => toggleBookmark(d, msg.page, msg.label));
        break;
      case "deleteBookmark":
        this.mutate(entry, (d) => deleteBookmark(d, msg.id));
        break;
      case "sendToDraft":
        await this.sendToDraft(formatQuoteForDraft(msg.text, msg.page, fileName));
        break;
      case "appendToSourceMap":
        this.appendToSourceMap(uri, msg.text, msg.page, fileName);
        break;
    }
  }
  findDraft() {
    const visible = this.vscode.window.visibleTextEditors ?? [];
    const draft = this.deps.draftEditor();
    if (draft && !draft.document.isClosed) {
      return draft;
    }
    const markdown = visible.find((e) => e.document.languageId === "markdown");
    if (markdown) {
      return markdown;
    }
    const last = this.lastTextEditor;
    return last && !last.document.isClosed && visible.includes(last) ? last : visible.find((e) => e.document.uri.scheme === "file");
  }
  async sendToDraft(quote) {
    const { vscode } = this;
    let editor = this.findDraft();
    if (editor && !(vscode.window.visibleTextEditors ?? []).includes(editor)) {
      editor = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preserveFocus: true, preview: false });
    }
    if (editor) {
      const sel = editor.selection;
      const line = editor.document.lineAt(sel.start.line).text;
      const endLine = editor.document.lineAt(sel.end.line).text;
      const text = padQuote(quote, line.slice(0, sel.start.character), endLine.slice(sel.end.character));
      const done = await editor.edit((b) => b.replace(sel, text));
      if (done) {
        editor.revealRange(sel, vscode.TextEditorRevealType.InCenter);
        vscode.window.setStatusBarMessage(`VSwriter: quote added to ${path6.basename(editor.document.fileName)}`, 4000);
        return true;
      }
    }
    await vscode.env.clipboard.writeText(quote);
    vscode.window.showInformationMessage("VSwriter: no Markdown draft is open, so the quote and its citation are on the clipboard.");
    return false;
  }
  appendToSourceMap(uri, text, page, fileName) {
    const { vscode } = this;
    const workspaceDir = this.workspaceDirFor(uri);
    if (!workspaceDir) {
      vscode.window.showWarningMessage("VSwriter: open the assignment folder first. source-map.md is kept there.");
      return;
    }
    appendHighlightToSourceMap(workspaceDir, text, page, fileName);
    vscode.window.setStatusBarMessage(`VSwriter: PDF p. ${page} added to source-map.md`, 4000);
    this.deps.onSourceMapChanged?.();
  }
}
var PDF_EXCLUDE = "{**/node_modules/**,**/.git/**,**/.vswriter/**}";
async function pickPdf(vscode) {
  const browse = async () => (await vscode.window.showOpenDialog({ canSelectMany: false, filters: { PDF: ["pdf"] }, openLabel: "Open beside draft" }))?.[0];
  const found = vscode.workspace.workspaceFolders?.length ? await vscode.workspace.findFiles("**/*.pdf", PDF_EXCLUDE, 2000) : [];
  if (!found.length) {
    return browse();
  }
  const items = [
    { label: "Browse for a PDF...", uri: undefined },
    ...found.map((uri) => ({ label: path6.basename(uri.fsPath), description: path6.dirname(vscode.workspace.asRelativePath(uri, false)), uri })).sort((a, b) => a.label.localeCompare(b.label))
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Open a PDF beside the draft", matchOnDescription: true });
  if (!pick) {
    return;
  }
  return pick.uri ?? browse();
}
async function openPdfBeside(vscode, provider, uri, page) {
  const target = uri && typeof uri.fsPath === "string" ? uri : await pickPdf(vscode);
  if (!target) {
    return;
  }
  if (isPage(page)) {
    provider.goToPage(target, page);
  }
  await vscode.commands.executeCommand("vscode.openWith", target, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false });
}
function registerPdfReader(vscode, deps) {
  const provider = new PdfReaderProvider(vscode, deps);
  provider.trackEditor(vscode.window.activeTextEditor);
  return {
    provider,
    disposables: [
      vscode.window.registerCustomEditorProvider(PDF_VIEW_TYPE, provider, {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }),
      vscode.commands.registerCommand("writerStudio.openPdfBeside", (uri, page) => openPdfBeside(vscode, provider, uri, page)),
      vscode.window.onDidChangeActiveTextEditor((e) => provider.trackEditor(e))
    ]
  };
}

// src/core/researchBrowser.ts
var fs7 = __toESM(require("fs"));
var path7 = __toESM(require("path"));
var SOURCES_DIR = "sources";
var FETCH_TIMEOUT_MS = 20000;
var MAX_PAGE_BYTES = 8 * 1024 * 1024;
var MAX_PDF_BYTES = 60 * 1024 * 1024;
var MIN_REGION_CHARS = 300;
var USER_AGENT = "Mozilla/5.0 (compatible; VSwriter/0.3; research capture)";
function isHttpUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const u = new URL(value.trim());
    return (u.protocol === "http:" || u.protocol === "https:") && !!u.hostname;
  } catch {
    return false;
  }
}
function normalizeUrlInput(value) {
  const v = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    return v;
  }
  return /^[\w-]+(\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(v) ? `https://${v}` : v;
}
var URL_IN_TEXT = /https?:\/\/[^\s<>"'`)\]]+/i;
function defaultUrl(candidates) {
  for (const c of candidates) {
    if (!c) {
      continue;
    }
    const found = (isHttpUrl(c) ? c.trim() : URL_IN_TEXT.exec(c)?.[0])?.replace(/[.,;:!?]+$/, "");
    if (found && isHttpUrl(found)) {
      return found;
    }
  }
  return "";
}
var NAMED = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  shy: "",
  zwnj: "",
  zwj: "",
  lrm: "",
  rlm: "",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  sbquo: "‚",
  ldquo: "“",
  rdquo: "”",
  bdquo: "„",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  bull: "•",
  middot: "·",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  sect: "§",
  para: "¶",
  dagger: "†",
  Dagger: "‡",
  prime: "′",
  Prime: "″",
  times: "×",
  divide: "÷",
  minus: "−",
  plusmn: "±",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  euro: "€",
  pound: "£",
  yen: "¥",
  cent: "¢",
  iexcl: "¡",
  iquest: "¿",
  aacute: "á",
  Aacute: "Á",
  agrave: "à",
  Agrave: "À",
  acirc: "â",
  auml: "ä",
  Auml: "Ä",
  atilde: "ã",
  aring: "å",
  aelig: "æ",
  ccedil: "ç",
  Ccedil: "Ç",
  eacute: "é",
  Eacute: "É",
  egrave: "è",
  Egrave: "È",
  ecirc: "ê",
  euml: "ë",
  iacute: "í",
  igrave: "ì",
  icirc: "î",
  iuml: "ï",
  ntilde: "ñ",
  Ntilde: "Ñ",
  oacute: "ó",
  Oacute: "Ó",
  ograve: "ò",
  ocirc: "ô",
  ouml: "ö",
  Ouml: "Ö",
  otilde: "õ",
  oslash: "ø",
  szlig: "ß",
  uacute: "ú",
  Uacute: "Ú",
  ugrave: "ù",
  ucirc: "û",
  uuml: "ü",
  Uuml: "Ü",
  yacute: "ý",
  yuml: "ÿ",
  oelig: "œ",
  OElig: "Œ",
  scaron: "š",
  Scaron: "Š"
};
var CP1252 = {
  128: "€",
  130: "‚",
  131: "ƒ",
  132: "„",
  133: "…",
  134: "†",
  135: "‡",
  136: "ˆ",
  137: "‰",
  138: "Š",
  139: "‹",
  140: "Œ",
  142: "Ž",
  145: "‘",
  146: "’",
  147: "“",
  148: "”",
  149: "•",
  150: "–",
  151: "—",
  152: "˜",
  153: "™",
  154: "š",
  155: "›",
  156: "œ",
  158: "ž",
  159: "Ÿ"
};
function decodeEntities(text) {
  return text.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (CP1252[code]) {
        return CP1252[code];
      }
      return code > 0 && code <= 1114111 && !(code >= 55296 && code <= 57343) ? String.fromCodePoint(code) : "�";
    }
    const named = NAMED[body];
    return named !== undefined && (whole.endsWith(";") || /^(amp|lt|gt|quot|nbsp)$/.test(body)) ? named : whole;
  });
}
var TOKEN = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\?[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
var RAW_TEXT = new Set(["script", "style", "textarea", "xmp", "noembed", "noframes", "noscript", "iframe", "title"]);
var DROP = new Set(["nav", "footer", "template", "svg", "math", "form", "button", "select", "object", "canvas", "video", "audio", "dialog", "menu"]);
var VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
var BLOCK = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "aside",
  "figure",
  "figcaption",
  "address",
  "dl",
  "dt",
  "dd",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "caption",
  "details",
  "summary",
  "center",
  "ul",
  "ol",
  "body",
  "html",
  "hgroup"
]);
var FURNITURE = /(?:^|[\s_-])(?:cookies?|consent|newsletter|share|sharing|social|advert|advertisement|ads|promo|breadcrumbs?|sidebar|related|comments?|subscribe|skip-link|visually-hidden|sr-only|footer|navbar|nav|menu|masthead|toolbar|editsection)(?=$|[\s_-])/i;
var MENU_MAX_CHARS = 120;
var MENU_LINK_SHARE = 0.75;
var NO_FURNITURE_CHECK = new Set(["html", "body", "main", "article"]);
function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(attrs);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
}
function render(html, dropFurniture) {
  const meta = { title: "", authors: [], published: "", site: "", doi: "" };
  const metaTags = {};
  const blocks = [];
  let buffer = "";
  let prefix = "";
  let heading = 0;
  const dropStack = [];
  let main = 0;
  let article = 0;
  let quoteDepth = 0;
  let pre = 0;
  let preText = "";
  const lists = [];
  let cell2 = 0;
  let link = 0;
  let linkChars = 0;
  let allChars = 0;
  const flush = () => {
    const text = buffer.replace(/[ \t\n\r\f\v    ]+/g, " ").replace(/ ?\u0000 ?/g, `
`).trim();
    buffer = "";
    const linkShare = allChars ? linkChars / allChars : 0;
    linkChars = allChars = 0;
    if (text) {
      const quote = "> ".repeat(quoteDepth);
      blocks.push({ text: quote + prefix + text.split(`
`).join(`
` + quote), region: main ? 2 : article ? 1 : 0, heading, linkShare });
      prefix = "";
    }
  };
  TOKEN.lastIndex = 0;
  let m;
  while (m = TOKEN.exec(html)) {
    const token = m[0];
    const name = m[2]?.toLowerCase();
    if (!name) {
      if (token.startsWith("<!") || token.startsWith("<?")) {
        continue;
      }
      if (dropStack.length) {
        continue;
      }
      const text = decodeEntities(token);
      if (pre) {
        preText += text;
      } else {
        buffer += text;
        const letters = text.replace(/\s+/g, "").length;
        allChars += letters;
        linkChars += link ? letters : 0;
      }
      continue;
    }
    const closing = m[1] === "/";
    const attrs = m[3] ?? "";
    if (!closing && RAW_TEXT.has(name)) {
      const end = new RegExp(`</${name}\\s*>`, "ig");
      end.lastIndex = TOKEN.lastIndex;
      const close = end.exec(html);
      const inner = html.slice(TOKEN.lastIndex, close ? close.index : html.length);
      TOKEN.lastIndex = close ? end.lastIndex : html.length;
      if (name === "title" && !meta.title && !dropStack.length) {
        meta.title = decodeEntities(inner).replace(/\s+/g, " ").trim();
      }
      continue;
    }
    if (name === "meta" && !closing) {
      const key = (attr(attrs, "name") ?? attr(attrs, "property") ?? "").toLowerCase();
      const content = attr(attrs, "content")?.trim();
      if (key && content) {
        (metaTags[key] ??= []).push(content);
      }
      continue;
    }
    if (dropStack.length) {
      if (name === dropStack[0]) {
        if (closing) {
          dropStack.pop();
        } else if (!attrs.trimEnd().endsWith("/")) {
          dropStack.push(name);
        }
      }
      continue;
    }
    if (!closing && !VOID.has(name)) {
      const hidden = /(?:^|\s)hidden(?:\s|=|$)/i.test(attrs) || attr(attrs, "aria-hidden") === "true";
      const furniture = dropFurniture && !NO_FURNITURE_CHECK.has(name) && FURNITURE.test(`${attr(attrs, "class") ?? ""} ${attr(attrs, "id") ?? ""}`);
      const role = attr(attrs, "role");
      if (DROP.has(name) || hidden || furniture || role === "navigation" || role === "banner" || role === "contentinfo") {
        if (!attrs.trimEnd().endsWith("/")) {
          dropStack.push(name);
        }
        continue;
      }
    }
    if (name === "pre") {
      if (!closing) {
        flush();
        pre++;
        preText = "";
      } else if (pre) {
        pre--;
        const code = preText.replace(/^\n/, "").replace(/\s+$/, "");
        if (code) {
          blocks.push({ text: "```\n" + code + "\n```", region: main ? 2 : article ? 1 : 0, heading: 0, linkShare: 0 });
        }
      }
      continue;
    }
    if (pre) {
      if (name === "br") {
        preText += `
`;
      }
      continue;
    }
    const level = /^h([1-6])$/.exec(name);
    if (level) {
      flush();
      if (!closing) {
        heading = Number(level[1]);
        prefix = "#".repeat(heading) + " ";
      } else {
        heading = 0;
      }
      continue;
    }
    switch (name) {
      case "br":
        buffer += "\x00";
        continue;
      case "hr":
        flush();
        blocks.push({ text: "---", region: main ? 2 : article ? 1 : 0, heading: 0, linkShare: 0 });
        continue;
      case "img":
        continue;
      case "a":
        if (closing) {
          link = Math.max(0, link - 1);
        } else if (attr(attrs, "href") !== undefined) {
          link++;
        }
        continue;
      case "li":
        flush();
        if (!closing) {
          const list = lists[lists.length - 1];
          const indent = "  ".repeat(Math.max(0, lists.length - 1));
          prefix = indent + (list?.ordered ? `${++list.n}. ` : "- ");
        }
        continue;
      case "ul":
      case "ol":
        flush();
        if (closing) {
          lists.pop();
        } else {
          lists.push({ ordered: name === "ol", n: 0 });
        }
        continue;
      case "blockquote":
        flush();
        quoteDepth = Math.max(0, quoteDepth + (closing ? -1 : 1));
        continue;
      case "tr":
        flush();
        cell2 = 0;
        continue;
      case "td":
      case "th":
        if (!closing && cell2++ > 0) {
          buffer += " | ";
        }
        continue;
      case "main":
        flush();
        main = Math.max(0, main + (closing ? -1 : 1));
        continue;
      case "article":
        flush();
        article = Math.max(0, article + (closing ? -1 : 1));
        continue;
    }
    if (BLOCK.has(name) || attr(attrs, "role") === "main") {
      flush();
    }
  }
  flush();
  const first = (...keys) => keys.map((k) => metaTags[k]?.[0]).find(Boolean) ?? "";
  meta.title = first("citation_title", "dc.title", "og:title") || meta.title;
  meta.authors = metaTags["citation_author"] ?? metaTags["dc.creator"] ?? (first("author", "article:author") ? [first("author", "article:author")] : []);
  meta.authors = meta.authors.filter((a) => !/^https?:/i.test(a));
  meta.published = first("citation_publication_date", "citation_date", "dc.date", "article:published_time", "date");
  meta.site = first("citation_journal_title", "og:site_name");
  meta.doi = first("citation_doi", "dc.identifier").replace(/^doi:\s*/i, "");
  const h1 = blocks.find((b) => b.heading === 1)?.text.replace(/^#+ /, "").trim() ?? "";
  if (!meta.title || h1 && h1.length < meta.title.length && meta.title.startsWith(h1) && /^\s*[-–—|:·•]\s*\S/.test(meta.title.slice(h1.length))) {
    meta.title = h1 || meta.title;
  }
  return { blocks, meta };
}
function isMenu(b) {
  return !b.heading && b.linkShare >= MENU_LINK_SHARE && b.text.length <= MENU_MAX_CHARS;
}
function chooseBlocks(all) {
  const blocks = all.filter((b) => !isMenu(b));
  const chars = (bs) => bs.reduce((n, b) => n + b.text.length, 0);
  for (const region of [2, 1]) {
    const inside = blocks.filter((b) => b.region >= region);
    if (chars(inside) >= MIN_REGION_CHARS) {
      return inside;
    }
  }
  return blocks;
}
function invertName(name) {
  const n = name.replace(/\s+/g, " ").trim();
  if (n.includes(",") || !n.includes(" ")) {
    return n;
  }
  const parts = n.split(" ");
  return `${parts.pop()}, ${parts.join(" ")}`;
}
function isoDate(d) {
  if (typeof d === "string") {
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : d;
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function longDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : iso;
}
var yaml = (s) => JSON.stringify(s);
function escapeTags(text) {
  return text.replace(/<(?=[a-zA-Z/!?])/g, "\\<");
}
function pageToMarkdown(html, url, accessedDate) {
  let { blocks, meta } = render(html, true);
  let chosen = chooseBlocks(blocks);
  if (chosen.reduce((n, b) => n + b.text.length, 0) < MIN_REGION_CHARS) {
    ({ blocks, meta } = render(html, false));
    chosen = chooseBlocks(blocks);
  }
  const title = meta.title || (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const firstH1 = chosen.findIndex((c) => c.heading === 1);
  const body = chosen.filter((b, i) => !(i === firstH1 && b.text.replace(/^# /, "").trim().toLowerCase() === title.toLowerCase()));
  const accessed = isoDate(accessedDate);
  const year = /\b((?:1[89]|20)\d{2})\b/.exec(meta.published)?.[1];
  const author = meta.authors[0] ? invertName(meta.authors[0]) : "";
  const h1 = author ? `${author}${year ? ` (${year})` : ""}. ${title}` : title;
  const front = ["---", `title: ${yaml(title)}`];
  if (meta.authors.length) {
    front.push(`author: ${yaml(meta.authors.map(invertName).join("; "))}`);
  }
  if (meta.published) {
    front.push(`published: ${yaml(meta.published)}`);
  }
  if (meta.site) {
    front.push(`site: ${yaml(meta.site)}`);
  }
  if (meta.doi) {
    front.push(`doi: ${yaml(meta.doi)}`);
  }
  front.push(`source_url: ${yaml(url)}`, `accessed: ${yaml(accessed)}`, "---");
  const lines = [
    front.join(`
`),
    `# ${escapeTags(h1)}`,
    `Source: <${url}> (accessed ${longDate(accessed)})`,
    ...body.map((b) => b.text.startsWith("```") ? b.text : escapeTags(b.text))
  ];
  return { markdown: lines.join(`

`) + `
`, title };
}
function plainTextToHtml(text, title) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<title>${esc(title)}</title>` + text.split(/\r?\n\s*\r?\n/).map((p) => `<p>${esc(p)}</p>`).join("");
}
function charsetOf(contentType, head) {
  const fromHeader = /charset\s*=\s*["']?([\w.:-]+)/i.exec(contentType)?.[1];
  if (fromHeader) {
    return fromHeader;
  }
  const ascii = new TextDecoder("latin1").decode(head.slice(0, 4096));
  return /<meta[^>]+charset\s*=\s*["']?([\w.:-]+)/i.exec(ascii)?.[1] ?? "utf-8";
}
function decode(bytes, charset) {
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
async function readCapped(response, max) {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > max) {
    throw new Error(`the page is larger than ${Math.round(max / 1024 / 1024)} MB`);
  }
  if (!response.body) {
    return new Uint8Array(await response.arrayBuffer());
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;; ) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new Error(`the page is larger than ${Math.round(max / 1024 / 1024)} MB`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
async function fetchPage(url, fetchImpl = fetch) {
  if (!isHttpUrl(url)) {
    throw new Error("only http:// and https:// addresses can be captured");
  }
  const controller = new AbortController;
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,application/pdf;q=0.8,*/*;q=0.5" }
    });
    const finalUrl = response.url && isHttpUrl(response.url) ? response.url : url;
    if (!response.ok) {
      throw new Error(`the server answered HTTP ${response.status}`);
    }
    const type = (response.headers.get("content-type") ?? "").toLowerCase();
    if (type.includes("application/pdf") || /\.pdf(?:$|[?#])/i.test(new URL(finalUrl).pathname) && !type.includes("html")) {
      return { kind: "pdf", finalUrl, text: "", bytes: await readCapped(response, MAX_PDF_BYTES) };
    }
    if (type && !/(?:text\/html|application\/xhtml\+xml|text\/plain)/.test(type)) {
      throw new Error(`it is ${type.split(";")[0]}, not a web page`);
    }
    const bytes = await readCapped(response, MAX_PAGE_BYTES);
    const text = decode(bytes, charsetOf(type, bytes));
    return { kind: type.includes("text/plain") ? "text" : "html", finalUrl, text, bytes };
  } catch (err) {
    if (err.name === "AbortError") {
      throw new Error(`no answer within ${FETCH_TIMEOUT_MS / 1000} seconds`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
function captureSlug(title, url) {
  let host = "";
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  return slugify(title, 60) || slugify(host, 60) || "page";
}
function writeUnique(dir, slug, ext, content) {
  fs7.mkdirSync(dir, { recursive: true });
  for (let n = 1;; n++) {
    const file = path7.join(dir, `${slug}${n === 1 ? "" : `-${n}`}${ext}`);
    try {
      fs7.writeFileSync(file, content, { flag: "wx" });
      return file;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
    }
  }
}
async function capturePage(url, workspaceDir, accessed, fetchImpl = fetch) {
  const page = await fetchPage(url, fetchImpl);
  const dir = path7.join(workspaceDir, SOURCES_DIR);
  if (page.kind === "pdf") {
    const name = decodeURIComponent(path7.basename(new URL(page.finalUrl).pathname)).replace(/\.pdf$/i, "");
    const file2 = writeUnique(dir, slugify(name, 60) || captureSlug("", page.finalUrl), ".pdf", page.bytes);
    return { file: file2, kind: "pdf", title: name };
  }
  const html = page.kind === "text" ? plainTextToHtml(page.text, path7.basename(new URL(page.finalUrl).pathname)) : page.text;
  const { markdown, title } = pageToMarkdown(html, page.finalUrl, accessed);
  const file = writeUnique(dir, captureSlug(title, page.finalUrl), ".md", markdown);
  return { file, kind: page.kind, title };
}

class ResearchBrowser {
  vscode;
  deps;
  lastUrl = "";
  constructor(vscode, deps) {
    this.vscode = vscode;
    this.deps = deps;
  }
  async suggestions(arg) {
    const editor = this.vscode.window.activeTextEditor;
    const selected = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : undefined;
    let clipboard;
    try {
      clipboard = await this.vscode.env.clipboard.readText();
    } catch {
      clipboard = undefined;
    }
    return defaultUrl([typeof arg === "string" ? arg : undefined, selected, clipboard, this.lastUrl]);
  }
  async askUrl(arg, prompt) {
    if (isHttpUrl(arg)) {
      return arg.trim();
    }
    const value = await this.vscode.window.showInputBox({
      prompt,
      value: await this.suggestions(arg),
      placeHolder: "https://",
      ignoreFocusOut: true,
      validateInput: (v) => isHttpUrl(normalizeUrlInput(v)) ? null : "Enter an http:// or https:// address."
    });
    const url = value === undefined ? undefined : normalizeUrlInput(value);
    return url && isHttpUrl(url) ? url : undefined;
  }
  async openBeside(arg) {
    const { vscode } = this;
    const url = await this.askUrl(arg, "Page to open beside the draft");
    if (!url) {
      return;
    }
    this.lastUrl = url;
    await vscode.commands.executeCommand("workbench.action.focusLastEditorGroup");
    await vscode.commands.executeCommand("workbench.action.newGroupRight");
    try {
      await vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(url), { viewColumn: vscode.ViewColumn.Active, preserveFocus: false });
    } catch {
      await vscode.commands.executeCommand("simpleBrowser.show", url);
    }
  }
  async capture(arg) {
    const { vscode } = this;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) {
      vscode.window.showWarningMessage("VSwriter: open the assignment folder first. Captured pages are saved in its sources folder.");
      return;
    }
    const url = await this.askUrl(arg, "Page to capture into sources/ as Markdown");
    if (!url) {
      return;
    }
    this.lastUrl = url;
    const running = capturePage(url, folder.uri.fsPath, (this.deps.now ?? (() => new Date))(), this.deps.fetchImpl);
    vscode.window.setStatusBarMessage(`VSwriter: capturing ${new URL(url).hostname}`, running);
    let result;
    try {
      result = await running;
    } catch (err) {
      vscode.window.showWarningMessage(`VSwriter: could not capture ${url}: ${err.message}.`);
      return;
    }
    const uri = vscode.Uri.file(result.file);
    if (result.kind === "pdf") {
      await this.deps.openPdf(uri);
    } else {
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: false });
    }
    vscode.window.setStatusBarMessage(`VSwriter: saved ${path7.join(SOURCES_DIR, path7.basename(result.file))}`, 5000);
    this.deps.onSourceCaptured(result.file);
    return result;
  }
}
function registerResearchBrowser(vscode, deps) {
  const browser = new ResearchBrowser(vscode, deps);
  return {
    browser,
    disposables: [
      vscode.commands.registerCommand("writerStudio.openBrowserBeside", (url) => browser.openBeside(url)),
      vscode.commands.registerCommand("writerStudio.captureWebPage", (url) => browser.capture(url))
    ]
  };
}

// src/core/paragraphLens.ts
function statusTitle(n) {
  const words = n.words === 1 ? "1 word" : `${n.words} words`;
  const quotes = n.quoteCount === 1 ? "1 quote" : `${n.quoteCount} quotes`;
  return `${words} · ${n.distinctSources}/${TARGET_SOURCES} sources · ${quotes}`;
}
var EVIDENCE_GAP = /sources$|^no direct quote$/;
function actionFor(n, hasReadings) {
  const evidenceGap = n.gaps.some((g) => EVIDENCE_GAP.test(g));
  if (hasReadings && evidenceGap && n.words >= SHORT_WORDS / 2) {
    return { title: "Open matching reading", command: "writerStudio.openParagraphReading" };
  }
  if (n.gaps.length || n.words < SHORT_WORDS) {
    return { title: "Insert paragraph skeleton", command: "writerStudio.insertSkeleton" };
  }
  return null;
}
function buildParagraphLenses(outline, hasReadings, uri) {
  const out = [];
  for (const n of outline) {
    out.push({ line: n.line, title: statusTitle(n), command: "writerStudio.openPanel", args: [] });
    const action = actionFor(n, hasReadings);
    if (action) {
      const args = action.command === "writerStudio.insertSkeleton" ? [undefined, uri, n.line] : [uri, n.line];
      out.push({ line: n.line, ...action, args });
    }
  }
  return out;
}
function matchReadingForParagraph(index, paragraphText) {
  if (!index || !index.size || !paragraphText.trim()) {
    return null;
  }
  const probe = { id: "paragraph", timestamp: "", prompt: "this paragraph", text: paragraphText };
  return index.matchBookmarks([probe], 1)[0] ?? null;
}
function createParagraphLensProvider(vscode, getAnswers, getIndex, isEnabled, shouldShow, busyLine = () => {
  return;
}) {
  const changed = new vscode.EventEmitter;
  return {
    onDidChangeCodeLenses: changed.event,
    provideCodeLenses(doc) {
      if (!isEnabled() || !shouldShow(doc)) {
        return [];
      }
      const outline = analyzeOutline(doc.getText(), getAnswers());
      const hasReadings = (getIndex()?.size ?? 0) > 0;
      const busy = busyLine(doc);
      return buildParagraphLenses(outline, hasReadings, doc.uri).filter((spec) => spec.line - 1 !== busy).map((spec) => {
        const range = new vscode.Range(spec.line - 1, 0, spec.line - 1, 0);
        return new vscode.CodeLens(range, { title: spec.title, command: spec.command, arguments: spec.args });
      });
    },
    refresh() {
      changed.fire();
    },
    dispose() {
      changed.dispose();
    }
  };
}

// src/core/quickFixes.ts
var SNAP_THRESHOLD = 0.72;
var SNAP_COVERAGE = 0.7;
var CANDIDATE_PASSAGES = 40;
var WINDOW_SLACK = 3;
function trigrams(s) {
  const padded = ` ${s} `;
  const out = new Set;
  for (let i = 0;i + 3 <= padded.length; i++) {
    out.add(padded.slice(i, i + 3));
  }
  return out;
}
function dice(a, b) {
  let shared = 0;
  const [small, large] = a.size < b.size ? [a, b] : [b, a];
  for (const g of small) {
    if (large.has(g)) {
      shared++;
    }
  }
  return 2 * shared / (a.size + b.size || 1);
}
function asQuotation(raw) {
  return raw.replace(/(\p{L})-\s+(\p{L})/gu, "$1$2").replace(/[“”]/g, (m) => m === "“" ? "‘" : "’").replace(/"/g, "'").replace(/^[^\p{L}\p{N}‘'(\[]+/u, "").replace(/[\s,;:.—–-]+$/u, "").trim();
}
function snapQuote(index, quote) {
  const target = normalizeForMatch(quote);
  if (!index || target.length < 12) {
    return null;
  }
  const want = target.split(" ").length;
  const targetGrams = trigrams(target);
  const targetStems = new Set(tokenize(quote).map((t) => t.stem));
  const needStems = Math.ceil(targetStems.size * SNAP_COVERAGE);
  let best = null;
  for (const passage of index.searchPassages(quote, CANDIDATE_PASSAGES)) {
    const words = [...passage.text.matchAll(/\S+/g)].map((m) => ({
      start: m.index,
      end: m.index + m[0].length,
      norm: normalizeForMatch(m[0]),
      stems: tokenize(m[0]).map((t) => t.stem).filter((st) => targetStems.has(st))
    }));
    for (let s = 0;s < words.length; s++) {
      if (!words[s].norm) {
        continue;
      }
      let norm = "";
      let counted = 0;
      const covered = new Set;
      for (let e = s;e < words.length && counted < want + WINDOW_SLACK; e++) {
        if (!words[e].norm) {
          continue;
        }
        norm = norm ? `${norm} ${words[e].norm}` : words[e].norm;
        counted += words[e].norm.split(" ").length;
        words[e].stems.forEach((st) => covered.add(st));
        if (counted < Math.max(2, want - WINDOW_SLACK) || covered.size < needStems) {
          continue;
        }
        const score = dice(targetGrams, trigrams(norm));
        if (!best || score > best.score) {
          best = { passage, start: words[s].start, end: words[e].end, score };
        }
      }
    }
  }
  if (!best || best.score < SNAP_THRESHOLD) {
    return null;
  }
  const text = asQuotation(best.passage.text.slice(best.start, best.end));
  return text ? { text, passage: best.passage, doc: index.docOf(best.passage), similarity: Math.round(best.score * 1000) / 1000 } : null;
}
function pageCite(doc, passage) {
  const page = /^\d+$/.test(passage.page) ? `p. ${passage.page}` : passage.page;
  return page ? `${doc.author} ${doc.year}: ${page}` : `${doc.author} ${doc.year}`;
}
var CODE_ALIASES = { "wide-range": "wide-page-range", "prose-semicolon": "semicolon" };
var capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
var matchCase = (model, word) => /^\p{Lu}/u.test(model) ? capitalize(word) : word;
var HEDGE_SWAPS = [
  [/^suggests$/i, ["shows", "argues"]],
  [/^suggesting$/i, ["showing", "arguing"]],
  [/^aligns with$/i, ["agrees with", "supports"]],
  [/^align with$/i, ["agree with", "support"]],
  [/^aligned with$/i, ["agreed with", "supported"]],
  [/^aligning with$/i, ["agreeing with", "supporting"]]
];
var CONJUNCTION = /^(?:and|but|so|or|yet|nor)\b/i;
function joinAround(line, text, start, end, joiner, capNext) {
  let s = start;
  while (s > 0 && text[s - 1] === " ") {
    s--;
  }
  let e = end;
  while (e < text.length && text[e] === " ") {
    e++;
  }
  if (capNext && e < text.length) {
    return { line, start: s, end: e + 1, text: joiner + text[e].toUpperCase() };
  }
  return { line, start: s, end: e, text: e < text.length ? joiner : joiner.trimEnd() };
}
function fixesFor(rawCode, lineText, line, start, end, index) {
  const code = CODE_ALIASES[rawCode] ?? rawCode;
  const found = lineText.slice(start, end);
  switch (code) {
    case "unverified-quote": {
      const open = /^["“]/.test(found) ? 1 : 0;
      const close = /["”]$/.test(found) && found.length > 1 ? 1 : 0;
      const inner = found.slice(open, found.length - close);
      const snap = snapQuote(index, inner);
      if (!snap || snap.text === inner) {
        return [];
      }
      return [{
        title: `Snap to verified quote (${pageCite(snap.doc, snap.passage)})`,
        edits: [{ line, start: start + open, end: end - close, text: snap.text }],
        preferred: true
      }];
    }
    case "wide-page-range": {
      const c = parseCitations(lineText).find((x) => x.start === start) ?? parseCitations(`(${found})`)[0];
      const range = /(pp?\.\s*)?(\d{1,4})\s*[-–]\s*\d{1,4}$/.exec(found);
      if (!c || c.pageStart === null || !range) {
        return [];
      }
      const at = start + range.index;
      const fixes = [{
        title: `Pinpoint starting page (${c.surname} ${c.year}: ${c.pageStart})`,
        edits: [{ line, start: at, end: at + range[0].length, text: (range[1] ? "p. " : "") + c.pageStart }]
      }];
      const target = index ? resolveCitation(index, c)?.passages[0] : undefined;
      if (target) {
        fixes.push({
          title: "Open reading to check page",
          edits: [],
          command: { command: "writerStudio.openReadingBeside", title: "Open reading to check page", arguments: [target.filePath, target.line] }
        });
      }
      return fixes;
    }
    case "em-dash":
      return [
        { title: "Replace em dash with comma", edits: [joinAround(line, lineText, start, end, ", ", false)] },
        { title: "Split into two sentences", edits: [joinAround(line, lineText, start, end, ". ", true)] }
      ];
    case "hedge-verb": {
      const swap = HEDGE_SWAPS.find(([re]) => re.test(found.replace(/\s+/g, " ")));
      if (!swap) {
        return [];
      }
      return swap[1].map((word) => ({
        title: `Replace with "${word}"`,
        edits: [{ line, start, end, text: matchCase(found, word) }]
      }));
    }
    case "semicolon": {
      const rest = lineText.slice(end).trimStart();
      const comma = CONJUNCTION.test(rest) ? ", " : ", and ";
      return [
        { title: "Replace semicolon with period", edits: [joinAround(line, lineText, start, end, ". ", true)] },
        { title: comma === ", " ? "Replace semicolon with comma" : 'Replace semicolon with comma and "and"', edits: [joinAround(line, lineText, start, end, comma, false)] }
      ];
    }
    default:
      return [];
  }
}
function codeOf(d) {
  const c = d.code;
  return typeof c === "object" && c !== null ? String(c.value) : String(c ?? "");
}
function createQuickFixProvider(vscode, getIndex) {
  return {
    provideCodeActions(doc, _range, context) {
      const actions = [];
      for (const d of context.diagnostics) {
        if (d.source !== "Writer" || d.range.start.line !== d.range.end.line) {
          continue;
        }
        const line = d.range.start.line;
        const specs = fixesFor(codeOf(d), doc.lineAt(line).text, line, d.range.start.character, d.range.end.character, getIndex());
        for (const spec of specs) {
          const action = new vscode.CodeAction(spec.title, vscode.CodeActionKind.QuickFix);
          action.diagnostics = [d];
          action.isPreferred = spec.preferred ?? false;
          if (spec.edits.length) {
            const edit = new vscode.WorkspaceEdit;
            for (const e of spec.edits) {
              edit.replace(doc.uri, new vscode.Range(e.line, e.start, e.line, e.end), e.text);
            }
            action.edit = edit;
          }
          if (spec.command) {
            action.command = spec.command;
          }
          actions.push(action);
        }
      }
      return actions;
    }
  };
}
function registerQuickFixes(vscode, getIndex) {
  return vscode.languages.registerCodeActionsProvider({ language: "markdown" }, createQuickFixProvider(vscode, getIndex), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] });
}

// src/core/slopLinter.ts
var BANNED_WORDS = {
  delve: 'Say what you look at: "examine", "read", "go through".',
  tapestry: "Name the actual parts and how they connect.",
  multifaceted: "Name the facets you mean.",
  nuance: "State the qualification itself.",
  foster: 'Say who does what: "encourage", "build", "pay for".',
  leverage: '"use" says the same thing.',
  underscore: "Say what the evidence shows.",
  navigate: "Name what the person actually does.",
  landscape: "Name the field, market or group you mean.",
  pivotal: "Show why it decided the outcome.",
  intricate: "Name the parts that make it complicated.",
  testament: "Say what it proves and how.",
  realm: "Name the field.",
  paradigm: "Name the model or assumption.",
  robust: "Say what it withstands.",
  streamline: "Say what got shorter or cheaper.",
  holistic: "Name what is being taken into account."
};
var BANNED_FORMS = "delv(?:e|es|ed|ing)|tapestr(?:y|ies)|multifaceted|nuanc(?:e|es|ed)|foster(?:s|ed|ing)?|" + "leverag(?:e|es|ed|ing)|underscor(?:e|es|ed|ing)|navigat(?:e|es|ed|ing)|landscapes?|pivotal|" + "intricate(?:ly)?|testaments?|realms?|paradigms?|robust(?:ly|ness)?|streamlin(?:e|es|ed|ing)|holistic(?:ally)?";
function bannedBase(word) {
  const w = word.toLowerCase();
  return Object.keys(BANNED_WORDS).find((base) => w.startsWith(base.slice(0, Math.max(4, base.length - 2)))) ?? w;
}
var NEGATIVE_PARALLELISM = "Names a position to reject before the one you hold. Lead with the claim you hold.";
var RULES = [
  { code: "negative-parallelism", severity: "warning", pattern: /\bnot\s+(?:just|only|merely|simply)\b/gi, message: () => NEGATIVE_PARALLELISM },
  { code: "negative-parallelism", severity: "warning", pattern: /\bnot\s+(?!just\b|only\b|merely\b|simply\b)[^.!?;:\n]{1,60}?,\s*but\b/gi, message: () => NEGATIVE_PARALLELISM },
  { code: "negative-parallelism", severity: "warning", pattern: /\brather than\b[^.!?\n]{1,80}?,/gi, message: () => '"Rather than X, Y" defines the point by what it replaces. State Y directly.' },
  { code: "negative-parallelism", severity: "warning", pattern: /\b(?:it|this|that)(?:'s|’s| is) not\b[^.!?\n]{1,60}?[,;]\s*(?:it|this|that)(?:'s|’s| is)\b/gi, message: () => NEGATIVE_PARALLELISM },
  { code: "negative-parallelism", severity: "warning", pattern: /\bis not the (\w+)\.\s+[^.!?\n]{1,80}?\bis the \1\b/gi, message: () => 'The same "not X. Y is" contrast runs across two sentences. Keep the second claim.' },
  { code: "hedge-verb", severity: "warning", pattern: /\bsuggest(?:s|ing)\b/gi, message: () => "Say what the author claims or what the evidence shows." },
  { code: "hedge-verb", severity: "warning", pattern: /\balign(?:s|ed|ing)? with\b/gi, message: () => "Say how the two agree: same claim, same cause or same result." },
  { code: "em-dash", severity: "error", pattern: /—|(?<=\s)–(?=\s)|(?<![-\w])--(?![-\w])|(?<=\w)--(?=\w)/g, message: () => "Dash. Use a comma, a period or parentheses." },
  { code: "ai-vocabulary", severity: "warning", pattern: new RegExp(`\\b(?:${BANNED_FORMS})\\b`, "gi"), message: (m) => `"${m}" is on the banned list. ${BANNED_WORDS[bannedBase(m)] ?? ""}`.trim() },
  { code: "self-commentary", severity: "info", pattern: /,\s*and (?:that|this)(?:'s|’s| is) (?:exactly |precisely )?(?:what|why)\b[^.!?\n]*/gi, message: () => "The tail comments on the claim. Cut it, or state the actual reason or consequence." },
  { code: "self-commentary", severity: "info", pattern: /,\s*which is (?:why|what) (?:it|this|that) (?:matters|counts)\b/gi, message: () => "The tail comments on the claim. Cut it, or state the actual reason or consequence." },
  { code: "abstract-recasting", severity: "info", pattern: /\b(?:becomes|became|turns into|turned into|is transformed into|serves as|functions as)\s+(?:the|a|an)\s+[\p{L}-]+/giu, message: () => 'Possible "X becomes Y" recasting. If it renames a concept, name the person, the action and the judgment instead.' }
];
var MAX_CITED_PAGES = 3;
var MIN_CHECKED_QUOTE = 25;
var EXCERPT_CHARS = 80;
var QUOTE2 = /“([^”\n]+)”|"([^"\n]+)"/g;
var blank = (s) => " ".repeat(s.length);
function maskLine(line) {
  return line.replace(/`[^`]*`/g, blank).replace(/<!--.*?-->/g, blank).replace(/\]\([^)]*\)/g, blank).replace(/<https?:[^>]*>/g, blank).replace(/https?:\/\/\S+/g, blank);
}
function maskQuotes(line) {
  return line.replace(QUOTE2, blank);
}
function semicolonColumns(line) {
  const cols = [];
  let depth = 0;
  for (let i = 0;i < line.length; i++) {
    const ch = line[i];
    if (ch === "(" || ch === "[") {
      depth++;
    } else if ((ch === ")" || ch === "]") && depth > 0) {
      depth--;
    } else if (ch === ";" && depth === 0 && !/&#?\w+$/.test(line.slice(0, i))) {
      cols.push(i);
    }
  }
  return cols;
}
var DASH_CONTEXT = 25;
function dashContext(line, col, length) {
  let start = Math.max(0, col - DASH_CONTEXT);
  let end = Math.min(line.length, col + length + DASH_CONTEXT);
  if (start > 0) {
    const space = line.indexOf(" ", start);
    start = space >= 0 && space < col ? space + 1 : start;
  }
  if (end < line.length) {
    const space = line.lastIndexOf(" ", end);
    end = space > col + length ? space : end;
  }
  const body = line.slice(start, end).trim();
  return (start > 0 ? "..." : "") + body + (end < line.length ? "..." : "");
}
function excerpt(s) {
  const t = s.trim();
  return t.length > EXCERPT_CHARS ? t.slice(0, EXCERPT_CHARS - 3) + "..." : t;
}
function analyzeDocument(text, readings) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const add = (line, col, length, severity, code, message, raw) => {
    findings.push({ line: line + 1, col: col + 1, length, severity, code, message, excerpt: excerpt(raw) });
  };
  let inFence = false;
  let inFrontMatter = lines[0]?.trim() === "---";
  for (let i = 0;i < lines.length; i++) {
    const original = lines[i];
    if (inFrontMatter) {
      if (i > 0 && original.trim() === "---") {
        inFrontMatter = false;
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(original)) {
      inFence = !inFence;
      continue;
    }
    if (inFence || /^\s*([-*_])(\s*\1){2,}\s*$/.test(original) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(original)) {
      continue;
    }
    const masked = maskLine(original);
    const prose = /^\s*>/.test(masked) ? "" : maskQuotes(masked);
    const seen = new Set;
    for (const rule of RULES) {
      for (const m of prose.matchAll(rule.pattern)) {
        const key = `${rule.code}:${m.index}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        const raw = rule.code === "em-dash" ? dashContext(original, m.index, m[0].length) : m[0];
        add(i, m.index, m[0].length, rule.severity, rule.code, rule.message(m[0]), raw);
      }
    }
    for (const col of semicolonColumns(prose)) {
      const sentenceStart = Math.max(original.lastIndexOf(".", col) + 1, 0);
      add(i, col, 1, "warning", "semicolon", 'Semicolon in prose. Split the sentence or join with a comma and "and".', original.slice(sentenceStart, col + 30));
    }
    for (const c of parseCitations(masked)) {
      if (c.pageStart !== null && c.pageEnd !== null && c.pageEnd - c.pageStart + 1 > MAX_CITED_PAGES) {
        const pages = c.pageEnd - c.pageStart + 1;
        add(i, c.start, c.end - c.start, "warning", "wide-page-range", `This citation spans ${pages} pages. Cite the page that holds the point.`, c.text);
      }
    }
    if (readings && readings.size > 0) {
      for (const m of masked.matchAll(QUOTE2)) {
        const inner = m[1] ?? m[2];
        if (inner.trim().length > MIN_CHECKED_QUOTE && !readings.containsQuote(inner)) {
          add(i, m.index, m[0].length, "warning", "unverified-quote", "No indexed reading contains this wording. Check it against the source before keeping the quotation marks.", m[0]);
        }
      }
    }
  }
  return findings.sort((a, b) => a.line - b.line || a.col - b.col);
}
var WORKFLOW_FILES = /(?:^|[\\/])(?:raw-answers|interview-state|source-map)\.md$/i;
var DEBOUNCE_MS = 350;
var SOURCE_FILE = /(?:^|[\\/])(?:sources?|readings?)[\\/][^\\/]+$/i;
function shouldLint(doc) {
  return doc.languageId === "markdown" && !WORKFLOW_FILES.test(doc.fileName) && !SOURCE_FILE.test(doc.fileName);
}
function createSlopLinter(vscode, getReadings, isLive, onLinted) {
  const collection = vscode.languages.createDiagnosticCollection("writer-lint");
  const timers = new Map;
  const severities = {
    error: vscode.DiagnosticSeverity.Error,
    warning: vscode.DiagnosticSeverity.Warning,
    info: vscode.DiagnosticSeverity.Information
  };
  const lint = (doc) => {
    if (!shouldLint(doc)) {
      return [];
    }
    const findings = analyzeDocument(doc.getText(), getReadings());
    collection.set(doc.uri, findings.map((f) => {
      const range = new vscode.Range(f.line - 1, f.col - 1, f.line - 1, f.col - 1 + f.length);
      const d = new vscode.Diagnostic(range, f.message, severities[f.severity]);
      d.source = "Writer";
      d.code = f.code;
      return d;
    }));
    onLinted(doc, findings);
    return findings;
  };
  const schedule = (doc) => {
    if (!isLive() || !shouldLint(doc)) {
      return;
    }
    const key = doc.uri.toString();
    clearTimeout(timers.get(key));
    timers.set(key, setTimeout(() => {
      timers.delete(key);
      lint(doc);
    }, DEBOUNCE_MS));
  };
  const lintOpenDocuments = () => {
    if (!isLive()) {
      collection.clear();
      return;
    }
    vscode.workspace.textDocuments.forEach((doc) => shouldLint(doc) && lint(doc));
  };
  const subscriptions = [
    collection,
    vscode.workspace.onDidOpenTextDocument(schedule),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri))
  ];
  return {
    lint,
    lintOpenDocuments,
    dispose() {
      timers.forEach(clearTimeout);
      timers.clear();
      subscriptions.forEach((s) => s.dispose());
    }
  };
}

// src/extension.ts
var CURSOR_KEY = "writerStudio.questionCursor";
var DRAFT_DEBOUNCE_MS = 400;
function config() {
  return vscode.workspace.getConfiguration("writerStudio");
}
function toProtocol(f) {
  return { line: f.line, col: f.col, severity: f.severity, code: f.code, message: f.message, excerpt: f.excerpt };
}

class WriterStudio {
  context;
  view;
  index = null;
  indexGeneration = 0;
  bookmarks = [];
  coaxOffset = 0;
  lastMarkdownEditor;
  findings = new Map;
  questionCache = null;
  draftTimer;
  chatBusy = false;
  chatError = "";
  pendingText = "";
  linter;
  outlineTree = new ArgumentOutlineTreeProvider(vscode);
  lenses;
  outlineView;
  constructor(context) {
    this.context = context;
    this.linter = createSlopLinter(vscode, () => this.index, () => config().get("enableLiveLint", true), (doc, findings) => {
      this.findings.set(doc.uri.toString(), findings);
      if (doc === this.markdownEditor()?.document) {
        this.postState();
      }
    });
    this.lenses = createParagraphLensProvider(vscode, () => this.store()?.readAnswers() ?? [], () => this.index, () => config().get("enableParagraphLens", true), shouldLint, (doc) => straightenLine(doc.uri.toString()));
  }
  dispose() {
    clearTimeout(this.draftTimer);
  }
  getIndex() {
    return this.index;
  }
  store() {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? new WorkflowStore(folder.uri.fsPath) : null;
  }
  markdownEditor() {
    const active = vscode.window.activeTextEditor;
    if (active && shouldLint(active.document)) {
      return active;
    }
    const last = this.lastMarkdownEditor;
    return last && !last.document.isClosed ? last : undefined;
  }
  trackEditor(editor) {
    if (editor && shouldLint(editor.document)) {
      this.lastMarkdownEditor = editor;
    }
    this.refreshOutline();
    this.postState();
  }
  outlineFor(editor, answers) {
    return editor ? analyzeOutline(editor.document.getText(), answers) : [];
  }
  refreshOutline() {
    const editor = this.markdownEditor();
    this.outlineTree.update(this.outlineFor(editor, this.store()?.readAnswers() ?? []), editor?.document.uri);
    if (this.outlineView) {
      this.outlineView.message = editor ? undefined : "Open a Markdown draft to see its paragraphs.";
    }
  }
  draftChanged(doc) {
    if (doc !== this.markdownEditor()?.document) {
      return;
    }
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => {
      this.draftTimer = undefined;
      this.refreshOutline();
      this.postState();
    }, DRAFT_DEBOUNCE_MS);
  }
  async editorFor(uri) {
    if (uri instanceof vscode.Uri || uri && typeof uri.fsPath === "string") {
      const target = uri.toString();
      const visible = vscode.window.visibleTextEditors?.find((e) => e.document.uri.toString() === target);
      if (visible) {
        return visible;
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      return vscode.window.showTextDocument(doc);
    }
    return this.markdownEditor();
  }
  async jumpToLine(line, uri) {
    const editor = await this.editorFor(uri);
    if (!editor || !Number.isFinite(line)) {
      return;
    }
    const target = Math.min(Math.max(0, line - 1), editor.document.lineCount - 1);
    const range = new vscode.Range(target, 0, target, editor.document.lineAt(target).text.length);
    const shown = await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, selection: range });
    shown.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
  async insertSkeleton(skeletonId, uri, line) {
    const editor = await this.editorFor(uri);
    if (!editor) {
      vscode.window.showInformationMessage("VSwriter: open a Markdown draft to insert a paragraph skeleton.");
      return;
    }
    let id = typeof skeletonId === "string" ? skeletonId : undefined;
    if (!id) {
      const pick = await vscode.window.showQuickPick(SKELETON_OPTIONS.map((o) => ({ label: o.label, detail: o.description, id: o.id })), { placeHolder: "Insert a paragraph skeleton" });
      id = pick?.id;
    }
    const text = id ? getSkeletonText(id) : null;
    if (!text) {
      return;
    }
    const doc = editor.document;
    const lines = doc.getText().split(/\r?\n/);
    const cursor = typeof line === "number" && Number.isFinite(line) ? line - 1 : editor.selection.active.line;
    const plan = planSkeletonInsert(lines, cursor, text);
    const target = await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, preserveFocus: false });
    const done = await target.edit((b) => b.insert(new vscode.Position(plan.line, plan.character), plan.text));
    if (!done) {
      return;
    }
    const slotLine = Math.min(plan.firstSlotLine, doc.lineCount - 1);
    const slot = new RegExp(SLOT.source).exec(doc.lineAt(slotLine).text);
    const selection = slot ? new vscode.Selection(slotLine, slot.index, slotLine, slot.index + slot[0].length) : new vscode.Selection(slotLine, 0, slotLine, 0);
    const shown = await vscode.window.showTextDocument(doc, { viewColumn: editor.viewColumn, selection });
    shown.revealRange(selection, vscode.TextEditorRevealType.InCenter);
  }
  async openParagraphReading(uri, line) {
    const editor = await this.editorFor(uri);
    if (!editor) {
      return;
    }
    const at = typeof line === "number" && Number.isFinite(line) ? line : editor.selection.active.line + 1;
    const paragraph = paragraphAtLine(splitParagraphs(editor.document.getText()), at);
    const match = paragraph ? matchReadingForParagraph(this.index, paragraph.text) : null;
    if (!match) {
      vscode.window.showInformationMessage("VSwriter: no indexed reading matches this paragraph yet. Check writerStudio.readingsDirs.");
      return;
    }
    await this.openReading(match.filePath, match.line);
  }
  async rebuildIndex() {
    const generation = ++this.indexGeneration;
    const readingDirs = config().get("readingsDirs", []);
    const workspaceDirs = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const building = ReadingsIndex.build(readingDirs, workspaceDirs);
    vscode.window.setStatusBarMessage("VSwriter: indexing readings", building);
    const index = await building;
    if (generation !== this.indexGeneration) {
      return;
    }
    this.index = index;
    this.questionCache = null;
    this.rematch();
    this.linter.lintOpenDocuments();
    this.lenses.refresh();
    this.postState();
  }
  rematch() {
    const answers = this.store()?.readAnswers() ?? [];
    this.bookmarks = this.index ? this.index.matchBookmarks(answers, 6) : [];
  }
  async openReading(filePath, line) {
    if (!this.index?.docs.some((d) => d.filePath === filePath)) {
      vscode.window.showWarningMessage("VSwriter: that reading is no longer in the index. Refresh bookmarks and try again.");
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    const target = Math.min(Math.max(0, line - 1), doc.lineCount - 1);
    const range = new vscode.Range(target, 0, target, doc.lineAt(target).text.length);
    const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, selection: range });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
  cursor() {
    return this.context.workspaceState.get(CURSOR_KEY, 0);
  }
  initWorkspace() {
    const store = this.store();
    if (!store) {
      vscode.window.showWarningMessage("VSwriter: open the assignment folder first. raw-answers.md, interview-state.md and source-map.md are kept there.");
      return;
    }
    const created = store.init();
    if (created.length) {
      vscode.window.showInformationMessage(`VSwriter: created ${created.join(", ")}.`);
    }
    this.postState();
  }
  submitAnswer(prompt, text) {
    const store = this.store();
    if (!store) {
      this.initWorkspace();
      return;
    }
    if (!text.trim()) {
      return;
    }
    store.init();
    store.appendAnswer(prompt || pickQuestion(store.readAnswers(), this.cursor()), text);
    this.coaxOffset = 0;
    this.rematch();
    this.answersChanged();
    this.postState();
  }
  async nextQuestion() {
    const current = pickQuestion(this.store()?.readAnswers() ?? [], this.cursor());
    await this.context.workspaceState.update(CURSOR_KEY, (QUESTIONS.indexOf(current) + 1) % QUESTIONS.length);
    this.postState();
  }
  runLint() {
    const editor = this.markdownEditor();
    if (!editor) {
      vscode.window.showInformationMessage("VSwriter: open a Markdown draft to lint it.");
      return;
    }
    this.linter.lint(editor.document);
    this.postState();
  }
  answersChanged() {
    this.refreshOutline();
    this.lenses.refresh();
  }
  resolveWebviewView(view) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((msg) => this.handle(msg));
    view.onDidChangeVisibility(() => view.visible && this.postState());
    view.onDidDispose(() => {
      this.view = undefined;
    });
  }
  html(webview, media) {
    const file = vscode.Uri.joinPath(media, "panel.html").fsPath;
    if (!fs8.existsSync(file)) {
      return "<!DOCTYPE html><html><body><p>media/panel.html is missing from the extension.</p></body></html>";
    }
    const values = {
      "{{CSP_SOURCE}}": webview.cspSource,
      "{{NONCE}}": crypto5.randomBytes(16).toString("hex"),
      "{{CSS_URI}}": webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css")).toString(),
      "{{JS_URI}}": webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js")).toString(),
      "{{CHAT_JS_URI}}": webview.asWebviewUri(vscode.Uri.joinPath(media, "chat.js")).toString()
    };
    let html = fs8.readFileSync(file, "utf8");
    for (const [placeholder, value] of Object.entries(values)) {
      html = html.split(placeholder).join(value);
    }
    return html;
  }
  async handle(msg) {
    switch (msg.type) {
      case "ready":
        this.postState();
        this.postChat();
        break;
      case "chatSend":
        await this.sendChat(String(msg.text ?? ""));
        break;
      case "launch":
        await this.launch(msg.what);
        break;
      case "mindMap":
        await this.mindMap();
        break;
      case "initWorkspace":
        this.initWorkspace();
        break;
      case "submitAnswer":
        this.submitAnswer(String(msg.prompt ?? ""), String(msg.text ?? ""));
        break;
      case "nextQuestion":
        await this.nextQuestion();
        break;
      case "refreshBookmarks":
        await this.rebuildIndex();
        break;
      case "openReading":
        await this.openReading(String(msg.filePath), Number(msg.line));
        break;
      case "generateCoax":
        this.coaxOffset++;
        this.postState();
        break;
      case "jumpDiagnostic":
      case "jumpLine":
        await this.jumpToLine(Number(msg.line));
        break;
      case "insertSkeleton":
        if (SKELETON_OPTIONS.some((o) => o.id === msg.skeletonId)) {
          await this.insertSkeleton(msg.skeletonId);
        }
        break;
    }
  }
  postChat() {
    const store = this.store();
    const state = store ? readState(store) : { phase: "define", brief: "", question: OPENING };
    const turns = store ? transcript(store, state) : [{ role: "assistant", text: "Open the folder for this piece (File > Open Folder) and we can start." }];
    if (this.chatBusy && this.pendingText) {
      turns.splice(turns.length - 1, 0, { role: "writer", text: this.pendingText });
    }
    const msg = { type: "chat", turns, busy: this.chatBusy, phase: state.phase, brief: state.brief, error: this.chatError };
    this.view?.webview.postMessage(msg);
  }
  draft() {
    const editor = this.markdownEditor();
    return editor ? { name: path8.basename(editor.document.fileName), text: editor.document.getText(), line: editor.selection.active.line } : null;
  }
  async readingNames() {
    const files = await vscode.workspace.findFiles("**/*.{pdf,PDF,md}", "**/{node_modules,.git}/**", 200);
    return files.map((u) => vscode.workspace.asRelativePath(u)).filter((r) => /\.pdf$/i.test(r) || /(^|\/)(readings?|sources?)\//i.test(r)).slice(0, 60);
  }
  async sendChat(text) {
    const store = this.store();
    if (!store || !text.trim() || this.chatBusy) {
      return;
    }
    this.chatBusy = true;
    this.chatError = "";
    this.pendingText = text;
    this.postChat();
    try {
      const model = config().get("companion.model", "claude-sonnet-5-5");
      await respond(store, text, this.draft(), await this.readingNames(), (prompt) => askClaude(model, prompt, (o) => /"reply"\s*:/.test(o)));
    } catch (err) {
      this.chatError = `The assistant did not answer (${err.message.slice(0, 160)}). Your message is saved; send another to try again.`;
    } finally {
      this.chatBusy = false;
      this.pendingText = "";
      this.answersChanged();
      this.postState();
      this.postChat();
    }
  }
  async mindMap() {
    const store = this.store();
    if (!store || this.chatBusy) {
      return;
    }
    const state = readState(store);
    const history = transcript(store, state).slice(0, -1);
    if (!history.some((t) => t.role === "writer")) {
      this.chatError = "Answer a few questions first; the mind map is built from the interview.";
      this.postChat();
      return;
    }
    this.chatBusy = true;
    this.chatError = "";
    this.postChat();
    try {
      const model = config().get("companion.model", "claude-sonnet-5-5");
      const map = parseMindMap(await askClaude(model, buildMindMapPrompt(state, history, this.draft()), (o) => /mindmap/.test(o)));
      if (!map)
        throw new Error("no mind map came back");
      const file = path8.join(store.root, "mind-map.md");
      fs8.writeFileSync(file, `# Mind map

Built from the interview on ${new Date().toLocaleString()}. Ask for a new one any time.

\`\`\`mermaid
${map}
\`\`\`
`, "utf8");
      await vscode.commands.executeCommand("markdown.showPreviewToSide", vscode.Uri.file(file));
    } catch (err) {
      this.chatError = `The mind map could not be made (${err.message.slice(0, 160)}).`;
    } finally {
      this.chatBusy = false;
      this.postChat();
    }
  }
  async launch(what) {
    switch (what) {
      case "pdf": {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { PDF: ["pdf"] }, openLabel: "Open beside draft" });
        const folder = vscode.workspace.workspaceFolders?.[0];
        for (const uri of picked ?? []) {
          let target = uri;
          if (folder && !uri.fsPath.startsWith(folder.uri.fsPath + path8.sep)) {
            const dir = path8.join(folder.uri.fsPath, "readings");
            fs8.mkdirSync(dir, { recursive: true });
            const dest = path8.join(dir, path8.basename(uri.fsPath));
            if (!fs8.existsSync(dest))
              fs8.copyFileSync(uri.fsPath, dest);
            target = vscode.Uri.file(dest);
          }
          await vscode.commands.executeCommand("vscode.openWith", target, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true });
        }
        break;
      }
      case "browser":
        await vscode.commands.executeCommand("writerStudio.openBrowserBeside", "https://www.google.com/");
        break;
      case "capture":
        await vscode.commands.executeCommand("writerStudio.captureWebPage");
        break;
      case "lint":
        this.runLint();
        break;
      case "terminal":
      case "claude": {
        const terminal = vscode.window.createTerminal({ name: what === "claude" ? "Claude" : "Terminal" });
        terminal.show();
        await vscode.commands.executeCommand("workbench.action.positionPanelRight");
        if (what === "claude")
          terminal.sendText("claude");
        break;
      }
    }
  }
  state() {
    const store = this.store();
    const answers = store?.readAnswers() ?? [];
    const editor = this.markdownEditor();
    let findings = [];
    if (editor) {
      const key = editor.document.uri.toString();
      if (!this.findings.has(key) && config().get("enableLiveLint", true)) {
        this.findings.set(key, analyzeDocument(editor.document.getText(), this.index));
      }
      findings = this.findings.get(key) ?? [];
    }
    const currentQuestion = pickQuestion(answers, this.cursor());
    return {
      type: "state",
      workspaceReady: store?.isReady() ?? false,
      activeFile: editor?.document.uri.fsPath ?? null,
      rawAnswers: answers,
      currentQuestion,
      bookmarks: this.bookmarks,
      coaxing: buildCoaxingStarters(answers, this.bookmarks, this.coaxOffset),
      diagnostics: findings.map(toProtocol),
      questionContext: this.questionContext(currentQuestion, answers),
      outline: this.outlineFor(editor, answers),
      skeletons: SKELETON_OPTIONS
    };
  }
  questionContext(question, answers) {
    const key = `${this.indexGeneration}|${this.index ? 1 : 0}|${question}|${answers.map((a) => a.id).join(",")}`;
    if (this.questionCache?.key !== key) {
      this.questionCache = { key, value: buildQuestionContext(question, answers, this.index) };
    }
    return this.questionCache.value;
  }
  postState() {
    if (this.view) {
      this.view.webview.postMessage(this.state());
    }
  }
  onWorkflowFilesChanged() {
    this.rematch();
    this.answersChanged();
    this.postState();
  }
  forget(doc) {
    this.findings.delete(doc.uri.toString());
  }
  liveLintChanged() {
    this.findings.clear();
    this.linter.lintOpenDocuments();
    this.postState();
  }
}
function activate(context) {
  const studio = new WriterStudio(context);
  const watcher = vscode.workspace.createFileSystemWatcher("**/{raw-answers,interview-state,source-map}.md");
  const outlineView = vscode.window.createTreeView("writerStudio.outline", { treeDataProvider: studio.outlineTree });
  studio.outlineView = outlineView;
  const pdf = registerPdfReader(vscode, {
    extensionUri: context.extensionUri,
    globalStorageDir: context.globalStorageUri?.fsPath ?? path8.join(os3.homedir(), ".vswriter"),
    draftEditor: () => studio.markdownEditor()
  });
  const companionLog = vscode.window.createOutputChannel("VSwriter Companion");
  const companion = new Companion(vscode, {
    pdf: pdf.provider,
    isDraft: (doc) => doc.uri.scheme === "file" && shouldLint(doc),
    log: (line) => companionLog.appendLine(`${new Date().toISOString()} ${line}`)
  });
  const research = registerResearchBrowser(vscode, {
    onSourceCaptured: () => studio.rebuildIndex(),
    openPdf: (uri) => vscode.commands.executeCommand("vscode.openWith", uri, PDF_VIEW_TYPE, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false })
  });
  context.subscriptions.push(...pdf.disposables, ...research.disposables, companion, companionLog, ...registerStraighten(vscode, () => config().get("companion.model", "claude-sonnet-5-5"), (line) => companionLog.appendLine(`${new Date().toISOString()} ${line}`), () => studio.lenses.refresh()), ...registerNudges(vscode, {
    isDraft: (doc) => doc.uri.scheme === "file" && shouldLint(doc),
    context: () => {
      const store = studio.store();
      if (!store)
        return null;
      const state = readState(store);
      return { root: store.root, state, history: transcript(store, state).slice(0, -1), answers: store.readAnswers().map((a) => a.text) };
    },
    ask: (prompt) => askClaude(config().get("companion.model", "claude-sonnet-5-5"), prompt, (o) => /"bubbles"\s*:/.test(o)),
    saveReply: (bubble, reply) => {
      const store = studio.store();
      if (!store)
        return;
      store.init();
      store.appendAnswer(bubble, reply);
      studio.postChat();
    },
    stuckSeconds: () => config().get("nudge.stuckSeconds", 45),
    log: (line) => companionLog.appendLine(`${new Date().toISOString()} ${line}`)
  }), studio, studio.linter, studio.lenses, watcher, outlineView, vscode.window.registerWebviewViewProvider("writerStudio.panel", studio), registerCitationNav(vscode, () => studio.getIndex()), registerQuickFixes(vscode, () => studio.getIndex()), vscode.languages.registerCodeLensProvider({ language: "markdown" }, studio.lenses), vscode.commands.registerCommand("writerStudio.openPanel", async () => {
    await vscode.commands.executeCommand("workbench.view.extension.writer-studio");
    await vscode.commands.executeCommand("writerStudio.panel.focus");
  }), vscode.commands.registerCommand("writerStudio.refreshBookmarks", () => studio.rebuildIndex()), vscode.commands.registerCommand("writerStudio.runLint", () => studio.runLint()), vscode.commands.registerCommand("writerStudio.initWorkspace", () => studio.initWorkspace()), vscode.commands.registerCommand("writerStudio.openReadingBeside", async (filePath, line) => {
    if (typeof filePath === "string") {
      return studio.openReading(filePath, Number(line) || 1);
    }
    const index = studio.getIndex();
    const answers = studio.store()?.readAnswers() ?? [];
    const picks = (index?.matchBookmarks(answers, 6) ?? []).map((b) => ({
      label: `${b.author} (${b.year}${b.page ? ": " + b.page : ""})`,
      detail: b.excerpt,
      description: b.reason,
      bookmark: b
    }));
    if (!picks.length) {
      vscode.window.showInformationMessage("VSwriter: no bookmarks yet. Save an answer and check writerStudio.readingsDirs.");
      return;
    }
    const pick = await vscode.window.showQuickPick(picks, { placeHolder: "Open a reading beside the draft", matchOnDetail: true });
    if (pick) {
      await studio.openReading(pick.bookmark.filePath, pick.bookmark.line);
    }
  }), vscode.commands.registerCommand("writerStudio.insertSkeleton", (skeletonId, uri, line) => studio.insertSkeleton(skeletonId, uri, line)), vscode.commands.registerCommand("writerStudio.jumpToLine", (line, uri) => studio.jumpToLine(Number(line), uri)), vscode.commands.registerCommand("writerStudio.openParagraphReading", (uri, line) => studio.openParagraphReading(uri, line)), vscode.window.onDidChangeActiveTextEditor((editor) => studio.trackEditor(editor)), vscode.workspace.onDidCloseTextDocument((doc) => studio.forget(doc)), vscode.workspace.onDidChangeTextDocument((e) => {
    if (!config().get("enableLiveLint", true)) {
      studio.forget(e.document);
    }
    studio.draftChanged(e.document);
  }), watcher.onDidChange(() => studio.onWorkflowFilesChanged()), watcher.onDidCreate(() => studio.onWorkflowFilesChanged()), watcher.onDidDelete(() => studio.onWorkflowFilesChanged()), vscode.workspace.onDidChangeWorkspaceFolders(() => studio.rebuildIndex()), vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("writerStudio.readingsDirs")) {
      studio.rebuildIndex();
    }
    if (e.affectsConfiguration("writerStudio.enableLiveLint")) {
      studio.liveLintChanged();
    }
    if (e.affectsConfiguration("writerStudio.enableParagraphLens")) {
      studio.lenses.refresh();
    }
  }));
  studio.trackEditor(vscode.window.activeTextEditor);
  studio.rebuildIndex();
}
function deactivate() {}
