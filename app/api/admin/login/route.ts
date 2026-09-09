import { NextRequest, NextResponse } from 'next/server';
import { createHash, timingSafeEqual } from 'node:crypto';
import { ADMIN_COOKIE, SESSION_TTL_SECONDS, createSessionToken } from '@/lib/admin-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── POST /api/admin/login  { password } ──────────────────────────────────────
// Compares against ADMIN_PASSWORD in constant time (both sides hashed to a
// fixed length first) and sets the HMAC-signed session cookie. Refuses with 503
// when either env var is missing — there is no default password.

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export async function POST(req: NextRequest) {
  const expected = process.env.ADMIN_PASSWORD;
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!expected || !secret) {
    return NextResponse.json({ error: 'Admin auth is not configured' }, { status: 503 });
  }

  const body = await req.json().catch(() => ({})) as { password?: unknown };
  const given = typeof body.password === 'string' ? body.password : '';
  const ok = given.length > 0 && timingSafeEqual(sha256(given), sha256(expected));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 400)); // blunt brute-force throttle
    return NextResponse.json({ error: 'Грешна парола' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(ADMIN_COOKIE, await createSessionToken(secret), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production', // plain-http localhost in dev
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
