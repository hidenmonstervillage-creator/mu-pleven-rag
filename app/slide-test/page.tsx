'use client';

// POC: render one OlyVia microscope slide through the server-side auth proxy.
// The proxy at /api/olyvia/[...path] handles login to http://194.141.67.249:8085,
// rewrites absolute paths in the viewer HTML, and patches the NIS API service URL
// so all tile/annotation requests fan back through the same proxy route.

export default function SlideTestPage() {
  return (
    <div
      style={{
        width: '100vw',
        height: '100vh',
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          padding: '6px 12px',
          background: '#1a1a2e',
          color: '#e0e0e0',
          fontSize: '12px',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <span style={{ fontWeight: 600 }}>OlyVia POC</span>
        <span style={{ color: '#888' }}>—</span>
        <span>Oesophagus_1_#18a_HE · record 21236 · proxied via /api/olyvia</span>
      </div>
      <iframe
        src="/api/olyvia/OlyViaWeb/Html5Viewer?recordId=21236"
        style={{ flex: 1, border: 'none', width: '100%' }}
        title="OlyVia microscope slide viewer"
        sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
      />
    </div>
  );
}
