/**
 * scripts/audit-fix-2-apply.mjs — second wave of the 2026-08-01 audit fixes.
 *
 * Same shape as audit-fix-apply.mjs: --dry first, revalidate every triple against
 * lib/faculties.ts immediately before the write, abort the ENTIRE run if any row fails,
 * write a receipt. Writes ONLY to documents — 0018's trg_documents_cascade_taxonomy
 * propagates to chunks.
 *
 * New here: a retry wrapper. The first wave hit 57014 (statement timeout) moving 277
 * chunks INTO Анатомия и хистология, the subject carrying the partial HNSW index —
 * HNSW insert cost, not row volume. It succeeded on retry. Both rows below also move
 * INTO indexed-or-large subjects, so each PATCH gets up to 3 attempts with backoff and
 * the receipt records whether a retry was needed.
 *
 * ROW 1  2022_Obshta_veterinarno_medicinska_patologiya
 *        medicina/medicina/Патоанатомия и цитопатология → fvm/veterinarna/Ветеринарна патоанатомия
 *        (target name comes from the fvm rename applied in the same change set)
 *
 * ROW 2  1997_Narachnik_ambulatorna_hirurgiya
 *        medicina/medicina/Неврохирургия → medicina/medicina/Обща и оперативна хирургия
 *        The konspekt does NOT contain this book: an inverse lookup of its own title
 *        ("Наръчник по амбулаторна хирургия", 1997) against the 527 konspekt titles
 *        scores NONE 0.332, below the 0.45 MEDIUM floor, and "амбулатор" appears in no
 *        konspekt title at all. The old Неврохирургия filing came from the konspekt entry
 *        "Хирургия" (1996) — a one-word title that matched the FOLDER at HIGH 0.841 with a
 *        margin of 0.002. So the fallback in the decision rule applies.
 *
 * Receipt: scripts/audit-fix-2-receipt.json     Dry run: --dry
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RECEIPT = resolve(__dirname, 'audit-fix-2-receipt.json');
const DRY = process.argv.includes('--dry');

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
const log = (s) => console.log(`[audit-fix-2] ${s}`);

let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties'); mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;
const isValidTriple = (f, s, subj) => {
  const F = FACULTIES.find((x) => x.id === f); if (!F) return false;
  const S = F.specialties.find((x) => x.id === s); return !!S && S.subjects.includes(subj);
};

const ROWS = [
  { id: '9af7a9fa-562c-412d-86b9-eda0e394d18d', label: '2022_Obshta_veterinarno_medicinska_patologiya',
    expect: { f: 'medicina', s: 'medicina', subj: 'Патоанатомия и цитопатология' },
    to: { f: 'fvm', s: 'veterinarna', subj: 'Ветеринарна патоанатомия' },
    rule: 'STEP2 veterinary text → fvm, using the renamed subject' },
  { id: '8d17215b-2b01-4a72-941b-b4fe5430e7cd', label: '1997_Narachnik_ambulatorna_hirurgiya',
    expect: { f: 'medicina', s: 'medicina', subj: 'Неврохирургия' },
    to: { f: 'medicina', s: 'medicina', subj: 'Обща и оперативна хирургия' },
    rule: 'STEP3 fallback — konspekt has no entry for this book (inverse lookup NONE 0.332)' },
];

const count = async (q) => {
  const r = await fetch(`${SUPA}/rest/v1/chunks?${q}&select=id&limit=1`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
};
const docCount = async (q) => {
  const r = await fetch(`${SUPA}/rest/v1/documents?${q}&select=id&limit=1`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
};

// ── preflight ────────────────────────────────────────────────────────────────
const apply = [], held = [];
for (const r of ROWS) {
  const d = (await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${r.id}&select=id,clean_title,faculty_id,specialty_id,subject,page_count`, { headers: H })).json())[0];
  if (!d) { held.push({ ...r, reason: 'no documents row' }); continue; }
  const cur = `${d.faculty_id}/${d.specialty_id}/${d.subject}`;
  if (d.faculty_id !== r.expect.f || d.specialty_id !== r.expect.s || d.subject !== r.expect.subj) {
    held.push({ ...r, current: cur, reason: `current triple "${cur}" ≠ expected "${r.expect.f}/${r.expect.s}/${r.expect.subj}" — state changed since the audit` });
    continue;
  }
  if (!isValidTriple(r.to.f, r.to.s, r.to.subj)) {
    const subs = FACULTIES.find((f) => f.id === r.to.f)?.specialties.find((s) => s.id === r.to.s)?.subjects || [];
    held.push({ ...r, current: cur, reason: `"${r.to.subj}" is NOT an exact subject of ${r.to.f}/${r.to.s}`, available: subs });
    continue;
  }
  apply.push({ ...r, doc: d, before: cur, chunks: await count(`document_id=eq.${r.id}`) });
}

const invalid = apply.filter((a) => !isValidTriple(a.to.f, a.to.s, a.to.subj));
if (invalid.length) {
  console.error(`[audit-fix-2] ABORT — ${invalid.length} row(s) failed final re-validation, NOTHING applied.`);
  invalid.forEach((a) => console.error(`   ${a.label} → ${a.to.f}/${a.to.s}/${a.to.subj}`));
  process.exit(1);
}
log(`apply: ${apply.length}   held: ${held.length}   (all apply rows re-validated ✓)`);

const TRACK = ['Патоанатомия и цитопатология', 'Ветеринарна патоанатомия', 'Неврохирургия', 'Обща и оперативна хирургия'];
const before = {}; for (const s of TRACK) before[s] = await count(`subject=eq.${encodeURIComponent(s)}`);
const unsortedDocsBefore = await docCount('faculty_id=eq.UNSORTED');
log(`chunks before: ${TRACK.map((s) => `${s}=${before[s]}`).join('  ')}`);
log(`documents with faculty_id='UNSORTED' before: ${unsortedDocsBefore}`);

if (DRY) {
  console.log('\n--dry: stopping before any write.');
  apply.forEach((a) => console.log(`   WOULD SET ${a.label}  (${a.chunks} chunks)\n        ${a.before}\n     →  ${a.to.f}/${a.to.s}/${a.to.subj}`));
  held.forEach((h) => console.log(`   HELD ${h.label} — ${h.reason}`));
  process.exit(0);
}

// ── apply, with retry on 57014 ───────────────────────────────────────────────
const results = [];
for (const a of apply) {
  if (!isValidTriple(a.to.f, a.to.s, a.to.subj)) { results.push({ label: a.label, ok: false, attempts: 0, error: 'failed per-row validation' }); continue; }
  let ok = false, attempts = 0, lastErr = null, ms = 0;
  for (attempts = 1; attempts <= 3; attempts++) {
    const t0 = Date.now();
    const res = await fetch(`${SUPA}/rest/v1/documents?id=eq.${a.id}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ faculty_id: a.to.f, specialty_id: a.to.s, subject: a.to.subj }),
    });
    const body = await res.json(); ms = Date.now() - t0;
    if (res.ok) { ok = true; log(`  ${a.label} → ${a.to.f}/${a.to.s}/${a.to.subj}  (attempt ${attempts}, ${ms}ms)`); break; }
    lastErr = { status: res.status, code: body?.code, message: String(body?.message).slice(0, 160), ms };
    log(`  ${a.label} attempt ${attempts} FAILED ${res.status} ${body?.code} after ${ms}ms`);
    if (String(body?.code) !== '57014') break;                 // retry only the timeout
    await new Promise((r) => setTimeout(r, 1500 * attempts));
  }
  results.push({ label: a.label, documentId: a.id, ok, attempts, retried: ok && attempts > 1, ms, error: ok ? null : lastErr });
}

// ── verify ───────────────────────────────────────────────────────────────────
const after = {}; for (const s of TRACK) after[s] = await count(`subject=eq.${encodeURIComponent(s)}`);
const unsortedDocsAfter = await docCount('faculty_id=eq.UNSORTED');
const recheck = [];
for (const a of apply) {
  const d = (await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${a.id}&select=id,clean_title,faculty_id,specialty_id,subject,page_count`, { headers: H })).json())[0];
  const now = `${d.faculty_id}/${d.specialty_id}/${d.subject}`;
  const cascaded = await count(`document_id=eq.${a.id}&faculty_id=eq.${encodeURIComponent(d.faculty_id)}&subject=eq.${encodeURIComponent(d.subject)}`);
  const total = await count(`document_id=eq.${a.id}`);
  recheck.push({ label: a.label, title: d.clean_title, pages: d.page_count, before: a.before, now,
    expected: `${a.to.f}/${a.to.s}/${a.to.subj}`, ok: now === `${a.to.f}/${a.to.s}/${a.to.subj}`,
    chunks: total, chunksCascaded: cascaded, cascadeConsistent: total === cascaded });
}
const nullChunks = await count('or=(faculty_id.is.null,subject.is.null)');
const balneo = (await (await fetch(`${SUPA}/rest/v1/documents?id=eq.03bebc97-4746-4858-88fc-0ae6ca438ec4&select=id,clean_title,faculty_id,specialty_id,subject`, { headers: H })).json())[0];

const receipt = {
  ranAt: new Date().toISOString(),
  taxonomyChange: 'lib/faculties.ts fvm/veterinarna: 8 of 15 subjects prefixed "Ветеринарна" (code-only; fvm had 0 documents and 0 chunks)',
  applied: results.filter((r) => r.ok).length, attempted: apply.length, heldBack: held.length,
  results, heldBackDetail: held,
  chunkCounts: Object.fromEntries(TRACK.map((s) => [s, { before: before[s], after: after[s], delta: after[s] - before[s] }])),
  unsortedDocuments: { before: unsortedDocsBefore, after: unsortedDocsAfter },
  verification: { recheck, chunksWithNullFacultyOrSubject: nullChunks,
    step4_balneologiya: { triple: `${balneo.faculty_id}/${balneo.specialty_id}/${balneo.subject}`, untouched: balneo.faculty_id === 'UNSORTED' } },
};
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1), 'utf8');

console.log('\n=== AUDIT FIX 2 ===');
console.log(`applied: ${receipt.applied} / ${apply.length}   held: ${held.length}   retries needed: ${results.filter((r) => r.retried).length}`);
console.log('\nre-selected:');
recheck.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${(r.title || r.label).slice(0, 52).padEnd(54)} ${r.pages}pp\n        ${r.before}\n     →  ${r.now}\n        chunks ${r.chunks}, cascaded ${r.chunksCascaded} ${r.cascadeConsistent ? '✓' : '✗ MISMATCH'}`));
console.log('\nchunk counts:');
TRACK.forEach((s) => console.log(`  ${s.padEnd(32)} ${String(before[s]).padStart(6)} → ${String(after[s]).padStart(6)}   ${after[s] - before[s] >= 0 ? '+' : ''}${after[s] - before[s]}`));
console.log(`\nchunks with null faculty_id or subject: ${nullChunks}`);
console.log(`documents faculty_id='UNSORTED': ${unsortedDocsBefore} → ${unsortedDocsAfter}`);
console.log(`STEP 4 — 2017_Balneologiya: ${receipt.verification.step4_balneologiya.triple}  ${receipt.verification.step4_balneologiya.untouched ? '(untouched ✓)' : '(*** CHANGED ***)'}`);
if (held.length) { console.log('\nheld back:'); held.forEach((h) => console.log(`  • ${h.label} — ${h.reason}`)); }
console.log(`\nreceipt → ${RECEIPT}`);
