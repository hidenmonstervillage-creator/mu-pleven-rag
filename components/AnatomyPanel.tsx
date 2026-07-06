'use client';

import { useMemo, useState } from 'react';
import { ANATOMY_MODELS, AnatomyModelEntry, AnatomyTopic } from '@/lib/anatomy-catalog';

interface AnatomyPanelProps {
  facultyId: string;
  specialtyId: string;
  subject: string;
  activeTopicId?: string;                                    // for highlight
  onOpenTopic: (model: AnatomyModelEntry, topic: AnatomyTopic) => void;
}

// Stage 1: the 3D anatomy browser is offered under the "Анатомия и хистология"
// subject. (Chat-driven contextual opening comes in a later stage.)
const ENABLED_SUBJECT = 'Анатомия и хистология';

export default function AnatomyPanel({ subject, activeTopicId, onOpenTopic }: AnatomyPanelProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [openModelId, setOpenModelId] = useState<string | null>(null);

  const q = query.trim().toLowerCase();

  // Filter topics per model by the search query.
  const filteredModels = useMemo(() => {
    if (!q) return ANATOMY_MODELS.map((m) => ({ model: m, topics: m.topics }));
    return ANATOMY_MODELS
      .map((m) => ({
        model: m,
        topics: m.topics.filter((t) =>
          t.label.toLowerCase().includes(q) ||
          (t.region ?? '').toLowerCase().includes(q) ||
          (t.system ?? '').toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q),
        ),
      }))
      .filter((x) => x.topics.length > 0);
  }, [q]);

  function openTopic(model: AnatomyModelEntry, topic: AnatomyTopic) {
    onOpenTopic(model, topic);
    setOpen(false);
  }

  if (subject !== ENABLED_SUBJECT) return null;

  return (
    <>
      {/* Trigger — sits just below the slides trigger (top-[72px]) */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          className="fixed top-[116px] right-5 z-30 flex items-center gap-2 pl-3 pr-3.5 py-2 rounded-full text-white text-sm font-semibold shadow-lg hover:brightness-110 transition-all"
          style={{ backgroundColor: '#334155' }}
          aria-label="Отвори 3D анатомия"
        >
          <span aria-hidden="true">🦴</span>
          <span>3D Анатомия</span>
        </button>
      )}

      {/* Overlay */}
      <div
        onClick={() => setOpen(false)}
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{ backgroundColor: 'rgba(0,0,0,0.4)', opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none' }}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col bg-white shadow-2xl w-full sm:w-[460px]"
        style={{ transform: open ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 300ms ease-in-out' }}
        aria-label="3D анатомия — каталог"
      >
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ backgroundColor: '#334155' }}>
          <div className="flex items-center gap-2.5 min-w-0">
            <span className="text-white text-lg" aria-hidden="true">🦴</span>
            <div className="flex flex-col min-w-0">
              <span className="text-white font-semibold text-sm leading-tight">3D Анатомия</span>
              <span className="text-slate-300 text-xs mt-0.5 truncate">{ANATOMY_MODELS.length} модела · Open3DModel · CC BY-SA 4.0</span>
            </div>
          </div>
          <button onClick={() => setOpen(false)} className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white hover:bg-white/20" aria-label="Затвори">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Search */}
        <div className="px-4 py-3 border-b border-gray-100 flex-shrink-0">
          <div className="relative">
            <svg className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              type="text" value={query} onChange={(e) => setQuery(e.target.value)}
              placeholder="Търсене по регион, система, модел (напр. forearm, muscles, skull)…"
              className="w-full pl-9 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-slate-500 focus:border-transparent"
            />
          </div>
        </div>

        {/* Model → topic list */}
        <div className="flex-1 overflow-y-auto px-3 py-3">
          {filteredModels.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-gray-400 text-sm">Няма съвпадения.</div>
          ) : (
            <div className="space-y-2">
              {filteredModels.map(({ model, topics }) => {
                const expanded = !!q || openModelId === model.id;
                // group topics by region for display
                const byRegion = new Map<string, AnatomyTopic[]>();
                for (const t of topics) {
                  const r = t.region ?? model.label;
                  if (!byRegion.has(r)) byRegion.set(r, []);
                  byRegion.get(r)!.push(t);
                }
                return (
                  <div key={model.id} className="border border-gray-200 rounded-xl overflow-hidden">
                    <button
                      onClick={() => setOpenModelId(expanded && !q ? null : model.id)}
                      className="w-full flex items-center justify-between px-3 py-2.5 text-left hover:bg-gray-50"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm font-semibold text-gray-900">{model.label}</span>
                        <span className="text-[11px] text-gray-400">{model.bodyRegion} · {topics.length} теми</span>
                      </div>
                      <svg className={`w-4 h-4 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                    {expanded && (
                      <div className="border-t border-gray-100 px-2 py-2 space-y-2">
                        {Array.from(byRegion.entries()).map(([region, ts]: [string, AnatomyTopic[]]) => (
                          <div key={region}>
                            <div className="text-[10px] uppercase tracking-wide text-gray-400 px-1.5 mb-1">{region}</div>
                            <div className="flex flex-wrap gap-1.5">
                              {ts.map((t) => (
                                <button
                                  key={t.id}
                                  onClick={() => openTopic(model, t)}
                                  className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
                                    activeTopicId === t.id
                                      ? 'bg-slate-700 text-white border-slate-700'
                                      : t.whole
                                        ? 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100'
                                        : 'bg-white text-gray-700 border-gray-200 hover:border-slate-400 hover:text-slate-700'
                                  }`}
                                  title={t.groups.length ? t.groups.join(', ') : 'цял модел'}
                                >
                                  {t.system ? (t.system[0].toUpperCase() + t.system.slice(1)) : t.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
