/**
 * scripts/konspekt-remap-apply.mjs — APPLIES the approved konspekt remap.
 *
 * Writes ONLY to `documents` (faculty_id, specialty_id, subject) by primary key.
 * NEVER touches `chunks`.
 *
 * Approved scope:
 *   • VALIDATED (102) + AMBIGUOUS (6, specialty confirmed as fzg/sestra)
 *   • NO_METADATA rows whose konspekt-match suggestion is HIGH confidence (5)
 *   • MEDIUM suggestions are deliberately SKIPPED (left UNSORTED for a later pass)
 *
 * Every triple is re-validated against lib/faculties.ts immediately before the write.
 * Updates are grouped by target triple so each PATCH is one id=in.(...) batch.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const DRY = process.argv.includes('--dry');

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
const SUPA = E.NEXT_PUBLIC_SUPABASE_URL, KEY = E.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── taxonomy (belt & braces re-validation source) ──────────────────────────────
let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties');
mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;
const isValidTriple = (fid, sid, subj) => {
  const f = FACULTIES.find((x) => x.id === fid); if (!f) return false;
  const s = f.specialties.find((x) => x.id === sid); return !!s && s.subjects.includes(subj);
};

// ── build the approved work list ───────────────────────────────────────────────
const plan = JSON.parse(readFileSync(resolve(__dirname, 'konspekt-remap-plan.json'), 'utf8')).plan;
const work = [];
for (const p of plan) {
  if (p.status === 'VALIDATED' || p.status === 'AMBIGUOUS') {
    work.push({ id: p.documentId, folder: p.folder, ...p.proposed, origin: p.status });
  } else if (p.status === 'NO_METADATA' && p.suggestion?.wouldValidate && p.suggestion.matchClass === 'HIGH') {
    work.push({ id: p.documentId, folder: p.folder, ...p.suggestion.wouldPropose, origin: 'HIGH_SUGGESTION' });
  }
}

// ── re-validate EVERY triple before writing anything ───────────────────────────
const invalid = work.filter((w) => !isValidTriple(w.faculty_id, w.specialty_id, w.subject));
if (invalid.length) {
  console.error(`ABORT — ${invalid.length} triple(s) failed re-validation:`);
  invalid.forEach((w) => console.error(`  ${w.folder} → ${w.faculty_id}/${w.specialty_id}/${w.subject}`));
  process.exit(1);
}
const originCounts = work.reduce((a, w) => { a[w.origin] = (a[w.origin] || 0) + 1; return a; }, {});
console.log(`work list: ${work.length} documents  ${JSON.stringify(originCounts)}`);
console.log('all triples re-validated against lib/faculties.ts ✓');

// ── BEFORE ─────────────────────────────────────────────────────────────────────
async function unsortedCount() {
  const r = await fetch(`${SUPA}/rest/v1/documents?faculty_id=eq.UNSORTED&select=id&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
}
const before = await unsortedCount();
console.log(`BEFORE: documents with faculty_id='UNSORTED' = ${before}`);
if (DRY) { console.log('--dry: stopping before any write.'); process.exit(0); }

// ── APPLY: one PATCH per distinct target triple (id=in.(...)) ──────────────────
const groups = new Map();
for (const w of work) {
  const k = `${w.faculty_id}\u0000${w.specialty_id}\u0000${w.subject}`;
  (groups.get(k) ?? groups.set(k, []).get(k)).push(w);
}
let updated = 0; const failures = []; const perTriple = {};
for (const [k, rows] of groups) {
  const [faculty_id, specialty_id, subject] = k.split('\u0000');
  // final per-batch guard
  if (!isValidTriple(faculty_id, specialty_id, subject)) { failures.push({ k, reason: 'failed final validation' }); continue; }
  const ids = rows.map((r) => r.id);
  const res = await fetch(`${SUPA}/rest/v1/documents?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ faculty_id, specialty_id, subject }),
  });
  const body = await res.json();
  if (!res.ok) { failures.push({ k, reason: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 160)}` }); continue; }
  const n = Array.isArray(body) ? body.length : 0;
  updated += n;
  perTriple[`${faculty_id}/${specialty_id}/${subject}`] = n;
  console.log(`  ${String(n).padStart(3)} → ${faculty_id}/${specialty_id}/${subject}`);
}

// ── AFTER ──────────────────────────────────────────────────────────────────────
const after = await unsortedCount();
console.log(`\nrows updated: ${updated} / ${work.length}`);
console.log(`AFTER: documents with faculty_id='UNSORTED' = ${after}  (before ${before}, expected ${before - work.length})`);
if (failures.length) { console.log('FAILURES:'); failures.forEach((f) => console.log('  ', f)); }

writeFileSync(resolve(__dirname, 'konspekt-remap-applied.json'),
  JSON.stringify({ appliedAt: new Date().toISOString(), updated, before, after, perTriple, failures, work }, null, 1), 'utf8');
console.log('receipt → scripts/konspekt-remap-applied.json');
console.log('chunks table: NOT touched.');
