'use client';

import { useEffect, useRef, useState } from 'react';
import { FACULTIES } from '@/lib/faculties';

// ── Types ──────────────────────────────────────────────────────────────────────

interface SubjectMapping {
  id?: string;
  faculty_id: string;
  specialty_id: string;
  subject: string;
}

interface SlideRow {
  id: string;
  record_id: number;
  slide_name: string;
  organ: string | null;
  konspekt_number: string | null;
  stain: string | null;
  olyvia_folder: string | null;
  parent_folder_id: number | null;
  created_at: string;
  slide_subjects: SubjectMapping[];
}

const EMPTY_SLIDE_FIELDS = {
  record_id:       '',
  slide_name:      '',
  organ:           '',
  konspekt_number: '',
  stain:           '',
  olyvia_folder:   '',
};

const EMPTY_MAPPING: SubjectMapping = { faculty_id: '', specialty_id: '', subject: '' };

// ── Slide name parser ──────────────────────────────────────────────────────────
function parseSlideName(name: string): { organ: string; konspekt_number: string; stain: string } {
  const parts = name.split('_');
  const kIdx = parts.findIndex(p => p.startsWith('#'));
  if (kIdx < 1) return { organ: name, konspekt_number: '', stain: '' };
  const organ           = parts.slice(0, kIdx - 1).join(' ').trim();
  const konspekt_number = parts[kIdx].slice(1).trim();
  const stain           = parts.slice(kIdx + 1).join('_').trim();
  return { organ, konspekt_number, stain };
}

// ── SubjectPicker ──────────────────────────────────────────────────────────────

interface SubjectPickerProps {
  value: SubjectMapping;
  onChange: (v: SubjectMapping) => void;
  label?: string;
}
function SubjectPicker({ value, onChange, label }: SubjectPickerProps) {
  const faculty    = FACULTIES.find(f => f.id === value.faculty_id);
  const specialties = faculty?.specialties ?? [];
  const specialty  = specialties.find(s => s.id === value.specialty_id);
  const subjects   = specialty?.subjects ?? [];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
      <div>
        {label && <div className="text-xs text-gray-500 mb-1">{label}</div>}
        <select
          value={value.faculty_id}
          onChange={e => onChange({ faculty_id: e.target.value, specialty_id: '', subject: '' })}
          className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
        >
          <option value="">— Факултет —</option>
          {FACULTIES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>
      <div>
        {label && <div className="text-xs opacity-0 mb-1">.</div>}
        <select
          value={value.specialty_id}
          onChange={e => onChange({ ...value, specialty_id: e.target.value, subject: '' })}
          disabled={!value.faculty_id}
          className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400"
        >
          <option value="">— Специалност —</option>
          {specialties.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div>
        {label && <div className="text-xs opacity-0 mb-1">.</div>}
        <select
          value={value.subject}
          onChange={e => onChange({ ...value, subject: e.target.value })}
          disabled={!value.specialty_id}
          className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm bg-white focus:outline-none focus:ring-1 focus:ring-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400"
        >
          <option value="">— Дисциплина —</option>
          {subjects.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>
    </div>
  );
}

// ── MultiSubjectEditor ─────────────────────────────────────────────────────────

interface MultiSubjectEditorProps {
  mappings: SubjectMapping[];
  onMappingsChange: (m: SubjectMapping[]) => void;
}
function MultiSubjectEditor({ mappings, onMappingsChange }: MultiSubjectEditorProps) {
  const [pending, setPending] = useState<SubjectMapping>(EMPTY_MAPPING);
  const [adding,  setAdding]  = useState(mappings.length === 0);

  function addPending() {
    if (!pending.faculty_id || !pending.specialty_id || !pending.subject) return;
    const already = mappings.some(
      m => m.faculty_id === pending.faculty_id &&
           m.specialty_id === pending.specialty_id &&
           m.subject === pending.subject,
    );
    if (already) { setAdding(false); return; }
    onMappingsChange([...mappings, { ...pending }]);
    setPending(EMPTY_MAPPING);
    setAdding(false);
  }

  function removeAt(idx: number) {
    onMappingsChange(mappings.filter((_, i) => i !== idx));
  }

  function label(m: SubjectMapping) {
    const f = FACULTIES.find(f => f.id === m.faculty_id);
    const s = f?.specialties.find(s => s.id === m.specialty_id);
    return `${m.subject}${s ? ` · ${s.name}` : ''}`;
  }

  return (
    <div className="space-y-2">
      {mappings.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {mappings.map((m, i) => (
            <span key={i} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-[#7B1C1C]/10 text-[#7B1C1C] border border-[#7B1C1C]/20">
              {label(m)}
              <button type="button" onClick={() => removeAt(i)} className="ml-0.5 text-[#7B1C1C]/60 hover:text-[#7B1C1C] font-bold leading-none" title="Премахни">×</button>
            </span>
          ))}
        </div>
      )}
      {adding ? (
        <div className="border border-gray-200 rounded-lg p-3 bg-gray-50 space-y-2">
          <SubjectPicker value={pending} onChange={setPending} label="Факултет" />
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={addPending} disabled={!pending.faculty_id || !pending.specialty_id || !pending.subject}
              className="px-3 py-1.5 text-xs font-semibold text-white rounded transition-colors disabled:opacity-40" style={{ backgroundColor: '#7B1C1C' }}>
              Добави
            </button>
            {mappings.length > 0 && (
              <button type="button" onClick={() => { setPending(EMPTY_MAPPING); setAdding(false); }}
                className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-100">
                Откажи
              </button>
            )}
          </div>
        </div>
      ) : (
        <button type="button" onClick={() => setAdding(true)} className="text-xs text-[#7B1C1C] hover:underline font-medium">
          + Добави още дисциплина
        </button>
      )}
    </div>
  );
}

// ── BulkAssignPanel ────────────────────────────────────────────────────────────
// Inline panel rendered per folder-group for bulk assignment.

interface BulkAssignPanelProps {
  folderId: number | null;
  onAssigned: () => void;
  onCleared: () => void;
  onFeedback: (msg: string, ok: boolean) => void;
}
function BulkAssignPanel({ folderId, onAssigned, onCleared, onFeedback }: BulkAssignPanelProps) {
  const [subs, setSubs]   = useState<SubjectMapping[]>([]);
  const [saving, setSaving] = useState(false);

  async function handleAssign() {
    if (subs.length === 0) { onFeedback('Изберете поне една дисциплина', false); return; }
    setSaving(true);
    try {
      const res = await fetch('/api/slides/bulk-assign', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_folder_id: folderId, subjects: subs }),
      });
      const json = await res.json() as { assigned?: number; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      onFeedback(`Разпределени ${json.assigned} препарата`, true);
      setSubs([]);
      onAssigned();
    } catch (e) {
      onFeedback(e instanceof Error ? e.message : 'Грешка', false);
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (!confirm(`Изчисти ВСИЧКИ дисциплини за папка ${folderId}?`)) return;
    setSaving(true);
    try {
      const res = await fetch('/api/slides/bulk-assign', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parent_folder_id: folderId }),
      });
      const json = await res.json() as { cleared?: number; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      onFeedback(`Изчистени ${json.cleared} препарата`, true);
      onCleared();
    } catch (e) {
      onFeedback(e instanceof Error ? e.message : 'Грешка', false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="border border-amber-200 rounded-lg p-3 bg-amber-50 space-y-2">
      <div className="text-xs font-medium text-amber-800 mb-1">Групово разпределяне на дисциплини за тази папка:</div>
      <MultiSubjectEditor mappings={subs} onMappingsChange={setSubs} />
      <div className="flex gap-2 pt-1">
        <button type="button" onClick={handleAssign} disabled={saving || subs.length === 0}
          className="px-3 py-1.5 text-xs font-semibold text-white rounded transition-colors disabled:opacity-40" style={{ backgroundColor: '#7B1C1C' }}>
          {saving ? 'Запазване…' : `Присвои (${subs.length} дисц.)`}
        </button>
        <button type="button" onClick={handleClear} disabled={saving}
          className="px-3 py-1.5 text-xs text-red-600 border border-red-200 rounded hover:bg-red-50 transition-colors disabled:opacity-40">
          Изчисти папката
        </button>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AdminSlidesPage() {
  const [slides,   setSlides]   = useState<SlideRow[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [saving,   setSaving]   = useState(false);
  const [feedback, setFeedback] = useState<{ msg: string; ok: boolean } | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Add-slide form ────────────────────────────────────────────────────────
  const [form,     setForm]     = useState(EMPTY_SLIDE_FIELDS);
  const [formSubs, setFormSubs] = useState<SubjectMapping[]>([]);
  const [formOpen, setFormOpen] = useState(false);

  // ── Filter + view mode ────────────────────────────────────────────────────
  const [filterFaculty,   setFilterFaculty]   = useState('');
  const [filterSpecialty, setFilterSpecialty] = useState('');
  const [filterSubject,   setFilterSubject]   = useState('');
  const [search,          setSearch]          = useState('');
  const [unassignedOnly,  setUnassignedOnly]  = useState(false);
  const [viewMode,        setViewMode]        = useState<'flat' | 'grouped'>('flat');

  const filterFacultyObj    = FACULTIES.find(f => f.id === filterFaculty);
  const filterSpecialtyList = filterFacultyObj?.specialties ?? [];
  const filterSpecialtyObj  = filterSpecialtyList.find(s => s.id === filterSpecialty);
  const filterSubjectList   = filterSpecialtyObj?.subjects ?? [];

  // ── Inline edit ───────────────────────────────────────────────────────────
  const [editingId,  setEditingId]  = useState<string | null>(null);
  const [editFields, setEditFields] = useState({ organ: '', konspekt_number: '', stain: '', olyvia_folder: '' });
  const [editSubs,   setEditSubs]   = useState<SubjectMapping[]>([]);

  // ── Bulk assign: which folder panel is open ───────────────────────────────
  const [openBulkFolder, setOpenBulkFolder] = useState<number | null | 'none'>(undefined as unknown as null);

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
      const res  = await fetch(`/api/slides?${params}`);
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
      showFeedback('Record ID трябва да е положително цяло число', false); return;
    }
    if (!form.slide_name.trim()) {
      showFeedback('Slide name е задължително', false); return;
    }
    if (formSubs.length === 0) {
      showFeedback('Добавете поне една учебна дисциплина', false); return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/slides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          record_id:       rid,
          slide_name:      form.slide_name.trim(),
          organ:           form.organ.trim()           || null,
          konspekt_number: form.konspekt_number.trim() || null,
          stain:           form.stain.trim()           || null,
          olyvia_folder:   form.olyvia_folder.trim()   || null,
          subjects:        formSubs,
        }),
      });
      const json = await res.json() as { slide?: SlideRow; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback(`Препарат ${form.slide_name} е записан`, true);
      setForm(EMPTY_SLIDE_FIELDS);
      setFormSubs([]);
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
      const res  = await fetch(`/api/slides/${slide.id}`, { method: 'DELETE' });
      const json = await res.json() as { error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback(`Препарат ${slide.slide_name} е изтрит`, true);
      setSlides(prev => prev.filter(s => s.id !== slide.id));
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при изтриване', false);
    }
  }

  // ── Inline edit ───────────────────────────────────────────────────────────

  function openEdit(slide: SlideRow) {
    setEditingId(slide.id);
    setEditFields({
      organ:           slide.organ           ?? '',
      konspekt_number: slide.konspekt_number ?? '',
      stain:           slide.stain           ?? '',
      olyvia_folder:   slide.olyvia_folder   ?? '',
    });
    setEditSubs(slide.slide_subjects.map(s => ({
      faculty_id:  s.faculty_id,
      specialty_id: s.specialty_id,
      subject:     s.subject,
    })));
  }

  async function handleEditSave(id: string) {
    try {
      const res = await fetch(`/api/slides/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          organ:           editFields.organ.trim()           || null,
          konspekt_number: editFields.konspekt_number.trim() || null,
          stain:           editFields.stain.trim()           || null,
          olyvia_folder:   editFields.olyvia_folder.trim()   || null,
          ...(editSubs.length > 0 ? { subjects: editSubs } : {}),
        }),
      });
      const json = await res.json() as { slide?: SlideRow; error?: string };
      if (!res.ok || json.error) throw new Error(json.error ?? 'Грешка');
      showFeedback('Промените са запазени', true);
      setEditingId(null);
      if (json.slide) setSlides(prev => prev.map(s => s.id === id ? json.slide! : s));
    } catch (e) {
      showFeedback(e instanceof Error ? e.message : 'Грешка при запис', false);
    }
  }

  // ── Counts ────────────────────────────────────────────────────────────────

  const assignedCount   = slides.filter(s => s.slide_subjects.length > 0).length;
  const unassignedCount = slides.length - assignedCount;

  // ── Filtered display list ─────────────────────────────────────────────────

  const displayed = slides.filter(s => {
    if (unassignedOnly && s.slide_subjects.length > 0) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      s.slide_name.toLowerCase().includes(q) ||
      (s.organ ?? '').toLowerCase().includes(q) ||
      (s.konspekt_number ?? '').toLowerCase().includes(q) ||
      s.slide_subjects.some(m => m.subject.toLowerCase().includes(q))
    );
  });

  // ── Grouped by parent_folder_id ────────────────────────────────────────────

  const grouped = new Map<number | null, SlideRow[]>();
  for (const s of displayed) {
    const pid = s.parent_folder_id ?? null;
    if (!grouped.has(pid)) grouped.set(pid, []);
    grouped.get(pid)!.push(s);
  }
  const sortedFolders: Array<[number | null, SlideRow[]]> = Array.from(grouped.entries()).sort(([a], [b]) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a - b;
  });

  // ── Slide row renderer ─────────────────────────────────────────────────────

  function renderSlideRow(slide: SlideRow) {
    const isEditing = editingId === slide.id;
    return (
      <div key={slide.id} className={`p-4 border-b border-gray-100 last:border-0 ${isEditing ? 'bg-blue-50' : 'hover:bg-gray-50'} transition-colors`}>
        {isEditing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(['organ', 'konspekt_number', 'stain', 'olyvia_folder'] as const).map(key => (
                <div key={key}>
                  <label className="block text-xs text-gray-500 mb-0.5 capitalize">{key.replace('_', ' ')}</label>
                  <input type="text" value={editFields[key]}
                    onChange={e => setEditFields(f => ({ ...f, [key]: e.target.value }))}
                    className="w-full border border-gray-300 rounded px-2.5 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
                  />
                </div>
              ))}
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Учебни дисциплини</label>
              <MultiSubjectEditor mappings={editSubs} onMappingsChange={setEditSubs} />
            </div>
            <div className="flex gap-2">
              <button type="button" onClick={() => void handleEditSave(slide.id)}
                className="px-3 py-1.5 text-xs font-semibold text-white rounded" style={{ backgroundColor: '#7B1C1C' }}>
                Запази
              </button>
              <button type="button" onClick={() => setEditingId(null)}
                className="px-3 py-1.5 text-xs text-gray-600 border border-gray-200 rounded hover:bg-gray-100">
                Откажи
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-mono text-gray-400">#{slide.record_id}</span>
                <span className="font-medium text-gray-900 text-sm truncate">{slide.slide_name}</span>
                {slide.slide_subjects.length === 0 && (
                  <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 border border-amber-200">неразпределен</span>
                )}
              </div>
              <div className="text-xs text-gray-500 mt-0.5">
                {[slide.organ, slide.konspekt_number && `#${slide.konspekt_number}`, slide.stain].filter(Boolean).join(' · ')}
              </div>
              {slide.slide_subjects.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1.5">
                  {slide.slide_subjects.map((m, i) => {
                    const f = FACULTIES.find(f => f.id === m.faculty_id);
                    const s = f?.specialties.find(s => s.id === m.specialty_id);
                    return (
                      <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-[#7B1C1C]/10 text-[#7B1C1C]">
                        {m.subject}{s ? ` · ${s.name}` : ''}
                      </span>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <a href={`/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${slide.record_id}`}
                target="_blank" rel="noopener noreferrer"
                className="p-1.5 rounded text-gray-400 hover:text-[#7B1C1C] hover:bg-gray-100 transition-colors text-xs" title="Преглед в OlyVia">
                🔬
              </a>
              <button type="button" onClick={() => openEdit(slide)}
                className="p-1.5 rounded text-gray-400 hover:text-[#7B1C1C] hover:bg-gray-100 transition-colors text-xs" title="Редактирай">
                ✏️
              </button>
              <button type="button" onClick={() => void handleDelete(slide)}
                className="p-1.5 rounded text-gray-400 hover:text-red-600 hover:bg-red-50 transition-colors text-xs" title="Изтрий">
                🗑️
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">

      {/* Page header */}
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
              {slides.length} записани
              {slides.length > 0 && (
                <> &mdash; <span className="text-green-700">{assignedCount} разпределени</span>,{' '}
                  <span className={unassignedCount > 0 ? 'text-amber-600' : 'text-gray-400'}>
                    {unassignedCount} неразпределени
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <a href="/admin/stats" className="text-xs text-gray-400 hover:text-[#7B1C1C]">📊 Статистика</a>
            <a href="/admin" className="text-xs text-gray-400 hover:text-[#7B1C1C]">← Документи</a>
          </div>
        </div>
      </header>

      {/* Feedback toast */}
      {feedback && (
        <div className={`fixed top-4 right-4 z-50 px-4 py-2.5 rounded-lg shadow-lg text-sm font-medium ${
          feedback.ok ? 'bg-green-50 text-green-800 border border-green-200' : 'bg-red-50 text-red-800 border border-red-200'
        }`}>
          {feedback.ok ? '✓ ' : '✗ '}{feedback.msg}
        </div>
      )}

      <main className="max-w-7xl mx-auto px-6 py-8 space-y-6">

        {/* ADD SLIDE FORM */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <button
            className="w-full flex items-center justify-between px-6 py-4 text-left hover:bg-gray-50 transition-colors"
            onClick={() => setFormOpen(v => !v)}
          >
            <span className="font-semibold text-gray-800">➕ Добави нов препарат ръчно</span>
            <span className="text-gray-400 text-sm">{formOpen ? '▲ Скрий' : '▼ Покажи'}</span>
          </button>

          {formOpen && (
            <form onSubmit={handleAdd} className="px-6 pb-6 border-t border-gray-100">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Record ID <span className="text-red-500">*</span></label>
                  <div className="flex gap-2">
                    <input type="number" min={1} value={form.record_id}
                      onChange={e => setForm(f => ({ ...f, record_id: e.target.value }))}
                      placeholder="напр. 21236"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                    <a href={form.record_id ? `/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${form.record_id}` : '#'}
                      target="_blank" rel="noopener noreferrer"
                      className={`flex items-center gap-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors whitespace-nowrap ${
                        form.record_id ? 'border-[#7B1C1C] text-[#7B1C1C] hover:bg-[#7B1C1C] hover:text-white' : 'border-gray-200 text-gray-300 pointer-events-none'
                      }`}>
                      🔬 Преглед
                    </a>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Оригинално OlyVia название <span className="text-red-500">*</span></label>
                  <div className="flex gap-2">
                    <input type="text" value={form.slide_name}
                      onChange={e => setForm(f => ({ ...f, slide_name: e.target.value }))}
                      placeholder="напр. Oesophagus_1_#18a_HE"
                      className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                    <button type="button" onClick={handleParse}
                      className="px-3 py-2 rounded-lg border border-[#7B1C1C] text-[#7B1C1C] text-xs font-medium hover:bg-[#7B1C1C] hover:text-white transition-colors whitespace-nowrap">
                      Парсирай
                    </button>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Орган / структура</label>
                  <input type="text" value={form.organ}
                    onChange={e => setForm(f => ({ ...f, organ: e.target.value }))}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Конспект №</label>
                    <input type="text" value={form.konspekt_number}
                      onChange={e => setForm(f => ({ ...f, konspekt_number: e.target.value }))}
                      placeholder="напр. 18a"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Оцветяване</label>
                    <input type="text" value={form.stain}
                      onChange={e => setForm(f => ({ ...f, stain: e.target.value }))}
                      placeholder="напр. HE"
                      className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                    />
                  </div>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-xs font-medium text-gray-600 mb-2">
                    Учебни дисциплини <span className="text-red-500">*</span>
                    <span className="text-gray-400 font-normal ml-1">(може повече от една)</span>
                  </label>
                  <MultiSubjectEditor mappings={formSubs} onMappingsChange={setFormSubs} />
                </div>
              </div>
              <div className="mt-5 flex items-center gap-3">
                <button type="submit" disabled={saving}
                  className="px-5 py-2.5 rounded-lg text-sm font-semibold text-white transition-colors disabled:opacity-50" style={{ backgroundColor: '#7B1C1C' }}>
                  {saving ? 'Запазване…' : '💾 Запази препарата'}
                </button>
                <button type="button" onClick={() => { setForm(EMPTY_SLIDE_FIELDS); setFormSubs([]); }}
                  className="px-4 py-2.5 rounded-lg text-sm text-gray-600 border border-gray-200 hover:bg-gray-50">
                  Изчисти
                </button>
              </div>
            </form>
          )}
        </section>

        {/* SLIDES LIST */}
        <section className="bg-white rounded-xl border border-gray-200 shadow-sm">

          {/* Filter / toolbar */}
          <div className="px-6 py-4 border-b border-gray-100 space-y-3">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-48">
                <label className="block text-xs font-medium text-gray-500 mb-1">Търсене</label>
                <input type="text" value={search} onChange={e => setSearch(e.target.value)}
                  placeholder="Орган, конспект №, дисциплина…"
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Факултет</label>
                <select value={filterFaculty}
                  onChange={e => { setFilterFaculty(e.target.value); setFilterSpecialty(''); setFilterSubject(''); }}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C]">
                  <option value="">Всички факултети</option>
                  {FACULTIES.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Специалност</label>
                <select value={filterSpecialty} disabled={!filterFaculty}
                  onChange={e => { setFilterSpecialty(e.target.value); setFilterSubject(''); }}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400">
                  <option value="">Всички специалности</option>
                  {filterSpecialtyList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-500 mb-1">Дисциплина</label>
                <select value={filterSubject} disabled={!filterSpecialty}
                  onChange={e => setFilterSubject(e.target.value)}
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-[#7B1C1C]/30 focus:border-[#7B1C1C] disabled:bg-gray-50 disabled:text-gray-400">
                  <option value="">Всички дисциплини</option>
                  {filterSubjectList.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
            </div>

            {/* View mode + unassigned toggle */}
            <div className="flex flex-wrap items-center gap-4">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input type="checkbox" checked={unassignedOnly} onChange={e => setUnassignedOnly(e.target.checked)}
                  className="rounded border-gray-300 text-amber-600 focus:ring-amber-500"
                />
                <span className="text-sm text-amber-700 font-medium">
                  Само неразпределени
                  {unassignedCount > 0 && <span className="ml-1.5 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 text-xs">{unassignedCount}</span>}
                </span>
              </label>

              <div className="flex items-center gap-1 ml-auto">
                <button type="button" onClick={() => setViewMode('flat')}
                  className={`px-3 py-1.5 text-xs rounded-l-lg border transition-colors ${viewMode === 'flat' ? 'bg-[#7B1C1C] text-white border-[#7B1C1C]' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                  ☰ Списък
                </button>
                <button type="button" onClick={() => setViewMode('grouped')}
                  className={`px-3 py-1.5 text-xs rounded-r-lg border-y border-r transition-colors ${viewMode === 'grouped' ? 'bg-[#7B1C1C] text-white border-[#7B1C1C]' : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'}`}>
                  📂 По папка
                </button>
              </div>

              <span className="text-xs text-gray-400">{displayed.length} от {slides.length}</span>
            </div>
          </div>

          {/* Content */}
          {loading ? (
            <div className="p-12 text-center text-gray-400 text-sm">Зареждане…</div>
          ) : displayed.length === 0 ? (
            <div className="p-12 text-center text-gray-400 text-sm">
              {unassignedOnly ? 'Всички препарати са разпределени.' : 'Няма намерени препарати.'}
            </div>
          ) : viewMode === 'flat' ? (
            <div>{displayed.map(renderSlideRow)}</div>
          ) : (
            /* Grouped by folder */
            <div className="divide-y divide-gray-100">
              {sortedFolders.map(([folderId, folderSlides]) => {
                const assigned   = folderSlides.filter(s => s.slide_subjects.length > 0).length;
                const unassigned = folderSlides.length - assigned;
                const isBulkOpen = openBulkFolder === folderId;

                return (
                  <div key={String(folderId)} className="bg-white">
                    {/* Folder header */}
                    <div className="px-6 py-3 bg-gray-50 border-b border-gray-100 flex items-center justify-between gap-4">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-semibold text-gray-700">
                          📂 Папка {folderId ?? '(без папка)'}
                        </span>
                        <span className="text-xs text-gray-500">{folderSlides.length} препарата</span>
                        <span className="text-xs text-green-700">{assigned} разпр.</span>
                        {unassigned > 0 && (
                          <span className="text-xs text-amber-600">{unassigned} неразпр.</span>
                        )}
                      </div>
                      <button type="button"
                        onClick={() => setOpenBulkFolder(isBulkOpen ? null : folderId)}
                        className={`text-xs px-3 py-1 rounded border transition-colors ${
                          isBulkOpen
                            ? 'bg-amber-100 text-amber-800 border-amber-200'
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-amber-50 hover:text-amber-700'
                        }`}
                      >
                        {isBulkOpen ? '▲ Затвори' : '🔖 Групово присвояване'}
                      </button>
                    </div>

                    {/* Bulk assign panel */}
                    {isBulkOpen && (
                      <div className="px-6 py-3 border-b border-amber-100">
                        <BulkAssignPanel
                          folderId={folderId}
                          onAssigned={() => { void loadSlides(); }}
                          onCleared={() => { void loadSlides(); }}
                          onFeedback={showFeedback}
                        />
                      </div>
                    )}

                    {/* Slides in folder */}
                    <div>{folderSlides.map(renderSlideRow)}</div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

      </main>
    </div>
  );
}
