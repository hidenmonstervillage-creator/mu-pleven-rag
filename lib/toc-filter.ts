// ── Contents / index page detector ───────────────────────────────────────────
//
// ~4.6% of chunks (~12,900 of 277k) are tables of contents, alphabetical indexes
// and similar front/back matter that were chunked and embedded like body text.
// They are semantic magnets for "какви са видовете X" questions: a contents page
// literally IS a list of the type names, so it scores high on similarity AND the
// gpt-4o-mini reranker rates it as maximally relevant — while containing no
// explanation whatsoever. Observed failure: „какви са видовете химични връзки"
// retrieved 3 genuine prose chunks at ranks 3/5/6, and the reranker discarded all
// three in favour of two contents pages, which became the citations.
//
// This runs UPSTREAM of the reranker so the top-5 backfills with prose.
//
// PRECISION OVER RECALL. Missing a contents page costs one mediocre citation;
// dropping real prose costs an answer. So a chunk is only rejected when a
// TOC-SPECIFIC structural marker is present (dotted leaders, index dashes, or
// page-number/title rows) AND corroborating weak signals push it over threshold.
// A dense table of physical constants is high-digit and low-prose but has none of
// the structural markers, so it survives.
//
// NOTE: tsconfig has no `target`, so no \p{...} classes and no /u flag — Cyrillic
// ranges are spelled out literally.

const CYR = 'А-яЁё';
const LETTER = new RegExp('[' + CYR + 'A-Za-z]', 'g');
const WORD = new RegExp('[' + CYR + 'A-Za-z]{2,}', 'g');
// "Заглавие - 123" / "Waals J.D.v.der - 20"  (alphabetical index entry).
// Requires >=3 leading letters and no alphanumeric immediately before, so
// scientific notation ("6.28E—06", "1.5E-3") cannot masquerade as an entry.
const INDEX_ENTRY = new RegExp(
  '(?:^|[^0-9' + CYR + 'A-Za-z])[' + CYR + 'A-Za-z]{3,}[' + CYR + 'A-Za-z.]*\\s*[-–—]\\s*\\d{1,3}(?![0-9])', 'g');
// "123 Заглавие"  (contents row: page number then capitalised entry)
const NUM_TITLE = new RegExp('(?:^|\\s)\\d{1,3}\\s+[' + 'А-ЯЁ' + 'A-Z]', 'g');
// sentence ender followed by a capital — real prose punctuation
const SENTENCE = new RegExp('[.!?](?=\\s+[' + 'А-ЯЁ' + 'A-Z])', 'g');
// Any dotted run. NOT sufficient on its own: Latin exercise sheets use dotted
// fill-in-the-blank lines ("bifurcatio tracheae...........") that look identical.
const DOTTED_ANY = /\.{5,}|(?:\.\s){5,}|…{2,}/g;
// A dotted run terminating in a page number — this is what a real contents leader
// looks like ("Йонна връзка..........16") and what an exercise blank never does.
const DOTTED_PAGE = /(?:\.{4,}|(?:\.\s){4,}|…+)\s*\d{1,4}/g;
// Numeric data tables (stability constants, dose coefficients) are digit-dense in
// a way no contents page is; the real ones here measure 0.065–0.138.
const DIGIT_RATIO_TABLE_GUARD = 0.25;

export interface TocVerdict {
  isToc: boolean;
  score: number;
  reasons: string[];
}

function countMatches(text: string, re: RegExp): number {
  re.lastIndex = 0;
  const m = text.match(re);
  return m ? m.length : 0;
}

/**
 * Structural analysis of a chunk. `isToc` is true only for contents/index pages.
 * Pure string work — no I/O, no allocation beyond the match arrays.
 */
export function analyzeToc(raw: string | null | undefined): TocVerdict {
  const text = (raw || '').trim();
  const reasons: string[] = [];
  // Too short to judge structurally — never reject.
  if (text.length < 60) return { isToc: false, score: 0, reasons: [] };

  // Dotted leaders are measured on the raw text, then stripped: they would
  // otherwise inflate both the digit ratio's denominator and the sentence count.
  const dottedRuns = countMatches(text, DOTTED_ANY);
  const dottedToPage = countMatches(text, DOTTED_PAGE);
  const stripped = text.replace(/\.{3,}|…+/g, ' ');

  const letters = countMatches(stripped, LETTER);
  const digits = countMatches(stripped, /[0-9]/g);
  const words = Math.max(1, countMatches(stripped, WORD));
  const per100 = (n: number) => (n / words) * 100;

  const digitRatio = digits / Math.max(1, letters + digits);

  // Index entries must actually reference PAGES. Figure legends and chemical
  // nomenclature produce the same "term—number" shape ("abductor pollicis—1",
  // "2-methylbut-2-ene") but their numbers are small sequential labels. A real
  // index points at page numbers, so require the references to reach past p.20.
  INDEX_ENTRY.lastIndex = 0;
  const indexMatches = stripped.match(INDEX_ENTRY) || [];
  let maxRef = 0;
  for (let i = 0; i < indexMatches.length; i++) {
    const num = indexMatches[i].match(/(\d{1,3})(?!.*\d)/);
    if (num) maxRef = Math.max(maxRef, parseInt(num[1], 10));
  }
  const indexDensity = maxRef >= 20 ? per100(indexMatches.length) : 0;
  const numTitleDensity = per100(countMatches(stripped, NUM_TITLE));
  const proseDensity = per100(countMatches(stripped, SENTENCE)); // sentences/100 words

  // Line-shape signals (only meaningful when the extractor preserved newlines;
  // most of this corpus is flat, so these act as corroboration when present).
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let lineEndPageNo = 0;
  let shortLines = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/\d{1,4}$/.test(lines[i])) lineEndPageNo++;
    if (lines[i].length < 45) shortLines++;
  }
  const lineEndRatio = lines.length >= 6 ? lineEndPageNo / lines.length : 0;
  const shortLineRatio = lines.length >= 6 ? shortLines / lines.length : 0;

  // Numeric data tables (appendices of constants, dose coefficients) are digit-dense
  // in a way no contents page is. Bail out before anything can flag them.
  if (digitRatio > DIGIT_RATIO_TABLE_GUARD) {
    return { isToc: false, score: 0, reasons: ['numeric-table digit-ratio ' + digitRatio.toFixed(3)] };
  }

  // ── STRONG markers: structure that only contents/index pages have ──────────
  let strong = false;
  let score = 0;

  // Leaders must terminate in a page number. Bare dotted runs are NOT strong:
  // Latin exercise sheets use dotted fill-in blanks that look identical.
  if (dottedToPage >= 3) { strong = true; score += 4; reasons.push('dotted-leaders→page x' + dottedToPage); }
  else if (dottedToPage >= 1) { strong = true; score += 3; reasons.push('dotted-leaders→page x' + dottedToPage); }
  else if (dottedRuns >= 3) { score += 1; reasons.push('dotted-runs x' + dottedRuns + ' (no page numbers — weak)'); }

  if (indexDensity >= 10) { strong = true; score += 4; reasons.push('index-entries ' + indexDensity.toFixed(1) + '/100w'); }
  else if (indexDensity >= 6) { strong = true; score += 3; reasons.push('index-entries ' + indexDensity.toFixed(1) + '/100w'); }

  if (lineEndRatio >= 0.6) { strong = true; score += 3; reasons.push('lines-ending-in-page-no ' + (lineEndRatio * 100).toFixed(0) + '%'); }

  // Weak only: figure legends ("12 13 14 Crista") and running heads trip this.
  if (numTitleDensity >= 15) { score += 2; reasons.push('page-number rows ' + numTitleDensity.toFixed(1) + '/100w'); }
  else if (numTitleDensity >= 8) { score += 1; reasons.push('page-number rows ' + numTitleDensity.toFixed(1) + '/100w'); }

  // ── WEAK corroboration: true of contents pages but also of tables/formulae ─
  if (digitRatio >= 0.08) { score += 2; reasons.push('digit-ratio ' + digitRatio.toFixed(3)); }
  else if (digitRatio >= 0.05) { score += 1; reasons.push('digit-ratio ' + digitRatio.toFixed(3)); }

  if (proseDensity < 1.0) { score += 2; reasons.push('prose-density ' + proseDensity.toFixed(2) + '/100w'); }
  else if (proseDensity < 2.0) { score += 1; reasons.push('prose-density ' + proseDensity.toFixed(2) + '/100w'); }

  if (shortLineRatio >= 0.75) { score += 2; reasons.push('short-lines ' + (shortLineRatio * 100).toFixed(0) + '%'); }

  // A structural marker is mandatory — weak signals alone can never reject.
  const isToc = strong && score >= 6;
  return { isToc, score, reasons };
}

export interface TocFilterResult<T> {
  kept: T[];
  removed: Array<{ item: T; verdict: TocVerdict }>;
  floorEngaged: boolean;
}

/**
 * Drop contents/index chunks, but never take the candidate set below `floor`.
 * If filtering would, the highest-similarity rejects are restored — a TOC
 * citation is bad, no answer at all is worse.
 */
export function filterTocChunks<T>(
  items: T[],
  getText: (item: T) => string | null | undefined,
  getSimilarity: (item: T) => number,
  floor = 3,
): TocFilterResult<T> {
  const kept: T[] = [];
  const removed: Array<{ item: T; verdict: TocVerdict }> = [];

  for (let i = 0; i < items.length; i++) {
    const verdict = analyzeToc(getText(items[i]));
    if (verdict.isToc) removed.push({ item: items[i], verdict });
    else kept.push(items[i]);
  }

  // Can't conjure candidates that were never retrieved.
  const effectiveFloor = Math.min(floor, items.length);
  if (kept.length >= effectiveFloor || removed.length === 0) {
    return { kept, removed, floorEngaged: false };
  }

  const restore = removed
    .slice()
    .sort((a, b) => getSimilarity(b.item) - getSimilarity(a.item))
    .slice(0, effectiveFloor - kept.length);
  const restoredSet: T[] = [];
  for (let i = 0; i < restore.length; i++) restoredSet.push(restore[i].item);

  return {
    kept: kept.concat(restoredSet).sort((a, b) => getSimilarity(b) - getSimilarity(a)),
    removed: removed.filter((r) => restoredSet.indexOf(r.item) === -1),
    floorEngaged: true,
  };
}
