import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── POST /api/admin/upload-target  { refresh? } ──────────────────────────────
// Admin-only (middleware: non-GET => session required). Returns where the
// browser should POST the file and the key the Hetzner upload server expects.
//
// Why the browser still uploads directly: Vercel caps a function's request body
// at 4.5 MB, so multi-hundred-MB PDFs cannot pass through a Route Handler. The
// key therefore has to reach the (authenticated) admin's browser for the
// duration of the upload — but it no longer lives in the client bundle or in
// any NEXT_PUBLIC_* variable, and only a logged-in admin can obtain it.
//
// The Cloudflare quick-tunnel URL rotates whenever cloudflared restarts; the
// box publishes the current one at /tunnel-url.txt, which we read server-side
// (the browser could not: plain HTTP inside an HTTPS page). HETZNER_UPLOAD_URL
// is the fallback.

const HETZNER_ORIGIN = 'http://178.105.161.66';

function isTunnelUrl(u: string): boolean {
  const host = u.startsWith('https://') ? u.slice(8) : '';
  return host.endsWith('.trycloudflare.com') && /^[a-z0-9-]+$/.test(host.slice(0, -'.trycloudflare.com'.length));
}

async function currentTunnelBase(): Promise<string | null> {
  try {
    const r = await fetch(`${HETZNER_ORIGIN}/tunnel-url.txt`, { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const url = (await r.text()).trim();
    return isTunnelUrl(url) ? url : null;
  } catch {
    return null;
  }
}

function withUploadPath(base: string): string {
  const b = base.replace(/[/]+$/, '');
  return b.endsWith('/upload') ? b : `${b}/upload`;
}

export async function POST(req: NextRequest) {
  const apiKey = process.env.HETZNER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'HETZNER_API_KEY is not configured' }, { status: 503 });

  const body = await req.json().catch(() => ({})) as { refresh?: unknown };
  const refresh = body.refresh === true;

  // Always prefer the live tunnel URL published by the box (the admin page is
  // served over HTTPS, so only the https tunnel works from the browser).
  // HETZNER_UPLOAD_URL is the fallback when that lookup fails; in production it
  // must itself be an https URL or the browser will block the upload as mixed
  // content. `refresh` only bypasses the env fast path — kept for the caller.
  const envBase = process.env.HETZNER_UPLOAD_URL?.trim() || null;
  const base = (await currentTunnelBase()) || (refresh ? null : envBase) || envBase;
  if (!base) return NextResponse.json({ error: 'No upload endpoint available' }, { status: 503 });

  return NextResponse.json({ uploadUrl: withUploadPath(base), apiKey });
}
