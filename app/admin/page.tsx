'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { FACULTIES } from '@/lib/faculties';
import { Faculty, Specialty } from '@/lib/types';

type FileStatus = {
  file: File;
  status: 'pending' | 'uploading' | 'success' | 'error';
  message?: string;
};

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const STATUS_ICON: Record<FileStatus['status'], string> = {
  pending: '⏳',
  uploading: '🔄',
  success: '✅',
  error: '❌',
};

export default function AdminPage() {
  const [facultyId, setFacultyId] = useState('');
  const [specialtyId, setSpecialtyId] = useState('');
  const [subject, setSubject] = useState('');
  const [fileType, setFileType] = useState<'textbook' | 'lecture'>('textbook');
  const [fileStatuses, setFileStatuses] = useState<FileStatus[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [summary, setSummary] = useState<{ success: number; failed: number } | null>(null);
  const [folderMode, setFolderMode] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // Sync webkitdirectory attribute whenever folderMode changes
  const applyFolderMode = useCallback((enabled: boolean) => {
    const el = fileRef.current;
    if (!el) return;
    if (enabled) {
      el.setAttribute('webkitdirectory', '');
    } else {
      el.removeAttribute('webkitdirectory');
    }
    // Reset selection when switching modes
    el.value = '';
    setFileStatuses([]);
    setSummary(null);
  }, []);

  useEffect(() => {
    applyFolderMode(folderMode);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderMode]);

  const selectedFaculty: Faculty | undefined = FACULTIES.find((f) => f.id === facultyId);
  const selectedSpecialty: Specialty | undefined = selectedFaculty?.specialties.find(
    (s) => s.id === specialtyId
  );

  const handleFileChange = () => {
    const raw = fileRef.current?.files;
    if (!raw || raw.length === 0) {
      setFileStatuses([]);
      setSummary(null);
      return;
    }
    // Keep only PDF / PPTX — silently skip everything else
    const valid = Array.from(raw).filter((f) => /\.(pdf|pptx)$/i.test(f.name));
    setFileStatuses(valid.map((file) => ({ file, status: 'pending' })));
    setSummary(null);
  };

  const handleUpload = async () => {
    if (!facultyId || !specialtyId || !subject) {
      alert('Попълнете всички полета преди качване.');
      return;
    }
    if (fileStatuses.length === 0) {
      alert('Изберете файлове за качване.');
      return;
    }

    setIsUploading(true);
    setSummary(null);
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < fileStatuses.length; i++) {
      // Mark current file as uploading
      setFileStatuses((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, status: 'uploading' } : s))
      );

      const formData = new FormData();
      formData.append('file', fileStatuses[i].file);
      formData.append('facultyId', facultyId);
      formData.append('specialtyId', specialtyId);
      formData.append('subject', subject);
      formData.append('fileType', fileType);

      try {
        const res = await fetch('/api/ingest', { method: 'POST', body: formData });
        const data = await res.json();

        if (!res.ok || !data.success) throw new Error(data.error ?? 'Unknown error');

        setFileStatuses((prev) =>
          prev.map((s, idx) =>
            idx === i ? { ...s, status: 'success', message: `${data.chunksCreated} чанка` } : s
          )
        );
        successCount++;
      } catch (err) {
        setFileStatuses((prev) =>
          prev.map((s, idx) =>
            idx === i ? { ...s, status: 'error', message: (err as Error).message } : s
          )
        );
        failCount++;
      }
    }

    setIsUploading(false);
    setSummary({ success: successCount, failed: failCount });
    if (fileRef.current) fileRef.current.value = '';
  };

  const doneCount = fileStatuses.filter(
    (s) => s.status === 'success' || s.status === 'error'
  ).length;
  const totalCount = fileStatuses.length;

  const selectClass =
    'w-full border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] bg-white';

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center py-12 px-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-sm border border-gray-200 p-8">
        <h1 className="text-2xl font-bold text-[#7B1C1C] mb-1">Качване на материали</h1>
        <p className="text-sm text-gray-500 mb-8">Административен панел — МУ-Плевен AI Library</p>

        <div className="flex flex-col gap-4">
          {/* Faculty */}
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

          {/* Specialty */}
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

          {/* Subject */}
          <div>
            <label className="block text-xs font-semibold text-gray-600 mb-1">Предмет</label>
            {selectedSpecialty && selectedSpecialty.subjects.length > 0 ? (
              <select value={subject} onChange={(e) => setSubject(e.target.value)} className={selectClass}>
                <option value="">— Изберете предмет —</option>
                {selectedSpecialty.subjects.map((sub) => (
                  <option key={sub} value={sub}>{sub}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="Въведете предмет..."
                className={selectClass}
                disabled={!selectedSpecialty}
              />
            )}
          </div>

          {/* File type */}
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

          {/* File picker with mode toggle */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-xs font-semibold text-gray-600">
                Файлове (PDF или PPTX)
              </label>
              {/* Toggle: Единичен файл / Папка */}
              <div className="flex rounded-lg border border-gray-200 overflow-hidden text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setFolderMode(false)}
                  className={`px-3 py-1.5 transition-colors ${
                    !folderMode
                      ? 'bg-[#7B1C1C] text-white'
                      : 'bg-white text-gray-500 hover:bg-gray-50'
                  }`}
                >
                  Единичен файл
                </button>
                <button
                  type="button"
                  onClick={() => setFolderMode(true)}
                  className={`px-3 py-1.5 transition-colors border-l border-gray-200 ${
                    folderMode
                      ? 'bg-[#7B1C1C] text-white'
                      : 'bg-white text-gray-500 hover:bg-gray-50'
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

          {/* File list */}
          {fileStatuses.length > 0 && (
            <div className="flex flex-col gap-2">
              {/* Progress counter */}
              {isUploading && (
                <p className="text-xs font-semibold text-[#7B1C1C]">
                  {doneCount} / {totalCount} файла качени
                </p>
              )}

              <div className="max-h-64 overflow-y-auto flex flex-col gap-1.5 rounded-lg border border-gray-200 p-2 bg-gray-50">
                {fileStatuses.map((entry, i) => (
                  <div
                    key={i}
                    className="flex items-start gap-2 text-xs text-gray-700 bg-white rounded-lg px-3 py-2 border border-gray-100"
                  >
                    <span className="flex-shrink-0 mt-0.5 text-sm">
                      {STATUS_ICON[entry.status]}
                    </span>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{entry.file.name}</p>
                      <p className="text-gray-400">{formatSize(entry.file.size)}</p>
                      {entry.status === 'success' && entry.message && (
                        <p className="text-green-600 mt-0.5">{entry.message}</p>
                      )}
                      {entry.status === 'error' && entry.message && (
                        <p className="text-red-600 mt-0.5 break-words">{entry.message}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Upload button */}
          <button
            onClick={handleUpload}
            disabled={isUploading || fileStatuses.length === 0}
            className="w-full py-2.5 bg-[#7B1C1C] text-white rounded-xl font-semibold text-sm hover:bg-[#6a1818] transition-colors disabled:opacity-50 mt-2"
          >
            {isUploading
              ? `Качвам ${doneCount + 1} / ${totalCount}...`
              : fileStatuses.length > 1
              ? `Качи и индексирай (${fileStatuses.length} файла)`
              : 'Качи и индексирай'}
          </button>

          {/* Summary */}
          {summary && (
            <div
              className={`rounded-lg px-4 py-3 text-sm font-medium ${
                summary.failed === 0
                  ? 'bg-green-50 text-green-700 border border-green-200'
                  : summary.success === 0
                  ? 'bg-red-50 text-red-700 border border-red-200'
                  : 'bg-yellow-50 text-yellow-700 border border-yellow-200'
              }`}
            >
              Завършено: {summary.success} успешни, {summary.failed} неуспешни
            </div>
          )}
        </div>

        <p className="text-xs text-gray-400 mt-6 text-center">
          Файловете се качват в Supabase Storage и се индексират автоматично с OpenAI embeddings.
        </p>
      </div>
    </div>
  );
}
