/**
 * scripts/dedupe-cytology.mjs
 *
 * B) Remove triplicate cytology uploads, keeping the earliest of each edition.
 *    Also scans the WHOLE documents table for duplicate clean_titles in other
 *    subjects (report only — no deletion there).
 *
 * Deletes are gated behind --yes. Chunks cascade-delete via the FK.
 *
 * Usage:
 *   node scripts/dedupe-cytology.mjs         # preview only
 *   node scripts/dedupe-cytology.mjs --yes   # execute the 4 deletions
 */
import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const YES       = process.argv.includes('--yes');
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
const ENV = parseEnvFile(resolve(ROOT, '.env.local'));
const U = ENV.NEXT_PUBLIC_SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${U}/rest/v1${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', apikey: K, Authorization: `Bearer ${K}`, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) throw new Error(`${res.status} ${path} — ${text.slice(0, 200)}`);
  return { data, headers: res.headers };
}
async function chunkCount(documentId) {
  const { headers } = await sb(`/chunks?select=id&document_id=eq.${documentId}`,
    { headers: { Prefer: 'count=exact', 'Range-Unit': 'items', Range: '0-0' } });
  return Number(headers.get('content-range')?.split('/')?.[1] ?? 0);
}

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log('  DEDUPE cytology + whole-table duplicate scan');
  console.log('══════════════════════════════════════════════════════════════');

  // ── 1. The 6 cytology docs ────────────────────────────────────────────────
  const { data: docs } = await sb(
    `/documents?select=id,clean_title,created_at&faculty_id=eq.medicina&specialty_id=eq.medicina` +
    `&subject=eq.${encodeURIComponent('Цитология')}&order=created_at.asc`,
  );
  for (const d of docs) d.chunk_count = await chunkCount(d.id);

  console.log('\n── Cytology documents (subject="Цитология") ───────────────────');
  for (const d of docs) {
    console.log(`  ${d.id}  ${d.created_at?.slice(0,19)}  ${String(d.chunk_count).padStart(3)} chunks  ${d.clean_title.slice(0,40)}`);
  }

  // ── 2. Group by title, keep earliest, delete the rest ─────────────────────
  const groups = new Map();
  for (const d of docs) {
    if (!groups.has(d.clean_title)) groups.set(d.clean_title, []);
    groups.get(d.clean_title).push(d);
  }
  const keep = [], remove = [];
  for (const [title, g] of groups) {
    g.sort((a, b) => a.created_at.localeCompare(b.created_at));  // earliest first
    keep.push(g[0]);
    remove.push(...g.slice(1));
  }

  console.log('\n── Plan ───────────────────────────────────────────────────────');
  console.log(`  KEEP (earliest of each of ${groups.size} editions):`);
  for (const d of keep)   console.log(`    ✓ ${d.id}  ${d.created_at?.slice(0,10)}  ${d.clean_title.slice(0,40)}`);
  console.log(`  DELETE (${remove.length} duplicate rows; chunks cascade):`);
  for (const d of remove) console.log(`    ✗ ${d.id}  ${d.created_at?.slice(0,10)}  ${d.clean_title.slice(0,40)}`);

  if (!YES) {
    console.log('\n  (preview only — re-run with --yes to delete)');
  } else if (remove.length > 0) {
    const ids = remove.map(d => d.id).join(',');
    await sb(`/documents?id=in.(${ids})`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
    console.log(`\n  ✓ Deleted ${remove.length} duplicate document rows (chunks cascaded).`);
  }

  // ── 3. Verify final cytology state ────────────────────────────────────────
  const { data: after } = await sb(
    `/documents?select=id,clean_title&faculty_id=eq.medicina&specialty_id=eq.medicina&subject=eq.${encodeURIComponent('Цитология')}`,
  );
  let totalChunks = 0;
  for (const d of after) totalChunks += await chunkCount(d.id);
  console.log('\n── Final cytology state ───────────────────────────────────────');
  console.log(`  ${after.length} cytology documents, ${totalChunks} total chunks`);
  for (const d of after) console.log(`    • ${d.clean_title.slice(0,50)}`);

  // ── 4. Whole-table duplicate scan (OTHER subjects — report only) ──────────
  console.log('\n── Duplicate clean_titles across the WHOLE documents table ────');
  const { data: all } = await sb(`/documents?select=id,clean_title,subject,faculty_id,specialty_id,created_at&order=clean_title.asc&limit=2000`);
  const titleGroups = new Map();
  for (const d of all) {
    const key = d.clean_title ?? '(untitled)';
    if (!titleGroups.has(key)) titleGroups.set(key, []);
    titleGroups.get(key).push(d);
  }
  const dupes = [...titleGroups.entries()].filter(([, g]) => g.length > 1);
  // Exclude the cytology edition we just handled
  const otherDupes = dupes.filter(([title]) => !groups.has(title));
  if (otherDupes.length === 0) {
    console.log('  None found in other subjects. ✓');
  } else {
    console.log(`  ${otherDupes.length} duplicated title(s) in other subjects (REPORT ONLY — not deleted):`);
    for (const [title, g] of otherDupes) {
      console.log(`\n  "${title}"  ×${g.length}`);
      for (const d of g) {
        console.log(`     ${d.id}  ${d.faculty_id}/${d.specialty_id}/${d.subject}  ${d.created_at?.slice(0,10)}`);
      }
    }
  }
  console.log('\n══════════════════════════════════════════════════════════════\n');
}
main().catch(err => { console.error('\n✗ Fatal:', err.message); process.exit(1); });
