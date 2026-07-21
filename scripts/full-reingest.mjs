/**
 * scripts/full-reingest.mjs
 *
 * Re-ingest EVERY document in the library using the fixed position-aware PDF
 * extraction (extractTextItems + reconstructPageText).  Deletes and rebuilds
 * all chunks for every document so the spacing improvement applies globally.
 *
 * Usage:
 *   node scripts/full-reingest.mjs [--dry-run] [--skip-ids id1,id2,...]
 *
 *   --dry-run        Extract & chunk each doc but do NOT delete/insert DB rows.
 *                    Lets you preview chunk counts without touching data.
 *   --skip-ids       Comma-separated list of document IDs to skip.
 *
 * Requirements:
 *   - Node 18+
 *   - Run from project root: node scripts/full-reingest.mjs
 *   - .env.local with NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
 *     OPENAI_API_KEY
 *   - DB must NOT be in read-only mode (script verifies this before starting)
 *
 * Estimated time: ~3-8 hours depending on library size and embedding rate limits.
 * Leave the terminal open; the script is fully resumable by re-running with
 * --skip-ids listing already-completed IDs (printed in the summary on success).
 */

import { readFileSync, createWriteStream } from 'fs';
import { createInterface }                 from 'readline';
import { resolve, dirname }                from 'path';
import { fileURLToPath }                   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── CLI flags ─────────────────────────────────────────────────────────────────

const args    = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

const skipArg  = args.find((a) => a.startsWith('--skip-ids'));
const SKIP_IDS = new Set(
  skipArg
    ? (skipArg.includes('=') ? skipArg.split('=')[1] : args[args.indexOf('--skip-ids') + 1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : []
);

// ── 1. Parse .env.local ───────────────────────────────────────────────────────

function parseEnvFile(filePath) {
  let content;
  try { content = readFileSync(filePath, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val   = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[key] = val;
  }
  return env;
}

const ENV          = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL ?? ENV.SUPABASE_URL ?? '';
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';
const OPENAI_KEY   = ENV.OPENAI_API_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY || !OPENAI_KEY) {
  console.error(
    'ERROR: Missing one or more required env vars in .env.local:\n' +
    '  NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENAI_API_KEY'
  );
  process.exit(1);
}

const SB_HEADERS = {
  apikey:         SUPABASE_KEY,
  Authorization:  `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ── 2. Helpers ────────────────────────────────────────────────────────────────

const sleep   = (ms) => new Promise((r) => setTimeout(r, ms));

function elapsed(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

function fmt(n) { return n.toLocaleString('en-US'); }

async function confirm(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ── 3. DB read-only safety check ──────────────────────────────────────────────
//
// Attempts a no-op DELETE on a non-existent UUID.  If the DB is read-only
// (disk full / Supabase error 53100), this will return an error body that
// contains "read-only" or a 5xx status.  If writable, PostgREST returns 204
// with 0 rows affected — perfectly safe.

async function checkDbWritable() {
  const SENTINEL = '00000000-0000-0000-0000-000000000000';
  let res;
  try {
    res = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?id=eq.${SENTINEL}`,
      { method: 'DELETE', headers: SB_HEADERS }
    );
  } catch (e) {
    return { ok: false, reason: `Network error: ${e.message}` };
  }

  if (res.ok) return { ok: true };  // 200 / 204 → writable

  let body = '';
  try { body = await res.text(); } catch { /* ignore */ }

  const isReadOnly =
    body.toLowerCase().includes('read-only') ||
    body.includes('53100') ||
    res.status === 503 ||
    res.status === 500;

  return {
    ok:     !isReadOnly,
    reason: isReadOnly
      ? `Database is in read-only mode (HTTP ${res.status}): ${body.slice(0, 200)}`
      : null,   // unexpected non-read-only error — still writable enough
  };
}

// ── 4. Text extraction — position-aware (mirrors lib/chunker.ts) ──────────────

function sanitizeText(t) {
  // eslint-disable-next-line no-control-regex
  return t.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
}

function normalizeText(t) {
  // Used only for PPTX (no position data). Replaces bullets, collapses ws.
  return t.replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Reconstruct page text with inter-word spaces inferred from glyph positions.
 *
 * Rules:
 *   • Same line (|Δy| < 0.5 × lineHeight) AND gap > 15% of fontSize → space.
 *   • Different line (|Δy| ≥ 0.5 × lineHeight)                       → space.
 *   • item.hasEOL                                                     → trailing space.
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

async function extractPptxPages(buffer) {
  const officeParser = await import('officeparser');
  const text = await new Promise((resolve, reject) => {
    officeParser.default.parseOffice(buffer, (data, err) => {
      if (err) reject(err); else resolve(data);
    });
  });
  return String(text ?? '').split(/\n{2,}/)
    .map((t, i) => ({ page: i + 1, text: normalizeText(sanitizeText(t)) }))
    .filter((s) => s.text.length > 0);
}

// ── 5. Chunker (mirrors lib/chunker.ts) ───────────────────────────────────────

function approxTokens(t) { return Math.ceil(t.length / 4); }

function chunkPages(pages, targetTokens = 500, overlapTokens = 50) {
  const segments = [];
  for (const { page, text } of pages) {
    for (const sentence of text.split(/(?<=[.!?।\n])\s+/).filter((s) => s.trim().length > 0)) {
      segments.push({ page, sentence });
    }
  }

  const chunks = [];
  let chunkIndex = 0;
  let i = 0;
  while (i < segments.length) {
    let tokenCount = 0;
    const cs = [];
    while (i < segments.length && tokenCount < targetTokens) {
      cs.push(segments[i]);
      tokenCount += approxTokens(segments[i].sentence);
      i++;
    }
    if (cs.length === 0) break;
    chunks.push({
      content:     cs.map((s) => s.sentence).join(' '),
      pageNumber:  cs[0].page,
      chunkIndex,
    });
    chunkIndex++;
    const back = Math.ceil(overlapTokens / approxTokens(segments[i - 1]?.sentence || 'x'));
    i = Math.max(i - back, i - cs.length + 1);
    if (i <= 0) break;
  }
  return chunks;
}

// ── 6. Embeddings (OpenAI REST with 429 backoff) ──────────────────────────────

const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];

async function embedBatchWithRetry(texts, label) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method:  'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body:    JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });

    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const m    = (body?.error?.message ?? '').match(/try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i);
      let wait   = BACKOFF[Math.min(attempt, 4)];
      if (m) wait = m[2].toLowerCase() === 'ms' ? Math.ceil(+m[1]) : Math.ceil(+m[1] * 1_000);
      console.log(`    [embed] 429 on ${label} — waiting ${wait} ms (attempt ${attempt + 1}/5)`);
      await sleep(wait + 250);
      continue;
    }

    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error(`[embed] ${label} failed after 5 retries`);
}

async function embedAll(texts, docLabel) {
  const BATCH = 50;
  const all   = [];
  const total = Math.ceil(texts.length / BATCH);
  for (let i = 0; i < texts.length; i += BATCH) {
    const bNum  = Math.floor(i / BATCH) + 1;
    const label = `${docLabel} batch ${bNum}/${total}`;
    const embs  = await embedBatchWithRetry(texts.slice(i, i + BATCH), label);
    all.push(...embs);
    if (i + BATCH < texts.length) await sleep(200);
  }
  return all;
}

// ── 7. Supabase helpers ───────────────────────────────────────────────────────

async function fetchAllDocuments() {
  // Supabase REST paginates at 1 000 rows by default; handle via Range header.
  const PAGE = 1_000;
  let   offset = 0;
  const all    = [];

  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/documents` +
      `?select=id,filename,clean_title,file_type,storage_url,created_at` +
      `&order=created_at.asc` +
      `&limit=${PAGE}&offset=${offset}`,
      { headers: { ...SB_HEADERS, Prefer: 'count=exact' } }
    );
    if (!res.ok) throw new Error(`fetchAllDocuments HTTP ${res.status}: ${await res.text()}`);
    const rows = await res.json();
    all.push(...rows);
    if (rows.length < PAGE) break;
    offset += PAGE;
  }

  return all;
}

async function getChunkCount(docId) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/chunks?select=id&document_id=eq.${docId}&limit=1`,
    { headers: { ...SB_HEADERS, Prefer: 'count=exact' } }
  );
  if (!res.ok) return 0;
  const raw = res.headers.get('content-range') ?? '';
  // content-range: 0-0/42  →  42
  const m = raw.match(/\/(\d+)$/);
  return m ? parseInt(m[1], 10) : 0;
}

async function deleteChunksBatched(docId) {
  let total = 0;
  for (;;) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id&document_id=eq.${docId}&limit=200`,
      { headers: SB_HEADERS }
    );
    if (!res.ok) throw new Error(`GET chunk IDs: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;

    const ids = rows.map((r) => r.id).join(',');
    const del = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?id=in.(${ids})`,
      { method: 'DELETE', headers: SB_HEADERS }
    );
    if (!del.ok) throw new Error(`DELETE chunk batch: ${del.status}`);
    total += rows.length;
  }
  return total;
}

async function insertChunks(docId, chunks, embeddings) {
  // 25-row batches keep each payload ≈ 300 KB — safe for PostgREST free tier.
  const DB_BATCH  = 25;
  const MAX_RETRY = 4;
  let   created   = 0;

  for (let i = 0; i < chunks.length; i += DB_BATCH) {
    const batchNum = Math.floor(i / DB_BATCH) + 1;
    const rows = chunks.slice(i, i + DB_BATCH).map((c, j) => ({
      document_id: docId,
      // eslint-disable-next-line no-control-regex
      content:     c.content.replace(/\x00/g, ''),
      page_number: c.pageNumber,
      chunk_index: c.chunkIndex,
      embedding:   embeddings[i + j],
    }));

    let ok = false;
    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/chunks`, {
        method:  'POST',
        headers: { ...SB_HEADERS, Prefer: 'return=minimal' },
        body:    JSON.stringify(rows),
      });
      if (res.ok) { created += rows.length; ok = true; break; }
      const body = await res.text().catch(() => '');
      console.error(
        `    Insert batch ${batchNum} attempt ${attempt + 1}/${MAX_RETRY} failed: ` +
        `HTTP ${res.status} ${body.slice(0, 120)}`
      );
      if (attempt < MAX_RETRY - 1) await sleep(3_000 * (attempt + 1));
    }
    if (!ok) console.error(`    Insert batch ${batchNum} PERMANENTLY failed after ${MAX_RETRY} attempts.`);

    if (i + DB_BATCH < chunks.length) await sleep(300);
  }
  return created;
}

// ── 8. Process one document ───────────────────────────────────────────────────

async function processDoc(doc, idx, total, chunksBefore) {
  const label = doc.clean_title ?? doc.filename;
  const t0    = Date.now();
  console.log(`\n[${idx}/${total}] ${label}`);
  console.log(`  ID          : ${doc.id}`);
  console.log(`  Chunks now  : ${chunksBefore}`);
  console.log(`  Storage URL : ${doc.storage_url}`);

  // ── Download ──────────────────────────────────────────────────────────────
  process.stdout.write('  Downloading…');
  const fileRes = await fetch(doc.storage_url);
  if (!fileRes.ok) throw new Error(`Download HTTP ${fileRes.status} ${fileRes.statusText}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  console.log(` ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  // ── Extract ───────────────────────────────────────────────────────────────
  const filename = doc.filename.toLowerCase();
  const isPdf    = filename.endsWith('.pdf');
  const isPptx   = /\.(pptx|ppt)$/.test(filename);

  let pages;
  if (isPdf) {
    process.stdout.write('  Extracting PDF (position-aware)…');
    pages = await extractPdfPages(buffer);
  } else if (isPptx) {
    process.stdout.write('  Extracting PPTX…');
    pages = await extractPptxPages(buffer);
  } else {
    throw new Error(`Unsupported file type: ${doc.filename}`);
  }
  console.log(` ${pages.length} pages`);

  // ── Chunk ─────────────────────────────────────────────────────────────────
  const chunks = chunkPages(pages);
  console.log(`  Chunks new  : ${chunks.length}`);

  if (DRY_RUN) {
    const ms = Date.now() - t0;
    console.log(`  [DRY RUN] Skipping DB writes. (${elapsed(ms)})`);
    return { chunksAfter: chunks.length, ms, dryRun: true };
  }

  if (chunks.length === 0) {
    // No text at all — skip delete+embed so we don't wipe existing chunks
    // for an image-only PDF without gaining anything new.
    console.log('  ⚠  No text extracted — skipping DB update (image-only PDF?).');
    return { chunksAfter: 0, ms: Date.now() - t0, imageOnly: true };
  }

  // ── Embed ─────────────────────────────────────────────────────────────────
  const shortLabel = label.slice(0, 40);
  console.log(`  Embedding ${chunks.length} chunks…`);
  const embeddings = await embedAll(chunks.map((c) => c.content), shortLabel);
  console.log(`  Embeddings  : ${embeddings.length} done`);

  // ── Delete old chunks ─────────────────────────────────────────────────────
  process.stdout.write('  Deleting old chunks…');
  const deleted = await deleteChunksBatched(doc.id);
  console.log(` ${deleted} deleted`);

  // ── Insert new chunks ─────────────────────────────────────────────────────
  process.stdout.write('  Inserting new chunks…');
  const created = await insertChunks(doc.id, chunks, embeddings);
  const ms      = Date.now() - t0;
  console.log(` ${created} inserted`);
  console.log(`  ✓ Done: ${chunksBefore} → ${created} chunks  (${elapsed(ms)})`);

  return { chunksAfter: created, ms };
}

// ── 9. Main ───────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  MU-Плевен Full-Library Re-ingest');
if (DRY_RUN) console.log('  ⚠  DRY RUN MODE — no database writes will occur');
console.log('══════════════════════════════════════════════════════════════\n');

// ── 9.1 DB writable check ─────────────────────────────────────────────────────

if (!DRY_RUN) {
  process.stdout.write('Checking database write access… ');
  const { ok, reason } = await checkDbWritable();
  if (!ok) {
    console.log('FAILED\n');
    console.error(
      '✗  DB is in read-only mode — cannot re-ingest.\n' +
      '   Resize the Supabase disk and wait for read-only mode to clear,\n' +
      '   then re-run this script.\n\n' +
      `   Detail: ${reason}`
    );
    process.exit(1);
  }
  console.log('OK ✓');
}

// ── 9.2 Fetch all documents ───────────────────────────────────────────────────

process.stdout.write('Fetching document list… ');
const allDocs = await fetchAllDocuments();
console.log(`${allDocs.length} documents found`);

const targetDocs = allDocs.filter((d) => !SKIP_IDS.has(d.id));
const skippedN   = allDocs.length - targetDocs.length;
if (skippedN > 0) console.log(`Skipping ${skippedN} documents (--skip-ids).`);

if (targetDocs.length === 0) {
  console.log('Nothing to do.');
  process.exit(0);
}

// ── 9.3 Fetch current chunk counts for all target docs (parallel HEAD) ────────

process.stdout.write(`Fetching current chunk counts for ${targetDocs.length} documents… `);
const preCounts = await Promise.all(targetDocs.map((d) => getChunkCount(d.id)));
const totalChunksBefore = preCounts.reduce((s, n) => s + n, 0);
console.log(`done — ${fmt(totalChunksBefore)} total chunks currently`);

// ── 9.4 Print plan + confirm ──────────────────────────────────────────────────

console.log('\n──────────────────────────────────────────────────────────────');
console.log(`  Documents to re-ingest : ${targetDocs.length}`);
console.log(`  Current total chunks   : ${fmt(totalChunksBefore)}`);
console.log(`  Extraction method      : position-aware (extractTextItems)`);
if (DRY_RUN) {
  console.log('  DB writes              : NONE (dry run)');
} else {
  console.log('  DB writes              : DELETE + INSERT for every document');
}
console.log('──────────────────────────────────────────────────────────────\n');

const answer = await confirm(
  DRY_RUN
    ? `About to DRY-RUN ${targetDocs.length} documents (no DB writes). Proceed? (y/N) `
    : `About to re-ingest ${targetDocs.length} documents.\n` +
      `This will DELETE and rebuild ALL ${fmt(totalChunksBefore)} chunks.\n` +
      `Proceed? (y/N) `
);

if (answer !== 'y') {
  console.log('\nAborted.');
  process.exit(0);
}

// ── 9.5 Process each document ─────────────────────────────────────────────────

const t0Global   = Date.now();
const results    = [];  // { doc, chunksBefore, chunksAfter, ms, error?, imageOnly?, dryRun? }

for (let i = 0; i < targetDocs.length; i++) {
  const doc          = targetDocs[i];
  const chunksBefore = preCounts[i];

  if (SKIP_IDS.has(doc.id)) continue;

  try {
    const res = await processDoc(doc, i + 1, targetDocs.length, chunksBefore);
    results.push({ doc, chunksBefore, ...res });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  ✗ FAILED: ${message}`);
    results.push({ doc, chunksBefore, chunksAfter: chunksBefore, ms: 0, error: message });
  }

  if (i < targetDocs.length - 1) await sleep(2_000);
}

// ── 9.6 Final summary ─────────────────────────────────────────────────────────

const totalMs     = Date.now() - t0Global;
const succeeded   = results.filter((r) => !r.error);
const failed      = results.filter((r) => r.error);
const imageOnly   = results.filter((r) => r.imageOnly);
const totalAfter  = succeeded.reduce((s, r) => s + (r.chunksAfter ?? 0), 0);
const totalBefore = results.reduce((s, r) => s + r.chunksBefore, 0);

console.log('\n══════════════════════════════════════════════════════════════');
console.log('  SUMMARY');
console.log('══════════════════════════════════════════════════════════════');
console.log(`Total documents     : ${targetDocs.length}`);
console.log(`Succeeded           : ${succeeded.length}`);
console.log(`Failed              : ${failed.length}`);
console.log(`Image-only (0 text) : ${imageOnly.length}`);
console.log(`Total chunks before : ${fmt(totalBefore)}`);
console.log(DRY_RUN
  ? `Total chunks would  : ${fmt(totalAfter)}  (dry run — no writes)`
  : `Total chunks after  : ${fmt(totalAfter)}`);
console.log(`Net chunk change    : ${totalAfter >= totalBefore ? '+' : ''}${fmt(totalAfter - totalBefore)}`);
console.log(`Total time          : ${elapsed(totalMs)}`);

if (failed.length > 0) {
  console.log('\n── Failed documents ───────────────────────────────────────────');
  for (const r of failed) {
    console.log(`  ${r.doc.id}  ${r.doc.clean_title ?? r.doc.filename}`);
    console.log(`    Error: ${r.error}`);
  }
  console.log('\nTo retry only failed documents, run:');
  const failIds = failed.map((r) => r.doc.id).join(',');
  const successIds = succeeded.map((r) => r.doc.id).join(',');
  console.log(`  node scripts/local-reingest.mjs ${failIds}`);
  if (!DRY_RUN && succeeded.length > 0) {
    console.log('\nTo re-run everything except already-completed docs:');
    console.log(`  node scripts/full-reingest.mjs --skip-ids ${successIds}`);
  }
}

if (imageOnly.length > 0) {
  console.log('\n── Image-only PDFs (0 chunks — may need OCR) ─────────────────');
  for (const r of imageOnly) {
    console.log(`  ${r.doc.id}  ${r.doc.clean_title ?? r.doc.filename}`);
  }
  console.log('\n  These PDFs contain no extractable text layer.');
  console.log('  Consider running OCR (e.g. ocrmypdf --language bul) before re-ingesting.');
}

if (DRY_RUN) {
  console.log('\n── Per-document dry-run results ───────────────────────────────');
  console.log('  ' + 'Clean title'.padEnd(50) + 'Before'.padStart(7) + '  After'.padStart(7) + '  Δ'.padStart(7));
  console.log('  ' + '─'.repeat(72));
  for (const r of results) {
    const title  = (r.doc.clean_title ?? r.doc.filename).slice(0, 48).padEnd(50);
    const before = String(r.chunksBefore).padStart(7);
    const after  = r.error ? '  ERROR' : String(r.chunksAfter).padStart(7);
    const delta  = r.error ? '' : (r.chunksAfter - r.chunksBefore >= 0 ? '+' : '') +
                   String(r.chunksAfter - r.chunksBefore).padStart(6);
    console.log(`  ${title}${before}  ${after}  ${delta}`);
  }
}

console.log('\n══════════════════════════════════════════════════════════════\n');
