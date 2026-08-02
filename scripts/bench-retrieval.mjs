/**
 * scripts/bench-retrieval.mjs — READ-ONLY retrieval benchmark. No writes.
 *
 * Run BEFORE migration 0018 and AFTER it, and diff the two runs, so we prove the
 * fix worked instead of assuming it.
 *
 *   node scripts/bench-retrieval.mjs --label before
 *   # ...apply 0018 in the SQL Editor...
 *   node scripts/bench-retrieval.mjs --label after
 *   node scripts/bench-retrieval.mjs --compare before after
 *
 * Measures, per subject:
 *   • cold-proxy  — first call after that subject has been untouched for the run
 *                   (we rotate subjects and use distinct query vectors so neither
 *                    Postgres' buffer cache nor a plan cache is primed for it)
 *   • warm p50/p95 — repeated calls with varied vectors
 *   • rows returned + top similarity, so a "fast" result that silently returns
 *     nothing is caught rather than celebrated
 *
 * NOTE on cold measurement: we cannot flush the Postgres buffer cache from here
 * (that needs SQL/superuser). "cold-proxy" is therefore a lower bound on true cold
 * cost — it captures first-touch-this-run, not first-touch-since-restart. Compare
 * cold-proxy before vs after; do not read it as absolute worst case.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTDIR = resolve(__dirname, 'bench');

const args = process.argv.slice(2);
const argOf = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const LABEL = argOf('--label');
const COMPARE = args.includes('--compare') ? args.slice(args.indexOf('--compare') + 1, args.indexOf('--compare') + 3) : null;
const WARM_RUNS = parseInt(argOf('--runs') || '5', 10);

function env() {
  const c = readFileSync(resolve(ROOT, '.env.local'), 'utf8'); const E = {};
  for (const raw of c.split('\n')) {
    const l = raw.trim(); if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('='); if (i < 0) continue;
    let v = l.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    E[l.slice(0, i).trim()] = v;
  }
  return E;
}
const E = env();
const SUPA = E.NEXT_PUBLIC_SUPABASE_URL, KEY = E.SUPABASE_SERVICE_ROLE_KEY, OPENAI = E.OPENAI_API_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

// The four subjects measured in the original 0018 diagnosis, smallest → largest.
const CORE_SUBJECTS = [
  { faculty: 'medicina', specialty: 'medicina', subject: 'Микробиология' },
  { faculty: 'medicina', specialty: 'medicina', subject: 'Физиология' },
  { faculty: 'medicina', specialty: 'medicina', subject: 'Анатомия и хистология' },
  { faculty: 'medicina', specialty: 'medicina', subject: 'Химия' },
];
// --all: benchmark EVERY triple that currently holds documents, discovered from the DB,
// so newly-populated subjects (foz / fvm / farmacia) are covered instead of assumed.
let SUBJECTS = CORE_SUBJECTS;
// Distinct probe texts so repeated calls are not identical queries.
const PROBES = [
  'клетъчна структура и функция', 'механизъм на действие и регулация',
  'лабораторен метод и оцветяване', 'патологични промени в тъканите',
  'обмяна на веществата и ензими', 'диагностика и клинично значение',
];

// ── compare mode ──────────────────────────────────────────────────────────────
if (COMPARE) {
  const [a, b] = COMPARE;
  const A = JSON.parse(readFileSync(resolve(OUTDIR, `${a}.json`), 'utf8'));
  const B = JSON.parse(readFileSync(resolve(OUTDIR, `${b}.json`), 'utf8'));
  const byS = (r) => Object.fromEntries(r.results.map((x) => [x.subject, x]));
  const ra = byS(A), rb = byS(B);
  console.log(`\ncomparing "${a}" → "${b}"\n`);
  console.log('subject                     chunks   cold(ms)         p50(ms)          p95(ms)        rows');
  for (const s of Object.keys(ra)) {
    const x = ra[s], y = rb[s]; if (!y) continue;
    const d = (u, v) => `${String(u).padStart(5)}→${String(v).padStart(5)} ${v <= u ? `(-${(100 * (u - v) / (u || 1)).toFixed(0)}%)` : `(+${(100 * (v - u) / (u || 1)).toFixed(0)}%)`}`;
    console.log(`${s.padEnd(26)} ${String(x.chunks).padStart(6)}  ${d(x.cold, y.cold)}  ${d(x.p50, y.p50)}  ${d(x.p95, y.p95)}  ${x.rows}→${y.rows}`);
  }
  const errA = A.results.filter((r) => r.errors).length, errB = B.results.filter((r) => r.errors).length;
  console.log(`\nsubjects with errors: ${a}=${errA}  ${b}=${errB}`);
  process.exit(0);
}

if (!LABEL) { console.error('usage: --label <before|after>   or   --compare <a> <b>'); process.exit(1); }

// ── embed probes once ─────────────────────────────────────────────────────────
async function embed(text) {
  const r = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST', headers: { Authorization: `Bearer ${OPENAI}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
  });
  const j = await r.json();
  if (!j.data) throw new Error(`embedding failed: ${JSON.stringify(j).slice(0, 200)}`);
  return j.data[0].embedding;
}
// ── --all: discover every populated (faculty, specialty, subject) from the DB ──
if (args.includes('--all')) {
  const docs = [];
  for (let off = 0; ; off += 1000) {
    const b = await (await fetch(
      `${SUPA}/rest/v1/documents?select=faculty_id,specialty_id,subject&order=id&offset=${off}&limit=1000`,
      { headers: H })).json();
    if (!Array.isArray(b)) throw new Error(`documents fetch failed: ${JSON.stringify(b).slice(0, 200)}`);
    docs.push(...b); if (b.length < 1000) break;
  }
  const seen = new Map();
  for (const d of docs) {
    if (!d.faculty_id || d.faculty_id === 'UNSORTED') continue;   // placeholder is unreachable by design
    const k = `${d.faculty_id}|${d.specialty_id}|${d.subject}`;
    if (!seen.has(k)) seen.set(k, { faculty: d.faculty_id, specialty: d.specialty_id, subject: d.subject });
  }
  SUBJECTS = Array.from(seen.values());
  console.error(`--all: discovered ${SUBJECTS.length} populated subjects from ${docs.length} documents`);
}

console.error('embedding probes...');
const vecs = [];
for (const p of PROBES) vecs.push(await embed(p));

async function chunkCount(s) {
  const docs = await (await fetch(
    `${SUPA}/rest/v1/documents?faculty_id=eq.${s.faculty}&specialty_id=eq.${s.specialty}&subject=eq.${encodeURIComponent(s.subject)}&select=id`,
    { headers: H })).json();
  if (!docs.length) return 0;
  const r = await fetch(`${SUPA}/rest/v1/chunks?document_id=in.(${docs.map((d) => d.id).join(',')})&select=id&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
}

async function call(s, vec) {
  const t0 = Date.now();
  const r = await fetch(`${SUPA}/rest/v1/rpc/match_chunks`, {
    method: 'POST', headers: H,
    body: JSON.stringify({
      query_embedding: vec, match_faculty: s.faculty, match_specialty: s.specialty,
      match_subject: s.subject, match_count: 8,
    }),
  });
  const ms = Date.now() - t0;
  const body = await r.json();
  return {
    ms, ok: r.ok && Array.isArray(body),
    rows: Array.isArray(body) ? body.length : 0,
    topSim: Array.isArray(body) && body[0] ? Number(body[0].similarity).toFixed(3) : null,
    error: r.ok ? null : JSON.stringify(body).slice(0, 160),
  };
}

// ── measure ───────────────────────────────────────────────────────────────────
const results = [];
// PASS 1 — cold proxy: touch each subject once, rotating, before any repeats.
console.error('pass 1: cold-proxy...');
const cold = {};
for (let i = 0; i < SUBJECTS.length; i++) {
  const s = SUBJECTS[i];
  cold[s.subject] = await call(s, vecs[i % vecs.length]);
}
// PASS 2 — warm: repeated calls with varied vectors.
console.error(`pass 2: warm x${WARM_RUNS}...`);
for (const s of SUBJECTS) {
  const chunks = await chunkCount(s);
  const times = []; let rows = 0, top = null, errors = null;
  for (let i = 0; i < WARM_RUNS; i++) {
    const r = await call(s, vecs[(i + 2) % vecs.length]);
    if (!r.ok) { errors = r.error; continue; }
    times.push(r.ms); rows = r.rows; top = r.topSim;
  }
  times.sort((a, b) => a - b);
  const p = (q) => times.length ? times[Math.min(times.length - 1, Math.floor(q * times.length))] : null;
  results.push({
    subject: s.subject, faculty: s.faculty, specialty: s.specialty, chunks,
    cold: cold[s.subject].ms, coldOk: cold[s.subject].ok, coldError: cold[s.subject].error,
    p50: p(0.5), p95: p(0.95), min: times[0] ?? null, max: times[times.length - 1] ?? null,
    msPer1kChunks: chunks && p(0.5) ? +(p(0.5) / (chunks / 1000)).toFixed(1) : null,
    rows, topSim: top, errors,
  });
}

const SLOW_MS = 1500;   // partial-HNSW candidate threshold
results.sort((a, b) => (b.p50 ?? 0) - (a.p50 ?? 0));   // slowest first
console.log(`\n=== retrieval benchmark [${LABEL}] — ${new Date().toISOString()} ===`);
console.log('subject                                   chunks    cold     p50     p95   ms/1k  rows  topSim  flag');
for (const r of results) {
  const slow = (r.p50 ?? 0) > SLOW_MS || (r.p95 ?? 0) > SLOW_MS;
  console.log(
    `${(r.faculty ? `${r.faculty}/${r.subject}` : r.subject).slice(0, 40).padEnd(41)} ${String(r.chunks).padStart(6)} ${String(r.cold).padStart(7)} ` +
    `${String(r.p50 ?? '-').padStart(7)} ${String(r.p95 ?? '-').padStart(7)} ${String(r.msPer1kChunks ?? '-').padStart(6)} ` +
    `${String(r.rows).padStart(5)}  ${String(r.topSim ?? '-').padEnd(6)} ${slow ? '<< HNSW candidate' : ''}` +
    (r.errors ? `  ERROR: ${r.errors}` : ''));
}
const slowOnes = results.filter((r) => (r.p50 ?? 0) > SLOW_MS || (r.p95 ?? 0) > SLOW_MS);
console.log(`\npartial-HNSW candidates (p50 or p95 > ${SLOW_MS}ms): ${slowOnes.length}`);
slowOnes.forEach((r) => console.log(`  ${r.subject} — ${r.chunks} chunks, p50 ${r.p50}ms, p95 ${r.p95}ms, cold ${r.cold}ms`));
const bad = results.filter((r) => r.errors || !r.coldOk || r.rows === 0);
if (bad.length) {
  console.log('\n⚠ problems:');
  bad.forEach((r) => console.log(`  ${r.subject}: rows=${r.rows} coldOk=${r.coldOk} ${r.errors || r.coldError || ''}`));
} else {
  console.log('\nall subjects returned rows, no errors.');
}

if (!existsSync(OUTDIR)) mkdirSync(OUTDIR, { recursive: true });
writeFileSync(resolve(OUTDIR, `${LABEL}.json`),
  JSON.stringify({ label: LABEL, at: new Date().toISOString(), warmRuns: WARM_RUNS, results }, null, 1), 'utf8');
console.log(`\nsaved → scripts/bench/${LABEL}.json`);
