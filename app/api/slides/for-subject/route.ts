import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { fetchSlidesForSubject } from '@/lib/slides-for-subject';

export const dynamic = 'force-dynamic';

// ── GET /api/slides/for-subject ─────────────────────────────────────────────────
// Student-facing: returns all slides mapped to a given subject, ordered by
// konspekt_number (natural/numeric) then organ. Public read — service role is
// used server-side only, same as the chat route. The query itself lives in
// lib/slides-for-subject so /api/slides/suggest sees exactly the same rows.
//
// Query: ?faculty_id=&specialty_id=&subject=

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const facultyId   = searchParams.get('faculty_id')   ?? '';
    const specialtyId = searchParams.get('specialty_id') ?? '';
    const subject     = searchParams.get('subject')      ?? '';

    if (!facultyId || !specialtyId || !subject) {
      return NextResponse.json(
        { error: 'faculty_id, specialty_id and subject are required' },
        { status: 400 },
      );
    }

    const slides = await fetchSlidesForSubject(createServiceClient(), facultyId, specialtyId, subject);
    return NextResponse.json({ slides });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
