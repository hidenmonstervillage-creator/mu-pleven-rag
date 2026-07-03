/**
 * scripts/verify-retrieval.mjs  — READ-ONLY
 *
 * Runs the app's real retrieval path (OpenAI text-embedding-3-small → match_chunks)
 * for a fixed set of test queries at match_count=8 (the app's real value) and
 * reports rows returned + top similarity scores + unique-vs-duplicate hits.
 *
 * Use it to capture BEFORE (ivfflat) and AFTER (hnsw) numbers around the index
 * migration. No DB writes.
 *
 * Usage: node scripts/verify-retrieval.mjs
 */
import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import OpenAI              from 'openai';

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
const ENV = parseEnvFile(resolve(ROOT, '.env.local'));
const U = ENV.NEXT_PUBLIC_SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

// The 4 diagnostic queries (3 cytology + 1 anatomy cross-subject check)
const QUERIES = [
  { subject: 'Цитология',              q: 'структура на клетъчната мембрана' },
  { subject: 'Цитология',              q: 'етапите на митозата и клетъчното делене' }, // returned 0 before
  { subject: 'Цитология',              q: 'хистологичен строеж на епителната тъкан' },
  { subject: 'Анатомия и хистология',  q: 'ход на външната сънна артерия' },           // cross-subject
  { subject: 'Анатомия и хистология',  q: 'строеж на сърцето и камерите' },            // timed out under 0014
  { subject: 'Анатомия и хистология',  q: 'мускули на предмишницата' },
  { subject: 'Анатомия и хистология',  q: 'черепно-мозъчни нерви' },
];

async function match(vec, subject, n = 8) {
  const r = await fetch(`${U}/rest/v1/rpc/match_chunks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: K, Authorization: `Bearer ${K}` },
    body: JSON.stringify({
      query_embedding: vec, match_faculty: 'medicina', match_specialty: 'medicina',
      match_subject: subject, match_count: n,
    }),
  });
  const data = await r.json();
  if (!Array.isArray(data)) {
    // Surface RPC errors instead of masking them as "0 rows".
    throw new Error(`match_chunks HTTP ${r.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

// Count eligible chunks for a subject (chunks whose document has this subject).
async function eligibleChunks(subject) {
  const dr = await fetch(
    `${U}/rest/v1/documents?select=id&faculty_id=eq.medicina&specialty_id=eq.medicina&subject=eq.${encodeURIComponent(subject)}`,
    { headers: { apikey: K, Authorization: `Bearer ${K}` } },
  );
  const docs = await dr.json();
  const ids = (Array.isArray(docs) ? docs : []).map(d => d.id);
  if (ids.length === 0) return 0;
  const cr = await fetch(
    `${U}/rest/v1/chunks?select=id&document_id=in.(${ids.join(',')})`,
    { headers: { apikey: K, Authorization: `Bearer ${K}`, Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } },
  );
  return Number(cr.headers.get('content-range')?.split('/')?.[1] ?? 0);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  Retrieval verification — match_count=8, real query embeddings');
  console.log('  medicina/medicina · ' + new Date().toISOString());
  console.log('══════════════════════════════════════════════════════════════');

  // eligible chunk totals per subject (recall denominator)
  const subjects = [...new Set(QUERIES.map(x => x.subject))];
  const eligible = {};
  for (const s of subjects) eligible[s] = await eligibleChunks(s);

  // ── Stability test: mitosis query 3× (returned 0 last turn) ───────────────
  console.log('\n── STABILITY TEST: "митоза и клетъчното делене" ×3 ─────────────');
  for (let run = 1; run <= 3; run++) {
    const emb = await openai.embeddings.create({ model: 'text-embedding-3-small', input: 'етапите на митозата и клетъчното делене' });
    const rows = await match(emb.data[0].embedding, 'Цитология', 8);
    const sims = rows.map(r => r.similarity ?? 0);
    console.log(`   run ${run}: ${rows.length}/8 rows   ${rows.length > 0 ? '✓' : '✗ EMPTY'}   top sim ${sims[0]?.toFixed(3) ?? '—'}`);
  }

  for (const { subject, q } of QUERIES) {
    const emb = await openai.embeddings.create({ model: 'text-embedding-3-small', input: q });
    const vec = emb.data[0].embedding;

    // ── Primary: the app's real path (count=8). Must succeed & be fast. ──
    const t0 = Date.now();
    const rows = await match(vec, subject, 8);
    const ms8 = Date.now() - t0;
    const sims = rows.map(r => r.similarity ?? 0);
    const topSims = sims.slice(0, 8).map(s => s.toFixed(3)).join(', ');
    const uniqueContent = new Set(rows.map(r => (r.content ?? '').slice(0, 120))).size;
    const pass = rows.length > 0;

    // ── Diagnostic: reachability probe (best-effort; iterative_scan can be slow) ──
    let recallStr;
    try {
      const t1 = Date.now();
      const recall = await match(vec, subject, 1000);
      const msR = Date.now() - t1;
      recallStr = `${recall.length} rows reachable of ${eligible[subject]} eligible (${msR}ms)`;
    } catch (e) {
      recallStr = /57014|timeout/.test(e.message)
        ? `timed out gathering 1000 rows (iterative_scan cost — not a production path; app uses count=8)`
        : `error: ${e.message}`;
    }

    console.log(`\n[${subject}]  "${q}"`);
    console.log(`   @count=8:    ${rows.length}/8 rows   ${pass ? '✓' : '✗ EMPTY'}   (${ms8}ms)`);
    if (rows.length) {
      console.log(`   top similarity: ${sims[0].toFixed(3)}   range: ${sims[sims.length-1].toFixed(3)}–${sims[0].toFixed(3)}`);
      console.log(`   all sims: [${topSims}]`);
      console.log(`   unique chunks (dedup by text): ${uniqueContent}/${rows.length}`);
    }
    console.log(`   @count=1000: ${recallStr}`);
  }
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  PASS/FAIL: mitosis query MUST return >0 rows after the fix.');
  console.log('══════════════════════════════════════════════════════════════\n');
}
main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
