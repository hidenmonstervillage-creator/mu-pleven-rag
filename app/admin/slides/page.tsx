'use client';

import { useEffect, useRef, useState } from 'react';
import { FACULTIES } from '@/lib/faculties';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SlideRow {
  id: string;
  record_id: number;
  slide_name: string;
  organ: string | null;
  konspekt_number: string | null;
  stain: string | null;
  faculty_id: string;
  specialty_id: string;
  subject: string;
  olyvia_folder: string | null;
  created_at: string;
}

const EMPTY_FORM = {
  record_id: '',
  slide_name: '',
  organ: '',
  konspekt_number: '',
  stain: '',
  faculty_id: '',
  specialty_id: '',
  subject: '',
  olyvia_folder: '',
};

// ── Slide name parser ──────────────────────────────────────────────────────────
// Formula: "[Organ]_[N]_#[konspekt]_[stain]"
// e.g. "Oesophagus_1_#18a_HE"      → { organ: "Oesophagus", konspekt: "18a", stain: "HE" }
//      "Glandula parotis_1_#28_HE"  → { organ: "Glandula parotis", konspekt: "28", stain: "HE" }
function parseSlideName(name: string): { organ: string; konspekt_number: string; stain: string } {
  const parts = name.split('_');
  const kIdx = parts.findIndex(p => p.startsWith('#'));
  if (kIdx < 1) return { organ: name, konspekt_number: '', stain: '' };
  const organ = parts.slice(0, kIdx - 1).join(' ').trim(); // before the N-index
  const konspekt_number = parts[kIdx].slice(1).trim();      // strip leading '#'
  const stain = parts.slice(kIdx + 1).join('_').trim();     // everything after konspekt
  return { organ, konspekt_number, stain };
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AdminSlidesPage() {
  const [slides, setSlides] = useState<SlideRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Add-slide form ────────────────────────────────────────────────────────
  const [form, setForm] = useState(EMPTY_FORM);
  const [formOpen, setFormOpen] = useState(true);

  // Cascading selectors for add form
  const formFaculty   = FACULTIES.find(f => f.id === form.faculty_id);
  const formSpecialties = formFaculty?.specialties ?? [];
  const formSpecialty = formSpecialties.find(s => s.id === form.specialty_id);
  const formSubjects  = formSpecialty?.subjects ?? [];

  // ── Filter state ──────────────────────────────────────────────────────────
  const [filterFaculty,   setFilterFaculty]   = useState('');
  const [filterSpecialty, setFilterSpecialty] = useState('');
  const [filterSubject,   setFilterSubject]   = useState('');
  const [search,          setSearch]          = useState('');

  const filterFacultyObj    = FACULTIES.find(f => f.id === filterFaculty);
  const filterSpecialtyList = filterFacultyObj?.specialties ?? [];
  const filterSpecialtyObj  = filterSpecialtyList.find(s => s.id === filterSpecialty);
  const filterSubjectList   = filterSpecialtyObj?.subjects ?? [];

  // ── Inline edit state ─────────────────────────────────────────────────────
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm,  setEditForm]  = useState({
    faculty_id: '',
    specialty_id: '',
    subject: '',
    organ: '',
    konspekt_number: '',
    stain: '',
    olyvia_folder: '',
  });
  const editFaculty    = FACULTIES.find(f => f.id === editForm.faculty_id);
  const editSpecialties = editFaculty?.specialties ?? [];
  const editSpecialty  = editSpecialties.find(s => s.id === editForm.specialty_id);
  const editSubjects   = editSpecialty?.subjects ?? [];

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showFeedback(msg: string, ok: boolean) {
    setFeedback({ msg, ok });
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    feedbackTimer.current = setTimeout(() => setFeedback(null), 3500);
  }

  async function loadSlides() {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filterFaculty)   params.set('faculty_id',   filterFaculty);
      if (filterSpecialty) params.set('specialty_id', filterSpecialty);
      if (filterSubject)   params.set('subject',      filterSubject);
      const res = await fetch(`/api/slides?${params}`);
      const json = await res.json() as { slides?: SlideRow[]; error?: string };
      if (json.error) throw new Error(json.error);
      setSlides(json.slides ?? []);
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при зареждане', false);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void loadSlides(); }, [filterFaculty, filterSpecialty, filterSubject]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Add slide ─────────────────────────────────────────────────────────────

  function handleParse() {
    const { organ, konspekt_number, stain } = parseSlideName(form.slide_name);
    setForm(f => ({ ...f, organ, konspekt_number, stain }));
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    const rid = parseInt(form.record_id, 10);
    if (!form.record_id || isNaN(rid) || rid <= 0) {
      showFeedback('Record ID трябва да е положително цяло число', false);
      return;
    }
    if (!form.slide_name.trim()) { showFeedback('Slide name е задължително', false); return; }
    if (!form.faculty_id)  { showFeedback('Изберете факултет', false); return; }
    if (!form.specialty_id) { showFeedback('Изберете специалност', false); return; }
    if (!form.subject)     { showFeedback('Изберете предмет', false); return; }

    setSaving(true);
    try {
      const res = await fetch('/api/slides', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id:       rid,
          slide_name:      form.slide_name.trim(),
          organ:           form.organ.trim() || null,
          konspekt_number: form.konspekt_number.trim() || null,
          stain:           form.stain.trim() || null,
          faculty_id:      form.faculty_id,
          specialty_id:    form.specialty_id,
          subject:         form.subject,
          olyvia_folder:   form.olyvia_folder.trim() || null,
        }),
      });
      const json = await res.json() as { slide?: SlideRow; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback(`Препарат ${form.slide_name} е записан`, true);
      setForm(EMPTY_FORM);
      await loadSlides();
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при запис', false);
    } finally {
      setSaving(false);
    }
  }

  // ── Delete slide ──────────────────────────────────────────────────────────

  async function handleDelete(slide: SlideRow) {
    if (!confirm(`Изтрий "${slide.slide_name}" (record ${slide.record_id}) от каталога?`)) return;
    try {
      const res = await fetch(`/api/slides/${slide.id}`, { method: 'DELETE' });
      const json = await res.json() as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback(`Препарат ${slide.slide_name} е изтрит`, true);
      setSlides(prev => prev.filter(s => s.id !== slide.id));
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при изтриване', false);
    }
  }

  // ── Open inline edit ──────────────────────────────────────────────────────

  function openEdit(slide: SlideRow) {
    setEditingId(slide.id);
    setEditForm({
      faculty_id:      slide.faculty_id,
      specialty_id:    slide.specialty_id,
      subject:         slide.subject,
      organ:           slide.organ ?? '',
      konspekt_number: slide.konspekt_number ?? '',
      stain:           slide.stain ?? '',
      olyvia_folder:   slide.olyvia_folder ?? '',
    });
  }

  async function handleEditSave(id: string) {
    if (!editForm.faculty_id || !editForm.specialty_id || !editForm.subject) {
      showFeedback('Изберете факултет, специалност и предмет', false);
      return;
    }
    try {
      const res = await fetch(`/api/slides/${id}`, {
        method:  'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id:      editForm.faculty_id,
          specialty_id:    editForm.specialty_id,
          subject:         editForm.subject,
          organ:           editForm.organ.trim() || null,
          konspekt_number: editForm.konspekt_number.trim() || null,
          stain:           editForm.stain.trim() || null,
          olyvia_folder:   editForm.olyvia_folder.trim() || null,
        }),
      });
      const json = await res.json() as { slide?: SlideRow; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback('Промените са запазени', true);
      setEditingId(null);
      setSlides(prev => prev.map(s => s.id === id ? (json.slide ?? s) : s));
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при запис', false);
    }
  }

  // ── Filtered display list ─────────────────────────────────────────────────

  const displayed = slides.filter(s => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.slide_name.toLowerCase().includes(q) ||
      (s.organ ?? '').toLowerCase().includes(q) ||
      (s.konspekt_number ?? '').toLowerCase().includes(q)
    );
  });

  // ── Faculty label helper ──────────────────────────────────────────────────
  function facultyName(id: string) {
    return FACULTIES.find(f => f.id === id)?.name ?? id;
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* ── Page header ─────────────────────────────────────────────────── */}
      <header className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div>
            <div className="text-xs text-gray-400 mb-0.5">
              <a href="/admin" className="hover:text-[#7B1C1C]">Администрация</a>
              {' / '}
              <span className="text-gray-600">Микроскопски препарати</span>
            </div>
            <h1 className="text-2xl font-bold text-[#7B1C1C]">Микроскопски препарати</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              Каталог на OlyVia препарати — {slides.length} записани
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/admin/stats"
              className="text-xs text-gray-400 hover:text-[#7B1C1C] transition-colors"
            >
              📊 Статистика
            </a>
            <a
              href="/admin"
              className="text-xs text-gray-400 hover:text-[#7B1C1C] transition-colors"
            >
              ← Документи
            </a>
          </div>
        </div>
      </header>

      {/* ── Feedback toast ───────────────────────────────────────────────── */}
      {feedback && (
        <div
          className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium transition-all ${
            feedback.ok
              ? 'bg-green-50 text-green-800 border border-green-200'
              : 'bg-red-50 text-red-800 border border-red-200'
          }`}
        >
          {feedback.ok ? '✓ ' : '✗ '}{feedback.msg}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-8">

        {/* ── ADD SLIDE FORM ─────────────────────────────────────────────── */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
            onClick={() => setFormOpen(v => !v)}
          >
            <span className="font-semibold text-gray-800">➕ Добави нов препарат</span>
            <span className="text-gray-400 text-sm">{formOpen ? '▲ Скрий' : '▼ Покажи'}</span>
          </button>

          {formOpen && (
            <form onSubmit={handleAdd} className="px-6 pb-6 border-t border-gray-100">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">

                {/* record_id + preview */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Record ID <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min={1}
                      value={form.record_id}
                      onChange={e => setForm(f => ({ ...f, record_id: e.target.value }))}
                      placeholder="напр. 21236"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                    <a
                      href={form.record_id
                        ? `/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${form.record_id}`
                        : '#'}
                      target="_blank"
                      rel="noopener noreferrer"
                      title="Преглед на препарата в OlyVia"
                      className={`flex items-center gap-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                        form.record_id
                          ? 'border-[#7B1C1C] text-[#7B1C1C] hover:bg-[#7B1C1C] hover:text-white'
                          : 'border-gray-200 text-gray-300 pointer-events-none'
                      }`}
                    >
                      🔬 Преглед
                    </a>
                  </div>
                </div>

                {/* slide_name + parse */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Оригинално OlyVia название <span className="text-red-500">*</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.slide_name}
                      onChange={e => setForm(f => ({ ...f, slide_name: e.target.value }))}
                      placeholder="напр. Oesophagus_1_#18a_HE"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                    <button
                      type="button"
                      onClick={handleParse}
                      className="px-3 py-2 rounded-lg border border-[#7B1C1C] text-[#7B1C1C] text-xs font-medium hover:bg-[#7B1C1C] hover:text-white transition-colors whitespace-nowrap"
                    >
                      Парсирай
                    </button>
                  </div>
                  <p className="text-xs text-gray-400 mt-1">
                    Формат: [Орган]_[N]_#[конспект]_[оцветяване]
                  </p>
                </div>

                {/* organ */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Орган / структура</label>
                  <input
                    type="text"
                    value={form.organ}
                    onChange={e => setForm(f => ({ ...f, organ: e.target.value }))}
                    placeholder="напр. Oesophagus"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                  />
                </div>

                {/* konspekt_number + stain */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Конспект №</label>
                    <input
                      type="text"
                      value={form.konspekt_number}
                      onChange={e => setForm(f => ({ ...f, konspekt_number: e.target.value }))}
                      placeholder="напр. 18a"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Оцветяване</label>
                    <input
                      type="text"
                      value={form.stain}
                      onChange={e => setForm(f => ({ ...f, stain: e.target.value }))}
                      placeholder="напр. HE"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                  </div>
                </div>

                {/* faculty */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Факултет <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={form.faculty_id}
                    onChange={e => setForm(f => ({ ...f, faculty_id: e.target.value, specialty_id: '', subject: '' }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] bg-white"
                  >
                    <option value="">— Изберете факултет —</option>
                    {FACULTIES.map(f => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>

                {/* specialty */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Специалност <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={form.specialty_id}
                    onChange={e => setForm(f => ({ ...f, specialty_id: e.target.value, subject: '' }))}
                    disabled={!form.faculty_id}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] bg-white disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    <option value="">— Изберете специалност —</option>
                    {formSpecialties.map(s => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </div>

                {/* subject */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    Учебна дисциплина <span className="text-red-500">*</span>
                  </label>
                  <select
                    value={form.subject}
                    onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
                    disabled={!form.specialty_id}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] bg-white disabled:bg-gray-50 disabled:text-gray-400"
                  >
                    <option value="">— Изберете дисциплина —</option>
                    {formSubjects.map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </div>

                {/* olyvia_folder */}
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">
                    OlyVia папка <span className="text-gray-400 font-normal">(по желание)</span>
                  </label>
                  <input
                    type="text"
                    value={form.olyvia_folder}
                    onChange={e => setForm(f => ({ ...f, olyvia_folder: e.target.value }))}
                    placeholder="напр. Anatomy/Practice 1"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                  />
                </div>

              </div>{/* end grid */}

              <div className="mt-5 flex items-center gap-3">
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50"
                  style={{ backgroundColor: '#7B1C1C' }}
                >
                  {saving ? 'Запазване…' : '💾 Запази препарата'}
                </button>
                <button
                  type="button"
                  onClick={() => setForm(EMPTY_FORM)}
                  className="px-4 py-2.5 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50 transition-colors"
                >
                  Изчисти
                </button>
              </div>
            </form>
          )}
        </section>

        {/* ── SLIDES LIST ────────────────────────────────────────────────── */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm">

          {/* Filter bar */}
          <div className="px-6 py-4 border-b border-gray-100 flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-48">
              <label className="block text-xs font-medium text-gray-500 mb-1">Търси по орган / название</label>
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Oesophagus, 18a…"
                className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Факултет</label>
              <select
                value={filterFaculty}
                onChange={e => { setFilterFaculty(e.target.value); setFilterSpecialty(''); setFilterSubject(''); }}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
              >
                <option value="">Всички факултети</option>
                {FACULTIES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Специалност</label>
              <select
                value={filterSpecialty}
                onChange={e => { setFilterSpecialty(e.target.value); setFilterSubject(''); }}
                disabled={!filterFaculty}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="">Всички</option>
                {filterSpecialtyList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1">Дисциплина</label>
              <select
                value={filterSubject}
                onChange={e => setFilterSubject(e.target.value)}
                disabled={!filterSpecialty}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400"
              >
                <option value="">Всички</option>
                {filterSubjectList.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {(filterFaculty || filterSpecialty || filterSubject || search) && (
              <button
                onClick={() => { setFilterFaculty(''); setFilterSpecialty(''); setFilterSubject(''); setSearch(''); }}
                className="text-xs text-gray-400 hover:text-[#7B1C1C] transition-colors pb-2"
              >
                ✕ Изчисти филтри
              </button>
            )}
          </div>

          {/* Table */}
          {loading ? (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">Зарежда…</div>
          ) : displayed.length === 0 ? (
            <div className="px-6 py-12 text-center text-gray-400 text-sm">
              {slides.length === 0
                ? 'Все още няма регистрирани препарати. Добавете първия от формата по-горе.'
                : 'Няма препарати, отговарящи на филтрите.'}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Конспект №</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Орган / структура</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Оцветяване</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Дисциплина</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">Record ID</th>
                    <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wide">OlyVia папка</th>
                    <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wide">Действия</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {displayed.map(slide => (
                    <>
                      <tr key={slide.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 py-3">
                          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-[#7B1C1C]/10 text-[#7B1C1C]">
                            #{slide.konspekt_number ?? '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-800">
                          {slide.organ ?? <span className="text-gray-400 italic">{slide.slide_name}</span>}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          <span className="font-mono text-xs bg-gray-100 px-1.5 py-0.5 rounded">
                            {slide.stain ?? '—'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-600 max-w-48">
                          <div className="truncate" title={slide.subject}>{slide.subject}</div>
                          <div className="text-xs text-gray-400 mt-0.5">{facultyName(slide.faculty_id)}</div>
                        </td>
                        <td className="px-4 py-3">
                          <a
                            href={`/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${slide.record_id}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="font-mono text-xs text-blue-600 hover:underline"
                            title="Отвори в OlyVia"
                          >
                            {slide.record_id} 🔬
                          </a>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-400">
                          {slide.olyvia_folder ?? '—'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            <button
                              onClick={() => editingId === slide.id ? setEditingId(null) : openEdit(slide)}
                              className="text-xs px-2.5 py-1 rounded border border-gray-200 text-gray-600 hover:border-[#7B1C1C] hover:text-[#7B1C1C] transition-colors"
                            >
                              {editingId === slide.id ? 'Затвори' : 'Редактирай'}
                            </button>
                            <button
                              onClick={() => handleDelete(slide)}
                              className="text-xs px-2.5 py-1 rounded border border-red-200 text-red-500 hover:bg-red-50 transition-colors"
                            >
                              Изтрий
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* Inline edit row */}
                      {editingId === slide.id && (
                        <tr key={`${slide.id}-edit`} className="bg-amber-50 border-l-2 border-amber-400">
                          <td colSpan={7} className="px-4 py-4">
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                              {/* Organ */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Орган</label>
                                <input
                                  type="text"
                                  value={editForm.organ}
                                  onChange={e => setEditForm(f => ({ ...f, organ: e.target.value }))}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                                />
                              </div>
                              {/* Konspekt */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Конспект №</label>
                                <input
                                  type="text"
                                  value={editForm.konspekt_number}
                                  onChange={e => setEditForm(f => ({ ...f, konspekt_number: e.target.value }))}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                                />
                              </div>
                              {/* Stain */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Оцветяване</label>
                                <input
                                  type="text"
                                  value={editForm.stain}
                                  onChange={e => setEditForm(f => ({ ...f, stain: e.target.value }))}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                                />
                              </div>
                              {/* OlyVia folder */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">OlyVia папка</label>
                                <input
                                  type="text"
                                  value={editForm.olyvia_folder}
                                  onChange={e => setEditForm(f => ({ ...f, olyvia_folder: e.target.value }))}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                                />
                              </div>
                              {/* Faculty */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Факултет</label>
                                <select
                                  value={editForm.faculty_id}
                                  onChange={e => setEditForm(f => ({ ...f, faculty_id: e.target.value, specialty_id: '', subject: '' }))}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                                >
                                  <option value="">— Факултет —</option>
                                  {FACULTIES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                                </select>
                              </div>
                              {/* Specialty */}
                              <div>
                                <label className="block text-xs font-medium text-gray-600 mb-1">Специалност</label>
                                <select
                                  value={editForm.specialty_id}
                                  onChange={e => setEditForm(f => ({ ...f, specialty_id: e.target.value, subject: '' }))}
                                  disabled={!editForm.faculty_id}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C] disabled:bg-gray-100"
                                >
                                  <option value="">— Специалност —</option>
                                  {editSpecialties.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                                </select>
                              </div>
                              {/* Subject */}
                              <div className="sm:col-span-2">
                                <label className="block text-xs font-medium text-gray-600 mb-1">Дисциплина</label>
                                <select
                                  value={editForm.subject}
                                  onChange={e => setEditForm(f => ({ ...f, subject: e.target.value }))}
                                  disabled={!editForm.specialty_id}
                                  className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C] disabled:bg-gray-100"
                                >
                                  <option value="">— Дисциплина —</option>
                                  {editSubjects.map(s => <option key={s} value={s}>{s}</option>)}
                                </select>
                              </div>
                            </div>
                            <div className="flex gap-2 mt-3">
                              <button
                                onClick={() => handleEditSave(slide.id)}
                                className="px-3 py-1.5 text-xs font-semibold text-white rounded transition-colors"
                                style={{ backgroundColor: '#7B1C1C' }}
                              >
                                Запази промените
                              </button>
                              <button
                                onClick={() => setEditingId(null)}
                                className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-50 transition-colors"
                              >
                                Откажи
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Footer count */}
          {!loading && displayed.length > 0 && (
            <div className="px-6 py-3 border-t border-gray-100 text-xs text-gray-400">
              {displayed.length} препарат{displayed.length !== 1 ? 'а' : ''}
              {displayed.length !== slides.length && ` (от ${slides.length} общо)`}
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
