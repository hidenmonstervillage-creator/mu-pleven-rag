/**
 * scripts/scale-run.mjs — LIVE batch runner (throwaway spike), capped at 20 books.
 *
 * Wraps the PROVEN streaming cycle around the READY_FULLBOOK list from the dry run:
 *   detect full-book PDF by SIZE -> copy -> ocrmypdf bul+eng -> (gs compress if >50MB)
 *   -> Hetzner upload (panel path) -> /api/ingest -> verify -> checkpoint -> wipe scratch
 *
 * WRITES REAL DOCUMENTS TO PRODUCTION. Resumable: scripts/scale-checkpoint.json is
 * loaded on start and completed folders are skipped, updated after each success.
 *
 * The classifier is deliberately NOT called. Placeholder triple:
 *   faculty_id = specialty_id = 'UNSORTED', subject = folder name verbatim.
 * Those rows are inert for retrieval (match_chunks needs an exact 3-way match and no
 * user ever selects these values) and trivially findable for the konspekt remap later.
 *
 * Requires the dev server on :3000 for /api/ingest. Does NOT modify the ingest pipeline.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHARE = '\\\\192.168.172.177\\Scan\\EXT_PAGES\\Knigi';
const SCRATCH = 'C:\\ocr-scratch\\run';
const CHECKPOINT = resolve(__dirname, 'scale-checkpoint.json');
const PLAN = resolve(__dirname, 'scale-plan-output.json');
const SKIPLIST = resolve(__dirname, 'scale-skiplist.json');   // folders permanently skipped (e.g. 413 oversized)
const LIMIT = 4;   // per-session cap, counted in NEW books (completed + skiplisted excluded first)
                   // EXACTLY the konspekt tier remainder measured live on 2026-07-30:
                   // HIGH 2 + MEDIUM 2 = 4. Deliberately stops at the end of the konspekt
                   // set and does NOT spill into REST (901 books). All four are retries of
                   // VPN-drop casualties from the previous session.
const MIN_FREE_GB = 12;
const COMPRESS_OVER_MB = 50;   // CLAUDE.md runbook: recompress before upload
const UPLOAD_ATTEMPTS = 3;     // retries when the upload returns 2xx with a non-JSON body
const UPLOAD_RETRY_MS = 4000;  // linear backoff: 4s, 8s
const OCR_TIMEOUT_MS = 150 * 60000;  // kill a wedged ocrmypdf (sleep/hibernation) after 150 min

const TESS = 'C:\\Users\\MIsho\\AppData\\Local\\Temp\\claude\\C--Users-MIsho-DKC-1-AI-reception-CRM\\23052c26-346a-4dd7-a92b-fc4f265cb37d\\scratchpad\\tessdata';
const PY = 'C:\\Users\\MIsho\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';
const GS = 'C:\\Program Files\\gs\\gs10.07.1\\bin\\gswin64c.exe';
const TESS_BIN = 'C:\\Program Files\\Tesseract-OCR';
const GS_BIN = 'C:\\Program Files\\gs\\gs10.07.1\\bin';
const PDFTOTEXT = 'C:\\Program Files\\Git\\mingw64\\bin\\pdftotext.exe';

// ── env ─────────────────────────────────────────────────────────────────────────
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
const HET_URL = E.HETZNER_UPLOAD_URL || E.NEXT_PUBLIC_HETZNER_UPLOAD_URL;
const HET_KEY = E.HETZNER_API_KEY || E.NEXT_PUBLIC_HETZNER_API_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

// ── helpers ─────────────────────────────────────────────────────────────────────
const MB = (b) => (b / 1048576).toFixed(1);
function freeGB() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', '(Get-PSDrive C).Free'], { encoding: 'utf8' });
  return parseFloat(r.stdout.trim()) / 1073741824;
}
// Transliterate Cyrillic -> ASCII slug (mirrors admin/page.tsx toStorageSlug)
function toStorageSlug(text) {
  const map = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'ts',ч:'ch',ш:'sh',щ:'sht',ъ:'a',ь:'',ю:'yu',я:'ya' };
  return text.toLowerCase().split('').map((c) => map[c] ?? c).join('')
    .replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}
// Full-book detection by SIZE, handling BOTH page-naming conventions.
function detectFullBook(dir) {
  const files = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => { try { return { n: e.name, s: statSync(join(dir, e.name)).size }; } catch { return { n: e.name, s: 0 }; } });
  const total = files.reduce((a, b) => a + b.s, 0);
  const pdfs = files.filter((f) => /\.pdf$/i.test(f.n));
  const trailing = {}, leading = {};
  for (const p of pdfs) {
    let m = p.n.match(/^(.*?)(\d{3,})\.pdf$/i);
    if (m) { (trailing[m[1]] ??= []).push(p); continue; }
    m = p.n.match(/^(\d{1,4})[_-](.*)\.pdf$/i);          // 100_pdfsam_X_FullText.pdf
    if (m) { (leading[m[2]] ??= []).push(p); continue; }
  }
  const pageSet = new Set();
  for (const g of [...Object.values(trailing), ...Object.values(leading)]) if (g.length >= 5) g.forEach((p) => pageSet.add(p.n));
  const cands = pdfs.filter((p) => !pageSet.has(p.n) && total > 0 && p.s / total >= 0.30).sort((a, b) => b.s - a.s);
  return { fullBook: cands[0] || null, totalBytes: total, pageFiles: pageSet.size };
}
// Ghostscript recompress at a given PDFSETTINGS level. /ebook = 150dpi (default path),
// /screen = 72dpi (the 413 fallback — visibly lower image quality, text layer untouched).
function gsCompress(inFile, outFile, level, dpi) {
  const g = spawnSync(GS, ['-sDEVICE=pdfwrite', '-dCompatibilityLevel=1.5', `-dPDFSETTINGS=/${level}`,
    '-dNOPAUSE', '-dBATCH', '-dQUIET',
    `-dColorImageResolution=${dpi}`, `-dGrayImageResolution=${dpi}`, `-dMonoImageResolution=${dpi * 2}`,
    `-sOutputFile=${outFile}`, inFile], { encoding: 'utf8', timeout: 45 * 60000 });
  return g.status === 0 && existsSync(outFile);
}
// Extract the text layer and measure it. Returns {alpha, cyr} character counts.
function textStats(file) {
  const r = spawnSync(PDFTOTEXT, ['-enc', 'UTF-8', file, '-'], { encoding: 'buffer', maxBuffer: 1 << 28 });
  const txt = r.stdout ? r.stdout.toString('utf8') : '';
  let alpha = 0, cyr = 0;
  for (const ch of txt) {
    if (!/\p{L}/u.test(ch)) continue;
    alpha++;
    if (ch >= 'Ѐ' && ch <= 'ӿ') cyr++;
  }
  return { alpha, cyr };
}
// Did recompression preserve the OCR text layer? Page count must be identical and the
// extracted text volume must be essentially unchanged.
// NOTE: we compare TEXT VOLUME rather than requiring Cyrillic, because several of the
// oversized flagship books (Guyton, Molecular Cell Biology, Organic Chemistry) are
// English-only — a Cyrillic-presence test would wrongly reject them. Cyrillic count is
// still reported so Bulgarian books are visibly verified.
function verifyTextLayer(file, expectedPages, baseline) {
  const pages = pdfPages(file);
  if (pages !== expectedPages) return { ok: false, why: `page count ${pages} != ${expectedPages}`, pages };
  const t = textStats(file);
  if (t.alpha < 50) return { ok: false, why: `text layer empty after recompress (alpha=${t.alpha})`, ...t };
  if (baseline && baseline.alpha > 0 && t.alpha < baseline.alpha * 0.9) {
    return { ok: false, why: `text shrank ${baseline.alpha}→${t.alpha} chars (<90%)`, ...t };
  }
  return { ok: true, pages, ...t };
}

function pdfPages(file) {
  const r = spawnSync(PY, ['-c', 'import pikepdf,sys;print(len(pikepdf.open(sys.argv[1]).pages))', file], { encoding: 'utf8' });
  const n = parseInt((r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}
function wipeScratch() {
  try { rmSync(SCRATCH, { recursive: true, force: true }); } catch {}
  mkdirSync(SCRATCH, { recursive: true });
}
// Is the SMB share reachable? A VPN drop makes this throw instead of hanging forever.
function shareReachable() {
  try { readdirSync(SHARE); return true; } catch { return false; }
}
// The share drops frequently and transiently (observed: gone 24s after a healthy probe,
// back minutes later). Rather than ending a whole unattended session on a blip, sleep-poll
// for it to return. This does NOT spin on errors — it waits quietly and logs. If the share
// is genuinely gone for the full window, we fall through to the same clean stop as before.
const SHARE_WAIT_MIN = 360;         // 6 h — an overnight drop can self-recover instead of losing the night
async function waitForShare(tag) {
  const probeMs = 30000, maxProbes = Math.ceil((SHARE_WAIT_MIN * 60000) / probeMs);
  console.log(`${tag} share unreachable — waiting up to ${(SHARE_WAIT_MIN / 60).toFixed(0)}h for it to return...`);
  for (let p = 1; p <= maxProbes; p++) {
    await new Promise((r) => setTimeout(r, probeMs));
    if (shareReachable()) {
      console.log(`${tag} share is BACK after ${((p * probeMs) / 60000).toFixed(1)} min — resuming`);
      return true;
    }
    // every 10 min (20 probes) — at 6 h that's ~36 lines, not 720
    if (p % 20 === 0) console.log(`${tag}   ...still down after ${((p * probeMs) / 60000).toFixed(0)} min`);
  }
  return false;
}
// ocrmypdf cleans its temp dir on normal exit but NOT when killed, so every
// interrupted run leaks a multi-GB "ocrmypdf.io.*" dir. Sweep orphans at startup
// (safe: none of our own ocrmypdf children exist yet at this point).
function sweepOrphanTemp() {
  const tmp = process.env.TEMP || process.env.TMP;
  if (!tmp) return 0;
  let freed = 0;
  for (const d of readdirSync(tmp, { withFileTypes: true })) {
    if (!d.isDirectory() || !d.name.startsWith('ocrmypdf.io.')) continue;
    try { rmSync(join(tmp, d.name), { recursive: true, force: true }); freed++; } catch {}
  }
  return freed;
}
// Network / share-loss signatures worth stopping on rather than retrying 100 times.
const NET_ERR = /ENOENT|ENETUNREACH|EHOSTUNREACH|ENETDOWN|ECONNRESET|ETIMEDOUT|EIO|network path|not reachable|fetch failed/i;

// Self-heal for the orphan class: the ingest server can create the doc + chunks and
// THEN the client fetch throws (VPN drop losing the response). Before treating a book
// as failed, ask Supabase whether it actually landed (subject=folder, faculty=UNSORTED,
// chunks>0). If so, checkpoint it instead of orphaning + re-ingesting a duplicate later.
// Uses only Supabase (cloud) — works even while the SMB share is unreachable.
// POLLS rather than checking once: /api/ingest inserts the documents row FIRST, then
// embeds (minutes), then inserts chunks. A client timeout mid-embed would otherwise see
// doc-with-0-chunks, return null, and orphan a book whose chunks land seconds later.
// Retries give the server time to finish before we call it a failure.
async function reconcileFromDB(folder, meta, H, SUPA, attempts = 6, delayMs = 30000) {
  for (let a = 0; a < attempts; a++) {
    try {
      const rows = await (await fetch(`${SUPA}/rest/v1/documents?faculty_id=eq.UNSORTED&subject=eq.${encodeURIComponent(folder)}&select=id,page_count`, { headers: H })).json();
      if (Array.isArray(rows) && rows.length > 0) {
        const doc = rows[0];
        const r = await fetch(`${SUPA}/rest/v1/chunks?document_id=eq.${doc.id}&select=id&limit=1`, { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
        const n = parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
        if (n > 0) return { documentId: doc.id, chunks: n, pages: doc.page_count, waitedSec: (a * delayMs) / 1000 };
      }
    } catch { /* transient — keep polling */ }
    if (a < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return null;
}

// ── load work queue + checkpoint ────────────────────────────────────────────────
// Priority order comes from konspekt-match-output.json when present:
//   HIGH konspekt matches -> MEDIUM -> everything else in READY_FULLBOOK.
const MATCH = resolve(__dirname, 'konspekt-match-output.json');
let ready;
if (existsSync(MATCH)) {
  const order = JSON.parse(readFileSync(MATCH, 'utf8')).order;
  ready = order.map((o) => ({ name: o.folder, priority: o.priority,
    konspekt_subject: o.konspekt_subject, faculty_hint: o.faculty_hint,
    course: o.course, konspekt_title: o.konspekt_title }));
  console.log(`[scale-run] konspekt priority order loaded: ` +
    `HIGH=${order.filter((o) => o.priority === 'HIGH').length} ` +
    `MEDIUM=${order.filter((o) => o.priority === 'MEDIUM').length} ` +
    `REST=${order.filter((o) => o.priority === 'REST').length}`);
} else {
  const plan = JSON.parse(readFileSync(PLAN, 'utf8')).plan;
  ready = plan.filter((p) => p.bucket === 'READY_FULLBOOK').map((p) => ({ name: p.name, priority: 'REST' }));
}
let ckpt = existsSync(CHECKPOINT) ? JSON.parse(readFileSync(CHECKPOINT, 'utf8')) : { completed: [] };
const done = new Set(ckpt.completed.map((c) => c.folder));

// Skiplist: folders permanently excluded (oversized 413s etc.), batch-fixed later.
let skip = existsSync(SKIPLIST) ? JSON.parse(readFileSync(SKIPLIST, 'utf8')) : { skipped: [] };
const skipSet = new Set(skip.skipped.map((s) => s.folder));
function addToSkiplist(folder, reason) {
  if (skipSet.has(folder)) return;
  skip.skipped.push({ folder, reason, at: new Date().toISOString() });
  skipSet.add(folder);
  writeFileSync(SKIPLIST, JSON.stringify(skip, null, 1), 'utf8');
}

// Drop already-completed AND skiplisted folders BEFORE applying the cap, so LIMIT
// counts NEW books (otherwise a resumed session burns its cap on SKIP lines).
const remainingAll = ready.filter((r) => !done.has(r.name) && !skipSet.has(r.name));
ready = LIMIT > 0 ? remainingAll.slice(0, LIMIT) : remainingAll;
console.log(`[scale-run] ${done.size} checkpointed, ${skipSet.size} skiplisted; ${remainingAll.length} remaining in queue; ` +
  `this session will process ${ready.length} (HIGH=${ready.filter((r) => r.priority === 'HIGH').length} ` +
  `MEDIUM=${ready.filter((r) => r.priority === 'MEDIUM').length} REST=${ready.filter((r) => r.priority === 'REST').length})`);

const failed = [];
const t0 = Date.now();
let stopReason = 'reached cap';
let consecutiveFailures = 0;

const swept = sweepOrphanTemp();
if (swept) console.log(`[scale-run] swept ${swept} orphaned ocrmypdf temp dir(s) from a previous kill`);
console.log(`[scale-run] C: ${freeGB().toFixed(1)} GB free at start`);

for (let i = 0; i < ready.length; i++) {
  const folder = ready[i].name;
  const tag = `[${i + 1}/${ready.length}]`;
  if (done.has(folder)) { console.log(`${tag} ${folder} → SKIP (checkpointed)`); continue; }
  if (skipSet.has(folder)) { console.log(`${tag} ${folder} → SKIP (skiplisted)`); continue; }

  // 1. precheck — disk, then share reachability (VPN drop), then failure circuit-breaker
  const gb = freeGB();
  if (gb < MIN_FREE_GB) {
    stopReason = `LOW DISK: C: only ${gb.toFixed(2)} GB free (< ${MIN_FREE_GB} GB required)`;
    console.log(`${tag} STOPPING — ${stopReason}`);
    break;
  }
  if (!shareReachable() && !(await waitForShare(tag))) {
    stopReason = `SHARE UNREACHABLE for ${SHARE_WAIT_MIN}+ min: \\\\192.168.172.177\\Scan not readable (VPN down)`;
    console.log(`${tag} STOPPING — ${stopReason}`);
    break;
  }
  if (consecutiveFailures >= 5) {
    stopReason = `ABORTED: ${consecutiveFailures} consecutive book failures — something is systematically wrong`;
    console.log(`${tag} STOPPING — ${stopReason}`);
    break;
  }

  wipeScratch();
  const bookStart = Date.now();
  const failedBefore = failed.length;
  try {
    // 2. detect
    const dir = join(SHARE, folder);
    const { fullBook, totalBytes } = detectFullBook(dir);
    if (!fullBook) { failed.push({ folder, reason: 'no full-book PDF detected' }); console.log(`${tag} ${folder} → FAILED: no full-book PDF`); continue; }
    const pct = ((100 * fullBook.s) / totalBytes).toFixed(0);

    // 3. copy
    const local = join(SCRATCH, 'book.pdf');
    copyFileSync(join(dir, fullBook.n), local);

    // 4. OCR
    const ocrOut = join(SCRATCH, 'book-ocr.pdf');
    const ocrStart = Date.now();
    // timeout: hibernation/sleep can wedge ocrmypdf so it never returns — spawnSync would
    // then block forever and the share-wait (which only runs at loop boundaries) never fires.
    // Observed worst legitimate case ~1500pp @ ~2.5 s/pg ≈ 62 min, so 150 min only ever
    // kills a genuine hang, never a slow book.
    const oc = spawnSync(PY, ['-m', 'ocrmypdf', '-l', 'bul+eng', '--force-ocr', '--oversample', '300',
      '--optimize', '1', '--jobs', '8', local, ocrOut], {
      encoding: 'utf8', maxBuffer: 1 << 26, timeout: OCR_TIMEOUT_MS, killSignal: 'SIGKILL',
      env: { ...process.env, TESSDATA_PREFIX: TESS, PATH: `${TESS_BIN};${GS_BIN};${process.env.PATH}` },
    });
    if (oc.error && (oc.error.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(oc.error)))) {
      failed.push({ folder, reason: `ocrmypdf HUNG — killed after ${OCR_TIMEOUT_MS / 60000} min (sleep/hibernation?)` });
      console.log(`${tag} ${folder} → FAILED: ocrmypdf hung, killed after ${OCR_TIMEOUT_MS / 60000} min`);
      continue;
    }
    if (oc.status !== 0 || !existsSync(ocrOut)) {
      const msg = (oc.stderr || '').trim().split('\n').slice(-3).join(' | ').slice(0, 200);
      failed.push({ folder, reason: `ocrmypdf exit ${oc.status}: ${msg}` });
      console.log(`${tag} ${folder} → FAILED ocr: ${msg}`);
      continue;
    }
    const ocrSecs = (Date.now() - ocrStart) / 1000;
    const realPages = pdfPages(ocrOut);
    const spp = realPages ? (ocrSecs / realPages).toFixed(2) : '?';

    // 4b. compress if large (CLAUDE.md runbook; text layer survives)
    let upload = ocrOut;
    if (statSync(ocrOut).size > COMPRESS_OVER_MB * 1048576) {
      const small = join(SCRATCH, 'book-final.pdf');
      if (gsCompress(ocrOut, small, 'ebook', 150) && pdfPages(small) === realPages) upload = small;
    }

    // 5. placeholder triple (NO classifier)
    const facultyId = 'UNSORTED', specialtyId = 'UNSORTED', subject = folder;
    const filename = `${folder}.pdf`;

    // 6. upload via panel's Hetzner multipart path
    const postFile = async (file) => {
      const buf = readFileSync(file);
      const fd = new FormData();
      fd.append('facultyId', toStorageSlug(facultyId));
      fd.append('specialtyId', toStorageSlug(specialtyId));
      fd.append('subject', toStorageSlug(subject));
      fd.append('file', new Blob([buf], { type: 'application/pdf' }), filename);
      const r = await fetch(HET_URL, { method: 'POST', headers: { 'x-api-key': HET_KEY }, body: fd });
      return { ok: r.ok, status: r.status, r };
    };

    // A 2xx response whose body is an nginx/proxy HTML error page used to reach
    // `await up.r.json()` and throw "SyntaxError: Unexpected token '<', \"<!DOCTYPE \"",
    // which killed the book outright — 1992_Anatomy and physiology died this way after a
    // full download + ~45 min OCR. Check the content type, and treat a non-JSON body as a
    // TRANSIENT upload failure worth retrying rather than a fatal one.
    const postFileChecked = async (file, what) => {
      let last = null;
      for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
        const res = await postFile(file);
        if (!res.ok) {                       // real HTTP status error (413 etc.) — caller decides
          const raw = await res.r.text().catch(() => '');
          return { ...res, body: null, raw };
        }
        const ct = (res.r.headers.get('content-type') || '').toLowerCase();
        const raw = await res.r.text();
        const looksJson = ct.includes('application/json') || /^\s*[{[]/.test(raw);
        if (looksJson) {
          try {
            const json = JSON.parse(raw);
            if (json && json.url) return { ...res, body: json, raw };
            last = { why: 'JSON without a url field', ct, raw };
          } catch (e) { last = { why: `JSON parse failed: ${e.message}`, ct, raw }; }
        } else {
          last = { why: 'non-JSON body on a 2xx response (proxy/nginx error page?)', ct: ct || '(none)', raw };
        }
        console.log(`${tag} ${folder} — ${what} attempt ${attempt}/${UPLOAD_ATTEMPTS} unusable: ${last.why}` +
          ` [content-type: ${last.ct}] first 120 chars: ${last.raw.replace(/\s+/g, ' ').slice(0, 120)}`);
        if (attempt < UPLOAD_ATTEMPTS) await new Promise((r) => setTimeout(r, UPLOAD_RETRY_MS * attempt));
      }
      return { ok: false, status: 0, r: null, body: null, raw: last?.raw ?? '', nonJson: true, why: last?.why };
    };

    let up = await postFileChecked(upload, 'upload');
    let usedScreenFallback = false;

    // ── 413 FALLBACK ─────────────────────────────────────────────────────────
    // The size check only happens here, at the END of a ~45-min cycle, so simply
    // skiplisting a 413 throws away the whole download+OCR. Instead recompress the
    // OCR output harder (/screen, 72dpi — from ocrOut, NOT from the already-/ebook
    // file, so quality loss doesn't compound), verify the text layer survived, and
    // retry ONCE. Only skiplist if that also 413s.
    if (!up.ok && up.status === 413) {
      const before = statSync(upload).size;
      console.log(`${tag} ${folder} — upload 413 at ${MB(before)}MB; trying /screen 72dpi fallback...`);
      const screenFile = join(SCRATCH, 'book-screen.pdf');
      const baseline = textStats(upload);
      if (!gsCompress(ocrOut, screenFile, 'screen', 72)) {
        console.log(`${tag} ${folder} — /screen recompress FAILED`);
      } else {
        const v = verifyTextLayer(screenFile, realPages, baseline);
        if (!v.ok) {
          console.log(`${tag} ${folder} — /screen REJECTED: ${v.why} (text layer must survive)`);
        } else {
          console.log(`${tag} ${folder} — /screen OK: ${MB(before)}MB → ${MB(statSync(screenFile).size)}MB, ` +
            `${v.pages}pp, text ${baseline.alpha}→${v.alpha} chars (cyrillic ${v.cyr}); retrying upload`);
          up = await postFileChecked(screenFile, 'upload(/screen)');
          if (up.ok) { upload = screenFile; usedScreenFallback = true; }
        }
      }
    }

    if (!up.ok) {
      const t = up.raw ?? '';
      if (up.nonJson) {
        // Deliberately NOT skiplisted: the OCR output is fine and the endpoint was
        // misbehaving, so this book should be retried in a later session rather than
        // permanently excluded.
        failed.push({ folder, reason: `upload returned a non-JSON body after ${UPLOAD_ATTEMPTS} attempts: ${up.why}` });
        console.log(`${tag} ${folder} → FAILED upload: ${up.why} (retried ${UPLOAD_ATTEMPTS}x, NOT skiplisted — retry next session)`);
        continue;
      }
      failed.push({ folder, reason: `upload HTTP ${up.status}: ${t.slice(0, 150)}` });
      if (up.status === 413) {
        // still too large even at 72dpi — genuinely needs the nginx limit raised
        addToSkiplist(folder, '413_oversized_after_screen_fallback');
        console.log(`${tag} ${folder} → FAILED upload 413 EVEN AFTER /screen → skiplisted`);
      } else {
        console.log(`${tag} ${folder} → FAILED upload ${up.status}`);
      }
      continue;
    }
    const storageUrl = up.body.url;

    // 7. ingest via the existing route
    const ing = await fetch('http://localhost:3000/api/ingest', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ storageUrl, filename, facultyId, specialtyId, subject, fileType: 'textbook' }),
    });
    // Same content-type guard as the upload. NOT retried, deliberately: /api/ingest is not
    // idempotent, so a blind retry on an ambiguous response risks a duplicate document.
    // reconcileFromDB() below already recovers a document that ingested but whose response
    // we failed to read, so failing loudly here is the safe direction.
    const ingCt = (ing.headers.get('content-type') || '').toLowerCase();
    const ingRaw = await ing.text();
    let ingJson = null;
    if (ingCt.includes('application/json') || /^\s*[{[]/.test(ingRaw)) {
      try { ingJson = JSON.parse(ingRaw); } catch { /* handled below */ }
    }
    if (!ingJson) {
      failed.push({ folder, reason: `ingest returned a non-JSON body [${ingCt || 'no content-type'}]: ${ingRaw.replace(/\s+/g, ' ').slice(0, 150)}` });
      console.log(`${tag} ${folder} → FAILED ingest: non-JSON response [${ingCt || 'no content-type'}] — ${ingRaw.replace(/\s+/g, ' ').slice(0, 120)}`);
      continue;
    }
    if (!ing.ok || !ingJson.success) { failed.push({ folder, reason: `ingest: ${ingJson.error ?? ing.status}` }); console.log(`${tag} ${folder} → FAILED ingest: ${ingJson.error ?? ing.status}`); continue; }
    const { documentId, chunksCreated } = ingJson;

    // 8. verify
    if (!chunksCreated || chunksCreated === 0) {
      failed.push({ folder, reason: 'ingest produced 0 chunks (scratch kept)', documentId });
      console.log(`${tag} ${folder} → FAILED: 0 chunks (scratch kept)`);
      continue; // keep scratch for inspection
    }
    // page_count sync is BEST-EFFORT and must never un-do a successful ingest:
    // if a post-ingest fetch throws (e.g. VPN dropping), the doc + chunks already
    // exist, so we still checkpoint. Otherwise the book gets re-ingested next run
    // as a duplicate. (This exact case produced 2 orphans before the fix.)
    let pageCount = realPages;
    try {
      const drow = await (await fetch(`${SUPA}/rest/v1/documents?id=eq.${documentId}&select=page_count`, { headers: H })).json();
      pageCount = drow?.[0]?.page_count ?? 0;
      if (!pageCount && realPages) {
        await fetch(`${SUPA}/rest/v1/documents?id=eq.${documentId}`, {
          method: 'PATCH', headers: { ...H, 'Content-Type': 'application/json' }, body: JSON.stringify({ page_count: realPages }),
        });
        pageCount = realPages;
      }
    } catch (e) {
      console.log(`${tag} ${folder} — page_count sync skipped (${String(e).slice(0, 60)}); ingest OK, checkpointing anyway`);
      pageCount = realPages;
    }

    // 9. checkpoint
    ckpt.completed.push({ folder, documentId, chunks: chunksCreated, pages: realPages, storedPageCount: pageCount,
      // konspekt metadata — recorded for the later remap; ingest still used the UNSORTED placeholder
      priority: ready[i].priority ?? null, konspekt_subject: ready[i].konspekt_subject ?? null,
      faculty_hint: ready[i].faculty_hint ?? null, course: ready[i].course ?? null,
      konspekt_title: ready[i].konspekt_title ?? null,
      pickedFile: fullBook.n, pickedPct: `${pct}%`, ocrSecs: +ocrSecs.toFixed(0), secPerPage: +spp,
      uploadedMB: +MB(statSync(upload).size),
      // true = uploaded at /screen 72dpi after a 413; images are visibly lower quality
      screenFallback: usedScreenFallback || undefined,
      at: new Date().toISOString() });
    writeFileSync(CHECKPOINT, JSON.stringify(ckpt, null, 1), 'utf8');
    done.add(folder);

    console.log(`${tag} ${ready[i].priority ?? 'REST'} ${folder} → ${chunksCreated} chunks, ${spp} s/page, C: ${freeGB().toFixed(1)}GB  [picked "${fullBook.n}" ${pct}%, ${realPages}pp, ${(Date.now() - bookStart) / 1000 | 0}s${usedScreenFallback ? ', ⚠ /screen 72dpi fallback' : ''}]`);
  } catch (err) {
    const msg = String(err);
    // Did the ingest actually complete server-side before the client fetch threw?
    // If so, checkpoint it (self-heal) instead of recording a false failure + orphan.
    const landed = await reconcileFromDB(folder, ready[i], H, SUPA);
    if (landed) {
      ckpt.completed.push({ folder, documentId: landed.documentId, chunks: landed.chunks, pages: landed.pages, storedPageCount: landed.pages,
        priority: ready[i].priority ?? null, konspekt_subject: ready[i].konspekt_subject ?? null,
        faculty_hint: ready[i].faculty_hint ?? null, course: ready[i].course ?? null, konspekt_title: ready[i].konspekt_title ?? null,
        recovered: true, recoveredReason: `client threw (${msg.slice(0, 60)}) but ingest landed; reconciled from DB`, at: new Date().toISOString() });
      writeFileSync(CHECKPOINT, JSON.stringify(ckpt, null, 1), 'utf8');
      done.add(folder);
      console.log(`${tag} ${folder} → RECOVERED ${landed.chunks} chunks (ingest landed despite client error; waited ${landed.waitedSec ?? 0}s)`);
    } else {
      failed.push({ folder, reason: msg.slice(0, 200) });
      console.log(`${tag} ${folder} → FAILED: ${msg.slice(0, 160)}`);
    }
    // A share/network error mid-book means the VPN went away — stop rather than
    // grinding through the rest of the queue throwing the same error.
    if (NET_ERR.test(msg) && !shareReachable()) {
      wipeScratch();                       // free the partial book before a possibly long wait
      if (!(await waitForShare(tag))) {
        stopReason = `SHARE UNREACHABLE mid-book for ${SHARE_WAIT_MIN}+ min (VPN down): ${msg.slice(0, 100)}`;
        console.log(`${tag} STOPPING — ${stopReason}`);
        break;
      }
      // share came back — fall through and continue with the next book
    }
  } finally {
    // 10. cleanup (unless we deliberately kept scratch for a 0-chunk failure)
    if (!failed.some((f) => f.folder === folder && f.reason.startsWith('ingest produced 0'))) wipeScratch();
    if (failed.length > failedBefore) consecutiveFailures++; else consecutiveFailures = 0;
  }
}

// ── final report ────────────────────────────────────────────────────────────────
const totalSecs = (Date.now() - t0) / 1000;
const c = ckpt.completed;
const totalPages = c.reduce((a, b) => a + (b.pages || 0), 0);
const totalChunks = c.reduce((a, b) => a + (b.chunks || 0), 0);
const totalOcr = c.reduce((a, b) => a + (b.ocrSecs || 0), 0);
console.log('\n=== FINAL ===');
console.log(`STOP REASON: ${stopReason}`);
console.log(JSON.stringify({
  stopReason,
  completed: c.length, totalPages, totalChunks,
  avgSecPerPage: totalPages ? +(totalOcr / totalPages).toFixed(2) : null,
  wallMinutes: +(totalSecs / 60).toFixed(1),
  failed, freeGB: +freeGB().toFixed(2),
  scratchEmpty: existsSync(SCRATCH) ? readdirSync(SCRATCH).length === 0 : true,
  skiplistTotal: skip.skipped.length,
  skiplist: skip.skipped.map((s) => `${s.folder} (${s.reason})`),
  screenFallbackBooks: c.filter((b) => b.screenFallback).map((b) => b.folder),
}, null, 1));
console.log('\nper-book:');
c.forEach((b, i) => console.log(` ${i + 1}. ${b.folder} → ${b.documentId} → ${b.chunks} chunks, ${b.pages}pp, ${b.secPerPage}s/pg`));
