/**
 * scripts/finalize-slides.mjs
 *
 * FIX 1 — Tag the 8 folder-37 control slides (record_ids 34,39,42,52,57,60,75,80)
 *          with all THREE medicina/medicina subjects (adds histology + cytology
 *          to the existing pathology tag). On-conflict-do-nothing → idempotent.
 *          Verifies each ends up with exactly 3 subject mappings.
 *
 * FIX 2 — Standardize the cytology subject string on "Цитология":
 *   STEP 1  preview documents rows still using the long string
 *   STEP 2  UPDATE those documents.subject → "Цитология"
 *   STEP 4  verify alignment across documents + slide_subjects + both TS trees
 *   STEP 5  spot-check match_chunks RPC (zero-vector) under the new string
 *
 * Usage: node scripts/finalize-slides.mjs
 * Requires Node 18+. No external deps. Reads .env.local.
 */

import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

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

const ENV          = parseEnvFile(resolve(ROOT, '.env.local'));
const SUPABASE_URL = ENV.NEXT_PUBLIC_SUPABASE_URL  ?? '';
const SUPABASE_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('✗ NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from .env.local');
  process.exit(1);
}

const FACULTY_ID   = 'medicina';
const SPECIALTY_ID = 'medicina';
const SUBJ_PATHO   = 'Патоанатомия и цитопатология';
const SUBJ_CYTO    = 'Цитология';
const SUBJ_ANAT    = 'Анатомия и хистология';
const SUBJ_OLD     = 'Цитология, обща хистология и ембриология';

const CONTROL_RECORD_IDS = [34, 39, 42, 52, 57, 60, 75, 80];

// ── Supabase REST helper ──────────────────────────────────────────────────────
async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...opts,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${SUPABASE_KEY}`,
      'apikey':        SUPABASE_KEY,
      ...(opts.headers ?? {}),
    },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 250)}`);
  return { data, headers: res.headers };
}

// ── FIX 1 ─────────────────────────────────────────────────────────────────────
async function fix1() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FIX 1 — 8 control slides → all three subjects');
  console.log('═══════════════════════════════════════════════════════════════');

  const inList = CONTROL_RECORD_IDS.join(',');
  const { data: slides } = await sb(
    `/slides?select=id,record_id,slide_name&record_id=in.(${inList})&order=record_id.asc`,
  );
  console.log(`  Matched ${slides.length}/8 control slides in DB.`);
  if (slides.length !== 8) {
    console.log(`  ⚠ Expected 8, found ${slides.length}. Found record_ids: ${slides.map(s => s.record_id).join(', ')}`);
  }

  // Insert all three subjects per slide, ignore-duplicates (idempotent)
  const rows = [];
  for (const s of slides) {
    for (const subject of [SUBJ_PATHO, SUBJ_ANAT, SUBJ_CYTO]) {
      rows.push({ slide_id: s.id, faculty_id: FACULTY_ID, specialty_id: SPECIALTY_ID, subject });
    }
  }
  await sb('/slide_subjects?on_conflict=slide_id,faculty_id,specialty_id,subject', {
    method:  'POST',
    headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body:    JSON.stringify(rows),
  });
  console.log(`  Upserted ${rows.length} rows (3 × ${slides.length}, on-conflict-do-nothing).`);

  // Verify: each control slide now has exactly 3 mappings
  console.log('\n  Verification — subject count per control slide:');
  let allThree = true;
  for (const s of slides) {
    const { data: subs } = await sb(
      `/slide_subjects?select=subject&slide_id=eq.${s.id}&order=subject.asc`,
    );
    const names = subs.map(x => x.subject);
    const ok = names.length === 3 &&
      names.includes(SUBJ_PATHO) && names.includes(SUBJ_ANAT) && names.includes(SUBJ_CYTO);
    if (!ok) allThree = false;
    console.log(`   [${String(s.record_id).padStart(3)}] ${s.slide_name.padEnd(12)} → ${names.length} subj ${ok ? '✓' : '✗ ' + JSON.stringify(names)}`);
  }
  console.log(`  ${allThree ? '✓ All 8 control slides have all 3 subjects.' : '✗ Some slides do NOT have all 3 subjects.'}`);
  return allThree;
}

// ── FIX 2 ─────────────────────────────────────────────────────────────────────
async function fix2() {
  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  FIX 2 — Standardize cytology string on "Цитология"');
  console.log('═══════════════════════════════════════════════════════════════');

  // STEP 1 — preview (no writes)
  console.log('\n  STEP 1 — PREVIEW documents still using the long string:');
  const filter = `faculty_id=eq.${FACULTY_ID}&specialty_id=eq.${SPECIALTY_ID}&subject=eq.${encodeURIComponent(SUBJ_OLD)}`;
  const { data: preview, headers } = await sb(
    `/documents?select=id,clean_title&${filter}`,
    { headers: { Prefer: 'count=exact' } },
  );
  const previewCount = headers.get('content-range')?.split('/')?.[1] ?? preview.length;
  if (preview.length === 0) {
    console.log('   (no documents found with the long string — may already be migrated)');
  } else {
    for (const d of preview) console.log(`   ${d.id}  ${d.clean_title}`);
  }
  console.log(`   → ${previewCount} document row(s) will be affected.`);

  // STEP 2 — update
  console.log('\n  STEP 2 — UPDATE documents.subject → "Цитология":');
  let updatedCount = 0;
  if (preview.length > 0) {
    const { data: updated } = await sb(
      `/documents?${filter}`,
      {
        method:  'PATCH',
        headers: { Prefer: 'return=representation' },
        body:    JSON.stringify({ subject: SUBJ_CYTO }),
      },
    );
    updatedCount = Array.isArray(updated) ? updated.length : 0;
  }
  console.log(`   ✓ ${updatedCount} document row(s) updated.`);

  // STEP 4 — verify alignment across all four sources
  console.log('\n  STEP 4 — Verify "Цитология" alignment across all sources:');

  // (a) documents.subject
  const { data: docNew, headers: dh } = await sb(
    `/documents?select=id&faculty_id=eq.${FACULTY_ID}&specialty_id=eq.${SPECIALTY_ID}&subject=eq.${encodeURIComponent(SUBJ_CYTO)}`,
    { headers: { Prefer: 'count=exact' } },
  );
  const docNewCount = dh.get('content-range')?.split('/')?.[1] ?? docNew.length;
  // any stragglers still on the old string?
  const { data: docOld } = await sb(
    `/documents?select=id&subject=eq.${encodeURIComponent(SUBJ_OLD)}`,
  );

  // (b) slide_subjects.subject
  const { data: slideCyto, headers: sh } = await sb(
    `/slide_subjects?select=slide_id&subject=eq.${encodeURIComponent(SUBJ_CYTO)}`,
    { headers: { Prefer: 'count=exact' } },
  );
  const slideCytoCount = sh.get('content-range')?.split('/')?.[1] ?? slideCyto.length;

  // (c) lib/faculties.ts   (d) lib/slides-faculties.ts
  const facTs   = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf-8');
  const slidesTs = readFileSync(resolve(ROOT, 'lib/slides-faculties.ts'), 'utf-8');
  const facHasShort  = facTs.includes(`'${SUBJ_CYTO}'`);
  const facHasLong   = facTs.includes(SUBJ_OLD);
  const slidesHasShort = slidesTs.includes(`'${SUBJ_CYTO}'`);

  console.log(`   (a) documents.subject='Цитология':        ${docNewCount} rows  (old string left: ${docOld.length})`);
  console.log(`   (b) slide_subjects.subject='Цитология':   ${slideCytoCount} rows`);
  console.log(`   (c) lib/faculties.ts has 'Цитология':      ${facHasShort ? 'yes' : 'NO'}  | long string gone: ${!facHasLong ? 'yes' : 'NO'}`);
  console.log(`   (d) lib/slides-faculties.ts has 'Цитология':${slidesHasShort ? 'yes' : 'NO'}`);

  const aligned = docOld.length === 0 && facHasShort && !facHasLong && slidesHasShort && Number(docNewCount) > 0;
  console.log(`   ${aligned ? '✓ All four sources aligned verbatim on "Цитология".' : '⚠ Mismatch remains — see above.'}`);

  // STEP 5 — match_chunks spot check with a zero vector
  console.log('\n  STEP 5 — Spot-check match_chunks RPC (zero-vector) for "Цитология":');
  const zeroVec = new Array(1536).fill(0);
  const { data: chunks } = await sb('/rpc/match_chunks', {
    method: 'POST',
    body: JSON.stringify({
      query_embedding: zeroVec,
      match_faculty:   FACULTY_ID,
      match_specialty: SPECIALTY_ID,
      match_subject:   SUBJ_CYTO,
      match_count:     1000,
    }),
  });
  const chunkCount = Array.isArray(chunks) ? chunks.length : 0;
  console.log(`   match_chunks returned ${chunkCount} chunk(s) under medicina/medicina/"Цитология".`);
  console.log(`   ${chunkCount > 0 ? '✓ Renamed documents are retrievable under the new string.' : '⚠ 0 chunks — check whether cytology docs have embeddings.'}`);

  return { previewCount, updatedCount, docNewCount, docOldLeft: docOld.length, slideCytoCount, aligned, chunkCount };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const f1 = await fix1();
  const f2 = await fix2();

  console.log('\n═══════════════════════════════════════════════════════════════');
  console.log('  SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`  FIX 1: 8 control slides all-3-subjects ...... ${f1 ? '✓' : '✗'}`);
  console.log(`  FIX 2 STEP 1 preview count ................... ${f2.previewCount}`);
  console.log(`  FIX 2 STEP 2 documents updated .............. ${f2.updatedCount}`);
  console.log(`  FIX 2 STEP 4 alignment ...................... ${f2.aligned ? '✓' : '⚠'}`);
  console.log(`         documents 'Цитология' ................ ${f2.docNewCount} (old left: ${f2.docOldLeft})`);
  console.log(`         slide_subjects 'Цитология' ........... ${f2.slideCytoCount}`);
  console.log(`  FIX 2 STEP 5 match_chunks rows .............. ${f2.chunkCount}`);
  console.log('═══════════════════════════════════════════════════════════════\n');
}

main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
