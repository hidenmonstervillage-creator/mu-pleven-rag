import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── GET /api/slides/for-subject ─────────────────────────────────────────────────
// Student-facing: returns all slides mapped to a given subject, ordered by
// konspekt_number (natural/numeric) then organ. Public read — service role is
// used server-side only, same as the chat route.
//
// Query: ?faculty_id=&specialty_id=&subject=

interface SubjectSlideRow {
  record_id: number;
  slide_name: string;
  organ: string | null;
  organ_bg: string | null;
  konspekt_number: string | null;
  stain: string | null;
}

// Natural sort key: leading integer first (so #2 < #18a), then the suffix.
function konspektKey(k: string | null): [number, string] {
  const m = (k ?? '').match(/^(\d+)(.*)$/);
  return m ? [parseInt(m[1], 10), m[2]] : [Number.MAX_SAFE_INTEGER, (k ?? '').toLowerCase()];
}

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

    const supabase = createServiceClient();

    // 1. Resolve slide ids mapped to this subject via the junction table.
    const { data: links, error: linkErr } = await supabase
      .from('slide_subjects')
      .select('slide_id')
      .eq('faculty_id', facultyId)
      .eq('specialty_id', specialtyId)
      .eq('subject', subject);
    if (linkErr) throw new Error(linkErr.message);

    const ids = Array.from(new Set((links ?? []).map((l) => l.slide_id)));
    if (ids.length === 0) return NextResponse.json({ slides: [] });

    // 2. Fetch the slide rows. Include organ_bg, but fall back gracefully if the
    //    0017 migration hasn't been applied yet — so the panel never breaks.
    let slides: SubjectSlideRow[] | null = null;
    {
      const withBg = await supabase
        .from('slides')
        .select('record_id, slide_name, organ, organ_bg, konspekt_number, stain')
        .in('id', ids);
      if (withBg.error && /organ_bg/i.test(withBg.error.message)) {
        // Column not yet added by migration 0017 — retry without it.
        const noBg = await supabase
          .from('slides')
          .select('record_id, slide_name, organ, konspekt_number, stain')
          .in('id', ids);
        if (noBg.error) throw new Error(noBg.error.message);
        slides = (noBg.data ?? []).map((s) => ({ ...s, organ_bg: null })) as SubjectSlideRow[];
      } else if (withBg.error) {
        throw new Error(withBg.error.message);
      } else {
        slides = (withBg.data ?? []) as SubjectSlideRow[];
      }
    }

    // 3. Natural sort: konspekt_number (numeric-aware) then organ.
    const sorted = (slides ?? []).sort((a, b) => {
      const [an, as] = konspektKey(a.konspekt_number);
      const [bn, bs] = konspektKey(b.konspekt_number);
      if (an !== bn) return an - bn;
      if (as !== bs) return as.localeCompare(bs);
      return (a.organ ?? '').localeCompare(b.organ ?? '');
    });

    return NextResponse.json({ slides: sorted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
