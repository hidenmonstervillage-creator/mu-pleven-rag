/**
 * scripts/audit-fix-apply.mjs
 *
 * Applies the mis-filings found by the 2026-08-01 audit of konspekt-remap-plan.mjs.
 * Same shape as konspekt-remap-autoapply.mjs: every proposed triple is re-validated
 * against lib/faculties.ts immediately before the write, the ENTIRE run aborts if any
 * row fails, and a receipt is written.
 *
 * Writes ONLY to documents (faculty_id, specialty_id, subject) by primary key.
 * NEVER touches chunks — migration 0018's trg_documents_cascade_taxonomy cascades.
 *
 * GROUP 1  physiotherapy cluster, subject-only, faculty/specialty untouched.
 *          GATED: applied only where scale-checkpoint.json faculty_hint === 'medicina'.
 *          A hint naming any other faculty is HELD for a human decision.
 * GROUP 2  the remaining Audit-A mis-filings whose target subject exists verbatim
 *          under medicina/medicina.
 * GROUP 3  revert: back to the UNSORTED placeholder, subject = the folder name read
 *          from scale-checkpoint.json (never reconstructed from the title).
 *
 * Receipt: scripts/audit-fix-receipt.json     Dry run: --dry
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RECEIPT = resolve(__dirname, 'audit-fix-receipt.json');
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
const log = (s) => console.log(`[audit-fix] ${s}`);

// ── taxonomy ─────────────────────────────────────────────────────────────────
let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties');
mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;
const isValidTriple = (fid, sid, subj) => {
  const f = FACULTIES.find((x) => x.id === fid); if (!f) return false;
  const s = f.specialties.find((x) => x.id === sid); return !!s && s.subjects.includes(subj);
};

const ckpt = JSON.parse(readFileSync(resolve(__dirname, 'scale-checkpoint.json'), 'utf8')).completed;
const cpById = new Map(ckpt.filter((x) => x.documentId).map((x) => [x.documentId, x]));

const docs = [];
for (let off = 0; ; off += 1000) {
  const b = await (await fetch(`${SUPA}/rest/v1/documents?select=id,filename,clean_title,faculty_id,specialty_id,subject,page_count&order=id&offset=${off}&limit=1000`, { headers: H })).json();
  if (!Array.isArray(b)) { console.error('[audit-fix] ABORT — documents fetch failed:', JSON.stringify(b).slice(0, 300)); process.exit(1); }
  docs.push(...b); if (b.length < 1000) break;
}
const byId = new Map(docs.map((d) => [d.id, d]));

const PHYSIO = 'Физиотерапия и рехабилитация';
const apply = [], held = [];

// ── GROUP 1 — gated on checkpoint faculty_hint ───────────────────────────────
for (const id of [
  '9dc893d5-0c04-44b7-b06e-c1daa8a4f5f4',
  'bb4d15d5-c821-426e-962f-70d17af34d74',
  '301d027e-6b4f-4527-bda2-b6ab40b9a62b',
  '18c1e269-4e2d-42db-a1f0-5b7b63ea91c6',
  '03bebc97-4746-4858-88fc-0ae6ca438ec4',
]) {
  const d = byId.get(id), cp = cpById.get(id);
  const label = cp ? cp.folder : id;
  if (!d) { held.push({ id, label, group: 1, reason: 'no documents row' }); continue; }
  if (!cp) { held.push({ id, label, group: 1, reason: 'no scale-checkpoint row — cannot read faculty_hint, gate cannot pass' }); continue; }
  if (cp.faculty_hint !== 'medicina') {
    held.push({ id, label, group: 1, current: `${d.faculty_id}/${d.specialty_id}/${d.subject}`,
      reason: `GATE: faculty_hint='${cp.faculty_hint}' (konspekt_subject='${cp.konspekt_subject}') — konspekt indicates a faculty other than medicina; not covered by the approved decision` });
    continue;
  }
  // subject-only: keep the row's existing faculty/specialty
  apply.push({ id, label, group: 1, before: `${d.faculty_id}/${d.specialty_id}/${d.subject}`,
    faculty_id: d.faculty_id, specialty_id: d.specialty_id, subject: PHYSIO,
    rule: `GROUP1 subject-only (faculty_hint=medicina, ${d.faculty_id}/${d.specialty_id} unchanged)` });
}

// ── GROUP 2 ──────────────────────────────────────────────────────────────────
const G2 = [
  { id: 'f581837f-b7a2-445e-9b9e-e4b5e5b98bca', expect: 'Химия',                        to: { f: 'medicina', s: 'medicina', subj: 'Физика' } },
  { id: '3ac8d95c-d1e8-4fa4-8aba-72453710668b', expect: 'Анатомия и хистология',        to: { f: 'medicina', s: 'medicina', subj: 'Биохимия' } },
  { id: '408b96a0-570f-4305-8333-462675370520', expect: 'Физиология',                   to: { f: 'medicina', s: 'medicina', subj: 'Анатомия и хистология' } },
  { id: '9af7a9fa-562c-412d-86b9-eda0e394d18d', expect: 'Патоанатомия и цитопатология', to: null, why: 'veterinary target NOT decided by the user — fvm options reported instead' },
  { id: '8d17215b-2b01-4a72-941b-b4fe5430e7cd', expect: 'Неврохирургия',                to: { f: 'medicina', s: 'medicina', subj: 'Хирургия' } },
];
for (const g of G2) {
  const d = byId.get(g.id), cp = cpById.get(g.id);
  const label = cp ? cp.folder : g.id;
  if (!d) { held.push({ id: g.id, label, group: 2, reason: 'no documents row' }); continue; }
  const cur = `${d.faculty_id}/${d.specialty_id}/${d.subject}`;
  if (!g.to) { held.push({ id: g.id, label, group: 2, current: cur, reason: g.why }); continue; }
  if (d.subject !== g.expect) {
    held.push({ id: g.id, label, group: 2, current: cur, reason: `current subject "${d.subject}" ≠ audited value "${g.expect}" — state changed since the audit` });
    continue;
  }
  if (!isValidTriple(g.to.f, g.to.s, g.to.subj)) {
    const subs = FACULTIES.find((f) => f.id === g.to.f)?.specialties.find((s) => s.id === g.to.s)?.subjects || [];
    const near = subs.filter((s) => s.toLowerCase().includes(g.to.subj.toLowerCase().slice(0, 6)));
    held.push({ id: g.id, label, group: 2, current: cur, proposed: `${g.to.f}/${g.to.s}/${g.to.subj}`,
      reason: `"${g.to.subj}" is NOT an exact subject of ${g.to.f}/${g.to.s}`, candidates: near });
    continue;
  }
  apply.push({ id: g.id, label, group: 2, before: cur,
    faculty_id: g.to.f, specialty_id: g.to.s, subject: g.to.subj, rule: 'GROUP2 audited mis-filing' });
}

// ── GROUP 3 — revert to the UNSORTED placeholder ─────────────────────────────
{
  const id = '16361dde-ae6e-47e8-af88-04384bef2efb';
  const d = byId.get(id), cp = cpById.get(id);
  if (!d) held.push({ id, label: id, group: 3, reason: 'no documents row' });
  else if (!cp || !cp.folder) held.push({ id, label: id, group: 3, reason: 'no checkpoint folder name — refusing to construct one from the title' });
  else apply.push({ id, label: cp.folder, group: 3, before: `${d.faculty_id}/${d.specialty_id}/${d.subject}`,
    faculty_id: 'UNSORTED', specialty_id: 'UNSORTED', subject: cp.folder,
    rule: 'GROUP3 revert to placeholder (subject = checkpoint folder verbatim)' });
}

// ── final re-validation of EVERY row about to be written ─────────────────────
const invalid = apply.filter((a) => {
  if (a.group === 3) {                       // the placeholder is intentionally not a taxonomy triple
    const cp = cpById.get(a.id);
    return !(a.faculty_id === 'UNSORTED' && a.specialty_id === 'UNSORTED' && cp && a.subject === cp.folder);
  }
  return !isValidTriple(a.faculty_id, a.specialty_id, a.subject);
});
if (invalid.length) {
  console.error(`[audit-fix] ABORT — ${invalid.length} row(s) failed final re-validation, NOTHING applied:`);
  invalid.forEach((a) => console.error(`   ${a.label} → ${a.faculty_id}/${a.specialty_id}/${a.subject}`));
  process.exit(1);
}
log(`apply: ${apply.length}   held: ${held.length}   (all apply rows re-validated ✓)`);

// ── before-counts ────────────────────────────────────────────────────────────
const TRACK = ['Урология', PHYSIO, 'Химия', 'Физика', 'Анатомия и хистология', 'Биохимия', 'Физиология', 'Клинична токсикология', 'Неврохирургия', 'Патоанатомия и цитопатология'];
async function chunkCount(subject) {
  const r = await fetch(`${SUPA}/rest/v1/chunks?subject=eq.${encodeURIComponent(subject)}&select=id&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
}
const before = {};
for (const s of TRACK) before[s] = await chunkCount(s);
log('chunk counts before: ' + TRACK.map((s) => `${s}=${before[s]}`).join('  '));

if (DRY) {
  console.log('\n--dry: stopping before any write.');
  apply.forEach((a) => console.log(`   WOULD SET ${a.label}\n        ${a.before}  →  ${a.faculty_id}/${a.specialty_id}/${a.subject}`));
  held.forEach((h) => console.log(`   HELD      ${h.label} — ${h.reason}`));
  process.exit(0);
}

// ── apply, grouped by target triple ──────────────────────────────────────────
const groups = new Map();
for (const a of apply) {
  const k = [a.faculty_id, a.specialty_id, a.subject].join(' ');
  if (!groups.has(k)) groups.set(k, { faculty_id: a.faculty_id, specialty_id: a.specialty_id, subject: a.subject, rows: [] });
  groups.get(k).rows.push(a);
}
let updated = 0; const failures = []; const perTarget = {};
for (const [, g] of groups) {
  const label = `${g.faculty_id}/${g.specialty_id}/${g.subject}`;
  const isRevert = g.faculty_id === 'UNSORTED';
  if (!isRevert && !isValidTriple(g.faculty_id, g.specialty_id, g.subject)) {
    failures.push({ label, reason: 'failed final per-batch validation' }); continue;
  }
  const ids = g.rows.map((r) => r.id);
  const res = await fetch(`${SUPA}/rest/v1/documents?id=in.(${ids.join(',')})`, {
    method: 'PATCH',
    headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify({ faculty_id: g.faculty_id, specialty_id: g.specialty_id, subject: g.subject }),
  });
  const body = await res.json();
  if (!res.ok) { failures.push({ label, reason: `HTTP ${res.status}: ${JSON.stringify(body).slice(0, 250)}` }); continue; }
  const n = Array.isArray(body) ? body.length : 0;
  updated += n; perTarget[label] = n;
  log(`  ${String(n).padStart(2)} → ${label}`);
}

// ── verify ───────────────────────────────────────────────────────────────────
const after = {};
for (const s of TRACK) after[s] = await chunkCount(s);

const recheck = [];
for (const a of apply) {
  const r = await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${a.id}&select=id,clean_title,faculty_id,specialty_id,subject`, { headers: H })).json();
  const d = Array.isArray(r) ? r[0] : null;
  recheck.push({ id: a.id, label: a.label, title: d?.clean_title,
    now: d ? `${d.faculty_id}/${d.specialty_id}/${d.subject}` : '(missing)',
    expected: `${a.faculty_id}/${a.specialty_id}/${a.subject}`,
    ok: !!d && d.faculty_id === a.faculty_id && d.specialty_id === a.specialty_id && d.subject === a.subject });
}

const nullR = await fetch(`${SUPA}/rest/v1/chunks?or=(faculty_id.is.null,subject.is.null)&select=id&limit=1`,
  { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
const nullChunks = parseInt((nullR.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;

const receipt = {
  ranAt: new Date().toISOString(),
  source: 'audit of konspekt-remap-plan.mjs, 2026-08-01',
  inScope: apply.length + held.length,
  applied: updated, attemptedApply: apply.length, heldBack: held.length,
  perTarget, failures,
  appliedDetail: apply.map((a) => ({ documentId: a.id, folder: a.label, group: a.group, before: a.before, after: `${a.faculty_id}/${a.specialty_id}/${a.subject}`, rule: a.rule })),
  heldBackDetail: held,
  chunkCounts: Object.fromEntries(TRACK.map((s) => [s, { before: before[s], after: after[s], delta: after[s] - before[s] }])),
  verification: { recheck, chunksWithNullFacultyOrSubject: nullChunks },
};
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1), 'utf8');

console.log('\n=== AUDIT FIX ===');
console.log(`applied: ${updated} / ${apply.length}    held back: ${held.length}    failures: ${failures.length}`);
console.log('\nre-selected triples:');
recheck.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${(r.title || r.label).slice(0, 58).padEnd(60)} ${r.now}`));
console.log('\nchunk counts (subject):');
TRACK.forEach((s) => { const dl = after[s] - before[s]; if (dl || before[s] || after[s]) console.log(`  ${s.padEnd(34)} ${String(before[s]).padStart(6)} → ${String(after[s]).padStart(6)}   ${dl > 0 ? '+' : ''}${dl}`); });
console.log(`\nchunks with null faculty_id or subject: ${nullChunks}`);
console.log('\nheld back:');
held.forEach((h) => console.log(`  • ${h.label}\n      ${h.reason}${h.candidates?.length ? `\n      candidates: ${h.candidates.join(' | ')}` : ''}`));
console.log(`\nchunks: NOT written directly — 0018's trg_documents_cascade_taxonomy cascaded.`);
console.log(`receipt → ${RECEIPT}`);
