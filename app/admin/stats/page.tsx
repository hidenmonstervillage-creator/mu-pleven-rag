/**
 * app/admin/stats/page.tsx
 *
 * Server-rendered library health dashboard at /admin/stats.
 * Queries Supabase with the service role key directly — no client JS needed.
 * Mirrors the exact per-document chunk-count strategy used by /api/documents
 * so the numbers here always match what the admin panel shows.
 */

import { FACULTIES } from '@/lib/faculties';
import { createServiceClient } from '@/lib/supabase';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

// ── Canonical lookup tables (module-level, built once) ────────────────────────

const FACULTY_NAME = new Map(FACULTIES.map((f) => [f.id, f.name]));

/** All canonical subject strings per faculty (across every specialty). */
const CANONICAL_BY_FACULTY = new Map<string, string[]>(
  FACULTIES.map((f) => [
    f.id,
    f.specialties.flatMap((s) => s.subjects),
  ]),
);

// ── Types ─────────────────────────────────────────────────────────────────────

type Doc = {
  id: string;
  faculty_id: string;
  specialty_id: string;
  subject: string;
  clean_title: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Format a number with thousands-comma separator: 69532 → "69,532" */
function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

/** Integer coverage percentage, clamped 0–100 */
function covPct(covered: number, total: number): number {
  return total === 0 ? 0 : Math.min(100, Math.round((covered / total) * 100));
}

// ── Data loading ──────────────────────────────────────────────────────────────

async function loadStats(): Promise<{ docs: Doc[]; chunkMap: Map<string, number> }> {
  const supabase = createServiceClient();

  // 1. Fetch all document rows (tiny result — ~113 rows)
  const { data: rawDocs, error } = await supabase
    .from('documents')
    .select('id, faculty_id, specialty_id, subject, clean_title');

  if (error || !rawDocs) {
    throw new Error(error?.message ?? 'Failed to fetch documents');
  }

  const docs = rawDocs as Doc[];

  // 2. Fetch per-document chunk counts in parallel.
  //    This replicates the proven strategy from /api/documents/route.ts —
  //    one lightweight HEAD request per document (returns only the count header).
  const counts = await Promise.all(
    docs.map(async (doc) => {
      const { count } = await supabase
        .from('chunks')
        .select('*', { count: 'exact', head: true })
        .eq('document_id', doc.id);
      return count ?? 0;
    }),
  );

  const chunkMap = new Map<string, number>(
    docs.map((doc, i) => [doc.id, counts[i]]),
  );

  return { docs, chunkMap };
}

// ── Page component ────────────────────────────────────────────────────────────

export default async function StatsPage() {
  const generatedAt = new Date();

  // Bulgaria time for display
  const timeStr = generatedAt.toLocaleTimeString('bg-BG', {
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    timeZone: 'Europe/Sofia',
  });

  // ── Fetch data ──────────────────────────────────────────────────────────────
  let docs: Doc[]               = [];
  let chunkMap = new Map<string, number>();
  let loadError: string | null  = null;

  try {
    ({ docs, chunkMap } = await loadStats());
  } catch (err) {
    loadError = err instanceof Error ? err.message : String(err);
  }

  const cc = (id: string) => chunkMap.get(id) ?? 0;

  // ── KPIs ────────────────────────────────────────────────────────────────────
  const totalDocs    = docs.length;
  const totalChunks  = docs.reduce((s, d) => s + cc(d.id), 0);

  const coveredSubjectSet = new Set(
    docs
      .filter((d) => cc(d.id) > 0)
      .map((d) => `${d.faculty_id}||${d.specialty_id}||${d.subject}`),
  );
  const coveredSubjects   = coveredSubjectSet.size;
  const facultiesWithDocs = new Set(docs.map((d) => d.faculty_id)).size;

  // ── Faculty coverage rows ───────────────────────────────────────────────────
  type FacultyAccum = {
    name:     string;
    docCount: number;
    chunkSum: number;
    subjects: Set<string>; // subjects with ≥ 1 doc
  };

  const facultyAccum = new Map<string, FacultyAccum>();

  for (const doc of docs) {
    if (!facultyAccum.has(doc.faculty_id)) {
      facultyAccum.set(doc.faculty_id, {
        name:     FACULTY_NAME.get(doc.faculty_id) ?? doc.faculty_id,
        docCount: 0,
        chunkSum: 0,
        subjects: new Set(),
      });
    }
    const row = facultyAccum.get(doc.faculty_id)!;
    row.docCount++;
    row.chunkSum += cc(doc.id);
    row.subjects.add(doc.subject);
  }

  const facultyRows = Array.from(facultyAccum.entries())
    .map(([id, row]) => {
      const canonical = CANONICAL_BY_FACULTY.get(id) ?? [];
      const covered   = row.subjects.size;
      const total     = canonical.length;
      return {
        id,
        name:     row.name,
        docCount: row.docCount,
        chunkSum: row.chunkSum,
        covered,
        empty:    Math.max(0, total - covered),
        total,
      };
    })
    .sort((a, b) => b.docCount - a.docCount);

  // ── Top-10 subjects by chunk count ──────────────────────────────────────────
  type SubjectAccum = {
    subject:  string;
    faculty:  string;
    docCount: number;
    chunkSum: number;
  };

  const subjectAccum = new Map<string, SubjectAccum>();

  for (const doc of docs) {
    const key = `${doc.faculty_id}||${doc.specialty_id}||${doc.subject}`;
    if (!subjectAccum.has(key)) {
      subjectAccum.set(key, {
        subject:  doc.subject,
        faculty:  FACULTY_NAME.get(doc.faculty_id) ?? doc.faculty_id,
        docCount: 0,
        chunkSum: 0,
      });
    }
    const row = subjectAccum.get(key)!;
    row.docCount++;
    row.chunkSum += cc(doc.id);
  }

  const top10 = Array.from(subjectAccum.values())
    .sort((a, b) => b.chunkSum - a.chunkSum)
    .slice(0, 10);

  // ── Health warnings ─────────────────────────────────────────────────────────
  const zeroDocs = docs.filter((d) => cc(d.id) === 0);
  const lowDocs  = docs.filter((d) => { const c = cc(d.id); return c >= 1 && c < 20; });
  const hasWarnings = zeroDocs.length > 0 || lowDocs.length > 0;

  // ─────────────────────────────────────────────────────────────────────────────
  // JSX
  // ─────────────────────────────────────────────────────────────────────────────

  return (
    <main className="min-h-screen bg-gray-50 py-10 px-4">
      <div className="max-w-6xl mx-auto flex flex-col gap-7">

        {/* ══ Page header ═══════════════════════════════════════════════════════ */}
        <div className="flex items-start justify-between flex-wrap gap-4">
          <div>
            <div className="flex items-center gap-1.5 text-xs text-gray-400 mb-2">
              <Link
                href="/admin"
                className="hover:text-[#7B1C1C] transition-colors"
              >
                ← Административен панел
              </Link>
            </div>
            <h1 className="text-2xl font-bold text-gray-900 leading-tight">
              Статистика на библиотеката
            </h1>
            <p className="text-sm text-gray-400 mt-1">
              МУ-Плевен AI Library&nbsp;&middot;&nbsp;Генерирано в {timeStr}
            </p>
          </div>

          <a
            href="/admin/stats"
            className="inline-flex items-center gap-2 px-4 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-600 shadow-sm hover:border-[#7B1C1C] hover:text-[#7B1C1C] transition-all"
          >
            <span className="text-base leading-none">↻</span>
            Обнови
          </a>
        </div>

        {/* Error state */}
        {loadError && (
          <div className="rounded-2xl bg-red-50 border border-red-200 px-6 py-5 text-sm text-red-700">
            <p className="font-semibold mb-1">Грешка при зареждане на данните</p>
            <p className="font-mono text-xs opacity-80">{loadError}</p>
          </div>
        )}

        {!loadError && (
          <>
            {/* ══ SECTION 1 — KPI cards ════════════════════════════════════════ */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
              {(
                [
                  {
                    value: fmt(totalDocs),
                    label: 'Документи\nв библиотеката',
                    sub:   null,
                  },
                  {
                    value: fmt(totalChunks),
                    label: 'Индексирани\nчанкове',
                    sub:   null,
                  },
                  {
                    value: fmt(coveredSubjects),
                    label: 'Покрити\nпредмети',
                    sub:   'с поне 1 индексиран чанк',
                  },
                  {
                    value: fmt(facultiesWithDocs),
                    label: 'Факултети\nс материали',
                    sub:   null,
                  },
                ] as const
              ).map((kpi, i) => (
                <div
                  key={i}
                  className="bg-white rounded-2xl border border-gray-200 shadow-sm px-6 py-8 flex flex-col items-center text-center"
                >
                  <p className="text-5xl font-bold text-[#7B1C1C] tabular-nums leading-none tracking-tight">
                    {kpi.value}
                  </p>
                  <p className="text-xs font-medium text-gray-500 mt-3 leading-snug whitespace-pre-line">
                    {kpi.label}
                  </p>
                  {kpi.sub && (
                    <p className="text-[10px] text-gray-300 mt-1 leading-snug">
                      {kpi.sub}
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* ══ SECTION 2 — Coverage by faculty ═════════════════════════════ */}
            {facultyRows.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-base font-bold text-gray-800">
                    Покритие по факултет
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Покрити предмети = предмети с поне 1 качен документ спрямо канонично дърво от lib/faculties.ts
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        {[
                          'Факултет',
                          'Документи',
                          'Чанкове',
                          'Покрити предмети',
                          'Празни предмети',
                        ].map((h) => (
                          <th
                            key={h}
                            className="px-5 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap"
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {facultyRows.map((row) => {
                        const pct = covPct(row.covered, row.total);
                        return (
                          <tr key={row.id} className="hover:bg-gray-50/70 transition-colors">
                            {/* Faculty name + mini progress bar */}
                            <td className="px-5 py-4 max-w-[260px]">
                              <p
                                className="font-medium text-gray-800 truncate text-sm"
                                title={row.name}
                              >
                                {row.name}
                              </p>
                              {row.total > 0 && (
                                <div className="mt-2 h-1.5 w-full bg-gray-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-1.5 rounded-full bg-[#7B1C1C]"
                                    style={{ width: `${pct}%` }}
                                  />
                                </div>
                              )}
                            </td>

                            <td className="px-5 py-4 text-gray-600 tabular-nums">
                              {fmt(row.docCount)}
                            </td>

                            <td className="px-5 py-4 text-gray-600 tabular-nums">
                              {fmt(row.chunkSum)}
                            </td>

                            {/* Covered */}
                            <td className="px-5 py-4 tabular-nums">
                              <span className="text-green-700 font-semibold">
                                {row.covered}
                              </span>
                              {row.total > 0 && (
                                <span className="text-gray-300 text-xs ml-1">
                                  / {row.total} ({pct}%)
                                </span>
                              )}
                            </td>

                            {/* Empty */}
                            <td className="px-5 py-4 tabular-nums">
                              {row.empty > 0 ? (
                                <span className="text-amber-600 font-semibold">
                                  {row.empty}
                                </span>
                              ) : (
                                <span className="text-green-500 text-xs font-medium">
                                  0 ✓
                                </span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ══ SECTION 3 — Top-10 subjects ════════════════════════════════ */}
            {top10.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
                <div className="px-6 py-4 border-b border-gray-100">
                  <h2 className="text-base font-bold text-gray-800">
                    Най-добре заредени предмети
                  </h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    Топ 10 по общ брой индексирани чанкове
                  </p>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-100">
                        {['#', 'Предмет', 'Факултет', 'Документи', 'Чанкове'].map(
                          (h) => (
                            <th
                              key={h}
                              className="px-5 py-3 text-left text-xs font-semibold text-gray-500 whitespace-nowrap"
                            >
                              {h}
                            </th>
                          ),
                        )}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {top10.map((row, i) => (
                        <tr
                          key={`${row.subject}-${i}`}
                          className="hover:bg-gray-50/70 transition-colors"
                        >
                          {/* Rank */}
                          <td className="px-5 py-3.5 w-10 text-gray-300 font-medium tabular-nums text-xs">
                            {i + 1}
                          </td>

                          {/* Subject */}
                          <td className="px-5 py-3.5 font-medium text-gray-800 max-w-[280px]">
                            <span className="block truncate" title={row.subject}>
                              {row.subject}
                            </span>
                          </td>

                          {/* Faculty */}
                          <td className="px-5 py-3.5 text-gray-400 text-xs max-w-[200px]">
                            <span className="block truncate" title={row.faculty}>
                              {row.faculty}
                            </span>
                          </td>

                          {/* Doc count */}
                          <td className="px-5 py-3.5 text-gray-600 tabular-nums">
                            {fmt(row.docCount)}
                          </td>

                          {/* Chunk count — highlighted */}
                          <td className="px-5 py-3.5 tabular-nums">
                            <span className="font-semibold text-[#7B1C1C]">
                              {fmt(row.chunkSum)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ══ SECTION 4 — Health warnings (collapsible) ══════════════════ */}
            <details
              className="group rounded-2xl border shadow-sm overflow-hidden"
              // Open by default only when there are issues — this way the healthy
              // state is collapsed (clean) and warnings surface immediately.
              {...(hasWarnings ? { open: true } : {})}
            >
              <summary
                className={`
                  px-6 py-5 flex items-center gap-3 cursor-pointer select-none
                  [&::-webkit-details-marker]:hidden marker:hidden
                  ${hasWarnings ? 'bg-amber-50/60 border-amber-200' : 'bg-green-50/40 border-green-200'}
                `}
              >
                {/* Icon */}
                <span className="text-xl leading-none flex-shrink-0">
                  {hasWarnings ? '⚠️' : '✓'}
                </span>

                {/* Title + subtitle */}
                <div className="flex-1 min-w-0">
                  <p
                    className={`text-sm font-bold ${
                      hasWarnings ? 'text-amber-800' : 'text-green-800'
                    }`}
                  >
                    Документи изискващи внимание
                  </p>
                  <p
                    className={`text-xs mt-0.5 ${
                      hasWarnings ? 'text-amber-600' : 'text-green-600'
                    }`}
                  >
                    {hasWarnings
                      ? `${zeroDocs.length + lowDocs.length} документа изискват преглед`
                      : 'Библиотеката е в добро здраве'}
                  </p>
                </div>

                {/* Chevron — rotates when open via group-open variant */}
                <span
                  className={`
                    flex-shrink-0 text-sm transition-transform duration-200
                    group-open:rotate-180
                    ${hasWarnings ? 'text-amber-400' : 'text-green-400'}
                  `}
                >
                  ▾
                </span>
              </summary>

              {/* ── Expanded content ── */}
              <div
                className={`
                  px-6 pb-6 pt-4 flex flex-col gap-4
                  ${hasWarnings ? 'bg-amber-50/30' : 'bg-green-50/20'}
                `}
              >
                {!hasWarnings && (
                  <p className="text-center text-green-700 font-semibold py-6">
                    Библиотеката е в добро здраве ✓
                  </p>
                )}

                {/* Zero-chunk documents */}
                {zeroDocs.length > 0 && (
                  <div className="rounded-xl border border-red-200 bg-white px-5 py-4">
                    <div className="flex items-start gap-3 mb-3">
                      <span className="mt-0.5 h-2.5 w-2.5 rounded-full bg-red-500 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-red-800">
                          Документи с 0 чанкове{' '}
                          <span className="font-normal text-red-600">
                            ({zeroDocs.length})
                          </span>
                        </p>
                        <p className="text-xs text-red-500 mt-0.5">
                          Вероятно сканирани PDF файлове, които изискват OCR.
                        </p>
                      </div>
                    </div>
                    <ul className="ml-5 flex flex-col gap-1">
                      {zeroDocs.slice(0, 5).map((doc) => (
                        <li
                          key={doc.id}
                          className="text-xs text-red-700 before:content-['·'] before:mr-2 before:text-red-300"
                        >
                          {doc.clean_title}
                        </li>
                      ))}
                      {zeroDocs.length > 5 && (
                        <li className="text-xs text-red-300 ml-4 italic">
                          + {zeroDocs.length - 5} още…
                        </li>
                      )}
                    </ul>
                  </div>
                )}

                {/* Low-chunk documents (1–19) */}
                {lowDocs.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-white px-5 py-4">
                    <div className="flex items-start gap-3 mb-3">
                      <span className="mt-0.5 h-2.5 w-2.5 rounded-full bg-amber-400 flex-shrink-0" />
                      <div>
                        <p className="text-sm font-semibold text-amber-800">
                          Документи с 1–19 чанкове{' '}
                          <span className="font-normal text-amber-600">
                            ({lowDocs.length})
                          </span>
                        </p>
                        <p className="text-xs text-amber-500 mt-0.5">
                          Възможно непълно индексиране.
                        </p>
                      </div>
                    </div>
                    <ul className="ml-5 flex flex-col gap-1">
                      {lowDocs.slice(0, 5).map((doc) => (
                        <li
                          key={doc.id}
                          className="text-xs text-amber-800 before:content-['·'] before:mr-2 before:text-amber-300"
                        >
                          {doc.clean_title}
                          <span className="text-amber-400 ml-2 tabular-nums">
                            ({cc(doc.id)} чанка)
                          </span>
                        </li>
                      ))}
                      {lowDocs.length > 5 && (
                        <li className="text-xs text-amber-300 ml-4 italic">
                          + {lowDocs.length - 5} още…
                        </li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            </details>

            {/* ── Footer note ── */}
            <p className="text-center text-xs text-gray-300 pb-4">
              Данните се изчисляват при всяко зареждане на страницата.
              Натиснете „Обнови“ за актуална справка.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
