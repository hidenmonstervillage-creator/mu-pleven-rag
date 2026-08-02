/**
 * scripts/konspekt-remap-plan.mjs — DRY RUN. Proposes the UNSORTED → real-taxonomy remap.
 *
 * READ-ONLY: reads Supabase + scale-checkpoint.json + lib/faculties.ts and writes ONE
 * local file (scripts/konspekt-remap-plan.json). It performs NO database writes.
 *
 * Every scale-run book was ingested with the placeholder triple
 * (faculty_id='UNSORTED', specialty_id='UNSORTED', subject=<folder name>), which makes it
 * invisible to match_chunks (exact 3-way equality). This plan maps each to a real
 * (faculty_id, specialty_id, subject) validated against lib/faculties.ts.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUT = resolve(__dirname, 'konspekt-remap-plan.json');

// ── env ────────────────────────────────────────────────────────────────────────
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

// ── taxonomy (authoritative) ───────────────────────────────────────────────────
let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties');
mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;

const subjectsOf = (fid, sid) => {
  const f = FACULTIES.find((x) => x.id === fid); if (!f) return null;
  const s = f.specialties.find((x) => x.id === sid); return s ? s.subjects : null;
};
const isValidTriple = (fid, sid, subj) => {
  const subs = subjectsOf(fid, sid);
  return !!subs && subs.includes(subj);
};

// ── faculty_hint → (faculty_id, specialty_id) ──────────────────────────────────
// Hints that name only a faculty with multiple specialties are AMBIGUOUS: we propose the
// most likely one and flag it for human confirmation.
const FACULTY_MAP = {
  medicina:      { fid: 'medicina', sid: 'medicina',    ambiguous: false },
  farmacia:      { fid: 'farmacia', sid: 'farmacia',    ambiguous: false },
  fvm:           { fid: 'fvm',      sid: 'veterinarna', ambiguous: false },
  fzg_laborant:  { fid: 'fzg',      sid: 'laborant',    ambiguous: false },
  fzg_rentgenov: { fid: 'fzg',      sid: 'rentgenov',   ambiguous: false },
  // bare 'fzg' covers сестра / акушерка / лаборант / рентгенов / медико-социални —
  // propose 'sestra' (largest cohort, shares the core curriculum) but flag it.
  fzg:           { fid: 'fzg',      sid: 'sestra',      ambiguous: true,
                   note: "bare 'fzg' — сестра vs акушерка (and 3 more) share these subjects; proposing sestra" },
  // 'foz' has 8 specialties; общественото здраве is the general one.
  foz:           { fid: 'foz',      sid: 'obshtestveno', ambiguous: true,
                   note: "bare 'foz' — 8 specialties; proposing obshtestveno (general public health)" },
};

// ── konspekt_subject → taxonomy subject aliases ────────────────────────────────
// The .docx headings carry stray whitespace (e.g. "Рентгенология,  радиология" with a
// double space), which silently defeated an exact-key alias lookup. Canonicalise runs of
// whitespace on BOTH sides of every alias lookup so the whole class is handled, not the
// one instance we happened to notice.
const canon = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const aliasGet = (map, key) => {
  const k = canon(key);
  for (const [a, b] of Object.entries(map)) if (canon(a) === k) return b;
  return undefined;
};
const SUBJECT_ALIAS = {
  'Анатомия на човека':                        'Анатомия и хистология',
  'Анатомия и хистология на човека':           'Анатомия и хистология',
  'Физиология на човека':                      'Физиология',
  'Биология на човека':                        'Биология',
  'Медицинска физика':                         'Физика',
  'Цитология, обща хистология и ембриология':  'Цитология',
  'Патоанатомия':                              'Патоанатомия и цитопатология',
  'Клинична патоанатомия':                     'Патоанатомия и цитопатология',
  'Рентгенология, радиология':                 'Рентгенология и радиология',
};
// ── REFINEMENTS beyond the original spec (added because the first pass produced 11
//    INVALID_TRIPLEs that are unambiguously resolvable from data already in hand) ──
//
// (a) Faculty-aware subject naming. The konspekt uses medical-faculty names, but ФЗГ
//     specialties name the same course differently (no combined histology course).
const FACULTY_SUBJECT_OVERRIDE = {
  'fzg': { 'Анатомия и хистология': 'Анатомия', 'Физиология': 'Физиология', 'Биология': 'Биология',
    // ФЗГ names these differently from the medical faculty; both targets already exist.
    'Анестезиология и интензивно лечение': 'Анестезиология и интензивни грижи',
    'Обща и оперативна хирургия': 'Хирургия' },
  // Фармация teaches anatomy and physiology as one course.
  'farmacia': { 'Анатомия и хистология': 'Анатомия и физиология',
    // pharmacy takes no occupational-disease component; fzg/laborant and fzg/rentgenov
    // already use exactly "Хигиена и екология", so reuse that name rather than the long one
    'Хигиена, екология и професионални заболявания': 'Хигиена и екология' },
  // The konspekt names veterinary courses with their human-medicine titles. Targets are the
  // Ветеринарна-prefixed forms introduced when fvm/veterinarna was disambiguated (2026-08-01).
  'fvm': { 'Акушерство и гинекология': 'Акушерство, репродукция и репродуктивни нарушения',
    'Клинична токсикология': 'Ветеринарна фармакология и токсикология',
    'Патоанатомия': 'Ветеринарна патоанатомия',
    'Патофизиология': 'Ветеринарна патофизиология',
    'Микробиология': 'Ветеринарна микробиология',
    'Биохимия': 'Ветеринарна биохимия',
    'Хирургия': 'Ветеринарна хирургия',
    'Генетика': 'Ветеринарна генетика' },
};
// (b) The konspekt lumps every pharmacy chemistry course under "Химия", but
//     farmacia/farmacia has no such subject — it has five specific ones. The book's own
//     title names which, so disambiguate from it. Order matters (неорганична before органична).
const CHEM_RULES = [
  [/неорганичн/i,   'Неорганична химия'],
  [/физикохими/i,   'Физикохимия'],
  [/аналитичн/i,    'Аналитична химия'],
  [/фармацевтичн/i, 'Фармацевтична химия'],
  [/биохими/i,      'Биохимия'],
  [/органичн/i,     'Органична химия'],
];

// The language subjects live under ДЕСО/езикови regardless of the book's faculty_hint.
const LANGUAGE_SUBJECTS = new Set([
  'Български език', 'Английски език', 'Немски език', 'Френски език',
  'Латински език с медицински термини', 'Латински език',
]);
const LANG_ALIAS = { 'Латински език': 'Латински език с медицински термини' };

// ── load documents + checkpoint ────────────────────────────────────────────────
const docs = await (await fetch(`${SUPA}/rest/v1/documents?faculty_id=eq.UNSORTED&select=id,filename,clean_title,subject,page_count`, { headers: H })).json();
const ckpt = JSON.parse(readFileSync(resolve(__dirname, 'scale-checkpoint.json'), 'utf8')).completed;
const byFolder = new Map(ckpt.map((c) => [c.folder, c]));
const byDocId = new Map(ckpt.filter((c) => c.documentId).map((c) => [c.documentId, c]));

// konspekt matcher results, keyed by matched folder (first/best wins). Used only to
// SUGGEST metadata for books ingested before metadata recording existed.
const MATCH_BY_FOLDER = new Map();
try {
  const mo = JSON.parse(readFileSync(resolve(__dirname, 'konspekt-match-output.json'), 'utf8'));
  for (const r of mo.results || []) if (r.match && !MATCH_BY_FOLDER.has(r.match)) MATCH_BY_FOLDER.set(r.match, r);
} catch { /* optional input */ }

// ── PERSISTENT exclusions ──────────────────────────────────────────────────────
// Documents deliberately reverted to UNSORTED by a human. Without this the planner
// cannot tell them apart from never-filed documents and will re-propose the very
// filing that was just undone. Checked BEFORE any proposal is built; the resulting
// 'EXCLUDED' status is not an auto-apply class, so an unattended autoapply run holds
// them. See scripts/remap-exclusions.json.
const EXCL = resolve(__dirname, 'remap-exclusions.json');
let exclusions = [];
try { exclusions = JSON.parse(readFileSync(EXCL, 'utf8')).excluded || []; }
catch { console.log('[plan] no remap-exclusions.json — proceeding with none'); }
const exclById = new Map(exclusions.filter((e) => e.documentId).map((e) => [e.documentId, e]));
const exclByFolder = new Map(exclusions.filter((e) => e.folder).map((e) => [e.folder, e]));
if (exclusions.length) console.log(`[plan] ${exclusions.length} persistent exclusion(s) loaded`);

// ── PERSISTENT per-folder routes (human decisions) — see scripts/remap-routes.json ──
const ROUTES_FILE = resolve(__dirname, 'remap-routes.json');
let ROUTES = new Map();
try {
  const r = JSON.parse(readFileSync(ROUTES_FILE, 'utf8')).routes || [];
  ROUTES = new Map(r.map((x) => [x.folder, x]));
  console.log(`[plan] ${ROUTES.size} explicit route(s) loaded`);
} catch { console.log('[plan] no remap-routes.json — proceeding with none'); }

const plan = [];
for (const d of docs) {
  // subject holds the folder name verbatim (placeholder ingest); documentId is the surer key
  const cp = byDocId.get(d.id) || byFolder.get(d.subject) || null;

  const ex = exclById.get(d.id) || exclByFolder.get(d.subject) || null;
  if (ex) {
    plan.push({ documentId: d.id, filename: d.filename, folder: d.subject, pages: d.page_count,
      konspekt_subject: cp?.konspekt_subject ?? null, faculty_hint: cp?.faculty_hint ?? null,
      course: cp?.course ?? null, konspekt_title: cp?.konspekt_title ?? null,
      proposed: null, status: 'EXCLUDED',
      reasons: [`persistently excluded (${ex.excludedAt}, ${ex.revertedBy || 'manual'}): ${ex.reason}`],
      exclusion: ex });
    continue;
  }

  const row = {
    documentId: d.id, filename: d.filename, folder: d.subject, pages: d.page_count,
    konspekt_subject: cp?.konspekt_subject ?? null,
    faculty_hint: cp?.faculty_hint ?? null,
    course: cp?.course ?? null,
    konspekt_title: cp?.konspekt_title ?? null,
    proposed: null, status: 'UNMAPPABLE', reasons: [],
  };

  // 0) explicit per-folder route — a HUMAN decision about this specific book. Wins over
  // the hint map, the aliases and the overrides, and needs no konspekt metadata at all,
  // so it is checked before the no-checkpoint / no-metadata guards below.
  const route = ROUTES.get(d.subject) || (cp && ROUTES.get(cp.folder));
  if (route) {
    row.proposed = { faculty_id: route.faculty_id, specialty_id: route.specialty_id, subject: route.subject };
    row.reasons.push(`explicit route (${route.decidedAt}): ${route.why}`);
    if (!isValidTriple(route.faculty_id, route.specialty_id, route.subject)) {
      row.status = 'INVALID_TRIPLE';
      row.reasons.push('routed triple does not validate — taxonomy addition still missing');
    } else row.status = 'ROUTED';
    plan.push(row); continue;
  }

  if (!cp) { row.reasons.push('no checkpoint entry matched'); plan.push(row); continue; }
  if (!cp.konspekt_subject || !cp.faculty_hint) {
    row.status = 'NO_METADATA';
    row.reasons.push('checkpoint entry has no konspekt_subject/faculty_hint (ingested before metadata was recorded) — needs manual or classifier handling');
    // Some of these DO have a konspekt match recorded in konspekt-match-output.json
    // (results[], which unlike order[] is not filtered by the checkpoint). Surface it as
    // a SUGGESTION only — status stays NO_METADATA, nothing is silently promoted, because
    // the MEDIUM tier of that matcher measured as unreliable.
    const sug = MATCH_BY_FOLDER.get(d.subject);
    if (sug) {
      let subj = sug.konspekt_subject;
      if (LANGUAGE_SUBJECTS.has(subj)) subj = LANG_ALIAS[subj] ?? subj;
      else if (SUBJECT_ALIAS[subj]) subj = SUBJECT_ALIAS[subj];
      const fm = FACULTY_MAP[sug.faculty_hint];
      const cand = fm ? { faculty_id: fm.fid, specialty_id: fm.sid, subject: subj } : null;
      row.suggestion = {
        source: 'konspekt-match results[]', matchClass: sug.class, matchScore: sug.score,
        konspekt_subject: sug.konspekt_subject, faculty_hint: sug.faculty_hint,
        wouldPropose: cand,
        wouldValidate: cand ? isValidTriple(cand.faculty_id, cand.specialty_id, cand.subject) : false,
      };
    }
    plan.push(row); continue;
  }

  // 1) subject side
  let subject = canon(cp.konspekt_subject);
  let langOverride = false;
  const langHit = aliasGet(LANG_ALIAS, subject);
  const aliasHit = aliasGet(SUBJECT_ALIAS, subject);
  if ([...LANGUAGE_SUBJECTS].some((x) => canon(x) === subject)) { subject = langHit ?? subject; langOverride = true; }
  else if (aliasHit) { row.reasons.push(`alias: "${cp.konspekt_subject}" → "${aliasHit}"`); subject = aliasHit; }

  // 2) faculty side (language subjects are re-homed to ДЕСО/езикови)
  let fid, sid, ambiguous = false;
  if (langOverride) {
    fid = 'deso'; sid = 'ezikovi';
    row.reasons.push(`language subject → deso/ezikovi (overrides faculty_hint '${cp.faculty_hint}')`);
  } else {
    const fm = FACULTY_MAP[cp.faculty_hint];
    if (!fm) { row.reasons.push(`unknown faculty_hint '${cp.faculty_hint}'`); plan.push(row); continue; }
    ({ fid, sid } = fm); ambiguous = fm.ambiguous;
    if (fm.note) row.reasons.push(fm.note);
  }

  // 2b) REFINEMENT (a): faculty-specific subject naming (e.g. ФЗГ says "Анатомия")
  const ov = FACULTY_SUBJECT_OVERRIDE[fid] ? aliasGet(FACULTY_SUBJECT_OVERRIDE[fid], subject) : undefined;
  if (ov && ov !== subject && isValidTriple(fid, sid, ov)) {
    row.reasons.push(`REFINEMENT: ${fid} names this course "${ov}", not "${subject}"`);
    subject = ov;
  }
  // 2c) REFINEMENT (b): split the konspekt's generic "Химия" into the specific pharmacy
  //     chemistry subject named by the book's own title.
  if (subject === 'Химия' && !isValidTriple(fid, sid, 'Химия')) {
    const hay = `${cp.konspekt_title || ''} ${d.subject || ''}`;
    const hit = CHEM_RULES.find(([re]) => re.test(hay));
    if (hit && isValidTriple(fid, sid, hit[1])) {
      row.reasons.push(`REFINEMENT: "Химия" is not a ${fid}/${sid} subject; title indicates "${hit[1]}"`);
      subject = hit[1];
    }
  }

  row.proposed = { faculty_id: fid, specialty_id: sid, subject };

  // 3) validate against the taxonomy
  if (!isValidTriple(fid, sid, subject)) {
    row.status = 'INVALID_TRIPLE';
    const subs = subjectsOf(fid, sid);
    row.reasons.push(subs
      ? `"${subject}" is NOT a subject of ${fid}/${sid}`
      : `${fid}/${sid} is not a valid faculty/specialty`);
    // offer near-misses to make the fix obvious
    if (subs) {
      const near = subs.filter((s) => s.includes(subject.split(' ')[0]) || subject.includes(s.split(' ')[0]));
      if (near.length) row.candidates = near;
    }
  } else {
    row.status = ambiguous ? 'AMBIGUOUS' : 'VALIDATED';
  }
  plan.push(row);
}

// ── report ─────────────────────────────────────────────────────────────────────
const by = (st) => plan.filter((p) => p.status === st);
const counts = plan.reduce((a, p) => { a[p.status] = (a[p.status] || 0) + 1; return a; }, {});

console.log('='.repeat(78));
console.log(`TOTAL UNSORTED DOCUMENTS: ${plan.length}`);
console.log('='.repeat(78));
console.log(`  VALIDATED      ${(counts.VALIDATED || 0).toString().padStart(3)}  → will become retrievable`);
console.log(`  ROUTED         ${(counts.ROUTED || 0).toString().padStart(3)}  → explicit human route, validated`);
console.log(`  AMBIGUOUS      ${(counts.AMBIGUOUS || 0).toString().padStart(3)}  → valid triple, but specialty is a guess`);
console.log(`  INVALID_TRIPLE ${(counts.INVALID_TRIPLE || 0).toString().padStart(3)}  → subject not valid under that faculty/specialty`);
console.log(`  NO_METADATA    ${(counts.NO_METADATA || 0).toString().padStart(3)}  → no konspekt metadata at ingest`);
console.log(`  EXCLUDED       ${(counts.EXCLUDED || 0).toString().padStart(3)}  → persistently excluded, never auto-filed`);
console.log(`  UNMAPPABLE     ${(counts.UNMAPPABLE || 0).toString().padStart(3)}`);
if (by('EXCLUDED').length) {
  console.log('\n' + '-'.repeat(78));
  console.log('PERSISTENTLY EXCLUDED — will not be proposed or applied');
  console.log('-'.repeat(78));
  by('EXCLUDED').forEach((p) => console.log(`  ${p.folder}\n      ${p.reasons[0]}`));
}

console.log('\n' + '-'.repeat(78));
console.log('DISTRIBUTION BY TARGET TRIPLE (VALIDATED + AMBIGUOUS)');
console.log('-'.repeat(78));
const dist = {};
for (const p of [...by('VALIDATED'), ...by('ROUTED'), ...by('AMBIGUOUS')]) {
  const k = `${p.proposed.faculty_id}/${p.proposed.specialty_id}/${p.proposed.subject}`;
  (dist[k] ??= { n: 0, amb: 0, pages: 0 });
  dist[k].n++; dist[k].pages += p.pages || 0;
  if (p.status === 'AMBIGUOUS') dist[k].amb++;
}
Object.entries(dist).sort((a, b) => b[1].n - a[1].n).forEach(([k, v]) =>
  console.log(`  ${String(v.n).padStart(3)} books ${String(v.pages).padStart(6)}pp  ${k}${v.amb ? `   [${v.amb} ambiguous]` : ''}`));

if (by('INVALID_TRIPLE').length) {
  console.log('\n' + '-'.repeat(78));
  console.log('INVALID TRIPLES — need a decision before apply');
  console.log('-'.repeat(78));
  const grp = {};
  for (const p of by('INVALID_TRIPLE')) {
    const k = `${p.proposed.faculty_id}/${p.proposed.specialty_id} :: "${p.proposed.subject}"`;
    (grp[k] ??= { n: 0, cands: p.candidates || [], eg: [] });
    grp[k].n++; if (grp[k].eg.length < 3) grp[k].eg.push(p.folder);
  }
  Object.entries(grp).forEach(([k, v]) => {
    console.log(`  ${v.n} × ${k}`);
    if (v.cands.length) console.log(`        candidates under that specialty: ${v.cands.join(' | ')}`);
    console.log(`        e.g. ${v.eg.join(', ')}`);
  });
}

if (by('NO_METADATA').length) {
  console.log('\n' + '-'.repeat(78));
  console.log(`NO KONSPEKT METADATA (${by('NO_METADATA').length}) — manual/classifier needed`);
  console.log('-'.repeat(78));
  const withSug = by('NO_METADATA').filter((p) => p.suggestion?.wouldValidate);
  by('NO_METADATA').forEach((p) => {
    const s = p.suggestion;
    console.log(`  ${p.folder}`);
    if (s?.wouldPropose) {
      console.log(`      suggestion [${s.matchClass} ${s.matchScore}]: ${s.wouldPropose.faculty_id}/${s.wouldPropose.specialty_id}/${s.wouldPropose.subject}` +
        `${s.wouldValidate ? '' : '   ⚠ would NOT validate'}`);
    }
  });
  console.log(`\n  ${withSug.length} of ${by('NO_METADATA').length} have a VALIDATING suggestion ` +
    `(${withSug.filter((p) => p.suggestion.matchClass === 'HIGH').length} HIGH, ${withSug.filter((p) => p.suggestion.matchClass === 'MEDIUM').length} MEDIUM) — NOT applied, your call.`);
}

writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), counts, distribution: dist, plan }, null, 1), 'utf8');
console.log(`\nfull per-document plan → ${OUT}`);
console.log('DRY RUN — no database writes performed.');
