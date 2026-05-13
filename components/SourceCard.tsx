'use client';

import { useState } from 'react';
import { SourceChunk } from '@/lib/types';
import { PDFViewerPayload } from './PDFViewer';

interface SourceCardProps {
  source: SourceChunk;
  onOpen: (payload: PDFViewerPayload) => void;
}

export default function SourceCard({ source, onOpen }: SourceCardProps) {
  const [expanded, setExpanded] = useState(false);

  const isTextbook = source.file_type === 'textbook';
  const icon = isTextbook ? '📚' : '🎓';
  const truncated = source.content.length > 200 && !expanded;
  const displayContent = truncated ? source.content.slice(0, 200) + '...' : source.content;

  const handleCardClick = () => {
    if (!source.storage_url) return;
    onOpen({
      storageUrl: source.storage_url,
      pageNumber: source.page_number,
      title: source.clean_title,
      content: source.content,
    });
  };

  const accentBar = (
    <span className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-[#7B1C1C]" />
  );

  const baseClasses =
    'relative rounded-lg border border-gray-200 bg-white px-3.5 py-3 pl-4 overflow-hidden transition-shadow duration-150';

  return (
    <div
      onClick={source.storage_url ? handleCardClick : undefined}
      className={`${baseClasses} ${source.storage_url ? 'cursor-pointer hover:shadow-md' : ''}`}
    >
      {accentBar}

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-base">{icon}</span>
          <span className="font-semibold text-gray-800 text-sm leading-tight">
            {source.clean_title}
          </span>
          {source.page_number && (
            <span className="ml-auto text-xs text-gray-500 whitespace-nowrap font-medium">
              стр. {source.page_number}
            </span>
          )}
          {/* Visual hint that the card opens the viewer */}
          {source.storage_url && (
            <svg
              className="w-3.5 h-3.5 text-gray-400 flex-shrink-0"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round"
                d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          )}
        </div>

        <p className="text-xs text-gray-600 leading-relaxed">{displayContent}</p>

        {source.content.length > 200 && (
          <button
            onClick={(e) => {
              e.stopPropagation(); // don't trigger the card click / PDF open
              setExpanded((v) => !v);
            }}
            className="text-xs text-[#7B1C1C] font-medium hover:underline self-start mt-0.5"
          >
            {expanded ? 'Покажи по-малко' : 'Покажи повече'}
          </button>
        )}
      </div>
    </div>
  );
}
