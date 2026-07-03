/**
 * scripts/diagnose-cytology.mjs
 *
 * Diagnose why medicina/medicina/"Цитология" documents returned only 9 chunks.
 * READ-ONLY — does NOT touch the database or re-ingest.
 *
 *   1. List every documents row with subject='Цитология' (medicina/medicina)
 *      → id, clean_title, filename, page_count, exact chunk_count.
 *   2. Flag docs with < 20 chunks as broken.
 *   3. For each broken doc, download storage_url and run the SAME position-aware
 *      extraction as lib/chunker.ts. Classify:
 *        • TEXT-PDF   → extraction yields real text  → re-ingestable
 *        • IMAGE-PDF  → 0 (or near-0) text pages     → needs OCR
 *        • LATIN-GLYPH→ text present but no Cyrillic  → font-encoding, needs OCR
 *
 * Usage: node scripts/diagnose-cytology.mjs
 * Requires Node 18+ and the project's `unpdf` dependency.
 */

import { readFileSync }     from 'fs';
import { resolve, dirname }  from 'path';
import { fileURLToPath }     from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── .env.local ────────────────────────────────────────────────────────────────
function parseEnvFile(path) {
  let content; try { content = readFileSync(path, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    env[line.slice(0, eq).trim()] = val;
  }
  return env;
}
const ENV          = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL  ?? '';
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ Supabase env vars missing from .env.local'); process.exit(1);
}

const FACULTY_ID   = 'medicina';
const SPECIALTY_ID = 'medicina';
const SUBJECT      = 'Цитология';
const BROKEN_THRESHOLD = 20;

// ── Supabase REST ─────────────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey':        SUPABASE_KEY,
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 200)}`);
  return { data, headers: res.headers };
}

async function chunkCount(documentId) {
  const { headers } = await sb(
    `/chunks?select=id&document_id=eq.${documentId}`,
    { headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } },
  );
  const cr = headers.get('content-range'); // e.g. "0-0/1234" or "*/0"
  return Number(cr?.split('/')?.[1] ?? 0);
}

// ── Position-aware extraction (mirrors lib/chunker.ts) ────────────────────────
function sanitizeText(t) {
  // eslint-disable-next-line no-control-regex
  return t.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
}
function reconstructPageText(items) {
  if (!items || items.length === 0) return '';
  let result = ''; let prevY = null; let prevRightEdge = null; let prevFontSize = null;
  for (const item of items) {
    const { str, x, y, width, fontSize, hasEOL } = item;
    if (!str) continue;
    if (prevY === null) { result += str; }
    else {
      const yDelta = Math.abs(y - prevY);
      const refSize = prevFontSize ?? fontSize ?? 12;
      const lineH = Math.max(refSize, fontSize ?? 0, 1);
      if (yDelta > lineH * 0.5) result += ' ';
      else { const gap = x - (prevRightEdge ?? x); if (gap > (fontSize ?? refSize) * 0.15) result += ' '; }
      result += str;
    }
    if (hasEOL) result += ' ';
    prevY = y; prevRightEdge = x + width; prevFontSize = fontSize || prevFontSize;
  }
  return result.replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ').replace(/\s+/g, ' ').trim();
}
async function extractPdf(buffer) {
  const { extractTextItems } = await import('unpdf');
  const { totalPages, items } = await extractTextItems(new Uint8Array(buffer));
  const pages = [];
  for (let i = 0; i < totalPages; i++) {
    const cleaned = sanitizeText(reconstructPageText(items[i] ?? []));
    if (cleaned.trim().length > 20) pages.push({ page: i + 1, text: cleaned });
  }
  return { totalPages, pages };
}

function countScripts(text) {
  let cyr = 0, lat = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x0400 && cp <= 0x04FF) cyr++;
    else if ((cp >= 0x41 && cp <= 0x5A) || (cp >= 0x61 && cp <= 0x7A)) lat++;
  }
  return { cyr, lat };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Цитология ingestion diagnostic (read-only)');
  console.log('══════════════════════════════════════════════════════════════');

  // 1. Fetch documents
  const { data: docs } = await sb(
    `/documents?select=id,clean_title,filename,file_type,page_count,storage_url` +
    `&faculty_id=eq.${FACULTY_ID}&specialty_id=eq.${SPECIALTY_ID}` +
    `&subject=eq.${encodeURIComponent(SUBJECT)}&order=clean_title.asc`,
  );
  console.log(`\nFound ${docs.length} document(s) with subject="${SUBJECT}".\n`);

  // 2. Per-doc chunk counts
  const rows = [];
  for (const d of docs) {
    const cc = await chunkCount(d.id);
    rows.push({ ...d, chunk_count: cc, broken: cc < BROKEN_THRESHOLD });
  }

  console.log('── Per-document chunk counts ──────────────────────────────────');
  console.log('chunks │ pages │ type     │ title');
  console.log('───────┼───────┼──────────┼──────────────────────────────────────');
  let totalChunks = 0;
  for (const r of rows) {
    totalChunks += r.chunk_count;
    const flag = r.broken ? '⚠' : ' ';
    console.log(
      `${flag}${String(r.chunk_count).padStart(4)} │ ${String(r.page_count ?? '?').padStart(5)} │ ` +
      `${String(r.file_type ?? '?').padEnd(8)} │ ${(r.clean_title ?? '').slice(0, 42)}`,
    );
  }
  console.log('───────┴───────┴──────────┴──────────────────────────────────────');
  console.log(`Total chunks: ${totalChunks} across ${rows.length} docs`);
  const broken = rows.filter(r => r.broken);
  console.log(`Broken (< ${BROKEN_THRESHOLD} chunks): ${broken.length}\n`);

  if (broken.length === 0) {
    console.log('No broken documents — nothing to diagnose.'); return;
  }

  // 3. Diagnose each broken doc via live extraction
  console.log('── Extraction diagnosis of broken docs ────────────────────────');
  const verdicts = [];
  for (const r of broken) {
    console.log(`\n▸ ${r.clean_title}`);
    console.log(`  id=${r.id}`);
    console.log(`  filename: ${r.filename}`);
    console.log(`  storage_url: ${r.storage_url ?? '(none)'}`);

    if (!r.storage_url) {
      console.log('  ✗ No storage_url — cannot re-extract. (file may have been deleted from Storage)');
      verdicts.push({ title: r.clean_title, verdict: 'NO_FILE' });
      continue;
    }

    let buffer;
    try {
      const res = await fetch(r.storage_url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) {
        console.log(`  ✗ Download failed: HTTP ${res.status}`);
        verdicts.push({ title: r.clean_title, verdict: `DOWNLOAD_${res.status}` });
        continue;
      }
      buffer = Buffer.from(await res.arrayBuffer());
    } catch (e) {
      console.log(`  ✗ Download error: ${e.message}`);
      verdicts.push({ title: r.clean_title, verdict: 'DOWNLOAD_ERR' });
      continue;
    }
    console.log(`  size: ${(buffer.length / 1024).toFixed(0)} KB`);

    if (r.filename && !/\.pdf$/i.test(r.filename) && !/pdf/i.test(res?.headers?.get?.('content-type') ?? '')) {
      // non-PDF (e.g. pptx) — extraction path differs; note and skip deep parse
      console.log(`  (non-PDF file type — skipping PDF extraction)`);
    }

    let totalPages = 0, pages = [];
    try {
      ({ totalPages, pages } = await extractPdf(buffer));
    } catch (e) {
      console.log(`  ✗ PDF parse error: ${e.message}`);
      verdicts.push({ title: r.clean_title, verdict: 'PARSE_ERR' });
      continue;
    }

    const fullText = pages.map(p => p.text).join(' ');
    const { cyr, lat } = countScripts(fullText);
    const density = fullText.length > 0 ? (fullText.match(/ /g)?.length ?? 0) / fullText.length : 0;
    const contentRatio = totalPages > 0 ? pages.length / totalPages : 0;

    console.log(`  PDF pages (total):     ${totalPages}`);
    console.log(`  pages with text (>20): ${pages.length}  (${(contentRatio * 100).toFixed(0)}% of pages)`);
    console.log(`  extracted chars:       ${fullText.length.toLocaleString('en-US')}`);
    console.log(`  space density:         ${density.toFixed(3)}  (healthy ≈ 0.12–0.18)`);
    console.log(`  Cyrillic letters:      ${cyr.toLocaleString('en-US')}`);
    console.log(`  Latin letters:         ${lat.toLocaleString('en-US')}`);
    if (fullText.length > 0) console.log(`  sample: "${fullText.slice(0, 160).replace(/\s+/g, ' ')}"`);

    // ── Classify ──
    let verdict, action;
    const charsPerPage = totalPages > 0 ? fullText.length / totalPages : 0;
    if (pages.length === 0 || charsPerPage < 50) {
      verdict = 'IMAGE-PDF (scanned)';
      action  = 'needs OCR — re-ingest will NOT help';
    } else if (cyr === 0 && lat > 200) {
      verdict = 'LATIN-GLYPH encoding';
      action  = 'text is decoding as Latin look-alikes — needs OCR (bul) to be usable';
    } else {
      verdict = 'TEXT-PDF';
      action  = `re-ingestable — extraction yields ~${Math.round(fullText.length / 2000)} chunks worth of text`;
    }
    console.log(`  ⇒ VERDICT: ${verdict} — ${action}`);
    verdicts.push({
      title: r.clean_title, verdict, action,
      totalPages, contentPages: pages.length, chars: fullText.length, cyr, lat,
      chunk_count: r.chunk_count,
    });
  }

  // 4. Summary
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('══════════════════════════════════════════════════════════════');
  for (const v of verdicts) {
    console.log(`  • [${String(v.chunk_count ?? '?').padStart(3)} chunks] ${v.verdict?.padEnd(22) ?? v.verdict}  ${v.title}`);
    if (v.action) console.log(`      ↳ ${v.action}`);
  }
  const reingestable = verdicts.filter(v => v.verdict === 'TEXT-PDF');
  const ocr          = verdicts.filter(v => /IMAGE|LATIN/.test(v.verdict ?? ''));
  const failed       = verdicts.filter(v => /NO_FILE|DOWNLOAD|PARSE/.test(v.verdict ?? ''));
  console.log('');
  console.log(`  Re-ingestable (text PDF): ${reingestable.length}`);
  console.log(`  Needs OCR (image/glyph):  ${ocr.length}`);
  if (failed.length) console.log(`  Could not fetch/parse:    ${failed.length}`);
  console.log('══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
