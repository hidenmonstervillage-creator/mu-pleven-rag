/**
 * scripts/audit-fix-retry-netter.mjs
 *
 * Retries the single PATCH that hit statement_timeout (57014) in audit-fix-apply.mjs:
 * 2002 Netter's Anatomy Flash Cards, Физиология → Анатомия и хистология.
 *
 * The suspected cause is index maintenance, not row volume: the document has only 277
 * chunks, but Анатомия и хистология is the subject carrying the partial HNSW index
 * chunks_hnsw_anatomiya, so the cascade has to insert 277 vectors into an HNSW graph
 * inside one statement. Moving OUT of that subject (the 76-chunk Биохимия move) was
 * cheap and succeeded.
 *
 * Same guarantees as the parent script: re-validate against lib/faculties.ts before the
 * write, verify after, never touch chunks directly. Updates audit-fix-receipt.json.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RECEIPT = resolve(__dirname, 'audit-fix-receipt.json');

const c = readFileSync(resolve(ROOT, '.env.local'), 'utf8'); const E = {};
for (const raw of c.split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('='); if (i < 0) continue;
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  E[l.slice(0, i).trim()] = v;
}
const SUPA = E.NEXT_PUBLIC_SUPABASE_URL, KEY = E.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties'); mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;
const isValidTriple = (f, s, subj) => {
  const F = FACULTIES.find((x) => x.id === f); if (!F) return false;
  const S = F.specialties.find((x) => x.id === s); return !!S && S.subjects.includes(subj);
};

const ID = '408b96a0-570f-4305-8333-462675370520';
const TARGET = { faculty_id: 'medicina', specialty_id: 'medicina', subject: 'Анатомия и хистология' };

if (!isValidTriple(TARGET.faculty_id, TARGET.specialty_id, TARGET.subject)) {
  console.error('ABORT — target triple failed validation, nothing written.'); process.exit(1);
}

const cur = (await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${ID}&select=id,clean_title,faculty_id,specialty_id,subject`, { headers: H })).json())[0];
if (!cur) { console.error('ABORT — document not found.'); process.exit(1); }
console.log(`before: ${cur.faculty_id}/${cur.specialty_id}/${cur.subject}   "${cur.clean_title}"`);
if (cur.subject === TARGET.subject) { console.log('already at target — nothing to do.'); process.exit(0); }
if (cur.subject !== 'Физиология') { console.error(`ABORT — expected subject "Физиология", found "${cur.subject}".`); process.exit(1); }

const ATTEMPTS = 4;
let ok = false, lastErr = null;
for (let i = 1; i <= ATTEMPTS; i++) {
  const t0 = Date.now();
  const res = await fetch(`${SUPA}/rest/v1/documents?id=eq.${ID}`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(TARGET),
  });
  const body = await res.json();
  const ms = Date.now() - t0;
  if (res.ok) { console.log(`attempt ${i}: OK in ${ms}ms`); ok = true; break; }
  lastErr = { status: res.status, body: JSON.stringify(body).slice(0, 200), ms };
  console.log(`attempt ${i}: HTTP ${res.status} after ${ms}ms — ${lastErr.body}`);
  if (String(body?.code) !== '57014') break;            // only retry the timeout
  await new Promise((r) => setTimeout(r, 2000));
}

// ── verify ───────────────────────────────────────────────────────────────────
const after = (await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${ID}&select=id,clean_title,faculty_id,specialty_id,subject`, { headers: H })).json())[0];
const count = async (q) => {
  const r = await fetch(`${SUPA}/rest/v1/chunks?${q}&select=id&limit=1`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
};
const mine = await count(`document_id=eq.${ID}`);
const mineAtTarget = await count(`document_id=eq.${ID}&subject=eq.${encodeURIComponent(TARGET.subject)}`);
const anat = await count(`subject=eq.${encodeURIComponent('Анатомия и хистология')}`);
const fiz = await count(`subject=eq.${encodeURIComponent('Физиология')}`);
const nulls = await count('or=(faculty_id.is.null,subject.is.null)');

console.log(`\nafter : ${after.faculty_id}/${after.specialty_id}/${after.subject}`);
console.log(`  document chunks: ${mine}   of which at "${TARGET.subject}": ${mineAtTarget}   ${mine === mineAtTarget ? '✓ cascade complete' : '✗ INCONSISTENT'}`);
console.log(`  Анатомия и хистология: ${anat}    Физиология: ${fiz}`);
console.log(`  chunks with null faculty_id or subject: ${nulls}`);

const receipt = JSON.parse(readFileSync(RECEIPT, 'utf8'));
receipt.retry = {
  ranAt: new Date().toISOString(), documentId: ID, target: TARGET,
  succeeded: ok, lastError: ok ? null : lastErr,
  verification: { documentTriple: `${after.faculty_id}/${after.specialty_id}/${after.subject}`,
    documentChunks: mine, chunksAtTarget: mineAtTarget, cascadeConsistent: mine === mineAtTarget,
    anatomiyaChunks: anat, fiziologiyaChunks: fiz, chunksWithNullFacultyOrSubject: nulls },
};
if (ok) { receipt.applied += 1; receipt.failures = []; receipt.perTarget[`${TARGET.faculty_id}/${TARGET.specialty_id}/${TARGET.subject}`] = 1; }
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1), 'utf8');
console.log(`\nreceipt updated → ${RECEIPT}`);
process.exit(ok ? 0 : 1);
