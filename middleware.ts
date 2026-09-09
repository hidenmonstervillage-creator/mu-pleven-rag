import { NextRequest, NextResponse } from 'next/server';
import { ADMIN_COOKIE, verifySessionToken } from '@/lib/admin-session';

// ── Admin gate — fails closed ─────────────────────────────────────────────────
// /admin/**            → valid session cookie or redirect to /admin/login
// /api/** (non-GET)    → valid session cookie or 401 JSON, except the student
//                        endpoints listed in OPEN_API and the login/logout routes
// GET/HEAD/OPTIONS on /api/** stay open (read-only handlers).
// If ADMIN_SESSION_SECRET is unset no cookie can verify, so every protected
// request is denied.

export const config = {
  matcher: ['/admin/:path*', '/api/:path*'],
};

// Student-facing endpoints that must keep working without a session.
const OPEN_API: RegExp[] = [
  /^\/api\/chat$/,
  /^\/api\/anatomy\/suggest$/,
  /^\/api\/slides\/suggest$/,
  /^\/api\/slides\/for-subject$/,
  /^\/api\/pdf$/,
  /^\/api\/olyvia(\/|$)/,       // slide viewer proxy — the upstream viewer POSTs tiles
  /^\/api\/admin\/login$/,
  /^\/api\/admin\/logout$/,
];

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const authed = await verifySessionToken(
    req.cookies.get(ADMIN_COOKIE)?.value,
    process.env.ADMIN_SESSION_SECRET,
  );

  if (pathname.startsWith('/admin')) {
    if (pathname === '/admin/login') {
      return authed ? NextResponse.redirect(new URL('/admin', req.url)) : NextResponse.next();
    }
    if (authed) return NextResponse.next();
    const login = new URL('/admin/login', req.url);
    login.searchParams.set('next', pathname);
    return NextResponse.redirect(login);
  }

  // /api/**
  if (READ_METHODS.has(req.method)) return NextResponse.next();
  if (OPEN_API.some((re) => re.test(pathname))) return NextResponse.next();
  if (authed) return NextResponse.next();
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}
