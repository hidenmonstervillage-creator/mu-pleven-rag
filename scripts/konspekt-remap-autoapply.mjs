/**
 * scripts/konspekt-remap-autoapply.mjs
 *
 * Unattended konspekt remap. Chained to run the moment scale-run.mjs exits.
 *
 * DESIGN RULE: this script invents NO new judgment. It re-runs the SAME dry-run
 * matcher that produced the 113-document plan approved on 2026-07-26
 * (scripts/konspekt-remap-plan.mjs — title/folder matching, faculty-hint mapping,
 * subject aliasing, plus the two refinements approved that day: faculty-aware
 * subject naming for ФЗГ, and the pharmacy-chemistry split), then applies ONLY
 * the row classes that were already approved. Everything else is left UNSORTED
 * for a human decision.
 *
 * AUTO-APPLY (approved classes only):
 *   • VALIDATED            — triple validates cleanly against lib/faculties.ts
 *   • AMBIGUOUS, fzg/sestra — the established convention: bare faculty_hint 'fzg'
 *                             with no specialty signal → specialty_id 'sestra'
 *   • NO_METADATA + HIGH    — konspekt-match suggestion at HIGH confidence that
 *                             also validates against the taxonomy
 *
 * HELD BACK (left faculty_id = 'UNSORTED'):
 *   • MEDIUM-confidence suggestions          (measured unreliable)
 *   • AMBIGUOUS that is NOT fzg/sestra       (e.g. bare 'foz' → 8 specialties;
 *                                             never approved, so never applied)
 *   • INVALID_TRIPLE                          (validation failure beyond known aliases)
 *   • no konspekt match at all / no metadata and no HIGH suggestion
 *
 * Writes ONLY to documents (faculty_id, specialty_id, subject) by primary key.
 * NEVER touches chunks — migration 0018's trg_documents_cascade_taxonomy cascades
 * the change to chunks automatically.
 *
 * Report: scripts/konspekt-remap-autoapply-report.json
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import Module from 'module';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PLAN_SCRIPT = resolve(__dirname, 'konspekt-remap-plan.mjs');
const PLAN_JSON = resolve(__dirname, 'konspekt-remap-plan.json');
const REPORT = resolve(__dirname, 'konspekt-remap-autoapply-report.json');
const DRY = process.argv.includes('--dry');

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
const H = { apikey: KEY, Authorization: `Bearer ${KEY}` };

const log = (s) => console.log(`[remap] ${s}`);

// ── taxonomy, for the final belt-and-braces re-validation before every write ──
let src = readFileSync(resolve(ROOT, 'lib/faculties.ts'), 'utf8');
src = src.replace(/^\s*import[^\n]*\n/m, '').replace(/export const FACULTIES\s*:\s*Faculty\[\]\s*=/, 'module.exports =');
const mod = new Module('faculties');
mod._compile(src, resolve(ROOT, 'lib/faculties.js'));
const FACULTIES = mod.exports;
const isValidTriple = (fid, sid, subj) => {
  const f = FACULTIES.find((x) => x.id === fid); if (!f) return false;
  const s = f.specialties.find((x) => x.id === sid); return !!s && s.subjects.includes(subj);
};

async function unsortedCount() {
  const r = await fetch(`${SUPA}/rest/v1/documents?faculty_id=eq.UNSORTED&select=id&limit=1`,
    { headers: { ...H, Prefer: 'count=exact', Range: '0-0' } });
  return parseInt((r.headers.get('content-range') || '0/0').split('/')[1], 10) || 0;
}

// ── 1. regenerate the plan with the approved matcher ─────────────────────────
log('running the approved dry-run matcher (konspekt-remap-plan.mjs)…');
const planRun = spawnSync(process.execPath, [PLAN_SCRIPT], { encoding: 'utf8', cwd: ROOT, maxBuffer: 1 << 26 });
if (planRun.status !== 0 || !existsSync(PLAN_JSON)) {
  console.error('[remap] plan generation FAILED — aborting, nothing applied.');
  console.error((planRun.stderr || planRun.stdout || '').slice(-1500));
  process.exit(1);
}
const plan = JSON.parse(readFileSync(PLAN_JSON, 'utf8')).plan;
log(`plan covers ${plan.length} UNSORTED documents`);

// ── 2. split into auto-apply vs held back, by the approved rules ─────────────
const apply = [];
const held = [];

for (const p of plan) {
  const base = { documentId: p.documentId, folder: p.folder, status: p.status };

  if (p.status === 'EXCLUDED') {
    // persistent exclusion — a human deliberately reverted this one. Never auto-file.
    held.push({ ...base, reason: (p.reasons || ['persistently excluded'])[0] });

  } else if (p.status === 'VALIDATED') {
    apply.push({ ...base, ...p.proposed, rule: 'VALIDATED' });

  } else if (p.status === 'ROUTED') {
    // explicit per-folder human decision from scripts/remap-routes.json, already
    // validated by the planner and re-validated below like every other row.
    apply.push({ ...base, ...p.proposed, rule: `ROUTED — ${(p.reasons || []).find((r) => r.startsWith('explicit route')) || 'explicit route'}` });

  } else if (p.status === 'AMBIGUOUS') {
    // ONLY the approved fzg/sestra convention. Bare 'foz' (8 specialties) was
    // never approved, so it is held even though its triple validates.
    if (p.proposed && p.proposed.faculty_id === 'fzg' && p.proposed.specialty_id === 'sestra') {
      apply.push({ ...base, ...p.proposed, rule: 'AMBIGUOUS_fzg_sestra (approved convention)' });
    } else {
      held.push({ ...base, proposed: p.proposed, reason: `ambiguous specialty not covered by an approved convention (${p.proposed?.faculty_id}/${p.proposed?.specialty_id}) — needs a human decision` });
    }

  } else if (p.status === 'NO_METADATA') {
    const s = p.suggestion;
    if (s && s.wouldValidate && s.matchClass === 'HIGH') {
      apply.push({ ...base, ...s.wouldPropose, rule: `NO_METADATA + HIGH suggestion (score ${s.matchScore})` });
    } else if (s && s.matchClass === 'MEDIUM') {
      held.push({ ...base, proposed: s.wouldPropose, reason: `MEDIUM-confidence suggestion (score ${s.matchScore}) — measured unreliable, not auto-applied` });
    } else {
      held.push({ ...base, reason: 'no konspekt metadata and no HIGH-confidence suggestion' });
    }

  } else if (p.status === 'INVALID_TRIPLE') {
    held.push({ ...base, proposed: p.proposed, reason: `taxonomy validation failed: ${(p.reasons || []).slice(-1)[0] || 'unknown'}` });

  } else {
    held.push({ ...base, reason: (p.reasons || []).join('; ') || 'unmappable' });
  }
}

// ── 3. re-validate EVERY row about to be written ─────────────────────────────
const invalid = apply.filter((a) => !isValidTriple(a.faculty_id, a.specialty_id, a.subject));
if (invalid.length) {
  console.error(`[remap] ABORT — ${invalid.length} row(s) failed final re-validation:`);
  invalid.forEach((a) => console.error(`   ${a.folder} → ${a.faculty_id}/${a.specialty_id}/${a.subject}`));
  process.exit(1);
}
log(`auto-apply: ${apply.length}   held back: ${held.length}   (all apply rows re-validated ✓)`);

const before = await unsortedCount();
log(`UNSORTED before: ${before}`);
if (DRY) { log('--dry: stopping before any write.'); process.exit(0); }

// ── 4. apply, one PATCH per document, with retry ────────────────────────────
// ONE PATCH PER DOCUMENT with retry on 57014. Per-document rather than per-group because
// the cascade trigger cost is dominated by index maintenance on the TARGET subject: the
// anatomy subject carries the partial HNSW index chunks_hnsw_anatomiya, whose inserts
// pushed a multi-row statement past statement_timeout on 2026-08-01 (succeeded on retry).
// One document per statement keeps each write small, isolates a failure to the row that
// caused it, and gives true per-row attempt counts. 57014 is the ONLY retried code.
let updated = 0; const perSubject = {}; const failures = []; const attemptsByDoc = [];
for (const a of apply) {
  const label = `${a.faculty_id}/${a.specialty_id}/${a.subject}`;
  if (!isValidTriple(a.faculty_id, a.specialty_id, a.subject)) {
    failures.push({ folder: a.folder, label, reason: 'failed final per-row validation' }); continue;
  }
  let ok = false, attempts = 0, lastErr = null, ms = 0;
  for (attempts = 1; attempts <= 3; attempts++) {
    const t0 = Date.now();
    const res = await fetch(`${SUPA}/rest/v1/documents?id=eq.${a.documentId}`, {
      method: 'PATCH',
      headers: { ...H, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ faculty_id: a.faculty_id, specialty_id: a.specialty_id, subject: a.subject }),
    });
    const body = await res.json(); ms = Date.now() - t0;
    if (res.ok && Array.isArray(body) && body.length) { ok = true; break; }
    lastErr = { status: res.status, code: body?.code ?? null, message: String(body?.message ?? '(empty result)').slice(0, 160), ms };
    log(`  ${a.folder} attempt ${attempts} FAILED ${res.status} ${body?.code ?? ''} after ${ms}ms`);
    if (String(body?.code) !== '57014') break;
    await new Promise((r) => setTimeout(r, 1500 * attempts));
  }
  attemptsByDoc.push({ folder: a.folder, documentId: a.documentId, target: label, ok, attempts, ms, error: ok ? null : lastErr });
  if (!ok) { failures.push({ folder: a.folder, label, reason: `${lastErr.status} ${lastErr.code}: ${lastErr.message}` }); continue; }
  updated++; perSubject[label] = (perSubject[label] || 0) + 1;
  log(`  ${a.folder} -> ${label}${attempts > 1 ? `  (retried x${attempts})` : ''}  ${ms}ms`);
}

const after = await unsortedCount();

// ── 5. report ────────────────────────────────────────────────────────────────
const heldByReason = {};
for (const h of held) {
  const k = h.reason.split(' (')[0].split(' —')[0];
  (heldByReason[k] ??= []).push(h.folder);
}

const report = {
  ranAt: new Date().toISOString(),
  planCovered: plan.length,
  applied: updated,
  attemptedApply: apply.length,
  heldBack: held.length,
  unsortedBefore: before,
  unsortedAfter: after,
  perSubject,
  heldBackByReason: Object.fromEntries(Object.entries(heldByReason).map(([k, v]) => [k, { count: v.length, folders: v }])),
  failures,
  attemptsByDoc,
  retriesNeeded: attemptsByDoc.filter((x) => x.ok && x.attempts > 1).length,
  appliedDetail: apply.map((a) => ({ folder: a.folder, documentId: a.documentId, triple: `${a.faculty_id}/${a.specialty_id}/${a.subject}`, rule: a.rule })),
};
writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');

console.log('\n=== KONSPEKT REMAP AUTO-APPLY ===');
console.log(`applied:      ${updated} / ${apply.length}`);
console.log(`held back:    ${held.length}`);
console.log(`UNSORTED:     ${before} → ${after}  (expected ${before - updated})`);
if (failures.length) { console.log('failures:'); failures.forEach((f) => console.log('  ', f)); }
console.log('\nby target subject:');
Object.entries(perSubject).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${String(v).padStart(3)}  ${k}`));
console.log('\nheld back by reason:');
Object.entries(heldByReason).forEach(([k, v]) => console.log(`  ${String(v.length).padStart(3)}  ${k}`));
console.log(`\nchunks: NOT touched — 0018's trg_documents_cascade_taxonomy cascades automatically.`);
console.log(`report → ${REPORT}`);
