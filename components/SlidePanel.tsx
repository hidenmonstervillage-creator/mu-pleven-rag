'use client';

import { useEffect, useMemo, useState } from 'react';
import SlideViewer, { SubjectSlide, organLabel } from './SlideViewer';

interface SlidePanelProps {
  facultyId: string;
  specialtyId: string;
  subject: string;
}

// Student-facing "Микроскопски препарати" panel. Fully additive and self-managing:
//   • Fetches the slides mapped to the currently-selected subject.
//   • If the subject has NO slides, renders nothing (no trigger, no panel).
//   • Trigger button → list drawer with search → click a slide → zoomable viewer.
export default function SlidePanel({ facultyId, specialtyId, subject }: SlidePanelProps) {
  const [slides, setSlides]   = useState<SubjectSlide[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen]       = useState(false);
  const [query, setQuery]     = useState('');
  const [selected, setSelected] = useState<SubjectSlide | null>(null);

  // Fetch whenever the subject selection changes. Reset panel state each time.
  useEffect(() => {
    setOpen(false);
    setSelected(null);
    setQuery('');

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
                  onClick={() => setSelected(s)}
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

      {/* Zoomable viewer (opens on top of the list) */}
      <SlideViewer slide={selected} onClose={() => setSelected(null)} />
    </>
  );
}
