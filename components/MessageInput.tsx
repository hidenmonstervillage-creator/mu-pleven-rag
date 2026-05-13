'use client';

import { useRef, useEffect, KeyboardEvent } from 'react';

interface MessageInputProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  placeholder?: string;
}

export default function MessageInput({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder = 'Задайте въпрос...',
}: MessageInputProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-expand textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
  }, [value]);

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!disabled && value.trim()) onSubmit();
    }
  };

  return (
    <div className="flex items-end gap-3 px-4 py-4 border-t border-[#E5E7EB] bg-white">
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        rows={1}
        className="flex-1 resize-none rounded-xl border border-[#E5E7EB] px-4 py-3 text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-[#7B1C1C] focus:border-transparent disabled:opacity-60 leading-relaxed"
        style={{ maxHeight: '200px', overflowY: 'auto' }}
      />
      <button
        onClick={onSubmit}
        disabled={disabled || !value.trim()}
        className="flex-shrink-0 w-10 h-10 rounded-xl bg-[#7B1C1C] text-white flex items-center justify-center hover:bg-[#6a1818] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title="Изпрати (Enter)"
      >
        {disabled ? (
          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            />
          </svg>
        ) : (
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
          </svg>
        )}
      </button>
    </div>
  );
}
