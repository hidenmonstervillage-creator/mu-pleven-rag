/**
 * scripts/test-extraction.mjs
 *
 * Diagnose PDF text extraction quality WITHOUT touching the database.
 *
 * Usage:
 *   node scripts/test-extraction.mjs <local-file-path-or-url>
 *
 * The script:
 *   1. Loads the PDF from a local path or HTTP(S) URL
 *   2. Runs the NEW position-aware extraction (same logic as lib/chunker.ts)
 *   3. Prints the first 3 000 characters of extracted text
 *   4. Prints diagnostic stats:
 *      - Total characters extracted
 *      - Space count (≈ word count − 1; 0 means words are still merged)
 *      - Space density (spaces / total chars) — healthy prose ≈ 0.12–0.18
 *      - Non-ASCII character sample (to check Cyrillic vs Latin impostor issue)
 *      - Unicode block breakdown of non-ASCII characters
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── helpers ──────────────────────────────────────────────────────────────────

function sanitizeText(t) {
  // eslint-disable-next-line no-control-regex
  return t.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
}

/**
 * Reconstruct page text from positioned text items.
 *
 * Inserts a space:
 *   - When the next item's x-position is more than 15 % of the font size
 *     beyond the previous item's right edge (word gap on the same line).
 *   - When the y-position changes by more than half a line height (new line).
 */
function reconstructPageText(items) {
  if (!items || items.length === 0) return '';

  let result        = '';
  let prevY         = null;
  let prevRightEdge = null;
  let prevFontSize  = null;

  for (const item of items) {
    const { str, x, y, width, fontSize, hasEOL } = item;
    if (!str) continue;

    if (prevY === null) {
      result += str;
    } else {
      const yDelta  = Math.abs(y - prevY);
      const refSize = prevFontSize ?? fontSize ?? 12;
      const lineH   = Math.max(refSize, fontSize ?? 0, 1);

      if (yDelta > lineH * 0.5) {
        // Line break → space
        result += ' ';
      } else {
        const gap       = x - (prevRightEdge ?? x);
        const threshold = (fontSize ?? refSize) * 0.15;
        if (gap > threshold) result += ' ';
      }

      result += str;
    }

    if (hasEOL) result += ' ';

    prevY         = y;
    prevRightEdge = x + width;
    prevFontSize  = fontSize || prevFontSize;
  }

  return result
    .replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractPdfPages(buffer) {
  const { extractTextItems } = await import('unpdf');
  const uint8Array = new Uint8Array(buffer);
  const { totalPages, items } = await extractTextItems(uint8Array);

  const pages = [];
  for (let i = 0; i < totalPages; i++) {
    const raw     = reconstructPageText(items[i] ?? []);
    const cleaned = sanitizeText(raw);
    if (cleaned.trim().length > 20) {
      pages.push({ page: i + 1, text: cleaned });
    }
  }
  return pages;
}

// ── Unicode block detection ───────────────────────────────────────────────────

function unicodeBlock(cp) {
  if (cp >= 0x0000 && cp <= 0x007F) return 'Basic Latin';
  if (cp >= 0x0080 && cp <= 0x00FF) return 'Latin-1 Supplement';
  if (cp >= 0x0100 && cp <= 0x017F) return 'Latin Extended-A';
  if (cp >= 0x0180 && cp <= 0x024F) return 'Latin Extended-B';
  if (cp >= 0x0400 && cp <= 0x04FF) return 'Cyrillic';
  if (cp >= 0x0500 && cp <= 0x052F) return 'Cyrillic Supplement';
  if (cp >= 0x1C80 && cp <= 0x1C8F) return 'Cyrillic Extended-C';
  if (cp >= 0x0370 && cp <= 0x03FF) return 'Greek/Coptic';
  if (cp >= 0x2000 && cp <= 0x206F) return 'General Punctuation';
  if (cp >= 0x2100 && cp <= 0x214F) return 'Letterlike Symbols';
  if (cp >= 0x2200 && cp <= 0x22FF) return 'Mathematical Operators';
  if (cp >= 0x0020 && cp <= 0x002F) return 'ASCII Punctuation';
  return `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
}

function analyzeNonAscii(text) {
  const blockCounts = new Map();
  const samples     = new Map();  // block → first 8 unique chars

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp <= 0x7F) continue;  // skip plain ASCII

    const block = unicodeBlock(cp);
    blockCounts.set(block, (blockCounts.get(block) ?? 0) + 1);
    if (!samples.has(block)) samples.set(block, new Set());
    const s = samples.get(block);
    if (s.size < 12) s.add(ch);
  }

  return { blockCounts, samples };
}

// ── main ──────────────────────────────────────────────────────────────────────

const source = process.argv[2];
if (!source) {
  console.error('Usage: node scripts/test-extraction.mjs <file-path-or-url>');
  process.exit(1);
}

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  MU-Плевен PDF Extraction Diagnostic');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Source: ${source}\n`);

// 1. Load bytes
let buffer;
if (/^https?:\/\//i.test(source)) {
  console.log('Downloading…');
  const res = await fetch(source);
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  buffer = Buffer.from(await res.arrayBuffer());
  console.log(`Downloaded: ${(buffer.length / 1024).toFixed(1)} KB\n`);
} else {
  const absPath = resolve(source);
  buffer = readFileSync(absPath);
  console.log(`Loaded: ${(buffer.length / 1024).toFixed(1)} KB\n`);
}

// 2. Extract
console.log('Extracting text (position-aware)…');
const t0    = Date.now();
const pages = await extractPdfPages(buffer);
const ms    = Date.now() - t0;
console.log(`Done in ${ms} ms — ${pages.length} content pages extracted.\n`);

if (pages.length === 0) {
  console.log('⚠  No text extracted — PDF may be image-only (needs OCR).');
  process.exit(0);
}

// 3. Concatenate all pages for analysis
const fullText  = pages.map((p) => p.text).join(' ');
const totalCh   = fullText.length;
const spaceCount = (fullText.match(/ /g) ?? []).length;
const density   = totalCh > 0 ? (spaceCount / totalCh).toFixed(4) : '—';

// 4. Print first 3 000 chars
console.log('─────────────────────────────────────────────────────────────');
console.log('  EXTRACTED TEXT  (first 3 000 characters)');
console.log('─────────────────────────────────────────────────────────────');
console.log(fullText.slice(0, 3000));
console.log('\n─────────────────────────────────────────────────────────────');

// 5. Stats
console.log('  STATS');
console.log('─────────────────────────────────────────────────────────────');
console.log(`Total pages with content : ${pages.length}`);
console.log(`Total characters         : ${totalCh.toLocaleString('en-US')}`);
console.log(`Space characters         : ${spaceCount.toLocaleString('en-US')}`);
console.log(`Space density            : ${density}  (healthy prose ≈ 0.12–0.18)`);
console.log('');

// 6. Non-ASCII analysis
const { blockCounts, samples } = analyzeNonAscii(fullText);
if (blockCounts.size === 0) {
  console.log('Non-ASCII characters     : NONE');
  console.log('⚠  Cyrillic diagnosis: ALL text is plain ASCII.');
  console.log('   This means either (a) the document is English-only,');
  console.log('   or (b) Cyrillic glyphs are being decoded as Latin ASCII — OCR may be needed.');
} else {
  console.log('Non-ASCII character blocks:');
  const sorted = [...blockCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [block, count] of sorted) {
    const sample = [...(samples.get(block) ?? [])].join('');
    const pct    = ((count / totalCh) * 100).toFixed(2);
    console.log(`  ${block.padEnd(30)} ${String(count).padStart(7)} chars (${pct}%)  sample: "${sample}"`);
  }

  const cyrillicCount = blockCounts.get('Cyrillic') ?? 0;
  console.log('');
  if (cyrillicCount > 0) {
    console.log(`✓ Real Cyrillic detected: ${cyrillicCount.toLocaleString('en-US')} characters.`);
    console.log('  Encoding is correct — spacing fix is the primary improvement needed.');
  } else {
    console.log('⚠  No Cyrillic Unicode characters found in extracted text.');
    console.log('   Bulgarian content is likely encoded as Latin look-alikes (font encoding issue).');
    console.log('   This requires OCR (e.g. Tesseract with bul language) to fix properly.');
  }
}

console.log('\n──────────────────────────────────────────────────────────────\n');
