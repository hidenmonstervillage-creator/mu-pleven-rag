'use client';

import { useEffect } from 'react';

export interface SubjectSlide {
  record_id: number;
  slide_name: string;
  organ: string | null;
  konspekt_number: string | null;
  stain: string | null;
}

interface SlideViewerProps {
  slide: SubjectSlide | null;
  onClose: () => void;
}

// Full-screen, zoomable Olympus OlyVia viewer for one slide. The iframe points
// at the server-side auth proxy (/api/olyvia/[...path]) which logs in, rewrites
// the viewer HTML, and fans tile/annotation requests back through the same route
// — the exact embed proven on /slide-test. Full-screen gives max room to pan/zoom.
export default function SlideViewer({ slide, onClose }: SlideViewerProps) {
  const isOpen = slide !== null;

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Lock body scroll while open.
  useEffect(() => {
    if (isOpen) document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  const src = slide
    ? `/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${slide.record_id}`
    : '';

  const meta = slide
    ? [slide.organ, slide.konspekt_number ? `№ ${slide.konspekt_number}` : null, slide.stain]
        .filter(Boolean)
        .join(' · ')
    : '';

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col"
      style={{
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform 300ms ease-in-out',
        pointerEvents: isOpen ? 'auto' : 'none',
        backgroundColor: '#0b0b12',
      }}
      aria-hidden={!isOpen}
      aria-label="Преглед на микроскопски препарат"
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
        style={{ backgroundColor: '#7B1C1C' }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-white text-lg" aria-hidden="true">🔬</span>
          <div className="flex flex-col min-w-0">
            <span className="text-white font-semibold text-sm leading-tight truncate">
              {slide?.organ || slide?.slide_name || 'Микроскопски препарат'}
            </span>
            {meta && (
              <span className="text-red-200 text-xs mt-0.5 truncate">{meta}</span>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="flex-shrink-0 flex items-center gap-1.5 px-3 h-8 rounded-lg text-white hover:bg-white/20 transition-colors text-sm font-medium"
          aria-label="Затвори"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
          <span className="hidden sm:inline">Затвори</span>
        </button>
      </div>

      {/* Zoomable viewer */}
      <div className="flex-1 overflow-hidden bg-black">
        {isOpen && src && (
          <iframe
            key={src}
            src={src}
            className="w-full h-full border-0"
            title={slide?.slide_name ?? 'OlyVia микроскопски препарат'}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
      </div>
    </div>
  );
}
