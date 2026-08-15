import { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { createServiceClient } from '@/lib/supabase';

// ── Courtesy throttling ───────────────────────────────────────────────────────
//
// This is fairness and overload protection for a student-facing demo, NOT access
// control. Both identifiers are client-supplied (a cookie the browser sends back,
// an IP header the edge sets), so anyone who wants more turns can get them by
// clearing a cookie. That is fine: the job here is to stop one open tab with a
// script — or one lecture hall refreshing at once — from draining the OpenAI
// balance, which is what took production down twice.
//
// Storage is the pre-existing daily_quota table + consume_daily_quota(p_bucket,
// p_limit) RPC. No migration is added by this module.
//
// RPC contract, established empirically (2026-08-15, probe buckets
// __probe:1786779206 / __probe0:1786779207 — see scratchpad/sprint/01-rate-limits.md):
//   • returns one row: [{ allowed: boolean, used: number }]
//   • a call that is allowed increments and returns the NEW count as `used`
//   • a call past the cap returns allowed=false and does NOT increment (the
//     counter pins at the cap instead of growing), so `used` is never > cap
//   • cap N therefore grants exactly N calls per (bucket, day) — no off-by-one
//   • it never throws on a denial; a denial is a normal 200
//   • the (bucket, day) primary key rolls the counter over on the DATABASE's
//     day boundary, which is Postgres CURRENT_DATE — 00:00 UTC = 03:00
//     Europe/Sofia on a Supabase instance left at the default UTC. This was NOT
//     provable at probe time (the UTC and Sofia dates coincide except between
//     00:00 and 03:00 local), so it is an inference; see the report for the
//     one-line SQL that settles it.
//
// The DAY component is left to the database. The HOUR component of the IP bucket
// is encoded into the bucket string in UTC so it turns over together with that
// same database day and no schema change is needed.

const SESSION_COOKIE = 'mup_sid';

/** A malformed cap falls back to the default rather than becoming NaN. */
function capFrom(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[rate-limit] ignoring non-numeric cap ${JSON.stringify(raw)} — using ${fallback}`);
    return fallback;
  }
  return n;
}

/** Per-student daily cap. Fairness, not defence — this is the demo beat. */
const SESSION_DAILY_CAP = capFrom(process.env.RATE_LIMIT_SESSION_DAILY, 50);
/** Per-IP hourly ceiling. Pure anti-abuse: a lecture hall NATs to one address, so
 *  this must sit far above anything a legitimate room full of students could do. */
const IP_HOURLY_CAP = capFrom(process.env.RATE_LIMIT_IP_HOURLY, 2000);

/** The quota round trip measured 50–85ms. Anything slower is treated as broken
 *  and the request goes through — a limiter must never be what stalls a demo. */
const QUOTA_TIMEOUT_MS = 2000;

export interface QuotaVerdict {
  allowed: boolean;
  /** Requests already spent from this bucket today, when the RPC reported it. */
  used: number | null;
  limit: number;
  /** Bulgarian text to show the student, set only when allowed === false. */
  message?: string;
  /** True when the check itself failed and the request was allowed anyway. */
  degraded: boolean;
}

export interface SessionResolution {
  id: string;
  /** Set-Cookie value to attach to the response, or null if the browser already had one. */
  setCookie: string | null;
}

// ── Messages ──────────────────────────────────────────────────────────────────

// „всяка нощ" rather than „на следващия ден": the counter is keyed on the
// database's own day, which is UTC (confirmed), so it rolls at 00:00 UTC =
// 03:00 Europe/Sofia. Between midnight and 03:00 local, "tomorrow" would be
// a false statement to a student who is already in tomorrow.
const DAILY_LIMIT_MESSAGE = (cap: number) =>
  `Достигнахте дневния лимит от ${cap} въпроса. ` +
  'Лимитът се възстановява автоматично всяка нощ. ' +
  'Благодарим Ви за разбирането.';

const HOURLY_LIMIT_MESSAGE =
  'В момента системата обработва голям брой запитвания от Вашата мрежа. ' +
  'Моля, опитайте отново след няколко минути. Благодарим Ви за търпението.';

// ── Identifiers ───────────────────────────────────────────────────────────────

/** First-party session id. Minted here on first contact; no personal data in it. */
export function resolveSession(req: NextRequest): SessionResolution {
  const existing = req.cookies.get(SESSION_COOKIE)?.value;
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return { id: existing, setCookie: null };
  }
  const id = randomUUID();
  const attrs = [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'Max-Age=31536000', // one year — a student keeps the same bucket across the term
    'HttpOnly',
    'SameSite=Lax',
    'Secure',
  ];
  return { id, setCookie: attrs.join('; ') };
}

/**
 * x-forwarded-for is a CHAIN, not an address: `client, proxy1, proxy2`, appended
 * left to right as the request crosses hops. The client is the FIRST entry, so
 * that is what we take — using the whole header, or the last entry, would bucket
 * every student behind Vercel's own edge address and turn the ceiling into a
 * global one.
 *
 * Measured on production 2026-08-15: Vercel REWRITES this header at the edge. A
 * request that sent a 3000-character value still bucketed under the true client
 * address, so the chain we receive is not client-controlled and the IP ceiling
 * cannot be shrugged off by spoofing it. That is a property of this deployment,
 * not a guarantee to lean on — nothing here treats an IP as identity.
 */
export function clientIp(req: NextRequest): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.headers.get('x-real-ip')?.trim() || 'unknown';
}

/**
 * Regression sweeps fire 140+ requests in a few minutes and must not be throttled
 * or counted. The expected value comes from HARNESS_BYPASS_KEY; if that env var is
 * unset the bypass does not exist at all — there is no fallback string.
 */
export function isHarnessRequest(req: NextRequest): boolean {
  const expected = process.env.HARNESS_BYPASS_KEY;
  if (!expected) return false;
  return req.headers.get('x-mup-harness-key') === expected;
}

/**
 * Fail-open test hook.
 *
 * Production fail-open could not be proven from outside: the only lever available
 * was an unreachable bucket key via x-forwarded-for, and Vercel rewrites that
 * header. This hook closes that gap — it makes the quota call throw, and nothing
 * else, so a deploy can be checked to still answer when the quota subsystem is
 * broken.
 *
 * The gate order is the point: a VALID harness key must be present before
 * x-mup-failtest is read at all. An ungated version of this would be an open
 * bypass, since forcing an error is by definition allow-through. With
 * HARNESS_BYPASS_KEY unset, isHarnessRequest() is false and the hook does not
 * exist — same rule as the bypass itself.
 */
export function isQuotaFailureTest(req: NextRequest): boolean {
  if (!isHarnessRequest(req)) return false;
  return req.headers.get('x-mup-failtest') === '1';
}

// ── Quota calls ───────────────────────────────────────────────────────────────

function withTimeout<T>(work: PromiseLike<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    Promise.resolve(work).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

const allowDegraded = (limit: number): QuotaVerdict => ({
  allowed: true, used: null, limit, degraded: true,
});

/**
 * One bucket, one request. FAIL-OPEN: every failure path — RPC error, timeout,
 * unreachable database, unexpected payload shape — returns allowed:true. The only
 * way this returns allowed:false is an explicit allowed:false from the database.
 */
async function consume(bucket: string, limit: number, forceFailure = false): Promise<QuotaVerdict> {
  // A cap of zero or less means the bucket is switched off, and the check is
  // skipped rather than delegated to the database. The RPC cannot express it:
  // its zero-guard sits on the ON CONFLICT update branch only, so the first
  // INSERT for a bucket is always allowed and p_limit=0 silently grants 1/day
  // (measured — probe bucket __probe0:1786779207). Never pass <= 0 to it.
  if (!(limit > 0)) {
    return { allowed: true, used: null, limit, degraded: false };
  }

  try {
    // The test hook throws from inside the real try block, so the request takes
    // the same catch, the same log line and the same allow-by-default path a
    // genuine outage would. Nothing outside this function is affected.
    if (forceFailure) {
      throw new Error(`forced quota failure for ${bucket} (x-mup-failtest)`);
    }

    const supabase = createServiceClient();
    const { data, error } = await withTimeout(
      supabase.rpc('consume_daily_quota', { p_bucket: bucket, p_limit: limit }),
      QUOTA_TIMEOUT_MS,
      `consume_daily_quota(${bucket})`,
    );

    if (error) {
      console.error('[rate-limit] quota RPC error — allowing request', { bucket, limit, error });
      return allowDegraded(limit);
    }

    // The RPC returns a single-row table, which supabase-js hands back as an array.
    const row = (Array.isArray(data) ? data[0] : data) as
      | { allowed?: unknown; used?: unknown }
      | undefined;

    if (!row || typeof row.allowed !== 'boolean') {
      console.error('[rate-limit] unexpected quota payload — allowing request', { bucket, limit, data });
      return allowDegraded(limit);
    }

    const used = typeof row.used === 'number' ? row.used : null;
    return { allowed: row.allowed, used, limit, degraded: false };
  } catch (err) {
    console.error('[rate-limit] quota check failed — allowing request', {
      bucket, limit,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
    return allowDegraded(limit);
  }
}

/** UTC hour stamp, so the hourly bucket turns over with the database's day. */
function hourStamp(now: Date): string {
  return now.toISOString().slice(0, 13).replace(/[-T]/g, ''); // YYYYMMDDHH
}

/**
 * Charge one request against both buckets.
 *
 * The IP ceiling is checked first on purpose: if a network is being throttled the
 * student should not also lose one of their own daily turns for a request that
 * never ran.
 */
export async function enforceRateLimit(
  req: NextRequest,
  sessionId: string,
  opts: { forceFailure?: boolean; now?: Date } = {},
): Promise<QuotaVerdict> {
  const now = opts.now ?? new Date();
  const forceFailure = opts.forceFailure ?? false;

  const ipVerdict = await consume(`ip:${clientIp(req)}:${hourStamp(now)}`, IP_HOURLY_CAP, forceFailure);
  if (!ipVerdict.allowed) {
    return { ...ipVerdict, message: HOURLY_LIMIT_MESSAGE };
  }

  const sessionVerdict = await consume(`sess:${sessionId}`, SESSION_DAILY_CAP, forceFailure);
  if (!sessionVerdict.allowed) {
    return { ...sessionVerdict, message: DAILY_LIMIT_MESSAGE(SESSION_DAILY_CAP) };
  }

  return sessionVerdict;
}

/** Turns remaining for the student's daily bucket, or null when it is unknown. */
export function remainingFor(verdict: QuotaVerdict): number | null {
  if (verdict.used === null) return null;
  return Math.max(0, verdict.limit - verdict.used);
}
