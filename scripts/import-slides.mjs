/**
 * scripts/import-slides.mjs
 *
 * Harvest ALL OlyVia slides into the slides table — UNASSIGNED (no slide_subjects rows).
 * Run once, then assign subjects via Admin UI → bulk-assign by folder.
 *
 * Scans two ranges:
 *   1–1500     → Pathology (~175 slides, parents 37–919)
 *   21000–22000 → Anatomy/Cytology (~128 slides, parents 21197–31824)
 *
 * Name resolution:
 *   1. "Record Name" field (clinical name — used by Pathology)
 *   2. data.name stripped of .vsi (VSI filename — used by Anatomy)
 *   If name matches _#_ pattern → parse organ/konspekt/stain.
 *   Otherwise → organ = full name, konspekt/stain = null.
 *
 * Usage:
 *   node scripts/import-slides.mjs            # preview + confirm prompt
 *   node scripts/import-slides.mjs --yes      # skip prompt, write immediately
 *
 * Requires: Node 18+. No extra npm deps.
 */

import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';
import { createInterface } from 'readline/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const YES       = process.argv.includes('--yes');

// ── .env.local parser ─────────────────────────────────────────────────────────
function parseEnvFile(path) {
  let content; try { content = readFileSync(path, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[line.slice(0, eq).trim()] = val;
  }
  return env;
}

const ENV            = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL   = ENV.NEXT_PUBLIC_SUPABASE_URL  ?? '';
const SUPABASE_KEY   = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';
const UPSTREAM       = 'http://194.141.67.249:8085';
const OLYVIA_USER    = ENV.OLYVIA_USER    ?? 'guest';
const OLYVIA_PASS    = ENV.OLYVIA_PASS    ?? 'Host-1234';
const OLYVIA_DB_GUID = ENV.OLYVIA_DB_GUID ?? '5eba802f-e4ba-4e6a-955d-ec04d32bfacf';
const CONCURRENCY    = 5;    // stay under OlyVia rate-limit threshold
const TIMEOUT_MS     = 5000; // per-request abort timeout

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  process.exit(1);
}

// ── OlyVia auth ───────────────────────────────────────────────────────────────

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const s = res.headers.get('set-cookie'); return s ? [s] : [];
}
function extractCookie(list, name) {
  const pat = new RegExp(`${name}=([^;]+)`);
  for (const c of list) { const m = c.match(pat); if (m) return m[1]; }
  return '';
}

async function authenticate() {
  process.stdout.write('  → GET /Account/Login …');
  const pageRes   = await fetch(`${UPSTREAM}/Account/Login`, {
    redirect: 'follow', signal: AbortSignal.timeout(10000),
  });
  const pc        = getSetCookies(pageRes);
  const sessionId = extractCookie(pc, 'ASP\\.NET_SessionId');
  const vtc       = extractCookie(pc, '__RequestVerificationToken');
  const html      = await pageRes.text();
  const fm        = html.match(/__RequestVerificationToken[^>]*type="hidden"[^>]*value="([^"]+)"/)
                 ?? html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
  process.stdout.write(' OK\n');

  process.stdout.write('  → POST /Account/Login …');
  const loginRes = await fetch(`${UPSTREAM}/Account/Login`, {
    method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: `ASP.NET_SessionId=${sessionId}; __RequestVerificationToken=${vtc}`,
    },
    body: new URLSearchParams({
      UserName: OLYVIA_USER, Password: OLYVIA_PASS, Database: OLYVIA_DB_GUID,
      __RequestVerificationToken: fm?.[1] ?? '',
    }).toString(),
  });
  const aspxAuth = extractCookie(getSetCookies(loginRes), '\\.ASPXAUTH');
  if (!aspxAuth) throw new Error('OlyVia login failed — no .ASPXAUTH cookie');
  process.stdout.write(' OK\n');

  const cookies = `ASP.NET_SessionId=${sessionId}; .ASPXAUTH=${aspxAuth}`;

  process.stdout.write('  → POST /api/nis/login …');
  const nisText = await (await fetch(`${UPSTREAM}/api/nis/login`, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Cookie: cookies },
    body: JSON.stringify({ username: OLYVIA_USER, password: OLYVIA_PASS, databaseId: OLYVIA_DB_GUID, domain: '' }),
  })).text();
  const connId = nisText.trim().replace(/^"|"$/g, '');
  if (!/^[0-9a-f-]{36}$/i.test(connId)) throw new Error(`NIS login failed: ${nisText.slice(0, 80)}`);
  process.stdout.write(` OK (${connId.slice(0, 8)}…)\n`);

  return { cookies, connId };
}

// ── NIS helpers ───────────────────────────────────────────────────────────────

function fieldVal(data, groupName, fieldName) {
  const g = data?.fieldGroups?.find(g => g.name === groupName);
  return g?.fields?.find(f => f.name === fieldName)?.value ?? null;
}

async function fetchRecord(cookies, connId, rid) {
  try {
    const r = await fetch(`${UPSTREAM}/api/nis`, {
      method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', Cookie: cookies },
      body: JSON.stringify({ connectionId: connId, command: 'GetRecordInfo', recordId: rid }),
    });
    const text = await r.text();
    return { status: r.status, data: JSON.parse(text) };
  } catch { return { status: 0, data: null }; }
}

async function scanRange(cookies, connId, start, end, label) {
  process.stdout.write(`\n  Scanning ${label} (${start}–${end}, concurrency=${CONCURRENCY})…\n`);
  const images = [];
  let i = start;

  while (i <= end) {
    const batch = [];
    for (let j = 0; j < CONCURRENCY && i + j <= end; j++) batch.push(i + j);
    i += batch.length;

    const results = await Promise.all(batch.map(rid => fetchRecord(cookies, connId, rid)));

    for (let k = 0; k < batch.length; k++) {
      const { status, data } = results[k];
      const rid = batch[k];
      if (status === 200 && data) {
        const type     = fieldVal(data, 'Record Fields', 'Record Type');
        const parentId = parseInt(fieldVal(data, 'Record Fields', 'Parent ID') ?? '0') || null;
        const recName  = (fieldVal(data, 'Record Fields', 'Record Name') ?? '').trim();
        const vsiName  = (data?.name ?? '').replace(/\.vsi$/i, '').trim();
        const name     = recName || vsiName;
        if (type === 'Image' && name) {
          images.push({ rid, name, parentId });
          process.stdout.write(`    [${rid}] "${name}" parent=${parentId}\n`);
        }
      }
    }

    const scanned = i - start;
    if (scanned > 0 && scanned % 250 === 0) {
      process.stdout.write(`  … ${scanned} IDs scanned | ${images.length} images found\n`);
    }
  }

  process.stdout.write(`  Done: ${images.length} images in ${label}\n`);
  return images;
}

// ── Slide name parser ─────────────────────────────────────────────────────────
// Anatomy formula: [Organ]_[N]_#[konspekt]_[stain]
// Pathology names: free text → organ = full name, konspekt/stain = null

function parseName(name) {
  const parts = name.split('_');
  const kIdx  = parts.findIndex(p => p.startsWith('#'));
  if (kIdx < 1) return { organ: name, konspekt_number: null, stain: null };
  const organ           = parts.slice(0, kIdx - 1).join(' ').trim() || name;
  const konspekt_number = parts[kIdx].slice(1).trim() || null;
  const stain           = parts.slice(kIdx + 1).join('_').trim() || null;
  return { organ, konspekt_number, stain };
}

// ── Supabase upsert ───────────────────────────────────────────────────────────

async function upsertSlide(row) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/slides?on_conflict=record_id`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey':        SUPABASE_KEY,
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(row),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(text.slice(0, 200));
  const data = JSON.parse(text);
  return Array.isArray(data) ? data[0] : data;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  OlyVia → Supabase harvest  (all slides, unassigned)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  console.log('Step 1: OlyVia authentication');
  const { cookies, connId } = await authenticate();

  console.log('\nStep 2: Scanning OlyVia record IDs…');
  const pathoImages = await scanRange(cookies, connId, 1,     1500,  'Pathology (1–1500)');
  const anatImages  = await scanRange(cookies, connId, 21000, 22000, 'Anatomy/Cytology (21000–22000)');
  const allImages   = [...pathoImages, ...anatImages];

  console.log(`\n  Total found: ${allImages.length} slides`);
  console.log(`  • Pathology range:        ${pathoImages.length}`);
  console.log(`  • Anatomy/Cytology range: ${anatImages.length}`);

  if (allImages.length === 0) {
    console.error('\n✗ No slides found in either range. Check OlyVia connectivity.');
    process.exit(1);
  }

  // Parse names
  const slides = allImages.map(img => {
    const { organ, konspekt_number, stain } = parseName(img.name);
    return {
      record_id:        img.rid,
      slide_name:       img.name,
      organ,
      konspekt_number,
      stain,
      parent_folder_id: img.parentId,
      olyvia_folder:    img.parentId ? `container:${img.parentId}` : null,
    };
  });

  // Breakdown table
  const byFolder = new Map();
  for (const s of slides) {
    const pid = s.parent_folder_id ?? 'none';
    if (!byFolder.has(pid)) byFolder.set(pid, []);
    byFolder.get(pid).push(s);
  }

  console.log('\n── Breakdown by parent_folder_id ──────────────────────────────────────');
  console.log('parent_folder_id │ count │ first slide name');
  console.log('─────────────────┼───────┼──────────────────────────────────────────────');
  for (const [pid, rows] of [...byFolder.entries()].sort(([a], [b]) => Number(a) - Number(b))) {
    console.log(`${String(pid).padEnd(16)} │  ${String(rows.length).padStart(4)} │ ${rows[0]?.slide_name?.slice(0, 50) ?? ''}`);
  }
  console.log(`\nTotal: ${slides.length} slides across ${byFolder.size} folders (ALL will be UNASSIGNED)`);

  // Confirm
  if (!YES) {
    const rl     = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nProceed with upsert to Supabase? (y/N) ');
    rl.close();
    if (!/^y/i.test(answer.trim())) { console.log('Aborted.'); return; }
  } else {
    console.log('\n(--yes: skipping prompt)');
  }

  // Upsert — no slide_subjects rows created
  console.log('\nStep 3: Upserting to Supabase slides table…');
  let ok = 0; let errors = 0;

  for (const slide of slides) {
    try {
      await upsertSlide(slide);
      ok++;
      if (ok % 25 === 0 || ok === slides.length) {
        process.stdout.write(`  ${ok}/${slides.length} upserted…\r`);
      }
    } catch (err) {
      errors++;
      process.stderr.write(`  ✗ record_id=${slide.record_id}: ${err.message}\n`);
    }
  }

  console.log(`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  Harvest complete`);
  console.log(`  ✓ Upserted: ${ok}`);
  if (errors > 0) console.log(`  ✗ Errors:   ${errors}`);
  console.log(`  All ${ok} slides are UNASSIGNED (0 slide_subjects rows).`);
  console.log(`  Open Admin → Микроскопски препарати → Групиране по папка`);
  console.log(`  to bulk-assign subjects by folder group.`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
}

main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
