/**
 * scripts/find-broken.mjs — READ-ONLY throwaway diagnostic
 *
 * Finds documents whose chunk count is 0 (image-only scans that ingested empty).
 * Prints id, filename, storage_url, page_count. No DB writes.
 *
 * Usage: node scripts/find-broken.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
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

async function rest(path) {
  const r = await fetch(`${U}/rest/v1/${path}`, {
    headers: { apikey: K, Authorization: `Bearer ${K}` },
  });
  const data = await r.json();
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${JSON.stringify(data)}`);
  return data;
}

// Pull all documents (id + metadata). Then, for each, ask chunks for an exact count
// via the Content-Range header (HEAD-like count with limit=0).
async function chunkCount(documentId) {
  const r = await fetch(
    `${U}/rest/v1/chunks?document_id=eq.${documentId}&select=id&limit=1`,
    { headers: { apikey: K, Authorization: `Bearer ${K}`, Prefer: 'count=exact', Range: '0-0' } },
  );
  const cr = r.headers.get('content-range') || '';
  const total = cr.includes('/') ? cr.split('/')[1] : '?';
  return total === '*' ? 0 : parseInt(total, 10);
}

const docs = await rest('documents?select=id,filename,clean_title,file_type,storage_url,page_count,faculty_id,specialty_id,subject&order=page_count.asc');
console.log(`Total documents: ${docs.length}\n`);

const broken = [];
for (const d of docs) {
  const n = await chunkCount(d.id);
  if (n === 0) broken.push({ ...d, chunks: n });
}

broken.sort((a, b) => (a.page_count ?? 1e9) - (b.page_count ?? 1e9));
console.log(`Documents with 0 chunks: ${broken.length}\n`);
for (const b of broken) {
  console.log(JSON.stringify({
    id: b.id, filename: b.filename, clean_title: b.clean_title, file_type: b.file_type,
    page_count: b.page_count, faculty_id: b.faculty_id, specialty_id: b.specialty_id,
    subject: b.subject, storage_url: b.storage_url,
  }));
}
