'use client';

import { FACULTIES } from '@/lib/faculties';
import { Faculty, Specialty } from '@/lib/types';
import SubjectCombobox from '@/components/SubjectCombobox';
import Logo from '@/components/Logo';
import {
  docsForFaculty,
  docsForSpecialty,
  docsForSubject,
  docsLabel,
} from '@/lib/subject-coverage';

// Only 74 of 396 taxonomy triples have any literature — the reading list simply
// names no books for the rest. Offering all 396 identically made the empty ones
// look broken (you ask, you get a refusal and no source cards). Coverage is a
// build-time snapshot (lib/subject-coverage.ts), so this costs no page-load query.
const EMPTY_BADGE = 'без налична литература';

interface TopBarProps {
  facultyId: string;
  specialtyId: string;
  subject: string;
  onFacultyChange: (id: string) => void;
  onSpecialtyChange: (id: string) => void;
  onSubjectChange: (s: string) => void;
}

export default function TopBar({
  facultyId,
  specialtyId,
  subject,
  onFacultyChange,
  onSpecialtyChange,
  onSubjectChange,
}: TopBarProps) {
  const selectedFaculty: Faculty | undefined = FACULTIES.find((f) => f.id === facultyId);
  const selectedSpecialty: Specialty | undefined = selectedFaculty?.specialties.find(
    (s) => s.id === specialtyId
  );

  const handleFacultyChange = (id: string) => {
    onFacultyChange(id);
    onSpecialtyChange('');
    onSubjectChange('');
  };

  const handleSpecialtyChange = (id: string) => {
    onSpecialtyChange(id);
    onSubjectChange('');
  };

  const selectClass =
    'text-sm border border-[#E5E7EB] rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] focus:border-transparent cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed max-w-[200px]';

  return (
    <header className="flex items-center gap-4 px-5 py-3 bg-white border-b border-[#E5E7EB] flex-shrink-0">
      {/* Logo + brand */}
      <div className="flex items-center gap-3 flex-shrink-0">
        <Logo className="h-10 w-10" />
        <div className="flex flex-col leading-tight">
          <span className="text-[#7B1C1C] font-bold text-base">МУ-Плевен</span>
          <span className="text-gray-500 text-xs">AI Library</span>
        </div>
      </div>

      <div className="w-px h-8 bg-gray-200 mx-1 flex-shrink-0" />

      {/* Cascading dropdowns */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Faculty — an entirely empty faculty (mk: 0 docs across all 58 subjects)
            is disabled here rather than three clicks deep. */}
        <select
          value={facultyId}
          onChange={(e) => handleFacultyChange(e.target.value)}
          className={selectClass}
        >
          <option value="">— Факултет —</option>
          {FACULTIES.map((f) => {
            const docs = docsForFaculty(f.id);
            return (
              <option key={f.id} value={f.id} disabled={docs === 0}>
                {docs > 0 ? `${f.name} · ${docsLabel(docs)}` : `${f.name} — ${EMPTY_BADGE}`}
              </option>
            );
          })}
        </select>

        {/* Specialty */}
        <select
          value={specialtyId}
          onChange={(e) => handleSpecialtyChange(e.target.value)}
          disabled={!selectedFaculty}
          className={selectClass}
        >
          <option value="">— Специалност —</option>
          {selectedFaculty?.specialties.map((s) => {
            const docs = docsForSpecialty(selectedFaculty.id, s.id);
            return (
              <option key={s.id} value={s.id} disabled={docs === 0}>
                {docs > 0 ? `${s.name} · ${docsLabel(docs)}` : `${s.name} — ${EMPTY_BADGE}`}
              </option>
            );
          })}
        </select>

        {/* Subject — searchable combobox (type to filter). Counts come from the
            FULL triple: subject names are not unique across faculties. */}
        <div className="w-[220px]">
          <SubjectCombobox
            subjects={selectedSpecialty?.subjects ?? []}
            value={subject}
            disabled={!selectedSpecialty || selectedSpecialty.subjects.length === 0}
            placeholder="— Предмет —"
            getDocs={(s) =>
              selectedFaculty && selectedSpecialty
                ? docsForSubject(selectedFaculty.id, selectedSpecialty.id, s)
                : 0
            }
            onChange={(v) => {
              // Only commit a real subject — ignore partial typing so the cascade
              // (chat, slide panel, auto-suggest) never sees an invalid value.
              // Also refuse subjects with no literature, so typing an empty one's
              // full name can't bypass the greyed-out list entry.
              if (!(selectedSpecialty?.subjects ?? []).includes(v)) return;
              if (!selectedFaculty || !selectedSpecialty) return;
              if (docsForSubject(selectedFaculty.id, selectedSpecialty.id, v) === 0) return;
              onSubjectChange(v);
            }}
          />
        </div>
      </div>
    </header>
  );
}
