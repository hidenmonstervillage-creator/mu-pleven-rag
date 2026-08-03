/**
 * scripts/dedupe-misfiled-apply.mjs
 *
 * Removes the two mis-filed duplicate copies found 2026-08-03. Both are the SAME file
 * uploaded twice with the wrong subject selected the second time — not cross-listings:
 *
 *   Клинична алергология @ Акушерство и гинекология
 *     0 chunks contain "акушер", 1 contains "гинеколог", out of 1,036.
 *   Учебник по клинична патология Т.2 @ Фармакология с клинична фармакология
 *     0 chunks contain "фармаколог", 0 contain "фармакокинет", out of 958.
 *     Identical filename INCLUDING the content hash 3c332f90…, uploaded 50 min apart.
 *
 * The chemistry/biochemistry pairs (Bioanalytical Chemistry, Илюстрована биохимия) are
 * deliberately NOT touched — those read as intentional cross-listing.
 *
 * Discipline, same as every prior wave:
 *   1. verify the SURVIVING copy exists and is intact BEFORE deleting anything
 *   2. abort the whole run if any survivor check fails
 *   3. delete through the app's own DELETE route (chunks cascade via the FK), with a
 *      retry wrapper on 57014
 *   4. verify after, and write a receipt
 *
 * Deletes are the cheap direction for HNSW: both target subjects are indexed
 * (chunks_hnsw_akusherstvo, chunks_hnsw_farma_klinichna) but a delete only marks tuples
 * dead — the graph is not rebuilt until VACUUM. Every 57014 so far has come from INSERTs.
 * The wrapper is insurance, not an expectation.
 *
 * Receipt: scripts/dedupe-misfiled-receipt.json     Dry run: --dry
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const RECEIPT = resolve(__dirname, 'dedupe-misfiled-receipt.json');
const DRY = process.argv.includes('--dry');
const APP = 'https://mu-pleven-rag.vercel.app';

const c = readFileSync(resolve(ROOT, '.env.local'), 'utf8'); const E = {};
for (const raw of c.split('\n')) {
  const l = raw.trim(); if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('='); if (i < 0) continue;
  let v = l.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  E[l.slice(0, i).trim()] = v;
}
const S = E.NEXT_PUBLIC_SUPABASE_URL, K = E.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: K, Authorization: `Bearer ${K}` };
const enc = encodeURIComponent;
const log = (s) => console.log(`[dedupe] ${s}`);

const cnt = async (t, q) => {
  const r = await fetch(`${S}/rest/v1/${t}?${q}&select=id&limit=1`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
};
const one = async (q) => { const b = await (await fetch(`${S}/rest/v1/${q}`, { headers: H })).json(); return Array.isArray(b) ? b[0] : null; };

const PLAN = [
  { label: 'Клинична алергология',
    deleteId: 'bacb8811-207e-4332-afe1-004087937e0a', deleteSubject: 'Акушерство и гинекология',
    keepId: '97b7db5f-9a06-4b94-a9dd-4f3437eae9fe', keepSubject: 'Клинична алергология',
    expectChunks: 1036, probe: 'Какви са основните видове алергични реакции?' },
  { label: 'Учебник по клинична патология Т.2',
    deleteId: 'fbcd62e4-3dc6-4fab-b8a5-c4d5f405d6f1', deleteSubject: 'Фармакология с клинична фармакология',
    keepId: '6256cef1-b286-4138-a93a-46db793ac3ac', keepSubject: 'Патоанатомия и цитопатология',
    expectChunks: 958, probe: 'Какви са морфологичните белези на възпалението?' },
];

// ── 1. SURVIVOR CHECKS — before anything is deleted ──────────────────────────
log('verifying surviving copies BEFORE any delete…');
const failures = [];
for (const p of PLAN) {
  const keep = await one(`documents?id=eq.${p.keepId}&select=id,clean_title,subject,page_count,storage_url`);
  const keepChunks = keep ? await cnt('chunks', `document_id=eq.${p.keepId}`) : 0;
  const keepTagged = keep ? await cnt('chunks', `document_id=eq.${p.keepId}&subject=eq.${enc(p.keepSubject)}`) : 0;
  const del = await one(`documents?id=eq.${p.deleteId}&select=id,clean_title,subject,storage_url`);
  const delChunks = del ? await cnt('chunks', `document_id=eq.${p.deleteId}`) : 0;
  p.keep = keep; p.keepChunks = keepChunks; p.keepTagged = keepTagged; p.del = del; p.delChunks = delChunks;

  const ok = !!keep && keepChunks === p.expectChunks && keepTagged === keepChunks
    && keep.subject === p.keepSubject && !!del && del.subject === p.deleteSubject && del.id !== keep.id;
  console.log(`\n  ${p.label}`);
  console.log(`     KEEP   ${p.keepId}  ${keep ? `${keep.subject}  ${keep.page_count}pp  ${keepChunks} chunks (${keepTagged} correctly tagged)` : 'MISSING'}`);
  console.log(`     DELETE ${p.deleteId}  ${del ? `${del.subject}  ${delChunks} chunks` : 'MISSING'}`);
  console.log(`     survivor intact: ${ok ? 'YES' : 'NO'}`);
  if (!ok) failures.push(`${p.label}: survivor check failed`);
}
if (failures.length) {
  console.error(`\n[dedupe] ABORT — ${failures.length} survivor check(s) failed, NOTHING deleted:`);
  failures.forEach((f) => console.error(`   ${f}`));
  process.exit(1);
}
log('all survivor checks passed');

const before = {
  docs: await cnt('documents', 'id=not.is.null'),
  akusherstvo: await cnt('chunks', `subject=eq.${enc('Акушерство и гинекология')}`),
  akusherstvoDocs: await cnt('documents', `subject=eq.${enc('Акушерство и гинекология')}`),
  farmaKlin: await cnt('chunks', `subject=eq.${enc('Фармакология с клинична фармакология')}`),
  farmaKlinDocs: await cnt('documents', `subject=eq.${enc('Фармакология с клинична фармакология')}`),
  nullTax: await cnt('chunks', 'or=(faculty_id.is.null,subject.is.null)'),
};
log(`BEFORE ${JSON.stringify(before)}`);

if (DRY) {
  console.log('\n--dry: stopping before any delete.');
  PLAN.forEach((p) => console.log(`   WOULD DELETE ${p.deleteId}  ${p.label} @ ${p.deleteSubject}  (${p.delChunks} chunks)`));
  process.exit(0);
}

// ── 2. DELETE, with retry on 57014 ───────────────────────────────────────────
const results = [];
for (const p of PLAN) {
  let ok = false, attempts = 0, lastErr = null, ms = 0;
  for (attempts = 1; attempts <= 3; attempts++) {
    const t0 = Date.now();
    const res = await fetch(`${APP}/api/documents/${p.deleteId}`, { method: 'DELETE' });
    const body = await res.text(); ms = Date.now() - t0;
    if (res.ok) { ok = true; log(`  deleted ${p.label} @ ${p.deleteSubject}  (attempt ${attempts}, ${ms}ms)`); break; }
    lastErr = { status: res.status, body: body.slice(0, 200), ms };
    log(`  ${p.label} attempt ${attempts} FAILED ${res.status} after ${ms}ms — ${body.slice(0, 120)}`);
    if (!/57014|statement timeout/i.test(body)) break;      // only retry the timeout
    await new Promise((r) => setTimeout(r, 1500 * attempts));
  }
  results.push({ label: p.label, deleteId: p.deleteId, deletedFrom: p.deleteSubject, chunks: p.delChunks,
    ok, attempts, ms, error: ok ? null : lastErr, orphanedFile: p.del?.storage_url ?? null });
}

// ── 3. VERIFY ────────────────────────────────────────────────────────────────
const after = {
  docs: await cnt('documents', 'id=not.is.null'),
  akusherstvo: await cnt('chunks', `subject=eq.${enc('Акушерство и гинекология')}`),
  akusherstvoDocs: await cnt('documents', `subject=eq.${enc('Акушерство и гинекология')}`),
  farmaKlin: await cnt('chunks', `subject=eq.${enc('Фармакология с клинична фармакология')}`),
  farmaKlinDocs: await cnt('documents', `subject=eq.${enc('Фармакология с клинична фармакология')}`),
  nullTax: await cnt('chunks', 'or=(faculty_id.is.null,subject.is.null)'),
};

const survivors = [];
for (const p of PLAN) {
  const keep = await one(`documents?id=eq.${p.keepId}&select=id,clean_title,subject,page_count`);
  const keepChunks = await cnt('chunks', `document_id=eq.${p.keepId}`);
  const gone = await cnt('documents', `id=eq.${p.deleteId}`);
  const goneChunks = await cnt('chunks', `document_id=eq.${p.deleteId}`);
  // app-level: does the surviving subject still answer with sources?
  let app = null;
  try {
    const r = await fetch(`${APP}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: p.probe, facultyId: 'medicina', specialtyId: 'medicina', subject: p.keepSubject, conversationHistory: [] }) });
    const txt = await r.text();
    let sources = [];
    for (const ln of txt.split('\n')) { if (!ln.trim()) continue; try { const j = JSON.parse(ln); if (j.type === 'sources') sources = j.sources || []; } catch {} }
    app = { status: r.status, sources: sources.length, titles: [...new Set(sources.map((x) => x.clean_title))], pages: sources.map((x) => x.page_number) };
  } catch (e) { app = { error: String(e.message) }; }
  survivors.push({ label: p.label, keepId: p.keepId, subject: keep?.subject, chunks: keepChunks,
    intact: keepChunks === p.expectChunks, deletedRowGone: gone === 0, deletedChunksGone: goneChunks === 0, app });
}

const receipt = {
  ranAt: new Date().toISOString(),
  source: 'duplicate-misfiling audit, 2026-08-03',
  notTouched: ['Bioanalytical Chemistry (Химия + Биохимия)', 'Илюстрована биохимия (Химия + Биохимия)'],
  results, before, after, survivors,
  orphanedFilesOnHetzner: [
    ...results.filter((r) => r.ok && r.orphanedFile).map((r) => r.orphanedFile),
    'http://178.105.161.66/documents/medicina/medicina/anatomiya_i_histologiya/reuma.pdf',
  ],
  orphanNote: 'nginx returns 405 on DELETE for /documents/, so the app cleanup never removes files. These PDFs remain on disk with no documents row pointing at them. Post-demo cleanup.',
};
writeFileSync(RECEIPT, JSON.stringify(receipt, null, 1), 'utf8');

console.log('\n=== DEDUPE MIS-FILED ===');
console.log(`applied: ${results.filter((r) => r.ok).length} / ${results.length}   retries: ${results.filter((r) => r.ok && r.attempts > 1).length}`);
results.forEach((r) => console.log(`  ${r.ok ? '✓' : '✗'} ${r.label} @ ${r.deletedFrom}  (${r.chunks} chunks, attempt ${r.attempts}, ${r.ms}ms)`));
console.log('\ncounts:');
console.log(`  documents                              ${before.docs} → ${after.docs}`);
console.log(`  Акушерство и гинекология chunks        ${before.akusherstvo} → ${after.akusherstvo}   docs ${before.akusherstvoDocs} → ${after.akusherstvoDocs}`);
console.log(`  Фармакология с клин. фармакология      ${before.farmaKlin} → ${after.farmaKlin}   docs ${before.farmaKlinDocs} → ${after.farmaKlinDocs}`);
console.log(`  chunks with null taxonomy              ${after.nullTax}`);
console.log('\nsurviving copies:');
survivors.forEach((s) => {
  console.log(`  ${s.label}`);
  console.log(`     ${s.subject}  ${s.chunks} chunks  intact=${s.intact}  deletedRowGone=${s.deletedRowGone}  deletedChunksGone=${s.deletedChunksGone}`);
  console.log(`     app query: HTTP ${s.app?.status} · ${s.app?.sources} sources · pages ${JSON.stringify(s.app?.pages)}`);
  console.log(`     cited: ${JSON.stringify(s.app?.titles)}`);
});
console.log(`\nfiles now orphaned on Hetzner (NOT deleted — nginx 405, post-demo):`);
receipt.orphanedFilesOnHetzner.forEach((f) => console.log(`   ${f}`));
console.log(`\nreceipt → ${RECEIPT}`);
