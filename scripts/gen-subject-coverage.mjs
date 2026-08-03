/**
 * scripts/gen-subject-coverage.mjs
 *
 * Regenerates lib/subject-coverage.ts — a build-time snapshot of how many
 * DOCUMENTS exist per taxonomy triple, so the UI can grey out empty subjects and
 * the chat route can short-circuit them without a page-load DB call.
 *
 *   node scripts/gen-subject-coverage.mjs
 *
 * Counts come from the `documents` table (443 rows), NOT `chunks` (277k) —
 * document counts are what we display.
 *
 * Keys are the FULL TRIPLE `faculty_id||specialty_id||subject`, never the subject
 * name alone: Клинична лаборатория exists under both medicina/medicina and
 * fzg/laborant, Фармакология under medicina and farmacia, Патофизиология under
 * three faculties. Subject-name keying would silently collapse them.
 *
 * Only POPULATED triples are emitted — absence means zero.
 *
 * Re-run after any ingest. Ingest is frozen until after 14.08.2026, so the
 * snapshot is authoritative until then. Node 18+.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'lib/subject-coverage.ts');
const SEP = '||';

// ── env ───────────────────────────────────────────────────────────────────────
const env = {};
for (const raw of readFileSync(resolve(ROOT, '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim();
  if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('=');
  if (eq < 0) continue;
  let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  env[l.slice(0, eq).trim()] = v;
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !KEY) throw new Error('missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in .env.local');

// ── taxonomy (parse lib/faculties.ts) ─────────────────────────────────────────
// Structural parse, not indentation-based: the most recent `id:` before
// `specialties: [` is a faculty id; before `subjects: [` it is a specialty id.
function readTaxonomy() {
  const src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
  const triples = new Set();
  let lastId = null, faculty = null, specialty = null, inSubjects = false;

  for (const line of src.split('\n')) {
    const idm = line.match(/^\s*id:\s*'([^']+)'/);
    if (idm) { lastId = idm[1]; continue; }

    if (/specialties:\s*\[/.test(line)) { faculty = lastId; continue; }

    if (/subjects:\s*\[/.test(line)) {
      specialty = lastId;
      // inline strings on the same line (covers `subjects: []` and one-liners)
      for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) {
        if (!/subjects:\s*\[/.test(m[1])) triples.add(`${faculty}${SEP}${specialty}${SEP}${m[1]}`);
      }
      inSubjects = !line.includes(']');
      continue;
    }

    if (inSubjects) {
      if (/^\s*\]/.test(line)) { inSubjects = false; continue; }
      const sm = line.match(/^\s*'((?:[^'\\]|\\.)*)'/);
      if (sm) triples.add(`${faculty}${SEP}${specialty}${SEP}${sm[1]}`);
    }
  }
  return triples;
}

// ── documents ─────────────────────────────────────────────────────────────────
async function fetchDocuments() {
  const rows = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const res = await fetch(
      `${URL_}/rest/v1/documents?select=faculty_id,specialty_id,subject`,
      {
        headers: {
          apikey: KEY,
          Authorization: `Bearer ${KEY}`,
          Range: `${from}-${from + PAGE - 1}`,
          'Range-Unit': 'items',
        },
      },
    );
    if (!res.ok) throw new Error(`documents fetch ${res.status}: ${await res.text()}`);
    const page = await res.json();
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return rows;
}

// ── build ─────────────────────────────────────────────────────────────────────
const taxonomy = readTaxonomy();
const docs = await fetchDocuments();

const byTriple = new Map();
const byFaculty = new Map();
const bySpecialty = new Map();
const orphans = new Map(); // in DB but not in taxonomy — drift, worth surfacing
let nullFiled = 0;

for (const d of docs) {
  const f = d.faculty_id, s = d.specialty_id, subj = d.subject;
  if (!f || !s || !subj) { nullFiled++; continue; }
  const triple = `${f}${SEP}${s}${SEP}${subj}`;

  // Only taxonomy-known triples enter the snapshot. The deliberately-held
  // UNSORTED document files under literal 'UNSORTED' placeholders — non-null, so
  // it passes the check above, but it is not a real taxonomy entry. Counting it
  // would invent a 7th faculty in the rollup and inflate every total.
  if (!taxonomy.has(triple)) {
    orphans.set(triple, (orphans.get(triple) ?? 0) + 1);
    continue;
  }

  byTriple.set(triple, (byTriple.get(triple) ?? 0) + 1);
  byFaculty.set(f, (byFaculty.get(f) ?? 0) + 1);
  bySpecialty.set(`${f}${SEP}${s}`, (bySpecialty.get(`${f}${SEP}${s}`) ?? 0) + 1);
}

let orphanDocs = 0;
for (const n of orphans.values()) orphanDocs += n;

const sortObj = (map, val = (v) => v) => {
  const o = {};
  for (const k of Array.from(map.keys()).sort((a, b) => a.localeCompare(b))) o[k] = val(map.get(k));
  return o;
};

const coverage = sortObj(byTriple, (n) => ({ docs: n }));
const facultyRollup = sortObj(byFaculty);
const specialtyRollup = sortObj(bySpecialty);

let inTaxonomyDocs = 0;
for (const n of byTriple.values()) inTaxonomyDocs += n;

const meta = {
  generatedAt: new Date().toISOString(),
  taxonomyCount: taxonomy.size,
  populatedTriples: byTriple.size,
  totalDocuments: inTaxonomyDocs,
  // Rows the snapshot deliberately excludes: the held UNSORTED document, plus
  // anything whose triple has drifted out of lib/faculties.ts.
  excludedDocuments: orphanDocs + nullFiled,
};

const lines = (obj, fmt) =>
  Object.keys(obj).map((k) => `  ${JSON.stringify(k)}: ${fmt(obj[k])},`).join('\n');

const out = `// AUTO-GENERATED by scripts/gen-subject-coverage.mjs (do not edit by hand).
//
// Build-time snapshot of DOCUMENT counts per taxonomy triple. Lets the UI grey
// out subjects with no literature and lets the chat route short-circuit them
// without an LLM call — no page-load DB query.
//
// Keys are the FULL TRIPLE \`faculty_id||specialty_id||subject\`. Subject names
// are NOT unique across faculties (Клинична лаборатория, Фармакология,
// Патофизиология each appear under several), so never key on the name alone.
//
// Only populated triples are listed — absence means zero.
//
// ${meta.populatedTriples} populated of ${meta.taxonomyCount} taxonomy triples; ${meta.totalDocuments} documents.
// Generated ${meta.generatedAt}

export interface CoverageEntry {
  docs: number;
}

/** faculty_id||specialty_id||subject -> document count (populated only). */
export const SUBJECT_COVERAGE: Record<string, CoverageEntry> = {
${lines(coverage, (v) => `{ docs: ${v.docs} }`)}
};

/** faculty_id -> document count across all its subjects. */
export const FACULTY_COVERAGE: Record<string, number> = {
${lines(facultyRollup, (v) => String(v))}
};

/** faculty_id||specialty_id -> document count across all its subjects. */
export const SPECIALTY_COVERAGE: Record<string, number> = {
${lines(specialtyRollup, (v) => String(v))}
};

export const COVERAGE_META = ${JSON.stringify(meta, null, 2)} as const;

/** Build the canonical coverage key. Always use this — never hand-concatenate. */
export function coverageKey(facultyId: string, specialtyId: string, subject: string): string {
  return facultyId + '${SEP}' + specialtyId + '${SEP}' + subject;
}

/** Documents for a full triple. 0 when the subject has no literature. */
export function docsForSubject(facultyId: string, specialtyId: string, subject: string): number {
  return SUBJECT_COVERAGE[coverageKey(facultyId, specialtyId, subject)]?.docs ?? 0;
}

/** Documents across a whole faculty. */
export function docsForFaculty(facultyId: string): number {
  return FACULTY_COVERAGE[facultyId] ?? 0;
}

/** Documents across a whole specialty. */
export function docsForSpecialty(facultyId: string, specialtyId: string): number {
  return SPECIALTY_COVERAGE[facultyId + '${SEP}' + specialtyId] ?? 0;
}

/** Bulgarian document-count badge: 1 документ / N документа. */
export function docsLabel(docs: number): string {
  return docs === 1 ? '1 документ' : docs + ' документа';
}
`;

writeFileSync(OUT, out);
console.log(`wrote ${OUT}`);
console.log(`  taxonomy triples : ${meta.taxonomyCount}`);
console.log(`  populated triples: ${meta.populatedTriples}`);
console.log(`  documents        : ${meta.totalDocuments} in taxonomy (+${meta.excludedDocuments} excluded)`);
console.log(`  faculties        : ${Object.keys(facultyRollup).length}`);
if (orphans.size) {
  console.log(`  note: ${orphans.size} triple(s) in DB but NOT in lib/faculties.ts — excluded from the snapshot:`);
  for (const [t, n] of orphans) console.log(`      ${t}  (${n} doc${n === 1 ? '' : 's'})`);
}
