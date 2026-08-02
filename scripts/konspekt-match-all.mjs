/**
 * scripts/konspekt-match-all.mjs — re-run the konspekt matcher against the FULL
 * folder inventory, not just READY_FULLBOOK.
 *
 * READ-ONLY. Reads the cached dry-run listing (scale-plan-output.json, 2,227 folders)
 * and konspekt-priority.json (527 entries). Touches no share, no database.
 *
 * konspekt-match.mjs only ever considered the 1,252 READY_FULLBOOK folders
 * (its line `plan.filter(p => p.bucket === 'READY_FULLBOOK')`), which is why
 * 96 entries came back NONE. This script widens the candidate set to every
 * bucket and additionally treats NESTED/CONTAINER *subdirectories* as candidates
 * in their own right — those subdir names are real book titles.
 *
 * The scoring block below is copied VERBATIM from konspekt-match.mjs and must
 * stay in sync with it. The script asserts that at the end: re-scoring with the
 * original candidate set + original IDF corpus must reproduce 348/83/96 exactly.
 *
 * Writes scripts/konspekt-match-all-output.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KON = resolve(__dirname, 'konspekt-priority.json');
const PLAN = resolve(__dirname, 'scale-plan-output.json');
const CKPT = resolve(__dirname, 'scale-checkpoint.json');
const PREV = resolve(__dirname, 'konspekt-match-output.json');
const OUT = resolve(__dirname, 'konspekt-match-all-output.json');

// ══ scoring — VERBATIM from konspekt-match.mjs ═════════════════════════════════
const BG = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',
  щ:'sht',ъ:'a',ь:'',ю:'yu',я:'ya' };
const translit = (s) => s.toLowerCase().split('').map((c) => (BG[c] !== undefined ? BG[c] : c)).join('');

function reduce(s) {
  return s
    .replace(/sht/g, 'sh').replace(/sht/g, 'sh')
    .replace(/ya/g, 'ia').replace(/ja/g, 'ia')
    .replace(/yu/g, 'iu').replace(/ju/g, 'iu')
    .replace(/zh/g, 'j').replace(/kh/g, 'h')
    .replace(/ts/g, 'c').replace(/tz/g, 'c')
    .replace(/ck/g, 'k').replace(/qu/g, 'kv')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');
}
const STOP = new Set(['na','i','za','po','s','v','the','of','and','a','an','in','for','to','de','za','pri','ot','no','ii']);

function norm(str) {
  return str.toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function cleanTitle(t) {
  let s = String(t).replace(/\r/g, '');
  if (s.includes('\n')) s = s.split('\n').pop();
  return s.replace(/;+\s*$/, '').trim();
}
function tokens(str) {
  return reduce(norm(translit(str))).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}
function folderParts(name) {
  const m = name.match(/^(\d{4})[_\-\s]*(.*)$/);
  const year = m ? parseInt(m[1], 10) : null;
  const rest = m ? m[2] : name;
  return { year, toks: tokens(rest) };
}

function makeScorer(folders) {
  const DF = new Map();
  for (const f of folders) for (const t of new Set(f.toks)) DF.set(t, (DF.get(t) || 0) + 1);
  const N = folders.length;
  const idf = (t) => Math.log((N + 1) / ((DF.get(t) || 0) + 1)) + 0.25;

  return function score(kt, ky, f) {
    if (!kt.length || !f.toks.length) return { s: 0, distinctive: false };
    const A = new Set(kt), B = new Set(f.toks);
    const matched = [...A].filter((t) => B.has(t));
    if (!matched.length) return { s: 0, distinctive: false };

    const wA = [...A].reduce((a, t) => a + idf(t), 0);
    const wB = [...B].reduce((a, t) => a + idf(t), 0);
    const wM = matched.reduce((a, t) => a + idf(t), 0);
    const fwd = wM / wA;
    const rev = wM / wB;
    let s = 0.7 * fwd + 0.3 * rev;

    const topTok = [...A].sort((a, b) => idf(b) - idf(a))[0];
    const distinctive = B.has(topTok);
    if (!distinctive) s *= 0.55;

    if (ky && f.year) {
      const d = Math.abs(ky - f.year);
      if (d === 0) s += 0.12; else if (d <= 1) s += 0.06;
      else if (d > 10) s -= 0.35; else if (d > 5) s -= 0.20; else if (d > 2) s -= 0.08;
    }
    return { s: Math.max(0, Math.min(1, s)), distinctive };
  };
}
const classify = (bestS, bestDist, yearOk) =>
  (bestS >= 0.72 && bestDist && yearOk) ? 'HIGH' : (bestS >= 0.45 ? 'MEDIUM' : 'NONE');
// ══ end verbatim block ════════════════════════════════════════════════════════

const konspekt = JSON.parse(readFileSync(KON, 'utf8'));
const plan = JSON.parse(readFileSync(PLAN, 'utf8')).plan;
const doneSet = new Set(existsSync(CKPT) ? JSON.parse(readFileSync(CKPT, 'utf8')).completed.map((c) => c.folder) : []);
const prev = JSON.parse(readFileSync(PREV, 'utf8'));

// ── candidate sets ────────────────────────────────────────────────────────────
const cand = (p) => ({
  name: p.name, bucket: p.bucket, pages: p.pageCount, files: p.fileCount,
  bytes: p.totalBytes, parent: null, ...folderParts(p.name),
});
const ORIGINAL = plan.filter((p) => p.bucket === 'READY_FULLBOOK').map(cand);

// full inventory: every folder, plus NESTED/CONTAINER subdirs as their own candidates
const FULL = plan.map(cand);
for (const p of plan) {
  if (p.bucket !== 'NESTED' && p.bucket !== 'CONTAINER') continue;
  for (const sd of p.subdirs || []) {
    FULL.push({ name: sd, bucket: p.bucket + '_SUBDIR', pages: null, files: null,
      bytes: null, parent: p.name, ...folderParts(sd) });
  }
}

function run(candidates, scorer) {
  const out = [];
  for (const [idx, k] of konspekt.entries()) {
    const title = cleanTitle(k.title);
    const kt = tokens(title);
    const ky = parseInt(k.year, 10) || null;
    let best = null, bestS = 0, runnerUp = 0, bestDist = false;
    for (const f of candidates) {
      const { s, distinctive } = scorer(kt, ky, f);
      if (s > bestS) { runnerUp = bestS; bestS = s; best = f; bestDist = distinctive; }
      else if (s > runnerUp) runnerUp = s;
    }
    const yearGap = best && ky && best.year ? Math.abs(ky - best.year) : null;
    const cls = best ? classify(bestS, bestDist, yearGap === null || yearGap <= 2) : 'NONE';
    out.push({
      idx,
      title, year: k.year, konspekt_subject: k.konspekt_subject, course: k.course,
      faculty_hint: k.faculty_hint,
      match: cls === 'NONE' ? null : best.name,
      bucket: cls === 'NONE' ? null : best.bucket,
      parent: cls === 'NONE' ? null : best.parent,
      matchYear: cls === 'NONE' ? null : best.year,
      matchPages: cls === 'NONE' ? null : best.pages,
      matchFiles: cls === 'NONE' ? null : best.files,
      matchBytes: cls === 'NONE' ? null : best.bytes,
      score: +bestS.toFixed(3), margin: +(bestS - runnerUp).toFixed(3), class: cls,
      alreadyDone: cls === 'NONE' ? false : doneSet.has(best.name),
    });
  }
  return out;
}

// ── 0. reproduce the original run, to prove the scoring block is in sync ──────
const repro = run(ORIGINAL, makeScorer(ORIGINAL));
const rc = { HIGH: 0, MEDIUM: 0, NONE: 0 }; repro.forEach((r) => rc[r.class]++);
const reproOk = rc.HIGH === prev.summary.HIGH && rc.MEDIUM === prev.summary.MEDIUM && rc.NONE === prev.summary.NONE;
console.log(`SELF-CHECK  reproduce original: HIGH=${rc.HIGH} MEDIUM=${rc.MEDIUM} NONE=${rc.NONE}  ` +
  `(expected ${prev.summary.HIGH}/${prev.summary.MEDIUM}/${prev.summary.NONE})  => ${reproOk ? 'MATCH' : 'MISMATCH'}`);
if (!reproOk) { console.error('Scoring drifted from konspekt-match.mjs — aborting, results would not be comparable.'); process.exit(1); }

// key by array index — konspekt-priority.json contains duplicate (title, year) pairs,
// so a text key silently collapses 96 NONE entries into 91.
const key = (r) => r.idx;
const wasNone = new Set(repro.filter((r) => r.class === 'NONE').map(key));

// ── 1. full inventory, IDF over the widened corpus (the statistically right one) ──
const full = run(FULL, makeScorer(FULL));
// ── 2. sensitivity check: same widened candidates, IDF frozen at the original corpus ──
const frozen = run(FULL, makeScorer(ORIGINAL));

function report(label, rows) {
  const rescued = rows.filter((r) => wasNone.has(key(r)) && r.class !== 'NONE');
  const byBucket = {};
  for (const r of rescued) {
    const b = (byBucket[r.bucket] ||= { HIGH: 0, MEDIUM: 0, folders: new Set(), pages: 0, unknownPages: 0 });
    b[r.class]++;
    if (!b.folders.has(r.match)) {
      b.folders.add(r.match);
      if (typeof r.matchPages === 'number' && r.matchPages > 0) b.pages += r.matchPages;
      else b.unknownPages++;
    }
  }
  console.log(`\n═══ ${label} ═══`);
  console.log(`  of ${wasNone.size} previously-NONE entries, ${rescued.length} now match`);
  console.log(`  ${'bucket'.padEnd(20)} ${'HIGH'.padStart(5)} ${'MED'.padStart(5)} ${'folders'.padStart(8)} ${'pages'.padStart(8)}  (folders w/o page data)`);
  for (const [b, v] of Object.entries(byBucket).sort((a, z) => (z[1].HIGH + z[1].MEDIUM) - (a[1].HIGH + a[1].MEDIUM))) {
    console.log(`  ${b.padEnd(20)} ${String(v.HIGH).padStart(5)} ${String(v.MEDIUM).padStart(5)} ` +
      `${String(v.folders.size).padStart(8)} ${String(v.pages).padStart(8)}  ${v.unknownPages || ''}`);
  }
  const allFolders = new Set(rescued.map((r) => r.match));
  const notDone = [...allFolders].filter((f) => !doneSet.has(f));
  console.log(`  TOTAL distinct new folders: ${allFolders.size}  (not yet processed: ${notDone.length})`);
  return { rescued, byBucket, allFolders };
}

const R = report('FULL INVENTORY — IDF over widened corpus (primary)', full);
const F = report('SENSITIVITY — same candidates, IDF frozen at READY_FULLBOOK corpus', frozen);

// how far the two variants disagree on the rescued set
const fullCls = new Map(full.map((r) => [key(r), r.class + '|' + r.match]));
const disagree = frozen.filter((r) => wasNone.has(key(r)) && fullCls.get(key(r)) !== r.class + '|' + r.match);
console.log(`\n  IDF-variant disagreement on previously-NONE entries: ${disagree.length}`);

// did any previously-matched entry find a BETTER home outside READY_FULLBOOK?
const prevByKey = new Map(repro.map((r) => [key(r), r]));
const moved = full.filter((r) => {
  const p = prevByKey.get(key(r));
  return p && p.class !== 'NONE' && r.match !== p.match && r.score > p.score + 0.02;
});
console.log(`  previously-matched entries whose best match moved elsewhere: ${moved.length}` +
  `  (${moved.filter((m) => m.bucket !== 'READY_FULLBOOK').length} of them to a non-FULLBOOK bucket)`);

writeFileSync(OUT, JSON.stringify({
  generated: new Date().toISOString(),
  selfCheck: { reproduced: rc, expected: { HIGH: prev.summary.HIGH, MEDIUM: prev.summary.MEDIUM, NONE: prev.summary.NONE }, ok: reproOk },
  candidateCounts: { original: ORIGINAL.length, full: FULL.length },
  rescuedPrimary: R.rescued,
  rescuedFrozenIdf: F.rescued,
  idfVariantDisagreement: disagree,
  movedMatches: moved,
  stillNone: full.filter((r) => wasNone.has(key(r)) && r.class === 'NONE'),
}, null, 1), 'utf8');
console.log('\nwrote', OUT);
