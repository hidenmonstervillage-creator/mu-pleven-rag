/**
 * scripts/bulk-reingest.mjs
 *
 * Finds every document with chunk_count < 20 and re-ingests each one via
 *   POST https://mu-pleven-rag.vercel.app/api/documents/[id]/reingest
 *
 * Requirements: Node 18+ (uses built-in fetch, readline/promises).
 * No external packages needed.
 *
 * Usage: node scripts/bulk-reingest.mjs
 */

import { createInterface } from 'readline/promises';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = resolve(__dirname, '..');
const VERCEL_URL = 'https://mu-pleven-rag.vercel.app';

// ── 1. Parse .env.local ───────────────────────────────────────────────────────

function parseEnvFile(path) {
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    return {};
  }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[key] = val;
  }
  return env;
}

const ENV = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL ?? ENV.SUPABASE_URL ?? '';
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('ERROR: Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local');
  process.exit(1);
}

const SB_HEADERS = {
  apikey:        SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  'Content-Type': 'application/json',
};

// ── 2. Helpers ────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function elapsed(startMs) {
  const ms   = Date.now() - startMs;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.floor((ms % 60_000) / 1_000);
  return `${mins} minute${mins !== 1 ? 's' : ''} ${secs} second${secs !== 1 ? 's' : ''}`;
}

// ── 3. Supabase queries ───────────────────────────────────────────────────────

async function fetchDocuments() {
  const url = `${SUPABASE_URL}/rest/v1/documents?select=id,clean_title,filename,faculty_id,specialty_id,subject`;
  const res  = await fetch(url, { headers: SB_HEADERS });
  if (!res.ok) throw new Error(`GET /documents failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function fetchAllChunkDocumentIds() {
  const PAGE  = 1000;
  let   offset = 0;
  let   total  = null;
  const ids    = [];

  process.stdout.write('  Fetching chunks (paginating)');

  while (true) {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/chunks?select=document_id`,
      {
        headers: {
          ...SB_HEADERS,
          Range:  `${offset}-${offset + PAGE - 1}`,
          Prefer: 'count=exact',
        },
      },
    );

    // PostgREST returns 200 when all rows fit, 206 for partial content
    if (!res.ok && res.status !== 206) {
      throw new Error(`GET /chunks page ${offset} failed: ${res.status}`);
    }

    const page = await res.json();
    for (const row of page) ids.push(row.document_id);

    // Parse total from Content-Range on first page
    if (total === null) {
      const cr = res.headers.get('Content-Range') ?? res.headers.get('content-range') ?? '';
      const m  = cr.match(/\/(\d+)$/);
      total = m ? parseInt(m[1], 10) : null;
    }

    process.stdout.write(
      `\r  Fetching chunks: ${ids.length}${total !== null ? '/' + total : ''} rows…`,
    );

    offset += PAGE;
    if (page.length < PAGE) break;           // fewer rows than page size → done
    if (total !== null && offset >= total) break; // fetched everything
  }

  process.stdout.write('\n');
  return ids;
}

// ── 4. Main ───────────────────────────────────────────────────────────────────

const t0 = Date.now();

console.log('\n══════════════════════════════════════════════════');
console.log('  MU-Плевен Bulk Re-ingest');
console.log('══════════════════════════════════════════════════\n');

console.log('Fetching document list…');
const documents = await fetchDocuments();
console.log(`  ${documents.length} documents in DB.\n`);

console.log('Fetching chunk counts (this may take a moment for 69 k+ rows)…');
const chunkIds = await fetchAllChunkDocumentIds();

// Build document_id → chunk_count map
const countMap = new Map();
for (const id of chunkIds) {
  countMap.set(id, (countMap.get(id) ?? 0) + 1);
}
console.log(`  ${chunkIds.length} chunk records processed.\n`);

// Annotate and filter
const withCounts = documents.map((d) => ({
  ...d,
  chunk_count: countMap.get(d.id) ?? 0,
}));

const broken = withCounts
  .filter((d) => d.chunk_count < 20)
  .sort((a, b) => a.chunk_count - b.chunk_count);

console.log(`Found ${broken.length} broken documents (chunk_count < 20):`);
if (broken.length === 0) {
  console.log('  (none)\n');
  console.log('Nothing to do. Exiting.');
  process.exit(0);
}
for (const d of broken) {
  console.log(`  [${String(d.chunk_count).padStart(2)}] ${d.clean_title}  (id=${d.id})`);
}

// Confirmation prompt
console.log('');
const rl = createInterface({ input: process.stdin, output: process.stdout });
const answer = await rl.question('Proceed? (y/N): ');
rl.close();

if (answer.trim().toLowerCase() !== 'y') {
  console.log('\nAborted.');
  process.exit(0);
}

console.log('');

// ── 5. Sequential re-ingest ───────────────────────────────────────────────────

let succeeded   = 0;
let failed      = 0;
let totalChunks = 0;
const failures  = [];

for (let i = 0; i < broken.length; i++) {
  const doc = broken[i];
  console.log(`[${i + 1}/${broken.length}] Re-ingesting: ${doc.clean_title}…`);

  try {
    // 90-second hard timeout per document (slightly above maxDuration=60 to
    // give the Vercel function full time before we cut it ourselves)
    const ac  = new AbortController();
    const tid = setTimeout(() => ac.abort(), 90_000);

    let res;
    try {
      res = await fetch(`${VERCEL_URL}/api/documents/${doc.id}/reingest`, {
        method: 'POST',
        signal: ac.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    let body;
    try {
      body = await res.json();
    } catch {
      body = {};
    }

    if (!res.ok || !body.success) {
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    const k = body.chunksCreated ?? 0;
    console.log(`  ✓ success: ${k} chunks`);
    succeeded++;
    totalChunks += k;

  } catch (err) {
    const msg =
      err.name === 'AbortError'
        ? 'Timed out after 90 s'
        : (err instanceof Error ? err.message : String(err));
    console.log(`  ✗ failed: ${msg}`);
    failed++;
    failures.push({ title: doc.clean_title, error: msg });
  }

  // 2-second pause between requests to be kind to the Vercel cold-start pool
  if (i < broken.length - 1) await sleep(2_000);
}

// ── 6. Final summary ──────────────────────────────────────────────────────────

console.log('\n─────── Summary ───────');
console.log(`Total processed : ${broken.length}`);
console.log(
  `Succeeded       : ${succeeded}` +
  (succeeded > 0 ? ` (avg ${Math.round(totalChunks / succeeded)} chunks)` : ''),
);
console.log(`Failed          : ${failed}`);
if (failures.length > 0) {
  console.log('Failures:');
  for (const f of failures) {
    console.log(`  - ${f.title}: ${f.error}`);
  }
}
console.log(`Total time      : ${elapsed(t0)}`);
console.log('');
