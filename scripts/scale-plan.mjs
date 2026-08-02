/**
 * scripts/scale-plan.mjs — DRY RUN library-scale planner (throwaway spike).
 *
 * Walks every folder directly under the Knigi share using METADATA ONLY (names +
 * file sizes; no page content is read), buckets each folder, and previews
 * folder-name classification for the first 30 READY_FULLBOOK folders via the
 * EXISTING /api/classify route. Copies nothing, OCRs nothing, ingests nothing.
 *
 * Output: scripts/scale-plan-output.json (gitignored) + a printed summary.
 *
 * Run with the dev server up (for /api/classify). ~10 min (SMB walk dominates).
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const SHARE = '\\\\192.168.172.177\\Scan\\EXT_PAGES\\Knigi';
const SCRATCH = 'C:/ocr-scratch';
const NDJSON = SCRATCH + '/scale-walk.ndjson';
const OUT = resolve(__dirname, 'scale-plan-output.json');
const CLASSIFY_URL = 'http://localhost:3000/api/classify';

// ── 1. PowerShell walk (fast: Get-ChildItem returns sizes inline over SMB) ──────
const PS = `
$ErrorActionPreference = 'SilentlyContinue'
$root = '${SHARE}'
$out = '${NDJSON}'
if (Test-Path $out) { Remove-Item $out -Force }
$sw = New-Object IO.StreamWriter($out, $false, [Text.UTF8Encoding]::new($false))
$dirs = Get-ChildItem -LiteralPath $root -Directory
foreach ($d in $dirs) {
  $items = Get-ChildItem -LiteralPath $d.FullName -Force
  $files = @($items | Where-Object { -not $_.PSIsContainer } | ForEach-Object { ,@($_.Name, [int64]$_.Length) })
  $subs  = @($items | Where-Object { $_.PSIsContainer } | ForEach-Object { $_.Name })
  $obj = [ordered]@{ name = $d.Name; files = $files; dirs = $subs }
  $sw.WriteLine(($obj | ConvertTo-Json -Compress -Depth 4))
}
$sw.Close()
Write-Output ("WALK_DONE folders=" + $dirs.Count)
`;
const walkStart = Date.now();
if (!existsSync(NDJSON) || process.env.REWALK) {
  console.error('[walk] starting PowerShell SMB walk...');
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS], { encoding: 'utf8', maxBuffer: 1 << 26 });
  console.error('[walk]', (r.stdout || '').trim(), (r.stderr || '').trim().slice(0, 300));
} else {
  console.error('[walk] reusing existing', NDJSON);
}
console.error(`[walk] done in ${((Date.now() - walkStart) / 1000).toFixed(0)}s`);

// ── 2. Parse + bucket ───────────────────────────────────────────────────────────
const lines = readFileSync(NDJSON, 'utf8').split('\n').filter((l) => l.trim());
const IMG = new Set(['.jpg', '.jpeg', '.png', '.tif', '.tiff']);
const extOf = (n) => { const i = n.lastIndexOf('.'); return i < 0 ? '' : n.slice(i).toLowerCase(); };

function detectSeries(pdfs) {
  const groups = {};
  for (const p of pdfs) {
    const m = p.n.match(/^(.*?)(\d{3,})\.pdf$/i);
    if (!m) continue;
    (groups[m[1]] ??= []).push({ num: parseInt(m[2], 10), name: p.n });
  }
  let best = null, bestPre = null;
  for (const pre in groups) if (!best || groups[pre].length > best.length) { best = groups[pre]; bestPre = pre; }
  if (!best || best.length < 5) return null;
  const nums = best.map((x) => x.num).sort((a, b) => a - b);
  const min = nums[0], max = nums[nums.length - 1];
  const present = new Set(nums);
  const gaps = [];
  for (let i = min; i <= max; i++) if (!present.has(i)) gaps.push(i);
  return { prefix: bestPre, count: best.length, min, max, gaps, names: new Set(best.map((x) => x.name)) };
}

function detectFullBook(pdfs, seriesNames, totalBytes) {
  const cands = pdfs.filter((p) => !(seriesNames && seriesNames.has(p.n)) && !/^(.*?)(\d{3,})\.pdf$/i.test(p.n));
  const big = cands.filter((p) => totalBytes > 0 && p.s / totalBytes >= 0.30).sort((a, b) => b.s - a.s);
  return big[0] || null;
}

const plan = [];
for (const line of lines) {
  let o; try { o = JSON.parse(line); } catch { continue; }
  const files = (o.files || []).map((f) => ({ n: f[0], s: f[1] }));
  const dirs = o.dirs || [];
  const totalBytes = files.reduce((a, b) => a + b.s, 0);
  const pdfs = files.filter((f) => extOf(f.n) === '.pdf');
  const images = files.filter((f) => IMG.has(extOf(f.n)));
  const series = detectSeries(pdfs);
  const fullBook = detectFullBook(pdfs, series?.names, totalBytes);
  const pageBytes = series ? pdfs.filter((p) => series.names.has(p.n)).reduce((a, b) => a + b.s, 0) : 0;

  let bucket, note = '';
  if (dirs.length > 0 && series) { bucket = 'NESTED'; note = `book series + ${dirs.length} book subfolder(s): ${dirs.slice(0, 3).join(', ')}`; }
  else if (dirs.length > 0) { bucket = 'CONTAINER'; note = `${dirs.length} subfolders${files.length ? `, +${files.length} loose file(s)` : ''}`; }
  else if (series && fullBook) { bucket = 'READY_FULLBOOK'; }
  else if (series && !fullBook) { bucket = 'READY_PAGES_ONLY'; }
  else if (images.length >= 5 && images.length >= pdfs.length) { bucket = 'IMAGE_DUMP'; note = `${images.length} images`; }
  else if (files.length <= 10) { bucket = 'STUB'; note = `${files.length} loose file(s), no series`; }
  else { bucket = 'OTHER'; note = `${files.length} files, ${pdfs.length} pdf, no series, no full-book`; }

  plan.push({
    name: o.name, bucket, note,
    fileCount: files.length, subdirCount: dirs.length, totalBytes,
    pageCount: series ? series.count : 0,
    pageRange: series ? `${series.min}..${series.max}` : null,
    gaps: series ? series.gaps : [],
    fullBookName: fullBook ? fullBook.n : null,
    fullBookBytes: fullBook ? fullBook.s : 0,
    pageBytes,
    subdirs: dirs.slice(0, 8),
  });
}

// ── 3. Classify preview: first 30 READY_FULLBOOK folder NAMES ───────────────────
const readyFull = plan.filter((p) => p.bucket === 'READY_FULLBOOK');
const preview = [];
for (const p of readyFull.slice(0, 30)) {
  try {
    const res = await fetch(CLASSIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: p.name }) });
    const j = await res.json();
    preview.push({ folder: p.name, faculty_id: j.faculty_id, specialty_id: j.specialty_id, subject: j.subject, confidence: j.confidence });
  } catch (e) {
    preview.push({ folder: p.name, error: String(e).slice(0, 80) });
  }
}

// ── 4. Summary ──────────────────────────────────────────────────────────────────
const GB = (b) => (b / 1073741824).toFixed(2);
const buckets = {};
for (const p of plan) (buckets[p.bucket] ??= []).push(p);
const rfPages = readyFull.map((p) => p.pageCount);
const totalRfPages = rfPages.reduce((a, b) => a + b, 0);
const dist = { '1-100': 0, '101-300': 0, '301-600': 0, '601-1000': 0, '1000+': 0 };
for (const n of rfPages) {
  if (n <= 100) dist['1-100']++; else if (n <= 300) dist['101-300']++;
  else if (n <= 600) dist['301-600']++; else if (n <= 1000) dist['601-1000']++; else dist['1000+']++;
}
const summary = {
  totalFolders: plan.length,
  bucketCounts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])),
  READY_FULLBOOK: {
    count: readyFull.length,
    downloadVolumeGB: GB(readyFull.reduce((a, p) => a + p.fullBookBytes, 0)),
    totalPages: totalRfPages,
    pageDistribution: dist,
    ocrHoursAt1_5s: (totalRfPages * 1.5 / 3600).toFixed(1),
    ocrHoursAt2s: (totalRfPages * 2 / 3600).toFixed(1),
  },
  READY_PAGES_ONLY: {
    count: (buckets.READY_PAGES_ONLY || []).length,
    pageVolumeGB: GB((buckets.READY_PAGES_ONLY || []).reduce((a, p) => a + p.pageBytes, 0)),
    totalPages: (buckets.READY_PAGES_ONLY || []).reduce((a, p) => a + p.pageCount, 0),
  },
  immediatelyProcessable: readyFull.length,
  needSpecialHandling: plan.length - readyFull.length,
  classifyPreview: preview,
};

writeFileSync(OUT, JSON.stringify({ summary, plan }, null, 1), 'utf8');
console.log(JSON.stringify(summary, null, 2));
console.log('\nfull per-folder plan ->', OUT);
