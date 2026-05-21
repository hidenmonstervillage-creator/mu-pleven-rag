import { NextRequest, NextResponse } from 'next/server';

export const runtime    = 'nodejs';
export const maxDuration = 30;           // large PDFs can be slow to forward
export const dynamic    = 'force-dynamic';

// ── Allowlist ─────────────────────────────────────────────────────────────────
// Only proxy PDFs served from our own Hetzner instance.  Any other host is
// rejected with 400 so this route cannot be abused as an open proxy / SSRF
// vector.  Supabase-hosted files are already on HTTPS and don't need proxying.

const ALLOWED_HOSTS = new Set([
  '178.105.161.66',
]);

// ── GET /api/pdf?url=<encoded-hetzner-url> ────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const rawUrl = searchParams.get('url');

  // ── 1. Presence check ──────────────────────────────────────────────────────
  if (!rawUrl) {
    return new NextResponse('Missing required ?url= query parameter.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // ── 2. Parse & validate host ───────────────────────────────────────────────
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return new NextResponse('Invalid URL.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    return new NextResponse(
      `Forbidden: only ${Array.from(ALLOWED_HOSTS).join(', ')} may be proxied via this route.`,
      { status: 400, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  // Reject anything that isn't a plain HTTP/HTTPS fetch to avoid protocol-level
  // SSRF (file://, gopher://, etc.).
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return new NextResponse('Only http/https URLs are accepted.', {
      status: 400,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  // ── 3. Fetch from Hetzner server-side ─────────────────────────────────────
  // HTTP is fine here — there is no mixed-content restriction on the server;
  // only the browser enforces that rule.  We then re-serve the bytes over the
  // site's existing HTTPS connection, which is what fixes the browser issue.
  let upstream: Response;
  try {
    upstream = await fetch(parsed.toString(), {
      // Surface redirect failures rather than silently following them
      // to unexpected hosts.
      redirect: 'follow',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/pdf] upstream fetch error:', message);
    return new NextResponse(`Upstream fetch failed: ${message}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  if (!upstream.ok) {
    return new NextResponse(
      `Upstream returned HTTP ${upstream.status} ${upstream.statusText}.`,
      { status: upstream.status, headers: { 'Content-Type': 'text/plain' } },
    );
  }

  // ── 4. Build response headers ──────────────────────────────────────────────
  const responseHeaders = new Headers();

  // Always application/pdf so the browser opens its native PDF viewer.
  responseHeaders.set('Content-Type', 'application/pdf');

  // Cache aggressively — PDFs in the library don't change.
  // 1 h browser cache, 24 h CDN / edge cache.
  responseHeaders.set('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=3600');

  // Forward Content-Length so the browser can show download progress.
  const upstreamLength = upstream.headers.get('content-length');
  if (upstreamLength) {
    responseHeaders.set('Content-Length', upstreamLength);
  }

  // Allow the PDF iframe to render on the same origin.
  // (X-Frame-Options is only needed for older browsers; modern sites use CSP.)
  responseHeaders.set('X-Frame-Options', 'SAMEORIGIN');

  // ── 5. Stream the body ─────────────────────────────────────────────────────
  // Streaming (rather than buffering) avoids loading the whole PDF into memory
  // on the server, which matters for the 200 MB+ books in the library.
  return new NextResponse(upstream.body, {
    status:  200,
    headers: responseHeaders,
  });
}
