/**
 * scripts/local-reingest.mjs
 *
 * Runs the full ingest pipeline locally (no Vercel timeout) for specific
 * document IDs.  Useful when books are too large to process within the 60 s
 * Vercel function ceiling.
 *
 * Pass target IDs as CLI args, or edit HARD_CODED_IDS below.
 *
 * Usage:
 *   node scripts/local-reingest.mjs [id1] [id2] ...
 *
 * Requirements: Node 18+. Run from the project root so node_modules
 * (unpdf, officeparser) can be resolved.
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// ── IDs to process (override via CLI args) ───────────────────────────────────
const HARD_CODED_IDS = [
  'bacb8811-207e-4332-afe1-004087937e0a', // Клинична Алергология
  'c5543cd0-c501-44e0-83e8-08f010e51b98', // Патофизиология На Заболяванията
  '6256cef1-b286-4138-a93a-46db793ac3ac', // Учебник По Клинична Патология Том 2
];

const TARGET_IDS = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : HARD_CODED_IDS;

// ── 1. Parse .env.local ───────────────────────────────────────────────────────

function parseEnvFile(path) {
  let content;
  try { content = readFileSync(path, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
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
  console.error('ERROR: Missing SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY or OPENAI_API_KEY in .env.local');
  process.exit(1);
}

const SB = {
  apikey:         SUPABASE_KEY,
  Authorization:  `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ── 2. Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function elapsed(ms) {
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return `${m}m ${s}s`;
}

// ── 3. Text extraction ────────────────────────────────────────────────────────

function sanitizeText(t) {
  // eslint-disable-next-line no-control-regex
  return t.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
}

function normalizeText(t) {
  // Used only for PPTX (no position data). Replaces bullets and collapses whitespace.
  return t
    .replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reconstruct page text from positioned text items.
 * Inserts spaces based on horizontal gaps and y-line changes so that words
 * separated only by visual whitespace in the PDF are not merged.
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
        // New line → space to prevent word merging across lines
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

// ── 4. Chunker (mirrors lib/chunker.ts) ──────────────────────────────────────

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
    chunks.push({ content: cs.map((s) => s.sentence).join(' '), pageNumber: cs[0].page, chunkIndex });
    chunkIndex++;
    const back = Math.ceil(overlapTokens / approxTokens(segments[i - 1]?.sentence || 'x'));
    i = Math.max(i - back, i - cs.length + 1);
    if (i <= 0) break;
  }
  return chunks;
}

// ── 5. Embeddings (direct OpenAI REST) ───────────────────────────────────────

const BACKOFF = [1_000, 2_000, 4_000, 8_000, 16_000];

async function embedBatchWithRetry(texts, batchNum) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${OPENAI_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: texts }),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const msg  = body?.error?.message ?? '';
      const m    = msg.match(/try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i);
      let wait   = BACKOFF[Math.min(attempt, 4)];
      if (m) wait = m[2].toLowerCase() === 'ms' ? Math.ceil(+m[1]) : Math.ceil(+m[1] * 1000);
      console.log(`  [embed] 429 on batch ${batchNum} — waiting ${wait} ms (attempt ${attempt + 1})`);
      await sleep(wait + 250);
      continue;
    }
    if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
  throw new Error(`[embed] batch ${batchNum} failed after 5 retries`);
}

async function embedAll(texts) {
  const BATCH = 50;
  const all   = [];
  const total = Math.ceil(texts.length / BATCH);
  for (let i = 0; i < texts.length; i += BATCH) {
    const bNum = Math.floor(i / BATCH) + 1;
    console.log(`  [embed] batch ${bNum}/${total} (${Math.min(BATCH, texts.length - i)} chunks)`);
    const emb = await embedBatchWithRetry(texts.slice(i, i + BATCH), bNum);
    all.push(...emb);
    if (i + BATCH < texts.length) await sleep(200);
  }
  return all;
}

// ── 6. Supabase helpers ───────────────────────────────────────────────────────

async function fetchDoc(id) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/documents?select=id,filename,file_type,storage_url&id=eq.${id}`,
    { headers: SB },
  );
  if (!res.ok) throw new Error(`GET document ${id}: ${res.status}`);
  const rows = await res.json();
  return rows[0] ?? null;
}

async function deleteChunksBatched(docId) {
  let total = 0;
  for (;;) {
    // Fetch a page of chunk IDs
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=id&document_id=eq.${docId}&limit=200`,
      { headers: SB },
    );
    if (!res.ok) throw new Error(`GET chunk IDs: ${res.status}`);
    const rows = await res.json();
    if (!rows.length) break;

    const ids  = rows.map((r) => r.id).join(',');
    const del  = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?id=in.(${ids})`,
      { method: 'DELETE', headers: SB },
    );
    if (!del.ok) throw new Error(`DELETE chunk batch: ${del.status}`);
    total += rows.length;
    process.stdout.write(`\r    Deleted ${total} chunks…`);
  }
  if (total > 0) process.stdout.write('\n');
  return total;
}

async function insertChunks(docId, chunks, embeddings) {
  // Keep batches small (25 rows) — each row carries a 1536-float vector
  // (~12 KB of JSON). 100-row batches push ~1.2 MB which triggers PostgREST
  // 503. 25 rows ≈ 300 KB — well within limits.
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
        headers: { ...SB, Prefer: 'return=minimal' },
        body:    JSON.stringify(rows),
      });
      if (res.ok) { created += rows.length; ok = true; break; }
      const body = await res.text().catch(() => '');
      console.error(`    Insert batch ${batchNum} attempt ${attempt + 1} failed: ${res.status} ${body.slice(0, 120)}`);
      if (attempt < MAX_RETRY - 1) await sleep(3_000 * (attempt + 1));
    }
    if (!ok) console.error(`    Insert batch ${batchNum} PERMANENTLY failed after ${MAX_RETRY} attempts`);

    // Small pause between inserts to avoid saturating the free-tier connection pool
    if (i + DB_BATCH < chunks.length) await sleep(300);
  }
  return created;
}

// ── 7. Process one document ───────────────────────────────────────────────────

async function processDoc(id, idx, total) {
  const t0 = Date.now();
  console.log(`\n[${idx}/${total}] ${id}`);

  // Fetch metadata
  console.log('  Fetching metadata…');
  const doc = await fetchDoc(id);
  if (!doc) { console.log('  ✗ Document not found — skipping.'); return null; }
  console.log(`  → ${doc.filename}`);
  console.log(`  → ${doc.storage_url}`);

  // Delete existing chunks
  console.log('  Deleting existing chunks (batched)…');
  const deleted = await deleteChunksBatched(id);
  console.log(`  → ${deleted} chunks deleted.`);

  // Download
  console.log('  Downloading file…');
  const fileRes = await fetch(doc.storage_url);
  if (!fileRes.ok) throw new Error(`Download failed: HTTP ${fileRes.status}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  console.log(`  → ${(buffer.length / 1024 / 1024).toFixed(1)} MB`);

  // Extract
  const filename = doc.filename;
  const isPdf    = filename.toLowerCase().endsWith('.pdf');
  const isPptx   = /\.(pptx|ppt)$/i.test(filename.toLowerCase());

  let pages;
  if (isPdf) {
    console.log('  Extracting PDF pages…');
    pages = await extractPdfPages(buffer);
  } else if (isPptx) {
    console.log('  Extracting PPTX slides…');
    pages = await extractPptxPages(buffer);
  } else {
    throw new Error(`Unsupported file type: ${filename}`);
  }
  console.log(`  → ${pages.length} pages extracted.`);

  // Chunk
  const chunks = chunkPages(pages);
  console.log(`  → ${chunks.length} chunks.`);

  if (chunks.length === 0) {
    console.log('  ✓ No text content — done (0 chunks).');
    return { chunksCreated: 0, ms: Date.now() - t0 };
  }

  // Embed
  console.log(`  Embedding ${chunks.length} chunks…`);
  const embeddings = await embedAll(chunks.map((c) => c.content));
  console.log(`  → ${embeddings.length} embeddings done.`);

  // Insert
  console.log('  Inserting chunks into Supabase…');
  const created = await insertChunks(id, chunks, embeddings);
  console.log(`  ✓ ${created}/${chunks.length} chunks inserted.`);

  return { chunksCreated: created, ms: Date.now() - t0 };
}

// ── 8. Main ───────────────────────────────────────────────────────────────────

const t0       = Date.now();
const failures = [];
let   totalOk  = 0;
let   totalCh  = 0;

console.log('\n══════════════════════════════════════════════════');
console.log('  MU-Плевен Local Re-ingest');
console.log(`  Target: ${TARGET_IDS.length} document(s)`);
console.log('══════════════════════════════════════════════════');

for (let i = 0; i < TARGET_IDS.length; i++) {
  const id = TARGET_IDS[i];
  try {
    const result = await processDoc(id, i + 1, TARGET_IDS.length);
    if (result) { totalOk++; totalCh += result.chunksCreated; }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ✗ FAILED: ${msg}`);
    failures.push({ id, error: msg });
  }
  if (i < TARGET_IDS.length - 1) await sleep(2_000);
}

console.log('\n─────── Summary ───────');
console.log(`Total processed : ${TARGET_IDS.length}`);
console.log(`Succeeded       : ${totalOk}${totalOk > 0 ? ` (${totalCh} chunks total)` : ''}`);
console.log(`Failed          : ${failures.length}`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f.id}: ${f.error}`);
}
console.log(`Total time      : ${elapsed(Date.now() - t0)}`);
console.log('');
