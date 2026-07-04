'use client';

import { useEffect, useMemo, useState } from 'react';
import SlideViewer, { SubjectSlide, organLabel } from './SlideViewer';

interface SlidePanelProps {
  facultyId: string;
  specialtyId: string;
  subject: string;
  question?: string;       // latest user chat message (for auto-suggest)
  questionNonce?: number;  // bumped on every send so re-asks re-trigger
}

// ── Question → slide matching (accent-tolerant, light Bulgarian stemming) ──────

const STOP = new Set([
  'и', 'на', 'за', 'от', 'с', 'в', 'до', 'по', 'при', 'към', 'или', 'ми', 'ме',
  'разкажи', 'кажи', 'какво', 'какви', 'каква', 'как', 'the', 'of', 'in', 'et',
  'and', 'a', 'an', 'tell', 'me', 'about', 'what', 'tissue', 'тъкан',
]);

function normText(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip combining diacritics
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ')          // keep Latin, digits, Cyrillic
    .trim();
}

// Strip common Bulgarian definite-article / plural / case endings.
const BG_ENDINGS = ['овете', 'ищата', 'ията', 'ите', 'ята', 'ове', 'ът', 'ят', 'та', 'то', 'ето', 'ата', 'ия', 'а', 'о', 'е', 'и', 'ъ', 'я'];
function stem(w: string): string {
  for (const e of BG_ENDINGS) {
    if (w.length > e.length + 2 && w.endsWith(e)) return w.slice(0, -e.length);
  }
  return w;
}

// Organ keywords are the CANONICAL base form — do NOT stem them (stemming e.g.
// "аорта" → "аор" would break matching). Inflection is handled in tokenMatch,
// where the (stemmed) query word starts-with the organ base.
function keywords(str: string): string[] {
  return normText(str).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

function tokenMatch(qw: string, k: string): boolean {
  return qw === k || (k.length >= 4 && qw.startsWith(k)) || (qw.length >= 4 && k.startsWith(qw));
}

// A slide matches if a distinctive keyword (stem ≥6) of its organ or organ_bg is
// present in the question; for organs made only of short words, require all of
// them (keeps precision high — a missed suggestion is fine, a wrong one is not).
function matchesQuestion(qWords: string[], slide: SubjectSlide): boolean {
  const test = (str: string) => {
    const kws = keywords(str);
    if (kws.length === 0) return false;
    const strong = kws.filter((k) => k.length >= 6);
    if (strong.length > 0) return strong.some((k) => qWords.some((qw) => tokenMatch(qw, k)));
    return kws.every((k) => qWords.some((qw) => tokenMatch(qw, k)));
  };
  return test(slide.organ_bg ?? '') || test(slide.organ ?? '');
}

// Student-facing "Микроскопски препарати" panel. Fully additive and self-managing:
//   • Fetches the slides mapped to the currently-selected subject.
//   • If the subject has NO slides, renders nothing (no trigger, no panel).
//   • Trigger button → list drawer with search → click a slide → zoomable viewer.
export default function SlidePanel({ facultyId, specialtyId, subject, question = '', questionNonce = 0 }: SlidePanelProps) {
  const [slides, setSlides]   = useState<SubjectSlide[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [selected, setSelected] = useState<SubjectSlide | null>(null);
  const [openMode, setOpenMode] = useState<'full' | 'min'>('full');
  const [suggestions, setSuggestions] = useState<SubjectSlide[]>([]);

  // Open a slide in the viewer: 'full' from the list, 'min' from a chat suggestion.
  function openSlide(slide: SubjectSlide, mode: 'full' | 'min') {
    setOpenMode(mode);
    setSelected(slide);
  }

  // Fetch whenever the subject selection changes. Reset panel state each time.
  useEffect(() => {
    setOpen(false);
    setSelected(null);
    setQuery('');
    setSuggestions([]);

    if (!facultyId || !specialtyId || !subject) {
      setSlides([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    const params = new URLSearchParams({ faculty_id: facultyId, specialty_id: specialtyId, subject });
    fetch(`/api/slides/for-subject?${params}`)
      .then((r) => r.json())
      .then((json: { slides?: SubjectSlide[]; error?: string }) => {
        if (cancelled) return;
        setSlides(json.slides ?? []);
      })
      .catch(() => { if (!cancelled) setSlides([]); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [facultyId, specialtyId, subject]);

  // Filter by organ, konspekt number, stain, or original name.
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return slides;
    return slides.filter((s) =>
      (s.organ ?? '').toLowerCase().includes(q) ||
      (s.organ_bg ?? '').toLowerCase().includes(q) ||
      (s.konspekt_number ?? '').toLowerCase().includes(q) ||
      (s.stain ?? '').toLowerCase().includes(q) ||
      (s.slide_name ?? '').toLowerCase().includes(q),
    );
  }, [slides, query]);

  // Auto-suggest: on each new chat question, match it against the ALREADY-LOADED
  // slides (no re-fetch) for the current subject. Up to 3 distinct organs.
  useEffect(() => {
    if (!question.trim() || slides.length === 0) { setSuggestions([]); return; }
    const qWords = normText(question).split(' ').filter(Boolean).map(stem);
    const matches: SubjectSlide[] = [];
    const seen = new Set<string>();
    for (const s of slides) {
      if (!matchesQuestion(qWords, s)) continue;
      const label = s.organ_bg || s.organ || s.slide_name || '';
      if (seen.has(label)) continue;
      seen.add(label);
      matches.push(s);
      if (matches.length >= 3) break;
    }
    setSuggestions(matches);
  }, [questionNonce]); // eslint-disable-line react-hooks/exhaustive-deps

  // Nothing to show for subjects without slides (or before first load completes).
  if (slides.length === 0) return null;

  return (
    <>
      {/* Trigger button — floats at the top-right of the chat column */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed top-[72px] right-5 z-30 flex items-center gap-2 pl-3 pr-3.5 py-2 rounded-full text-white text-sm font-semibold shadow-lg hover:brightness-110 transition-all"
          style={{ backgroundColor: '#7B1C1C' }}
          aria-label="Отвори микроскопски препарати"
        >
          <span aria-hidden="true">🔬</span>
          <span>Микроскопски препарати</span>
          <span className="ml-0.5 inline-flex items-center justify-center min-w-5 h-5 px-1.5 rounded-full bg-white/25 text-xs">
            {slides.length}
          </span>
        </button>
      )}

      {/* Overlay behind the list drawer */}
      <div
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          backgroundColor: 'rgba(0,0,0,0.4)',
          opacity: open ? 1 : 0,
          pointerEvents: open ? 'auto' : 'none',
        }}
        aria-hidden="true"
      />

      {/* List drawer */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col bg-white shadow-2xl w-full sm:w-[440px]"
        style={{
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms ease-in-out',
        }}
        aria-label="Списък с микроскопски препарати"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ backgroundColor: '#7B1C1C' }}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-white text-lg" aria-hidden="true">🔬</span>
            <div className="flex flex-col min-w-0">
              <span className="text-white font-semibold text-sm leading-tight">Микроскопски препарати</span>
              <span className="text-red-200 text-xs mt-0.5 truncate">{subject} · {slides.length} препарата</span>
            </div>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white hover:bg-white/20 transition-colors"
            aria-label="Затвори"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="relative">
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Търсене по орган или конспект № (напр. Oesophagus, Хранопровод, 18a)…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] focus:border-transparent"
            />
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {loading ? (
            <div className="flex flex-col items-center justify-center h-40 text-gray-400 text-sm gap-2">
              <div className="w-6 h-6 border-2 border-gray-200 border-t-[#7B1C1C] rounded-full animate-spin" />
              Зареждане…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex items-center justify-center h-40 text-gray-400 text-sm text-center px-4">
              Няма препарати, отговарящи на „{query}“.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-2">
              {filtered.map((s) => (
                <button
                  key={s.record_id}
                  onClick={() => openSlide(s, 'full')}
                  className="group flex items-center gap-3 text-left p-2.5 rounded-xl border border-gray-200 hover:border-[#7B1C1C] hover:bg-[#7B1C1C]/[0.03] transition-colors"
                >
                  {/* Prominent konspekt number — students search by it */}
                  <div
                    className="flex-shrink-0 flex flex-col items-center justify-center w-14 h-14 rounded-lg text-white"
                    style={{ backgroundColor: '#7B1C1C' }}
                  >
                    <span className="text-[10px] leading-none opacity-80">конспект</span>
                    <span className="font-bold text-lg leading-tight">
                      {s.konspekt_number ? `№${s.konspekt_number}` : '—'}
                    </span>
                  </div>

                  <div className="flex-1 min-w-0">
                    <div
                      className="font-semibold text-gray-900 text-sm leading-snug"
                      style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}
                    >
                      {organLabel(s)}
                    </div>
                    <div className="flex items-center gap-2 mt-1 flex-wrap">
                      {s.stain && (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 text-xs">
                          {s.stain}
                        </span>
                      )}
                      <span className="text-[11px] font-mono text-gray-400">#{s.record_id}</span>
                    </div>
                  </div>

                  <svg className="w-4 h-4 text-gray-300 group-hover:text-[#7B1C1C] flex-shrink-0 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                  </svg>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Auto-suggest chip — subtle nudge above the chat input, opens the mini-viewer */}
      {suggestions.length > 0 && (
        <div className="fixed bottom-[88px] left-1/2 -translate-x-1/2 z-30 max-w-[92vw]">
          <div className="flex items-start gap-2 bg-white border border-[#7B1C1C]/20 shadow-xl rounded-2xl pl-3.5 pr-2 py-2">
            <div className="flex flex-col gap-1">
              {suggestions.map((s) => (
                <button
                  key={s.record_id}
                  onClick={() => { openSlide(s, 'min'); setSuggestions([]); }}
                  className="group flex items-center gap-1.5 text-sm text-[#7B1C1C] hover:underline text-left"
                >
                  <span aria-hidden="true">🔬</span>
                  <span>Разгледай препарата: <span className="font-semibold">{s.organ_bg || s.organ}</span></span>
                  <span className="transition-transform group-hover:translate-x-0.5" aria-hidden="true">→</span>
                </button>
              ))}
            </div>
            <button
              onClick={() => setSuggestions([])}
              className="flex-shrink-0 w-6 h-6 rounded-md flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
              aria-label="Скрий предложението"
            >
              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      )}

      {/* Zoomable viewer (opens on top of the list) */}
      <SlideViewer slide={selected} onClose={() => setSelected(null)} initialMode={openMode} />
    </>
  );
}
