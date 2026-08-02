/**
 * scripts/konspekt-match.mjs — match konspekt reading-list entries to share folders.
 *
 * READ-ONLY. Matches each of the 527 konspekt entries against the READY_FULLBOOK
 * folder names from scale-plan-output.json, using transliteration-tolerant token
 * scoring plus a year bonus. Writes scripts/konspekt-match-output.json.
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const KON = resolve(__dirname, 'konspekt-priority.json');
const PLAN = resolve(__dirname, 'scale-plan-output.json');
const CKPT = resolve(__dirname, 'scale-checkpoint.json');
const OUT = resolve(__dirname, 'konspekt-match-output.json');

// ── Cyrillic → Latin (standard BG scheme) ───────────────────────────────────────
const BG = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',
  м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',
  щ:'sht',ъ:'a',ь:'',ю:'yu',я:'ya' };
const translit = (s) => s.toLowerCase().split('').map((c) => (BG[c] !== undefined ? BG[c] : c)).join('');

// Collapse transliteration variants both sides so ya/ia, y/i, sht/sh, ts/c, zh/j, kh/h agree.
function reduce(s) {
  return s
    .replace(/sht/g, 'sh').replace(/sht/g, 'sh')
    .replace(/ya/g, 'ia').replace(/ja/g, 'ia')
    .replace(/yu/g, 'iu').replace(/ju/g, 'iu')
    .replace(/zh/g, 'j').replace(/kh/g, 'h')
    .replace(/ts/g, 'c').replace(/tz/g, 'c')
    .replace(/ck/g, 'k').replace(/qu/g, 'kv')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1');   // collapse doubled letters
}
const STOP = new Set(['na','i','za','po','s','v','the','of','and','a','an','in','for','to','de','za','pri','ot','no','ii']);

function norm(str) {
  return str.toLowerCase()
    .replace(/[‘’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
// konspekt titles sometimes carry "Author, Name;  \nTitle;" — keep the title part
function cleanTitle(t) {
  let s = String(t).replace(/\r/g, '');
  if (s.includes('\n')) s = s.split('\n').pop();
  return s.replace(/;+\s*$/, '').trim();
}
function tokens(str) {
  return reduce(norm(translit(str))).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}
// folder: "1980_Medicinska_biofizika" -> year 1980, name tokens
function folderParts(name) {
  const m = name.match(/^(\d{4})[_\-\s]*(.*)$/);
  const year = m ? parseInt(m[1], 10) : null;
  const rest = m ? m[2] : name;
  return { year, toks: tokens(rest) };
}

const konspekt = JSON.parse(readFileSync(KON, 'utf8'));
const plan = JSON.parse(readFileSync(PLAN, 'utf8')).plan;
const ready = plan.filter((p) => p.bucket === 'READY_FULLBOOK');
const doneSet = new Set(existsSync(CKPT) ? JSON.parse(readFileSync(CKPT, 'utf8')).completed.map((c) => c.folder) : []);

const folders = ready.map((p) => ({ name: p.name, pages: p.pageCount, ...folderParts(p.name) }));

// IDF over the folder corpus: boilerplate ("rakovodstvo", "uprajneniia", "po") gets
// near-zero weight, so the DISTINCTIVE subject word (biologiia vs fiziologiia) decides.
const DF = new Map();
for (const f of folders) for (const t of new Set(f.toks)) DF.set(t, (DF.get(t) || 0) + 1);
const N = folders.length;
const idf = (t) => Math.log((N + 1) / ((DF.get(t) || 0) + 1)) + 0.25;

function score(kt, ky, f) {
  if (!kt.length || !f.toks.length) return { s: 0, distinctive: false };
  const A = new Set(kt), B = new Set(f.toks);
  const matched = [...A].filter((t) => B.has(t));
  if (!matched.length) return { s: 0, distinctive: false };

  const wA = [...A].reduce((a, t) => a + idf(t), 0);
  const wB = [...B].reduce((a, t) => a + idf(t), 0);
  const wM = matched.reduce((a, t) => a + idf(t), 0);
  const fwd = wM / wA;               // how much of the title's information the folder covers
  const rev = wM / wB;               // penalises folders carrying extra distinctive content
  let s = 0.7 * fwd + 0.3 * rev;

  // the single most distinctive title token must be present, else it's a different book
  const topTok = [...A].sort((a, b) => idf(b) - idf(a))[0];
  const distinctive = B.has(topTok);
  if (!distinctive) s *= 0.55;

  // year: modest bonus when close, strong penalty when far apart
  if (ky && f.year) {
    const d = Math.abs(ky - f.year);
    if (d === 0) s += 0.12; else if (d <= 1) s += 0.06;
    else if (d > 10) s -= 0.35; else if (d > 5) s -= 0.20; else if (d > 2) s -= 0.08;
  }
  return { s: Math.max(0, Math.min(1, s)), distinctive };
}

const results = [];
for (const k of konspekt) {
  const title = cleanTitle(k.title);
  const kt = tokens(title);
  const ky = parseInt(k.year, 10) || null;
  let best = null, bestS = 0, runnerUp = 0, bestDist = false;
  for (const f of folders) {
    const { s, distinctive } = score(kt, ky, f);
    if (s > bestS) { runnerUp = bestS; bestS = s; best = f; bestDist = distinctive; }
    else if (s > runnerUp) runnerUp = s;
  }
  let cls = 'NONE';
  if (best) {
    const yearGap = ky && best.year ? Math.abs(ky - best.year) : null;
    const yearOk = yearGap === null || yearGap <= 2;
    // HIGH demands: strong weighted overlap, the distinctive token present, and a plausible year
    if (bestS >= 0.72 && bestDist && yearOk) cls = 'HIGH';
    else if (bestS >= 0.45) cls = 'MEDIUM';
  }
  results.push({
    title, year: k.year, konspekt_subject: k.konspekt_subject, course: k.course,
    faculty_hint: k.faculty_hint,
    match: cls === 'NONE' ? null : best.name,
    matchYear: cls === 'NONE' ? null : best.year,
    matchPages: cls === 'NONE' ? null : best.pages,
    score: +bestS.toFixed(3), margin: +(bestS - runnerUp).toFixed(3), class: cls,
    alreadyDone: cls === 'NONE' ? false : doneSet.has(best.name),
  });
}

// ── ordered, de-duplicated folder work list ─────────────────────────────────────
const seen = new Set();
const order = [];
for (const cls of ['HIGH', 'MEDIUM']) {
  for (const r of results.filter((x) => x.class === cls).sort((a, b) => b.score - a.score)) {
    if (!r.match || seen.has(r.match) || doneSet.has(r.match)) continue;
    seen.add(r.match);
    order.push({ folder: r.match, priority: cls, konspekt_subject: r.konspekt_subject,
      faculty_hint: r.faculty_hint, course: r.course, konspekt_title: r.title, score: r.score });
  }
}
for (const f of ready) {
  if (seen.has(f.name) || doneSet.has(f.name)) continue;
  seen.add(f.name);
  order.push({ folder: f.name, priority: 'REST', konspekt_subject: null, faculty_hint: null, course: null, konspekt_title: null, score: 0 });
}

const counts = { HIGH: 0, MEDIUM: 0, NONE: 0 };
results.forEach((r) => counts[r.class]++);
const matchedFolders = new Set(results.filter((r) => r.match).map((r) => r.match));
const toProcess = [...matchedFolders].filter((f) => !doneSet.has(f));

const summary = {
  konspektEntries: results.length,
  HIGH: counts.HIGH, MEDIUM: counts.MEDIUM, NONE: counts.NONE,
  distinctFoldersMatched: matchedFolders.size,
  matchedFoldersNotYetProcessed: toProcess.length,
  matchedFoldersAlreadyDone: matchedFolders.size - toProcess.length,
  orderQueue: { HIGH: order.filter((o) => o.priority === 'HIGH').length,
                MEDIUM: order.filter((o) => o.priority === 'MEDIUM').length,
                REST: order.filter((o) => o.priority === 'REST').length, total: order.length },
};

writeFileSync(OUT, JSON.stringify({ summary, order, results }, null, 1), 'utf8');
console.log(JSON.stringify(summary, null, 2));
console.log('\n--- 20 sample HIGH ---');
results.filter((r) => r.class === 'HIGH').slice(0, 20)
  .forEach((r) => console.log(`  ${r.title} (${r.year})  ->  ${r.match}   [${r.score}]`));
console.log('\n--- 20 sample MEDIUM ---');
results.filter((r) => r.class === 'MEDIUM').slice(0, 20)
  .forEach((r) => console.log(`  ${r.title} (${r.year})  ->  ${r.match}   [${r.score}]`));
console.log('\nwrote', OUT);
