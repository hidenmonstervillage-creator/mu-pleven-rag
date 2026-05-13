'use client';

import Image from 'next/image';
import { FACULTIES } from '@/lib/faculties';
import { Faculty, Specialty } from '@/lib/types';

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
        <div className="relative h-10 w-10">
          <Image
            src="/Logo_MU_BG_New.png"
            alt="МУ Плевен"
            fill
            className="object-contain"
            priority
          />
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-[#7B1C1C] font-bold text-base">МУ-Плевен</span>
          <span className="text-gray-500 text-xs">AI Library</span>
        </div>
      </div>

      <div className="w-px h-8 bg-gray-200 mx-1 flex-shrink-0" />

      {/* Cascading dropdowns */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* Faculty */}
        <select
          value={facultyId}
          onChange={(e) => handleFacultyChange(e.target.value)}
          className={selectClass}
        >
          <option value="">— Факултет —</option>
          {FACULTIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>

        {/* Specialty */}
        <select
          value={specialtyId}
          onChange={(e) => handleSpecialtyChange(e.target.value)}
          disabled={!selectedFaculty}
          className={selectClass}
        >
          <option value="">— Специалност —</option>
          {selectedFaculty?.specialties.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>

        {/* Subject */}
        <select
          value={subject}
          onChange={(e) => onSubjectChange(e.target.value)}
          disabled={!selectedSpecialty || selectedSpecialty.subjects.length === 0}
          className={selectClass}
        >
          <option value="">— Предмет —</option>
          {selectedSpecialty?.subjects.map((sub) => (
            <option key={sub} value={sub}>
              {sub}
            </option>
          ))}
        </select>
      </div>
    </header>
  );
}
