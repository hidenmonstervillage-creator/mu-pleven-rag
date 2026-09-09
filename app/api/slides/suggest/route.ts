import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { fetchSlidesForSubject } from '@/lib/slides-for-subject';
import { suggestSlides } from '@/lib/slides-match';

export const dynamic = 'force-dynamic';

// ── POST /api/slides/suggest ─────────────────────────────────────────────────
// Chat-driven slide auto-suggest, evaluated server-side so the Bulgarian
// stemmer / stop-list never ship to the browser. Fired by the client in
// parallel with /api/chat — the answer never waits on it.
//
// Body:  { question, subject, facultyId, specialtyId }
// Reply: { slideIds: number[] }   — up to 3 slide record_ids, distinct organs

const MAX_QUESTION_CHARS = 2000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({})) as {
      question?: unknown; subject?: unknown; facultyId?: unknown; specialtyId?: unknown;
    };
    const question    = typeof body.question    === 'string' ? body.question.slice(0, MAX_QUESTION_CHARS) : '';
    const subject     = typeof body.subject     === 'string' ? body.subject     : '';
    const facultyId   = typeof body.facultyId   === 'string' ? body.facultyId   : '';
    const specialtyId = typeof body.specialtyId === 'string' ? body.specialtyId : '';

    if (!question.trim() || !subject || !facultyId || !specialtyId) {
      return NextResponse.json({ slideIds: [] });
    }

    const slides = await fetchSlidesForSubject(createServiceClient(), facultyId, specialtyId, subject);
    return NextResponse.json({ slideIds: suggestSlides(question, slides) });
  } catch (err) {
    // A failed suggestion must never surface as an error in the chat — the
    // chip simply does not appear.
    const message = err instanceof Error ? err.message : String(err);
    console.error('[slides/suggest]', message);
    return NextResponse.json({ slideIds: [] });
  }
}
