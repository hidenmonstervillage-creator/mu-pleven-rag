// ── Admin session cookie (HMAC-signed, stateless) ─────────────────────────────
// Web Crypto only, so the same code runs in the Edge middleware and in the Node
// login route. Token = "<expiryMs>.<base64url(HMAC-SHA256(secret, "v1.<expiryMs>"))>".
// No secret ⇒ verification always fails ⇒ everything protected stays closed.

export const ADMIN_COOKIE = 'mup_admin';
export const SESSION_TTL_SECONDS = 12 * 60 * 60; // 12 h

const enc = new TextEncoder();

function b64url(buf: ArrayBuffer): string {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(payload)));
}

// Constant-time string compare (lengths are compared first, which leaks only
// the length of a forged signature — never its content).
function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function createSessionToken(secret: string, now: number = Date.now()): Promise<string> {
  const exp = String(now + SESSION_TTL_SECONDS * 1000);
  return `${exp}.${await sign(secret, `v1.${exp}`)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (!token || !secret) return false;
  const dot = token.indexOf('.');
  if (dot < 1) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^\d{10,16}$/.test(exp) || Number(exp) <= now) return false;
  const expected = await sign(secret, `v1.${exp}`);
  return timingSafeEqualStr(sig, expected);
}
