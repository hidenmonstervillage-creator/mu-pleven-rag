'use client';

import { Fragment, useState, useRef, useEffect, useCallback } from 'react';
import { FACULTIES } from '@/lib/faculties';
import { Faculty, Specialty } from '@/lib/types';

// Upload directly to the Cloudflare tunnel (HTTPS) — bypasses Vercel's 4.5 MB limit.
// Update this constant whenever the ephemeral tunnel URL rotates.
const HETZNER_UPLOAD_URL =
  process.env.NEXT_PUBLIC_HETZNER_UPLOAD_URL ??
  'https://pixels-clocks-reprint-increasingly.trycloudflare.com/upload';
const HETZNER_API_KEY =
  process.env.NEXT_PUBLIC_HETZNER_API_KEY ?? 'mup-upload-secret-2024';

// Transliterate Cyrillic → ASCII slug for Hetzner path segments
function toStorageSlug(text: string): string {
  const map: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ж: 'zh', з: 'z',
    и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p',
    р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch',
    ш: 'sh', щ: 'sht', ъ: 'a', ь: '', ю: 'yu', я: 'ya',
  };
  return text.toLowerCase().split('').map((c) => map[c] ?? c).join('')
    .replace(/[^a-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
}

// ─── XHR upload wrapper ───────────────────────────────────────────────────────
// Wraps XMLHttpRequest in a Promise so the outer async/await flow is unchanged.
// Resolves on any completed response (caller checks .ok / .status).
// Rejects with Error('Failed to fetch') on network error — intentionally mirrors
// the fetch() error message so the existing tunnel-retry path triggers correctly.

interface XHRResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

function xhrUpload(
  url: string,
  formData: FormData,
  apiKey: string,
  onProgress: (pct: number) => void,
): Promise<XHRResponse> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('x-api-key', apiKey);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };

    xhr.onload = () => {
      const responseText = xhr.responseText;
      resolve({
        ok:     xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text:   () => Promise.resolve(responseText),
        json:   () => {
          try   { return Promise.resolve(JSON.parse(responseText) as unknown); }
          catch { return Promise.reject(new Error('Invalid JSON response'));    }
        },
      });
    };

    xhr.onerror   = () => reject(new Error('Failed to fetch'));
    xhr.ontimeout = () => reject(new Error('Upload timed out'));

    xhr.send(formData);
  });
}

// ─── Document row type (returned by /api/documents) ──────────────────────────

type DocumentRow = {
  id: string;
  filename: string;
  clean_title: string;
  file_type: 'textbook' | 'lecture';
  faculty_id: string;
  specialty_id: string;
  subject: string;
  storage_url: string;
  page_count: number;
  created_at: string;
  chunk_count: number;
};

// ─── Types ────────────────────────────────────────────────────────────────────

type ClassifyResult = {
  faculty_id: string;
  specialty_id: string;
  subject: string;
  confidence: number;
  file_type: 'textbook' | 'lecture';
};

type UploadStatus = 'idle' | 'uploading' | 'success' | 'error' | 'duplicate' | 'skipped';

type FileEntry = {
  id: number;
  file: File;
  // Upload
  uploadStatus: UploadStatus;
  uploadMessage?: string;
  // Auto-classification
  classifyStatus: 'idle' | 'loading' | 'done' | 'error';
  classifyResult?: ClassifyResult;
  // Manual overrides (used when confidence < 0.7 or classify error)
  manualSubject: string;
  manualFacultyId: string;
  manualSpecialtyId: string;
  manualFileType: 'textbook' | 'lecture';
};

type SortKey = 'date_desc' | 'date_asc' | 'chunks_asc' | 'chunks_desc';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
}

// Chunk count health colour: red < 20, amber 20–99, green ≥ 100
function chunkClass(count: number): string {
  if (count < 20)  return 'text-red-600 font-semibold';
  if (count < 100) return 'text-amber-600 font-semibold';
  return 'text-green-600 font-semibold';
}

// Flat subject → { faculty_id, specialty_id } lookup
const SUBJECT_LOOKUP = new Map<string, { faculty_id: string; specialty_id: string }>();
for (const f of FACULTIES) {
  for (const s of f.specialties) {
    for (const sub of s.subjects) {
      if (!SUBJECT_LOOKUP.has(sub)) SUBJECT_LOOKUP.set(sub, { faculty_id: f.id, specialty_id: s.id });
    }
  }
}

// All subjects flat for manual dropdown
const ALL_SUBJECTS: Array<{ faculty: string; subject: string; faculty_id: string; specialty_id: string }> = [];
for (const f of FACULTIES) {
  for (const s of f.specialties) {
    for (const sub of s.subjects) {
      ALL_SUBJECTS.push({ faculty: f.name, subject: sub, faculty_id: f.id, specialty_id: s.id });
    }
  }
}

// Fast id → human name lookups for the documents table
const FACULTY_NAME = new Map(FACULTIES.map((f) => [f.id, f.name]));
const SPECIALTY_NAME = new Map(
  FACULTIES.flatMap((f) => f.specialties.map((s) => [s.id, s.name]))
);

const UPLOAD_ICON: Record<UploadStatus, string> = {
  idle:      '⏳',
  uploading: '🔄',
  success:   '✅',
  error:     '❌',
  duplicate: '⚠️',
  skipped:   '⏭️',
};

let nextId = 0;

// ─── Sub-components ────────────────────────────────────────────────────────────

// ─── Searchable subject combobox ──────────────────────────────────────────────

function SubjectCombobox({
  subjects,
  value,
  onChange,
  disabled,
}: {
  subjects: string[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setQuery(value); }, [value]);

  const suggestions = query.trim()
    ? subjects.filter((s) => s.toLowerCase().includes(query.toLowerCase())).slice(0, 8)
    : subjects;

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const commit = (sub: string) => {
    setQuery(sub);
    onChange(sub);
    setOpen(false);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    onChange(subjects.includes(v) ? v : v);
    setOpen(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') setOpen(false);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <input
        type="text"
        value={query}
        onChange={handleChange}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder="Търсете предмет..."
        disabled={disabled}
        className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white disabled:opacity-50"
      />
      {open && !disabled && (
        <ul className="absolute z-50 mt-1 w-full rounded-lg border border-gray-200 bg-white shadow-lg max-h-56 overflow-y-auto">
          {suggestions.length > 0 ? (
            suggestions.map((sub) => (
              <li
                key={sub}
                onMouseDown={() => commit(sub)}
                className={`px-3 py-2 text-sm cursor-pointer hover:bg-red-50 hover:text-[#7B1C1C] ${
                  sub === value ? 'bg-red-50 text-[#7B1C1C] font-medium' : 'text-gray-700'
                }`}
              >
                {sub}
              </li>
            ))
          ) : (
            <li className="px-3 py-2 text-sm text-gray-400 select-none">
              Няма намерени предмети
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

function ConfidenceBadge({ result }: { result: ClassifyResult }) {
  const pct = Math.round(result.confidence * 100);
  const high = result.confidence >= 0.7;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
        high
          ? 'bg-green-100 text-green-700 border border-green-200'
          : 'bg-yellow-100 text-yellow-700 border border-yellow-200'
      }`}
    >
      {high ? '✓' : '?'} {result.subject} · {pct}%
    </span>
  );
}

function ManualOverride({
  entry,
  onChange,
}: {
  entry: FileEntry;
  onChange: (id: number, patch: Partial<FileEntry>) => void;
}) {
  const handleSubjectChange = (subject: string) => {
    const lookup = SUBJECT_LOOKUP.get(subject);
    onChange(entry.id, {
      manualSubject: subject,
      manualFacultyId: lookup?.faculty_id ?? '',
      manualSpecialtyId: lookup?.specialty_id ?? '',
    });
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5">
      <p className="text-xs text-yellow-700 font-medium">
        Ниска увереност — изберете предмет ръчно:
      </p>
      <select
        value={entry.manualSubject}
        onChange={(e) => handleSubjectChange(e.target.value)}
        className="w-full rounded border border-yellow-300 bg-white px-2 py-1 text-xs text-gray-700 focus:outline-none focus:ring-1 focus:ring-[#7B1C1C]"
      >
        <option value="">— Изберете предмет —</option>
        {ALL_SUBJECTS.map((s, i) => (
          <option key={i} value={s.subject}>
            {s.subject} ({s.faculty})
          </option>
        ))}
      </select>
      <div className="flex gap-3">
        {(['textbook', 'lecture'] as const).map((t) => (
          <label key={t} className="flex items-center gap-1 cursor-pointer text-xs text-gray-600">
            <input
              type="radio"
              checked={entry.manualFileType === t}
              onChange={() => onChange(entry.id, { manualFileType: t })}
              className="accent-[#7B1C1C]"
            />
            {t === 'textbook' ? '📚 Учебник' : '🎓 Лекция'}
          </label>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function AdminPage() {
  // Global form state (normal mode)
  const [facultyId, setFacultyId] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [subject, setSubject] = useState('');
  const [fileType, setFileType] = useState<'textbook' | 'lecture'>('textbook');

  // Upload state
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<{
    success: number;
    failed: number;
    skipped: number;
  } | null>(null);

  // Per-file upload progress (0–100), keyed by FileEntry.id
  const [uploadProgress, setUploadProgress] = useState<Record<number, number>>({});

  // "Apply to all" inline feedback message
  const [applyAllMsg, setApplyAllMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const applyAllTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Documents list state
  const [documents, setDocuments]     = useState<DocumentRow[]>([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [docsError, setDocsError]     = useState<string | null>(null);
  const [deletingId, setDeletingId]   = useState<string | null>(null);

  // Documents filter / sort state
  const [filterFacultyId,   setFilterFacultyId]   = useState('');
  const [filterSpecialtyId, setFilterSpecialtyId] = useState('');
  const [filterSubject,     setFilterSubject]     = useState('');
  const [searchText,        setSearchText]        = useState('');
  const [sortKey,           setSortKey]           = useState<SortKey>('date_desc');

  // Inline reassign state
  const [reassignId,          setReassignId]          = useState<string | null>(null);
  const [reassignFacultyId,   setReassignFacultyId]   = useState('');
  const [reassignSpecialtyId, setReassignSpecialtyId] = useState('');
  const [reassignSubject,     setReassignSubject]     = useState('');
  const [reassignSaving,      setReassignSaving]      = useState(false);
  const [reassignMsg,         setReassignMsg]         = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const reassignTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Mode toggles
  const [autoMode, setAutoMode] = useState(false);
  const [folderMode, setFolderMode] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  // Mutable ref — updated without re-render when tunnel URL rotates
  const tunnelUrlRef = useRef(HETZNER_UPLOAD_URL);

  // Duplicate-confirmation gates: entry.id → resolve(proceed: boolean)
  // The file's upload promise parks here while waiting for the user's click.
  const confirmCallbacksRef = useRef<Map<number, (proceed: boolean) => void>>(new Map());

  // ── Fetch all documents from /api/documents ───────────────────────────────
  const fetchDocuments = useCallback(async () => {
    setDocsLoading(true);
    setDocsError(null);
    try {
      const res = await fetch('/api/documents');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { documents: rows } = await res.json() as { documents: DocumentRow[] };
      setDocuments(rows);
    } catch (err) {
      setDocsError(err instanceof Error ? err.message : String(err));
    } finally {
      setDocsLoading(false);
    }
  }, []);

  useEffect(() => { fetchDocuments(); }, [fetchDocuments]);

  // ── Delete a document ─────────────────────────────────────────────────────
  const handleDelete = useCallback(async (doc: DocumentRow) => {
    if (!confirm(`Сигурни ли сте, че искате да изтриете "${doc.clean_title}"? Това ще изтрие и всички чанкове.`)) return;
    setDeletingId(doc.id);
    try {
      const res = await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
    } catch (err) {
      alert('Грешка при изтриване: ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setDeletingId(null);
    }
  }, []);

  // ── Reassign callbacks ────────────────────────────────────────────────────

  const openReassign = useCallback((doc: DocumentRow) => {
    if (reassignTimerRef.current) clearTimeout(reassignTimerRef.current);
    setReassignId(doc.id);
    setReassignFacultyId(doc.faculty_id);
    setReassignSpecialtyId(doc.specialty_id);
    setReassignSubject(doc.subject);
    setReassignMsg(null);
  }, []);

  const closeReassign = useCallback(() => {
    if (reassignTimerRef.current) clearTimeout(reassignTimerRef.current);
    setReassignId(null);
    setReassignMsg(null);
  }, []);

  const handleReassignSave = useCallback(async () => {
    if (!reassignId || !reassignFacultyId || !reassignSpecialtyId || !reassignSubject.trim()) return;
    setReassignSaving(true);
    setReassignMsg(null);
    try {
      const res = await fetch(`/api/documents/${reassignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          faculty_id:   reassignFacultyId,
          specialty_id: reassignSpecialtyId,
          subject:      reassignSubject.trim(),
        }),
      });
      const body = await res.json() as { success?: boolean; error?: string; document?: DocumentRow };
      if (!res.ok || !body.success) throw new Error(body.error ?? `HTTP ${res.status}`);

      // Patch local state so the table updates immediately without a full refetch
      if (body.document) {
        const updated = body.document;
        setDocuments((prev) =>
          prev.map((d) => (d.id === reassignId ? { ...d, ...updated } : d))
        );
      }

      setReassignMsg({ type: 'ok', text: 'Запазено успешно' });
      reassignTimerRef.current = setTimeout(() => {
        setReassignId(null);
        setReassignMsg(null);
      }, 2000);
    } catch (err) {
      setReassignMsg({ type: 'err', text: err instanceof Error ? err.message : String(err) });
      reassignTimerRef.current = setTimeout(() => setReassignMsg(null), 2000);
    } finally {
      setReassignSaving(false);
    }
  }, [reassignId, reassignFacultyId, reassignSpecialtyId, reassignSubject]);

  // ── Derived values ────────────────────────────────────────────────────────

  const selectedFaculty: Faculty | undefined = FACULTIES.find((f) => f.id === facultyId);
  const selectedSpecialty: Specialty | undefined = selectedFaculty?.specialties.find(
    (s) => s.id === specialtyId
  );

  // Reassign form cascading
  const reassignFaculty = FACULTIES.find((f) => f.id === reassignFacultyId);
  const reassignSpecialty = reassignFaculty?.specialties.find((s) => s.id === reassignSpecialtyId);

  // Filter bar cascading options
  const filterFacultyObj  = FACULTIES.find((f) => f.id === filterFacultyId);
  const filterSpecialties = filterFacultyObj?.specialties ?? [];
  const filterSubjectOptions =
    filterSpecialties.find((s) => s.id === filterSpecialtyId)?.subjects ?? [];

  // Filtered + sorted documents
  const filteredDocs = (() => {
    let result = [...documents];
    if (filterFacultyId)   result = result.filter((d) => d.faculty_id    === filterFacultyId);
    if (filterSpecialtyId) result = result.filter((d) => d.specialty_id  === filterSpecialtyId);
    if (filterSubject)     result = result.filter((d) => d.subject        === filterSubject);
    if (searchText.trim()) {
      const q = searchText.trim().toLowerCase();
      result = result.filter(
        (d) =>
          d.clean_title.toLowerCase().includes(q) ||
          d.filename.toLowerCase().includes(q)
      );
    }
    result.sort((a, b) => {
      switch (sortKey) {
        case 'date_desc':   return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
        case 'date_asc':    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        case 'chunks_desc': return b.chunk_count - a.chunk_count;
        case 'chunks_asc':  return a.chunk_count - b.chunk_count;
      }
    });
    return result;
  })();

  const applyFolderMode = useCallback((enabled: boolean) => {
    const el = fileRef.current;
    if (!el) return;
    if (enabled) el.setAttribute('webkitdirectory', '');
    else el.removeAttribute('webkitdirectory');
    el.value = '';
    setEntries([]);
    setSummary(null);
  }, []);

  useEffect(() => { applyFolderMode(folderMode); }, [folderMode, applyFolderMode]);

  const patchEntry = useCallback((id: number, patch: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }, []);

  const classifyFile = useCallback(async (entry: FileEntry) => {
    patchEntry(entry.id, { classifyStatus: 'loading' });
    try {
      const res = await fetch('/api/classify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: entry.file.name }),
      });
      if (!res.ok) throw new Error('API error');
      const result: ClassifyResult = await res.json();
      patchEntry(entry.id, {
        classifyStatus: 'done',
        classifyResult: result,
        manualSubject:     result.subject,
        manualFacultyId:   result.faculty_id,
        manualSpecialtyId: result.specialty_id,
        manualFileType:    result.file_type,
      });
    } catch {
      patchEntry(entry.id, { classifyStatus: 'error' });
    }
  }, [patchEntry]);

  const handleFileChange = useCallback(() => {
    const raw = fileRef.current?.files;
    if (!raw || raw.length === 0) { setEntries([]); setSummary(null); return; }

    const valid = Array.from(raw).filter((f) => /\.(pdf|pptx)$/i.test(f.name));
    const newEntries: FileEntry[] = valid.map((file) => ({
      id: nextId++,
      file,
      uploadStatus:    'idle',
      classifyStatus:  'idle',
      manualSubject:   '',
      manualFacultyId: '',
      manualSpecialtyId: '',
      manualFileType:  'textbook',
    }));

    setEntries(newEntries);
    setSummary(null);

    if (autoMode) newEntries.forEach((e) => classifyFile(e));
  }, [autoMode, classifyFile]);

  useEffect(() => {
    if (autoMode && entries.length > 0) {
      entries.filter((e) => e.classifyStatus === 'idle').forEach((e) => classifyFile(e));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoMode]);

  function resolveParams(entry: FileEntry) {
    if (!autoMode) {
      return { fid: facultyId, sid: specialtyId, sub: subject, ft: fileType };
    }
    const r = entry.classifyResult;
    if (r && r.confidence >= 0.7) {
      return { fid: r.faculty_id, sid: r.specialty_id, sub: r.subject, ft: r.file_type };
    }
    return {
      fid: entry.manualFacultyId,
      sid: entry.manualSpecialtyId,
      sub: entry.manualSubject,
      ft:  entry.manualFileType,
    };
  }

  const canUpload = useCallback((): boolean => {
    if (entries.length === 0) return false;
    if (autoMode) {
      const allDone = entries.every(
        (e) => e.classifyStatus !== 'loading' && e.classifyStatus !== 'idle'
      );
      if (!allDone) return false;
      return entries.every((e) => {
        const p = resolveParams(e);
        return p.fid && p.sid && p.sub;
      });
    }
    return !!(facultyId && specialtyId && subject);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entries, autoMode, facultyId, specialtyId, subject]);

  // ── "Приложи към всички" ───────────────────────────────────────────────────
  // Copies the current global faculty/specialty/subject into every entry's
  // manual fields. Only visible in manual mode with ≥ 2 files. Locked once
  // any upload has started (any entry leaves 'idle' status).

  // True when every entry in the queue is still in its pre-upload idle state
  const allEntriesIdle = entries.length > 0 && entries.every((e) => e.uploadStatus === 'idle');

  const showApplyAll = !autoMode && entries.length >= 2;

  const showApplyAllInline = (type: 'ok' | 'err', text: string, ttlMs: number) => {
    if (applyAllTimerRef.current !== null) clearTimeout(applyAllTimerRef.current);
    setApplyAllMsg({ type, text });
    applyAllTimerRef.current = setTimeout(() => {
      setApplyAllMsg(null);
      applyAllTimerRef.current = null;
    }, ttlMs);
  };

  const handleApplyAll = useCallback(() => {
    if (!facultyId || !specialtyId || !subject) {
      showApplyAllInline('err', 'Избери факултет, специалност и предмет първо', 3000);
      return;
    }
    setEntries((prev) =>
      prev.map((e) => ({
        ...e,
        manualFacultyId:   facultyId,
        manualSpecialtyId: specialtyId,
        manualSubject:     subject,
      }))
    );
    showApplyAllInline('ok', `Приложено към ${entries.length} файла`, 2000);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facultyId, specialtyId, subject, entries.length]);

  // ── Upload handler ─────────────────────────────────────────────────────────
  //
  // Duplicate detection strategy: CLIENT-SIDE filtering of the `documents`
  // state snapshot (already loaded on mount, refreshed after each batch).
  // This avoids extra API calls and query-param changes to /api/documents.
  // The snapshot is taken once when handleUpload is called; documents uploaded
  // within the current batch are NOT in this snapshot, preventing false
  // positives between sibling files in the same run.
  //
  // All files run in parallel via Promise.all. A file that finds a duplicate
  // parks in 'duplicate' status, awaiting a Promise<boolean> whose resolver is
  // stored in confirmCallbacksRef. The "Да"/"Не" buttons in the UI call that
  // resolver, unblocking only that file's async chain while all other files
  // continue unaffected.

  const handleUpload = async () => {
    if (!canUpload() || isUploading) return;
    if (!autoMode && (!facultyId || !specialtyId || !subject)) {
      alert('Попълнете всички полета преди качване.');
      return;
    }

    setIsUploading(true);
    setSummary(null);
    setUploadProgress({});

    // Capture current documents snapshot for duplicate checks
    const docsSnapshot = documents;

    // Upload one file; returns 'success' | 'error' | 'skipped'
    const uploadOne = async (entry: FileEntry): Promise<'success' | 'error' | 'skipped'> => {
      const { fid, sid, sub, ft } = resolveParams(entry);

      // ── Duplicate check (client-side against snapshot) ─────────────────────
      const isDuplicate = docsSnapshot.some(
        (doc) =>
          doc.filename.trim().toLowerCase() === entry.file.name.trim().toLowerCase() &&
          doc.faculty_id  === fid &&
          doc.specialty_id === sid &&
          doc.subject      === sub
      );

      if (isDuplicate) {
        // Park the file — UI renders the confirmation badge
        patchEntry(entry.id, { uploadStatus: 'duplicate', uploadMessage: undefined });

        const proceed = await new Promise<boolean>((resolve) => {
          confirmCallbacksRef.current.set(entry.id, resolve);
        });
        confirmCallbacksRef.current.delete(entry.id);

        if (!proceed) {
          patchEntry(entry.id, { uploadStatus: 'skipped', uploadMessage: 'Пропуснат' });
          return 'skipped';
        }

        // User said "Да" — reset to uploading state and continue
        patchEntry(entry.id, { uploadStatus: 'uploading', uploadMessage: undefined });
        setUploadProgress((prev) => ({ ...prev, [entry.id]: 0 }));
      } else {
        patchEntry(entry.id, { uploadStatus: 'uploading', uploadMessage: undefined });
        setUploadProgress((prev) => ({ ...prev, [entry.id]: 0 }));
      }

      try {
        // ── Step 1: upload file to Hetzner ──────────────────────────────────
        const formData = new FormData();
        formData.append('facultyId',   toStorageSlug(fid));
        formData.append('specialtyId', toStorageSlug(sid));
        formData.append('subject',     toStorageSlug(sub));
        formData.append('file',        entry.file);

        const doXhr = (url: string) =>
          xhrUpload(url, formData, HETZNER_API_KEY, (pct) => {
            setUploadProgress((prev) => ({ ...prev, [entry.id]: pct }));
          });

        let uploadRes: XHRResponse;
        try {
          uploadRes = await doXhr(tunnelUrlRef.current);
        } catch (fetchErr) {
          const fetchMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
          if (fetchMsg === 'Failed to fetch') {
            patchEntry(entry.id, {
              uploadStatus:  'uploading',
              uploadMessage: 'Tunnel URL обновен, опитвам отново...',
            });
            setUploadProgress((prev) => ({ ...prev, [entry.id]: 0 }));
            try {
              const txt = await fetch('http://178.105.161.66/tunnel-url.txt').then((r) => r.text());
              const newBase = txt.trim();
              if (newBase) tunnelUrlRef.current = newBase + '/upload';
            } catch { /* keep existing URL */ }
            uploadRes = await doXhr(tunnelUrlRef.current);
          } else {
            throw fetchErr;
          }
        }

        if (!uploadRes.ok) {
          const errBody = await uploadRes.text();
          throw new Error(`Hetzner upload failed (${uploadRes.status}): ${errBody}`);
        }
        const { url: storageUrl } = await uploadRes.json() as { url: string };

        // ── Step 2: ingest (embed + index) ───────────────────────────────────
        const res = await fetch('/api/ingest', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            storageUrl,
            filename:    entry.file.name,
            facultyId:   fid,
            specialtyId: sid,
            subject:     sub,
            fileType:    ft,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error ?? 'Unknown error');

        patchEntry(entry.id, {
          uploadStatus:  'success',
          uploadMessage: `${data.chunksCreated} чанка`,
        });
        return 'success';

      } catch (err) {
        const errMsg = err instanceof Error
          ? err.message
          : typeof err === 'string'
          ? err
          : JSON.stringify(err);
        patchEntry(entry.id, { uploadStatus: 'error', uploadMessage: errMsg });
        return 'error';
      }
    };

    // Run all files in parallel — duplicates gate independently, others proceed
    const results = await Promise.all(entries.map(uploadOne));

    setIsUploading(false);
    setSummary({
      success: results.filter((r) => r === 'success').length,
      failed:  results.filter((r) => r === 'error').length,
      skipped: results.filter((r) => r === 'skipped').length,
    });
    if (fileRef.current) fileRef.current.value = '';
    fetchDocuments();
  };

  // Resolve/reject a duplicate confirmation for a specific entry
  const confirmDuplicate = useCallback((entryId: number, proceed: boolean) => {
    confirmCallbacksRef.current.get(entryId)?.(proceed);
  }, []);

  const doneCount = entries.filter(
    (e) =>
      e.uploadStatus === 'success' ||
      e.uploadStatus === 'error'   ||
      e.uploadStatus === 'skipped'
  ).length;
  const totalCount      = entries.length;
  const classifyingCount = entries.filter((e) => e.classifyStatus === 'loading').length;

  const selectClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white';

  // Check whether any filter/search is active (for the "Показани N от M" label)
  const isFiltered =
    !!filterFacultyId || !!filterSpecialtyId || !!filterSubject || !!searchText.trim();

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-12 px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-[#7B1C1C] mb-1">Качване на материали</h1>
        <p className="text-sm text-gray-500 mb-6">Административен панел — МУ-Плевен AI Library</p>

        {/* ── Auto mode toggle ── */}
        <div className="flex items-center justify-between rounded-xl border border-gray-200 bg-gray-50 px-4 py-3 mb-6">
          <div>
            <p className="text-sm font-semibold text-gray-800">🤖 Автоматичен режим</p>
            <p className="text-xs text-gray-500 mt-0.5">
              AI класифицира предмета по името на файла
            </p>
          </div>
          <button
            onClick={() => setAutoMode((v) => !v)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
              autoMode ? 'bg-[#7B1C1C]' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                autoMode ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </div>

        <div className="flex flex-col gap-4">
          {/* ── Normal mode selectors ── */}
          {!autoMode && (
            <>
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Факултет</label>
                <select
                  value={facultyId}
                  onChange={(e) => { setFacultyId(e.target.value); setSpecialtyId(''); setSubject(''); }}
                  className={selectClass}
                >
                  <option value="">— Изберете факултет —</option>
                  {FACULTIES.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Специалност</label>
                <select
                  value={specialtyId}
                  onChange={(e) => { setSpecialtyId(e.target.value); setSubject(''); }}
                  disabled={!selectedFaculty}
                  className={selectClass}
                >
                  <option value="">— Изберете специалност —</option>
                  {selectedFaculty?.specialties.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Subject row — combobox + "Apply to all" button on the same line */}
              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Предмет</label>
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <SubjectCombobox
                      subjects={selectedSpecialty?.subjects ?? []}
                      value={subject}
                      onChange={setSubject}
                      disabled={!selectedSpecialty}
                    />
                  </div>

                  {/* "Apply to all" button — only when ≥ 2 files in queue */}
                  {showApplyAll && (
                    <button
                      type="button"
                      onClick={handleApplyAll}
                      disabled={!allEntriesIdle}
                      title={
                        !allEntriesIdle
                          ? 'Не може да се промени по време на качване'
                          : 'Приложи текущия факултет, специалност и предмет към всички файлове'
                      }
                      className={`flex-shrink-0 border border-gray-300 bg-white text-sm px-3 py-2 rounded-lg transition-colors whitespace-nowrap ${
                        allEntriesIdle
                          ? 'text-gray-700 hover:bg-gray-50 cursor-pointer'
                          : 'opacity-50 cursor-not-allowed pointer-events-none text-gray-400'
                      }`}
                    >
                      Приложи към всички
                    </button>
                  )}
                </div>

                {/* Inline feedback message (error or confirmation) */}
                {applyAllMsg && (
                  <p
                    className={`mt-1.5 text-xs ${
                      applyAllMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'
                    }`}
                  >
                    {applyAllMsg.text}
                  </p>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">Тип материал</label>
                <div className="flex gap-3">
                  {(['textbook', 'lecture'] as const).map((type) => (
                    <label key={type} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        value={type}
                        checked={fileType === type}
                        onChange={() => setFileType(type)}
                        className="accent-[#7B1C1C]"
                      />
                      <span className="text-sm text-gray-700">
                        {type === 'textbook' ? '📚 Учебник' : '🎓 Лекция'}
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}

          {/* ── File picker ── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-gray-600">
                Файлове (PDF или PPTX)
              </label>
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setFolderMode(false)}
                  className={`px-3 py-1.5 transition-colors ${
                    !folderMode ? 'bg-[#7B1C1C] text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  Единичен файл
                </button>
                <button
                  type="button"
                  onClick={() => setFolderMode(true)}
                  className={`px-3 py-1.5 transition-colors border-l border-gray-200 ${
                    folderMode ? 'bg-[#7B1C1C] text-white' : 'bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  Папка
                </button>
              </div>
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.pptx"
              multiple
              onChange={handleFileChange}
              className="w-full text-sm text-gray-600 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-red-50 file:text-[#7B1C1C] hover:file:bg-red-100 cursor-pointer"
            />
            <p className="text-xs text-gray-400 mt-1">
              {folderMode
                ? 'Изберете папка — всички PDF и PPTX файлове ще бъдат качени'
                : 'Изберете един или повече файлове (Ctrl+клик за множество)'}
            </p>
          </div>

          {/* ── File list ── */}
          {entries.length > 0 && (
            <div className="flex flex-col gap-2">
              {isUploading && (
                <p className="text-xs font-semibold text-[#7B1C1C]">
                  {doneCount} / {totalCount} файла обработени
                </p>
              )}
              {autoMode && classifyingCount > 0 && !isUploading && (
                <p className="text-xs text-gray-500 animate-pulse">
                  🤖 Класифициране на {classifyingCount} файл(а)…
                </p>
              )}

              <div className="max-h-80 overflow-y-auto flex flex-col gap-1.5 rounded-lg border border-gray-200 p-2 bg-gray-50">
                {entries.map((entry) => {
                  const pct     = uploadProgress[entry.id] ?? 0;
                  const showBar = entry.uploadStatus === 'uploading';

                  return (
                    <div
                      key={entry.id}
                      className="flex items-start gap-2 text-xs text-gray-700 bg-white rounded-lg px-3 py-2.5 border border-gray-100"
                    >
                      <span className="flex-shrink-0 mt-0.5 text-sm">
                        {UPLOAD_ICON[entry.uploadStatus]}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{entry.file.name}</p>
                        <p className="text-gray-400">{formatSize(entry.file.size)}</p>

                        {/* Progress bar — shown only while uploading */}
                        {showBar && (
                          <div className="mt-1.5 flex items-center gap-2">
                            <div className="flex-1 bg-gray-200 rounded-full h-1 overflow-hidden">
                              <div
                                className="bg-blue-500 h-1 rounded-full transition-all duration-150"
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="text-gray-500 tabular-nums w-7 text-right">
                              {pct}%
                            </span>
                          </div>
                        )}

                        {/* Duplicate confirmation badge */}
                        {entry.uploadStatus === 'duplicate' && (
                          <div className="mt-1.5 flex flex-wrap items-center gap-2">
                            <span className="bg-yellow-100 border border-yellow-400 text-yellow-900 rounded px-2 py-1 text-xs">
                              Вече качен — качи отново?
                            </span>
                            <button
                              onClick={() => confirmDuplicate(entry.id, true)}
                              className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700 transition-colors"
                            >
                              Да
                            </button>
                            <button
                              onClick={() => confirmDuplicate(entry.id, false)}
                              className="text-xs bg-gray-300 text-gray-700 px-2 py-1 rounded hover:bg-gray-400 transition-colors"
                            >
                              Не
                            </button>
                          </div>
                        )}

                        {/* Large-file warning */}
                        {entry.file.size > 100 * 1024 * 1024 &&
                          (entry.uploadStatus === 'idle' || entry.uploadStatus === 'uploading') && (
                            <p className="text-yellow-600 mt-0.5">
                              ⚠️ Файлът е по-голям от 100MB. Cloudflare tunnel може да го откаже.
                              Препоръчваме компресиране с{' '}
                              <a
                                href="https://www.ilovepdf.com/compress_pdf"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="underline hover:text-yellow-700"
                              >
                                ilovepdf.com
                              </a>
                            </p>
                          )}

                        {/* Auto-classification result */}
                        {autoMode && (
                          <div className="mt-1">
                            {entry.classifyStatus === 'loading' && (
                              <span className="text-xs text-gray-400 animate-pulse">🤖 Класифициране…</span>
                            )}
                            {entry.classifyStatus === 'done' && entry.classifyResult && (
                              <>
                                <ConfidenceBadge result={entry.classifyResult} />
                                {entry.classifyResult.confidence < 0.7 && (
                                  <ManualOverride entry={entry} onChange={patchEntry} />
                                )}
                              </>
                            )}
                            {entry.classifyStatus === 'error' && (
                              <>
                                <span className="text-xs text-red-500">Неуспешна класификация</span>
                                <ManualOverride entry={entry} onChange={patchEntry} />
                              </>
                            )}
                          </div>
                        )}

                        {/* Upload result messages */}
                        {entry.uploadStatus === 'success' && entry.uploadMessage && (
                          <p className="text-green-600 mt-0.5">{entry.uploadMessage}</p>
                        )}
                        {entry.uploadStatus === 'skipped' && (
                          <p className="text-gray-500 mt-0.5">Пропуснат</p>
                        )}
                        {entry.uploadStatus === 'error' && entry.uploadMessage && (
                          <p className="text-red-600 mt-0.5 break-words">{entry.uploadMessage}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* ── Upload button ── */}
          <button
            onClick={handleUpload}
            disabled={isUploading || !canUpload()}
            className="w-full py-2.5 bg-[#7B1C1C] text-white rounded-xl font-semibold text-sm hover:bg-[#6a1818] transition-colors disabled:opacity-50 mt-2"
          >
            {isUploading
              ? `Обработени ${doneCount} / ${totalCount}…`
              : classifyingCount > 0
              ? 'Изчакване на класификация…'
              : entries.length > 1
              ? `Качи и индексирай (${entries.length} файла)`
              : 'Качи и индексирай'}
          </button>

          {/* ── Summary ── */}
          {summary && (
            <div
              className={`rounded-lg px-4 py-3 text-sm font-medium ${
                summary.failed === 0
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : summary.success === 0 && summary.skipped === 0
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-yellow-50 text-yellow-700 border border-yellow-200'
              }`}
            >
              Завършено: {summary.success} успешни, {summary.failed} неуспешни
              {summary.skipped > 0 && `, ${summary.skipped} пропуснати`}
            </div>
          )}
        </div>

        <p className="text-xs text-gray-400 mt-6 text-center">
          Файловете се качват на сървъра и се индексират автоматично с OpenAI embeddings.
        </p>
      </div>

      {/* ══ Documents management section ══════════════════════════════════════ */}
      <div className="w-full max-w-6xl mt-8 bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-xl font-bold text-[#7B1C1C]">Качени материали</h2>
            {!docsLoading && !docsError && (
              <p className="text-xs text-gray-400 mt-0.5">
                Общо {documents.length} материала,{' '}
                {documents.reduce((s, d) => s + d.chunk_count, 0)} чанка
              </p>
            )}
          </div>
          <button
            onClick={fetchDocuments}
            disabled={docsLoading}
            className="text-xs text-gray-500 hover:text-[#7B1C1C] disabled:opacity-40 flex items-center gap-1 transition-colors"
            title="Обнови списъка"
          >
            <span className={docsLoading ? 'animate-spin inline-block' : ''}>↻</span>
            Обнови
          </button>
        </div>

        {/* ── Filter bar ── */}
        <div className="mb-4 flex flex-col gap-2">
          {/* Row 1: cascading faculty → specialty → subject */}
          <div className="flex gap-2 flex-wrap">
            <select
              value={filterFacultyId}
              onChange={(e) => {
                setFilterFacultyId(e.target.value);
                setFilterSpecialtyId('');
                setFilterSubject('');
              }}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white"
            >
              <option value="">Всички факултети</option>
              {FACULTIES.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>

            <select
              value={filterSpecialtyId}
              onChange={(e) => {
                setFilterSpecialtyId(e.target.value);
                setFilterSubject('');
              }}
              disabled={!filterFacultyId}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white disabled:opacity-50"
            >
              <option value="">Всички специалности</option>
              {filterSpecialties.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>

            <select
              value={filterSubject}
              onChange={(e) => setFilterSubject(e.target.value)}
              disabled={!filterSpecialtyId}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white disabled:opacity-50"
            >
              <option value="">Всички предмети</option>
              {filterSubjectOptions.map((sub) => (
                <option key={sub} value={sub}>{sub}</option>
              ))}
            </select>
          </div>

          {/* Row 2: filename search + sort */}
          <div className="flex gap-2">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              placeholder="Търсене по заглавие или файл..."
              className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white"
            />
            <select
              value={sortKey}
              onChange={(e) => setSortKey(e.target.value as SortKey)}
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white"
            >
              <option value="date_desc">Дата ↓</option>
              <option value="date_asc">Дата ↑</option>
              <option value="chunks_desc">Чанки ↓</option>
              <option value="chunks_asc">Чанки ↑</option>
            </select>
          </div>
        </div>

        {docsLoading && (
          <div className="flex items-center justify-center py-12 text-gray-400 text-sm gap-2">
            <span className="animate-spin text-lg">⏳</span> Зареждане…
          </div>
        )}

        {!docsLoading && docsError && (
          <div className="rounded-lg bg-red-50 border border-red-200 px-4 py-3 text-sm text-red-700">
            Грешка при зареждане: {docsError}
          </div>
        )}

        {!docsLoading && !docsError && documents.length === 0 && (
          <div className="text-center py-12 text-gray-400 text-sm">
            Все още няма качени материали.
          </div>
        )}

        {!docsLoading && !docsError && documents.length > 0 && (
          <>
            {/* Shown / total counter */}
            <p className="text-xs text-gray-400 mb-2">
              {isFiltered
                ? `Показани ${filteredDocs.length} от ${documents.length} документа`
                : `Показани ${filteredDocs.length} документа`}
            </p>

            {filteredDocs.length === 0 ? (
              <div className="text-center py-12 text-gray-400 text-sm">
                Няма документи, отговарящи на филтрите.
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-gray-200">
                <table className="w-full text-sm text-left">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Заглавие', 'Факултет', 'Специалност', 'Предмет', 'Тип', 'Чанки', 'Дата', ''].map((h) => (
                        <th key={h} className="px-3 py-2.5 text-xs font-semibold text-gray-500 whitespace-nowrap">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {filteredDocs.map((doc) => (
                      <Fragment key={doc.id}>
                        {/* ── Main document row ── */}
                        <tr className={`hover:bg-gray-50 transition-colors ${reassignId === doc.id ? 'bg-red-50' : ''}`}>
                          <td className="px-3 py-2.5 max-w-[220px]">
                            <p className="font-medium text-gray-800 truncate" title={doc.clean_title}>
                              {doc.clean_title}
                            </p>
                            <p className="text-xs text-gray-400 truncate" title={doc.filename}>
                              {doc.filename}
                            </p>
                          </td>
                          <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap text-xs">
                            {FACULTY_NAME.get(doc.faculty_id) ?? doc.faculty_id}
                          </td>
                          <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap text-xs">
                            {SPECIALTY_NAME.get(doc.specialty_id) ?? doc.specialty_id}
                          </td>
                          <td className="px-3 py-2.5 text-gray-600 text-xs max-w-[140px]">
                            <span className="truncate block" title={doc.subject}>{doc.subject}</span>
                          </td>
                          <td className="px-3 py-2.5 whitespace-nowrap text-xs">
                            {doc.file_type === 'textbook' ? '📚 Учебник' : '🎓 Лекция'}
                          </td>
                          <td className={`px-3 py-2.5 text-center text-xs ${chunkClass(doc.chunk_count)}`}>
                            {doc.chunk_count}
                          </td>
                          <td className="px-3 py-2.5 text-xs text-gray-400 whitespace-nowrap">
                            {formatDate(doc.created_at)}
                          </td>
                          <td className="px-3 py-2.5">
                            <div className="flex items-center gap-1">
                              {/* Reassign toggle button */}
                              <button
                                onClick={() =>
                                  reassignId === doc.id ? closeReassign() : openReassign(doc)
                                }
                                title={
                                  reassignId === doc.id
                                    ? 'Затвори'
                                    : 'Премести към друг предмет'
                                }
                                className={`text-xs px-2 py-1 rounded border transition-colors whitespace-nowrap ${
                                  reassignId === doc.id
                                    ? 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                                    : 'text-[#7B1C1C] border-[#7B1C1C] hover:bg-red-50'
                                }`}
                              >
                                {reassignId === doc.id ? '✕' : 'Премести'}
                              </button>

                              {/* Delete button */}
                              <button
                                onClick={() => handleDelete(doc)}
                                disabled={deletingId === doc.id}
                                title="Изтрий"
                                className="text-red-400 hover:text-red-600 disabled:opacity-40 transition-colors p-1 rounded hover:bg-red-50"
                              >
                                {deletingId === doc.id ? (
                                  <span className="animate-spin inline-block text-base">⏳</span>
                                ) : (
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                    <path fillRule="evenodd" d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z" clipRule="evenodd" />
                                  </svg>
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>

                        {/* ── Inline reassign expansion row ── */}
                        {reassignId === doc.id && (
                          <tr>
                            <td colSpan={8} className="px-4 py-3 bg-red-50 border-t border-red-100">
                              <div className="flex flex-col gap-3">
                                <p className="text-xs font-semibold text-[#7B1C1C]">
                                  Преместване на документа
                                </p>
                                <div className="flex flex-wrap gap-3 items-end">
                                  {/* Faculty */}
                                  <div>
                                    <label className="block text-xs text-gray-500 mb-1">Факултет</label>
                                    <select
                                      value={reassignFacultyId}
                                      onChange={(e) => {
                                        setReassignFacultyId(e.target.value);
                                        setReassignSpecialtyId('');
                                        setReassignSubject('');
                                      }}
                                      className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white"
                                    >
                                      <option value="">— Факултет —</option>
                                      {FACULTIES.map((f) => (
                                        <option key={f.id} value={f.id}>{f.name}</option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* Specialty */}
                                  <div>
                                    <label className="block text-xs text-gray-500 mb-1">Специалност</label>
                                    <select
                                      value={reassignSpecialtyId}
                                      onChange={(e) => {
                                        setReassignSpecialtyId(e.target.value);
                                        setReassignSubject('');
                                      }}
                                      disabled={!reassignFaculty}
                                      className="border border-gray-300 rounded-lg px-3 py-1.5 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white disabled:opacity-50"
                                    >
                                      <option value="">— Специалност —</option>
                                      {reassignFaculty?.specialties.map((s) => (
                                        <option key={s.id} value={s.id}>{s.name}</option>
                                      ))}
                                    </select>
                                  </div>

                                  {/* Subject combobox */}
                                  <div className="min-w-[200px]">
                                    <label className="block text-xs text-gray-500 mb-1">Предмет</label>
                                    <SubjectCombobox
                                      subjects={reassignSpecialty?.subjects ?? []}
                                      value={reassignSubject}
                                      onChange={setReassignSubject}
                                      disabled={!reassignSpecialty}
                                    />
                                  </div>

                                  {/* Action buttons */}
                                  <div className="flex gap-2">
                                    <button
                                      onClick={handleReassignSave}
                                      disabled={
                                        reassignSaving ||
                                        !reassignFacultyId ||
                                        !reassignSpecialtyId ||
                                        !reassignSubject.trim()
                                      }
                                      className="px-4 py-1.5 bg-red-900 text-white text-sm rounded-lg font-semibold hover:bg-red-800 disabled:opacity-50 transition-colors"
                                    >
                                      {reassignSaving ? '…' : 'Запази'}
                                    </button>
                                    <button
                                      onClick={closeReassign}
                                      className="px-4 py-1.5 text-gray-600 text-sm rounded-lg border border-gray-300 hover:bg-gray-50 transition-colors"
                                    >
                                      Откажи
                                    </button>
                                  </div>
                                </div>

                                {/* Inline save feedback */}
                                {reassignMsg && (
                                  <p
                                    className={`text-xs ${
                                      reassignMsg.type === 'ok' ? 'text-green-600' : 'text-red-600'
                                    }`}
                                  >
                                    {reassignMsg.text}
                                  </p>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
