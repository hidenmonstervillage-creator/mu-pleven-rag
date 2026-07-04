'use client';

import { useState, useRef, useEffect, type ChangeEvent, type KeyboardEvent } from 'react';

// Searchable subject combobox — type to filter, click/enter to commit.
// Shared by the admin upload page and the chat subject selector.
export default function SubjectCombobox({
  subjects,
  value,
  onChange,
  disabled,
  placeholder = 'Търсете предмет...',
}: {
  subjects: string[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  placeholder?: string;
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

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    setQuery(v);
    onChange(subjects.includes(v) ? v : v);
    setOpen(true);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
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
        placeholder={placeholder}
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
