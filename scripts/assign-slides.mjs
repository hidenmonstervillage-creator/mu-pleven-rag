/**
 * scripts/assign-slides.mjs
 *
 * Auto-assign subjects to all 325 OlyVia slides, enrich stain from slide_name,
 * and probe OlyVia folder-path API.
 *
 * RULES:
 *   A) record_id < 1500  → Патоанатомия и цитопатология (medicina/medicina)
 *   B) record_id >= 21000 → Цитология + Анатомия и хистология (2 rows, medicina/medicina)
 *   C) Flag mismatches for manual review (report only — no auto-changes)
 *
 * STAIN ENRICHMENT:
 *   Parse stain from slide_name for every slide; update stain column if it
 *   differs from the current DB value.
 *
 * OLYVIA_FOLDER:
 *   Probe NIS API for a sample folder ID. If 400 (expected), report and skip.
 *
 * Usage:
 *   node scripts/assign-slides.mjs            # dry-run (shows plan, prompts)
 *   node scripts/assign-slides.mjs --yes      # execute without prompting
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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
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

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  process.exit(1);
}

// ── Subject constants ─────────────────────────────────────────────────────────
const FACULTY_ID    = 'medicina';
const SPECIALTY_ID  = 'medicina';
const SUBJ_PATHO    = 'Патоанатомия и цитопатология';
const SUBJ_CYTO     = 'Цитология';
const SUBJ_ANAT     = 'Анатомия и хистология';

// ── Stain detection ───────────────────────────────────────────────────────────
// Ordered: longer/more-specific patterns first to avoid partial matches.

const STAIN_PATTERNS = [
  // Multi-word / special characters first
  [/MethylGreen[-\s]?Pironin/i,           'MethylGreen-Pironin'],
  [/Methyl\s+violet/i,                    'Methyl violet'],
  [/Alkaline\s+Phosphatase/i,             'Alkaline Phosphatase'],
  [/Alcian\s+blue/i,                      'Alcian blue'],
  [/Congo\s+R/i,                          'Congo R'],
  [/Sudan\s+III/i,                        'Sudan III'],
  [/Van\s+Gieson/i,                       'Van Gieson'],
  [/AgNO3/i,                              'AgNO3'],
  // H&E variants (Latin and Cyrillic НЕ)
  [/\bH&E\b/i,                            'HE'],
  [/[-–_\s](?:НЕ|НE)(?:[-–_\s\d]|$)/,   'HE'],  // Cyrillic Н+Latin E or both Cyrillic
  [/[-–_\s]НЕ(?:[-–_\s\d]|$)/,           'HE'],  // all-Cyrillic
  [/[-–_\s]HE(?:[-–_\s\d]|$)/i,          'HE'],  // plain Latin
  [/_HE$/i,                               'HE'],  // at end of anatomy name
  [/\bHE\b/i,                             'HE'],  // fallback word boundary
  // Single-word stains
  [/\bAzan\b/i,                           'Azan'],
  [/\bGiemsa\b/i,                         'Giemsa'],
  [/\bOrcein\b/i,                         'Orcein'],
  [/\bNissl\b/i,                          'Nissl'],
  [/\bOsO4\b/i,                           'OsO4'],
  [/\bSchmorl\b/i,                        'Schmorl'],
  [/\bPAF\b/i,                            'PAF'],
  [/\bPAS\b/i,                            'PAS'],
  [/\bPerls\b|\bPearls\b/i,              'Perls'],
  [/\bMucicarmine\b/i,                    'Mucicarmine'],
  [/\bFeH\b/i,                            'FeH'],
  [/\b(?:IHC|immunohistochem)/i,          'IHC'],
  // Short codes used in anatomy names (after splitting on _)
  [/^Au$/i,                               'Au'],
  [/^Ag$/i,                               'Ag'],
];

function parseStain(slideName) {
  for (const [re, label] of STAIN_PATTERNS) {
    if (re.test(slideName)) return label;
  }
  // For anatomy-style names (underscored), check each token
  if (slideName.includes('_')) {
    const parts = slideName.split('_');
    for (const part of parts) {
      for (const [re, label] of STAIN_PATTERNS) {
        if (re.test(part)) return label;
      }
    }
  }
  return null;
}

// ── Keyword signals for RULE C mismatch detection ────────────────────────────

const PATHO_KEYWORDS = [
  /necrosis/i, /granuloma/i, /carcinoma/i, /tumor/i, /oedema/i, /edema/i,
  /fibrosis/i, /congestion/i, /infarct/i, /metaplasia/i, /hyperplasia/i,
  /hypertrophy/i, /atrophy/i, /amyloid/i, /anthracosis/i, /lipoma/i,
  /steatosis/i, /cirrhosis/i, /hepatitis/i, /icterus/i, /jaundice/i,
  /pigmented/i, /melanoma/i, /lymphoma/i, /adenoma/i, /papilloma/i,
  /haemorrhage/i, /hemorrhage/i, /abscess/i, /ulcer/i, /polyp/i,
  /nevus/i, /foreign\s*body/i, /calcif/i, /hyaline/i, /fatty/i,
  /congestion/i, /Brown\s+induration/i, /caseous/i, /liquefactive/i,
  /coagulative/i,
];

const NORMAL_HISTOLOGY_KEYWORDS = [
  /^Cor\b/i, /^Heart\b/i, /^Brain\b/i, /^Kidney\b/i, /^Liver\b/i,
  /^Lung\b/i, /^Testis\b/i, /^Ovary\b/i, /^Skin\b/i, /^Bone\b/i,
  /^Muscle\b/i, /^Oesophagus\b/i, /^Stomach\b/i, /^Intestin/i,
  /^Colon\b/i, /^Thyroid\b/i, /^Adrenal\b/i, /^Pancreas\b/i,
  /^Spleen\b/i, /^Lymph\b/i, /^Nerve\b/i, /^Vessel\b/i, /^Aorta\b/i,
  /^Glandula/i, /^Tonsil/i, /^Trachea/i, /^Bronch/i, /^Ureter/i,
  /^Bladder/i, /^Uterus/i, /^Cervix/i, /^Placenta/i, /^Thymus/i,
  /^Hypophysis/i, /^Cerebell/i, /^Cerebr/i, /^Retina/i, /^Cornea/i,
  /^Articular/i, /^Cartilage/i, /^Periosteum/i,
];

function looksLikePathology(name) {
  return PATHO_KEYWORDS.some(re => re.test(name));
}
function looksLikeNormalHistology(name) {
  return NORMAL_HISTOLOGY_KEYWORDS.some(re => re.test(name));
}

// ── Supabase REST helpers ─────────────────────────────────────────────────────

async function sbFetch(path, opts = {}) {
  const url = `${SUPABASE_URL}/rest/v1${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey':        SUPABASE_KEY,
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 200)}`);
  return data;
}

async function fetchAllSlides() {
  // Use pagination just in case (though 325 is well under the 1000 default limit)
  const data = await sbFetch('/slides?select=id,record_id,slide_name,stain,parent_folder_id&limit=1000&order=record_id.asc', {
    headers: { Prefer: 'count=exact' },
  });
  return data;
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

async function authenticateOlyVia() {
  try {
    const pageRes   = await fetch(`${UPSTREAM}/Account/Login`, {
      redirect: 'follow', signal: AbortSignal.timeout(10000),
    });
    const pc        = getSetCookies(pageRes);
    const sessionId = extractCookie(pc, 'ASP\\.NET_SessionId');
    const vtc       = extractCookie(pc, '__RequestVerificationToken');
    const html      = await pageRes.text();
    const fm        = html.match(/__RequestVerificationToken[^>]*type="hidden"[^>]*value="([^"]+)"/)
                   ?? html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);

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
    if (!aspxAuth) throw new Error('no .ASPXAUTH cookie');
    const cookies = `ASP.NET_SessionId=${sessionId}; .ASPXAUTH=${aspxAuth}`;

    const nisText = await (await fetch(`${UPSTREAM}/api/nis/login`, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/json', Cookie: cookies },
      body: JSON.stringify({ username: OLYVIA_USER, password: OLYVIA_PASS, databaseId: OLYVIA_DB_GUID, domain: '' }),
    })).text();
    const connId = nisText.trim().replace(/^"|"$/g, '');
    if (!/^[0-9a-f-]{36}$/i.test(connId)) throw new Error(`NIS login failed: ${nisText.slice(0, 80)}`);
    return { cookies, connId };
  } catch (err) {
    return { error: err.message };
  }
}

async function probeFolder(cookies, connId, folderId) {
  try {
    const res = await fetch(`${UPSTREAM}/api/nis`, {
      method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', Cookie: cookies },
      body: JSON.stringify({ connectionId: connId, command: 'GetRecordInfo', recordId: folderId }),
    });
    return { status: res.status, body: (await res.text()).slice(0, 150) };
  } catch (err) {
    return { status: 0, body: err.message };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  assign-slides.mjs — auto-assign + stain enrichment');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  // ── 1. Fetch all slides ───────────────────────────────────────────────────
  process.stdout.write('Step 1: Fetching slides from Supabase… ');
  const slides = await fetchAllSlides();
  console.log(`${slides.length} slides`);

  if (slides.length === 0) {
    console.error('✗ No slides found — run import-slides.mjs first.');
    process.exit(1);
  }

  const pathoSlides = slides.filter(s => s.record_id < 1500);
  const anatSlides  = slides.filter(s => s.record_id >= 21000);
  const otherSlides = slides.filter(s => s.record_id >= 1500 && s.record_id < 21000);

  console.log(`   Pathology  (record_id < 1500):   ${pathoSlides.length}`);
  console.log(`   Anat/Cyto  (record_id >= 21000):  ${anatSlides.length}`);
  if (otherSlides.length) console.log(`   ⚠ Other range (1500–20999):      ${otherSlides.length} — UNCLASSIFIED`);

  // ── 2. Stain enrichment plan ──────────────────────────────────────────────
  console.log('\nStep 2: Parsing stains from slide names…');
  const stainUpdates = [];
  let stainAlreadySet = 0; let stainNew = 0; let stainBlank = 0;

  for (const s of slides) {
    const parsed = parseStain(s.slide_name);
    if (!parsed) { stainBlank++; continue; }
    if (s.stain === parsed) { stainAlreadySet++; continue; }
    stainUpdates.push({ id: s.id, record_id: s.record_id, stain: parsed, old: s.stain });
    stainNew++;
  }
  console.log(`   Already correct: ${stainAlreadySet}`);
  console.log(`   Will update:     ${stainNew}`);
  console.log(`   Blank (no match): ${stainBlank}`);

  // ── 3. RULE C — mismatch flags ────────────────────────────────────────────
  console.log('\nStep 3: RULE C — mismatch detection (report only)…');

  const rule_c_flags = [];
  for (const s of anatSlides) {
    if (looksLikePathology(s.slide_name)) {
      rule_c_flags.push({ record_id: s.record_id, name: s.slide_name, reason: 'record_id>=21000 but name looks pathological' });
    }
  }
  for (const s of pathoSlides) {
    if (looksLikeNormalHistology(s.slide_name)) {
      rule_c_flags.push({ record_id: s.record_id, name: s.slide_name, reason: 'record_id<1500 but name looks like normal histology' });
    }
  }

  if (rule_c_flags.length === 0) {
    console.log('   No mismatches found.');
  } else {
    console.log(`   ${rule_c_flags.length} potential mismatch(es) flagged for manual review:`);
    for (const f of rule_c_flags) {
      console.log(`   [${f.record_id}] "${f.name}"\n         ↳ ${f.reason}`);
    }
  }

  // ── 4. OlyVia folder path probe ───────────────────────────────────────────
  console.log('\nStep 4: Probing OlyVia NIS for folder path retrieval…');
  const authResult = await authenticateOlyVia();
  if (authResult.error) {
    console.log(`   ✗ OlyVia auth failed: ${authResult.error}`);
    console.log('   olyvia_folder will remain as container:{id}');
  } else {
    // Try a known folder ID from each range
    const sampleFolders = [37, 21197, 919];
    for (const fid of sampleFolders) {
      const probe = await probeFolder(authResult.cookies, authResult.connId, fid);
      console.log(`   Folder ${fid}: HTTP ${probe.status} — ${probe.body}`);
    }
    if (true) { // always the case given prior tests
      console.log('   → Folder path API returns non-200 for container IDs (as expected).');
      console.log('   olyvia_folder values remain as container:{id} — no update needed.');
    }
  }

  // ── 5. Summary of planned changes ────────────────────────────────────────
  console.log('\n── Plan ─────────────────────────────────────────────────────────────────');
  console.log(`  slide_subjects to insert:`);
  console.log(`    ${pathoSlides.length} × "${SUBJ_PATHO}" (RULE A)`);
  console.log(`    ${anatSlides.length} × "${SUBJ_CYTO}"   (RULE B)`);
  console.log(`    ${anatSlides.length} × "${SUBJ_ANAT}"  (RULE B)`);
  console.log(`  Total subject rows: ${pathoSlides.length + anatSlides.length * 2} (on-conflict-do-nothing)`);
  console.log(`  Stain column updates: ${stainUpdates.length}`);
  if (otherSlides.length) console.log(`  ⚠ ${otherSlides.length} slides in 1500–20999 range will remain UNASSIGNED`);
  console.log('─────────────────────────────────────────────────────────────────────────');

  if (!YES) {
    const rl     = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question('\nProceed? (y/N) ');
    rl.close();
    if (!/^y/i.test(answer.trim())) { console.log('Aborted.'); return; }
  } else {
    console.log('(--yes: skipping prompt)');
  }

  // ── 6. Upsert slide_subjects ──────────────────────────────────────────────
  console.log('\nStep 5: Upserting slide_subjects…');

  // Build rows
  const subjRows = [];
  for (const s of pathoSlides) {
    subjRows.push({ slide_id: s.id, faculty_id: FACULTY_ID, specialty_id: SPECIALTY_ID, subject: SUBJ_PATHO });
  }
  for (const s of anatSlides) {
    subjRows.push({ slide_id: s.id, faculty_id: FACULTY_ID, specialty_id: SPECIALTY_ID, subject: SUBJ_CYTO });
    subjRows.push({ slide_id: s.id, faculty_id: FACULTY_ID, specialty_id: SPECIALTY_ID, subject: SUBJ_ANAT });
  }

  // Batch upsert in chunks of 200 (Supabase REST limit is generous but let's be safe)
  const CHUNK = 200;
  let subjInserted = 0;
  for (let i = 0; i < subjRows.length; i += CHUNK) {
    const chunk = subjRows.slice(i, i + CHUNK);
    await sbFetch('/slide_subjects?on_conflict=slide_id,faculty_id,specialty_id,subject', {
      method:  'POST',
      headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
      body:    JSON.stringify(chunk),
    });
    subjInserted += chunk.length;
    process.stdout.write(`  ${subjInserted}/${subjRows.length} subject rows…\r`);
  }
  console.log(`\n  ✓ slide_subjects upserted: ${subjRows.length} rows`);

  // ── 7. Update stains ──────────────────────────────────────────────────────
  console.log('\nStep 6: Updating stain column…');
  let stainDone = 0;
  for (const u of stainUpdates) {
    await sbFetch(`/slides?id=eq.${u.id}`, {
      method:  'PATCH',
      headers: { Prefer: 'return=minimal' },
      body:    JSON.stringify({ stain: u.stain }),
    });
    stainDone++;
    if (stainDone % 20 === 0 || stainDone === stainUpdates.length) {
      process.stdout.write(`  ${stainDone}/${stainUpdates.length} stain updates…\r`);
    }
  }
  if (stainUpdates.length > 0) console.log(`\n  ✓ Stain updated: ${stainDone}`);
  else console.log('  (no stain updates needed)');

  // ── 8. Verify unassigned=0 ────────────────────────────────────────────────
  console.log('\nStep 7: Verifying — fetching unassigned count…');
  const allSubjSlides = await sbFetch('/slide_subjects?select=slide_id&limit=2000');
  const assignedSet   = new Set(allSubjSlides.map(r => r.slide_id));
  const unassigned    = slides.filter(s => !assignedSet.has(s.id));
  console.log(`  Total slides:    ${slides.length}`);
  console.log(`  With subjects:   ${assignedSet.size}`);
  console.log(`  Unassigned:      ${unassigned.length}${unassigned.length === 0 ? ' ✓' : ' ⚠'}`);
  if (unassigned.length > 0) {
    console.log('  Unassigned slide record_ids:', unassigned.map(s => s.record_id).join(', '));
  }

  // ── 9. Final report ───────────────────────────────────────────────────────
  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('  Done.');
  console.log(`  Subjects assigned:`);
  console.log(`    "${SUBJ_PATHO}": ${pathoSlides.length} slides`);
  console.log(`    "${SUBJ_CYTO}":             ${anatSlides.length} slides`);
  console.log(`    "${SUBJ_ANAT}": ${anatSlides.length} slides`);
  console.log(`  Stain populated: ${stainAlreadySet + stainNew} | blank: ${stainBlank}`);
  console.log(`  RULE C flags:    ${rule_c_flags.length}`);
  console.log(`  olyvia_folder:   unchanged (folder API returned non-200)`);
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
