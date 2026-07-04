'use client';

import { useEffect, useRef, useState } from 'react';

export interface SubjectSlide {
  record_id: number;
  slide_name: string;
  organ: string | null;
  organ_bg: string | null;
  konspekt_number: string | null;
  stain: string | null;
}

interface SlideViewerProps {
  slide: SubjectSlide | null;
  onClose: () => void;
}

// "Latin / Български" — Latin first, Bulgarian after the slash; Latin only if null.
export function organLabel(s: Pick<SubjectSlide, 'organ' | 'organ_bg' | 'slide_name'>): string {
  const latin = s.organ || s.slide_name || '';
  return s.organ_bg ? `${latin} / ${s.organ_bg}` : latin;
}

const MIN_W = 400;
const MIN_H = 300;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// Full zoomable Olympus OlyVia viewer for one slide, via the /api/olyvia proxy —
// the embed proven on /slide-test. Three states: full-screen, minimized floating
// (draggable, iframe stays mounted so zoom/pan is preserved), and closed.
export default function SlideViewer({ slide, onClose }: SlideViewerProps) {
  const open = slide !== null;
  const [mode, setMode] = useState<'full' | 'min'>('full');
  const [pos, setPos]   = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef  = useRef<{ dx: number; dy: number } | null>(null);
  const boxRef   = useRef<HTMLDivElement | null>(null);

  // Every newly-opened slide starts full-screen.
  useEffect(() => {
    if (slide) setMode('full');
  }, [slide?.record_id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes (only meaningful in full-screen; harmless otherwise).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open && mode === 'full') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose, open, mode]);

  // Lock body scroll only in full-screen mode (minimized must let the chat scroll).
  useEffect(() => {
    document.body.style.overflow = open && mode === 'full' ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open, mode]);

  function effectiveSize() {
    const vw = typeof window !== 'undefined' ? window.innerWidth : 1280;
    const vh = typeof window !== 'undefined' ? window.innerHeight : 800;
    return { w: Math.min(MIN_W, vw - 16), h: Math.min(MIN_H, vh - 96), vw, vh };
  }

  function minimize() {
    // Default landing spot: top-right, clear of the bottom chat input. Remembered
    // for the rest of the session (pos state persists while mounted).
    if (!pos) {
      const { w, vw } = effectiveSize();
      setPos({ x: Math.max(8, vw - w - 24), y: 76 });
    }
    setMode('min');
  }

  // ── Dragging (pointer events on the title bar; no external lib) ──────────────
  function onPointerDown(e: React.PointerEvent) {
    if (mode !== 'min' || !pos) return;
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
    setDragging(true);
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return;
    const w = boxRef.current?.offsetWidth  ?? MIN_W;
    const h = boxRef.current?.offsetHeight ?? MIN_H;
    const x = clamp(e.clientX - dragRef.current.dx, 8, window.innerWidth  - w - 8);
    const y = clamp(e.clientY - dragRef.current.dy, 8, window.innerHeight - h - 8);
    setPos({ x, y });
  }
  function onPointerUp(e: React.PointerEvent) {
    dragRef.current = null;
    setDragging(false);
    try { (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
  }

  const src = slide ? `/api/olyvia/OlyViaWeb/Html5Viewer?recordId=${slide.record_id}` : '';
  const meta = slide
    ? [slide.konspekt_number ? `№ ${slide.konspekt_number}` : null, slide.stain].filter(Boolean).join(' · ')
    : '';
  const minimized = open && mode === 'min';

  // Container positioning per state.
  const base: React.CSSProperties = {
    display: 'flex', flexDirection: 'column', backgroundColor: '#0b0b12', zIndex: 70,
  };
  let style: React.CSSProperties;
  if (!open) {
    style = { ...base, position: 'fixed', inset: 0, transform: 'translateX(100%)', transition: 'transform 300ms ease-in-out', pointerEvents: 'none' };
  } else if (minimized) {
    style = {
      ...base, position: 'fixed', left: pos?.x ?? 0, top: pos?.y ?? 0,
      width: `min(${MIN_W}px, calc(100vw - 16px))`, height: `${MIN_H}px`,
      borderRadius: 12, overflow: 'hidden', boxShadow: '0 12px 48px rgba(0,0,0,0.55)',
      border: '1px solid rgba(255,255,255,0.1)',
    };
  } else {
    style = { ...base, position: 'fixed', inset: 0, transform: 'translateX(0)', transition: 'transform 300ms ease-in-out' };
  }

  return (
    <div ref={boxRef} style={style} aria-hidden={!open} aria-label="Преглед на микроскопски препарат">
      {/* Header / title bar (drag handle when minimized) */}
      <div
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        className="flex items-center justify-between flex-shrink-0"
        style={{
          backgroundColor: '#7B1C1C',
          padding: minimized ? '5px 8px 5px 10px' : '10px 16px',
          cursor: minimized ? 'move' : 'default',
          touchAction: minimized ? 'none' : 'auto',
        }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-white" aria-hidden="true" style={{ fontSize: minimized ? 14 : 18 }}>🔬</span>
          <div className="flex flex-col min-w-0">
            <span
              className="text-white font-semibold leading-tight truncate"
              style={{ fontSize: minimized ? 12 : 14 }}
            >
              {slide ? organLabel(slide) : ''}
            </span>
            {!minimized && meta && <span className="text-red-200 text-xs mt-0.5 truncate">{meta}</span>}
          </div>
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          {minimized ? (
            <button
              onClick={() => setMode('full')}
              className="w-7 h-7 rounded-md flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              aria-label="Цял екран"
              title="Цял екран"
            >
              {/* fullscreen glyph */}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 8V4h4M20 8V4h-4M4 16v4h4M20 16v4h-4" />
              </svg>
            </button>
          ) : (
            <button
              onClick={minimize}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white hover:bg-white/20 transition-colors"
              aria-label="Намали в плаващ прозорец"
              title="Намали"
            >
              {/* minimize (—) glyph */}
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 12h14" />
              </svg>
            </button>
          )}
          <button
            onClick={onClose}
            className={`rounded-lg flex items-center justify-center text-white hover:bg-white/20 transition-colors ${minimized ? 'w-7 h-7' : 'w-8 h-8'}`}
            aria-label="Затвори"
            title="Затвори"
          >
            <svg className={minimized ? 'w-4 h-4' : 'w-5 h-5'} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Zoomable viewer — iframe stays mounted across full ↔ min (preserves zoom/pan) */}
      <div className="flex-1 overflow-hidden bg-black relative">
        {open && src && (
          <iframe
            key={src}
            src={src}
            className="w-full h-full border-0"
            title={slide?.slide_name ?? 'OlyVia микроскопски препарат'}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
          />
        )}
        {/* While dragging, a transparent shield stops the iframe from swallowing pointer moves */}
        {minimized && dragging && <div className="absolute inset-0" />}
      </div>
    </div>
  );
}
