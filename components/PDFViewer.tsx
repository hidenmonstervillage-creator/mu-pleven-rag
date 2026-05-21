'use client';

import { useEffect } from 'react';

export interface PDFViewerPayload {
  storageUrl: string;
  pageNumber: number | null;
  title: string;
  content: string;
}

interface PDFViewerProps {
  payload: PDFViewerPayload | null;
  onClose: () => void;
}

// ── Hosts that serve PDFs over plain HTTP ─────────────────────────────────────
// Browsers block HTTP resources loaded inside an HTTPS page (mixed-content).
// For these hosts we route the fetch through our server-side proxy at
// /api/pdf?url=… which re-serves the bytes over the site's own HTTPS.
// Supabase-hosted files (ncpykcokbyzkgnmuvrgo.supabase.co) are already HTTPS
// and are passed through unchanged.
const HTTP_PROXY_HOSTS = new Set(['178.105.161.66']);

function toProxiedUrl(storageUrl: string): string {
  try {
    const { hostname, protocol } = new URL(storageUrl);
    if (protocol === 'http:' && HTTP_PROXY_HOSTS.has(hostname)) {
      return `/api/pdf?url=${encodeURIComponent(storageUrl)}`;
    }
  } catch {
    // Malformed URL — fall through and let the iframe fail visibly.
  }
  return storageUrl;
}

export default function PDFViewer({ payload, onClose }: PDFViewerProps) {
  const isOpen = payload !== null;

  // Close on Escape key
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  // Route HTTP Hetzner URLs through the server-side proxy so that the HTTPS
  // site can embed them without triggering a mixed-content block.
  const baseUrl  = payload?.storageUrl ? toProxiedUrl(payload.storageUrl) : '';
  const iframeSrc = baseUrl
    ? payload?.pageNumber
      ? `${baseUrl}#page=${payload.pageNumber}`
      : baseUrl
    : '';

  return (
    <>
      {/* Dark overlay — clicking it closes the drawer */}
      <div
        onClick={onClose}
        className="fixed inset-0 z-40 transition-opacity duration-300"
        style={{
          backgroundColor: 'rgba(0,0,0,0.4)',
          opacity: isOpen ? 1 : 0,
          pointerEvents: isOpen ? 'auto' : 'none',
        }}
        aria-hidden="true"
      />

      {/* Sliding drawer */}
      <div
        className="fixed top-0 right-0 h-full z-50 flex flex-col bg-white shadow-2xl"
        style={{
          width: '40%',
          minWidth: '340px',
          transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
          transition: 'transform 300ms ease-in-out',
        }}
        aria-label="PDF преглед"
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-4 py-3 flex-shrink-0"
          style={{ backgroundColor: '#7B1C1C' }}
        >
          <div className="flex flex-col min-w-0 pr-3">
            <span className="text-white font-semibold text-sm leading-tight truncate">
              {payload?.title ?? ''}
            </span>
            {payload?.pageNumber && (
              <span className="text-red-200 text-xs mt-0.5">
                стр. {payload.pageNumber}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center text-white hover:bg-white/20 transition-colors"
            aria-label="Затвори"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* PDF iframe */}
        <div className="flex-1 overflow-hidden">
          {isOpen && iframeSrc && (
            <iframe
              key={iframeSrc}
              src={iframeSrc}
              className="w-full h-full border-0"
              title={payload?.title ?? 'PDF документ'}
            />
          )}
          {isOpen && !iframeSrc && (
            <div className="flex items-center justify-center h-full text-gray-400 text-sm">
              Няма наличен файл
            </div>
          )}
        </div>

        {/* Extracted text fallback */}
        {payload?.content && (
          <div className="flex-shrink-0 border-t border-gray-200 px-4 py-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Извлечен текст от страницата
            </p>
            <div
              className="overflow-y-auto rounded-lg border border-gray-200 p-3 text-xs font-mono text-gray-700 leading-relaxed"
              style={{ backgroundColor: '#F9FAFB', maxHeight: '200px' }}
            >
              {payload.content}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
