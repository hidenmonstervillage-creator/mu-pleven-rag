/**
 * scripts/verify-cytology.mjs  — READ-ONLY
 *
 * Follow-up: docs have 481–486 chunks each, so they're NOT broken. Explain why
 * the earlier match_chunks spot-check returned only 9, and characterize the
 * duplicate documents.
 *
 *   1. Per-doc: total chunks vs chunks WITH a non-null embedding.
 *   2. Characterize the 6 docs (filename, storage_url, created_at) to confirm
 *      they are triplicate uploads of 2 unique textbooks.
 *   3. Call match_chunks with (a) a zero vector and (b) two random vectors,
 *      match_count=1000, to show the count swings with the query vector —
 *      i.e. the "9" is an IVFFlat + zero-vector artifact, not missing data.
 */

import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
function parseEnvFile(path) {
  let content; try { content = readFileSync(path, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[line.slice(0, eq).trim()] = val;
  }
  return env;
}
const ENV          = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL  ?? '';
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';

const FACULTY_ID = 'medicina', SPECIALTY_ID = 'medicina', SUBJECT = 'Цитология';

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_KEY}`, apikey: SUPABASE_KEY, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 200)}`);
  return { data, headers: res.headers };
}
async function countChunks(filter) {
  const { headers } = await sb(`/chunks?select=id&${filter}`, { headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } });
  return Number(headers.get('content-range')?.split('/')?.[1] ?? 0);
}
async function matchChunks(vec, count = 1000) {
  const { data } = await sb('/rpc/match_chunks', {
    method: 'POST',
    body: JSON.stringify({ query_embedding: vec, match_faculty: FACULTY_ID, match_specialty: SPECIALTY_ID, match_subject: SUBJECT, match_count: count }),
  });
  return Array.isArray(data) ? data.length : 0;
}
function randUnitVec(n = 1536) {
  const v = Array.from({ length: n }, () => Math.random() * 2 - 1);
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map(x => x / norm);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Цитология verification (read-only)');
  console.log('══════════════════════════════════════════════════════════════\n');

  const { data: docs } = await sb(
    `/documents?select=id,clean_title,filename,storage_url,page_count,created_at` +
    `&faculty_id=eq.${FACULTY_ID}&specialty_id=eq.${SPECIALTY_ID}&subject=eq.${encodeURIComponent(SUBJECT)}&order=created_at.asc`,
  );

  // 1. embeddings present?
  console.log('── Chunks total vs embedded, per document ─────────────────────');
  let allChunks = 0, allEmbedded = 0;
  for (const d of docs) {
    const total    = await countChunks(`document_id=eq.${d.id}`);
    const embedded = await countChunks(`document_id=eq.${d.id}&embedding=not.is.null`);
    allChunks += total; allEmbedded += embedded;
    console.log(`  ${String(total).padStart(3)} chunks | ${String(embedded).padStart(3)} embedded | ${d.created_at?.slice(0,10)} | ${(d.clean_title ?? '').slice(0,34)}`);
  }
  console.log(`  ── total: ${allChunks} chunks, ${allEmbedded} embedded (${allChunks === allEmbedded ? 'ALL embedded ✓' : 'SOME MISSING ⚠'})\n`);

  // 2. duplicate characterization
  console.log('── Duplicate characterization ─────────────────────────────────');
  const byTitle = new Map();
  for (const d of docs) {
    const key = d.clean_title ?? '(untitled)';
    if (!byTitle.has(key)) byTitle.set(key, []);
    byTitle.get(key).push(d);
  }
  for (const [title, group] of byTitle) {
    console.log(`  "${title}"  ×${group.length}`);
    for (const d of group) {
      const sameFile = group.filter(g => g.filename === d.filename).length;
      console.log(`     id=${d.id.slice(0,8)}… file="${d.filename}" pages=${d.page_count} created=${d.created_at?.slice(0,19)}`);
    }
  }
  const uniqueTitles = byTitle.size;
  console.log(`  → ${docs.length} document rows = ${uniqueTitles} unique title(s), each uploaded ${docs.length / uniqueTitles}×\n`);

  // 3. match_chunks count vs query vector
  console.log('── match_chunks row count vs query vector (match_count=1000) ───');
  const zero = new Array(1536).fill(0);
  console.log(`  zero vector      → ${await matchChunks(zero)} rows`);
  console.log(`  random vector A  → ${await matchChunks(randUnitVec())} rows`);
  console.log(`  random vector B  → ${await matchChunks(randUnitVec())} rows`);
  console.log(`  random vector C  → ${await matchChunks(randUnitVec())} rows`);
  console.log(`\n  (Total eligible chunks under this subject: ${allChunks}.`);
  console.log(`   If these counts are far below ${allChunks}, the IVFFlat index is`);
  console.log(`   probing too few lists — a retrieval-tuning issue, not missing data.)\n`);

  console.log('══════════════════════════════════════════════════════════════\n');
}
main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
