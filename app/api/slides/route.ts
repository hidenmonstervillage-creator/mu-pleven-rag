import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── GET /api/slides ────────────────────────────────────────────────────────────
// Returns all cataloged slides, optionally filtered by faculty_id, specialty_id,
// and/or subject query params.

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const facultyId   = searchParams.get('faculty_id')   ?? '';
    const specialtyId = searchParams.get('specialty_id') ?? '';
    const subject     = searchParams.get('subject')       ?? '';

    const supabase = createServiceClient();

    let query = supabase
      .from('slides')
      .select('id, record_id, slide_name, organ, konspekt_number, stain, faculty_id, specialty_id, subject, olyvia_folder, created_at')
      .order('konspekt_number', { ascending: true });

    if (facultyId)   query = query.eq('faculty_id',   facultyId);
    if (specialtyId) query = query.eq('specialty_id', specialtyId);
    if (subject)     query = query.eq('subject',      subject);

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ slides: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST /api/slides ───────────────────────────────────────────────────────────
// Creates a new slide catalog entry.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;

    const record_id       = body.record_id;
    const slide_name      = body.slide_name;
    const organ           = body.organ       ?? null;
    const konspekt_number = body.konspekt_number ?? null;
    const stain           = body.stain       ?? null;
    const faculty_id      = body.faculty_id;
    const specialty_id    = body.specialty_id;
    const subject         = body.subject;
    const olyvia_folder   = body.olyvia_folder ?? null;

    // Validate required fields
    if (typeof record_id !== 'number' || !Number.isInteger(record_id) || record_id <= 0) {
      return NextResponse.json(
        { error: 'record_id must be a positive integer' },
        { status: 400 },
      );
    }
    if (typeof slide_name !== 'string' || !slide_name.trim()) {
      return NextResponse.json({ error: 'slide_name is required' }, { status: 400 });
    }
    if (typeof faculty_id !== 'string' || !faculty_id.trim()) {
      return NextResponse.json({ error: 'faculty_id is required' }, { status: 400 });
    }
    if (typeof specialty_id !== 'string' || !specialty_id.trim()) {
      return NextResponse.json({ error: 'specialty_id is required' }, { status: 400 });
    }
    if (typeof subject !== 'string' || !subject.trim()) {
      return NextResponse.json({ error: 'subject is required' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from('slides')
      .insert({
        record_id,
        slide_name:      slide_name.trim(),
        organ:           typeof organ === 'string' ? organ.trim() || null : null,
        konspekt_number: typeof konspekt_number === 'string' ? konspekt_number.trim() || null : null,
        stain:           typeof stain === 'string' ? stain.trim() || null : null,
        faculty_id:      (faculty_id as string).trim(),
        specialty_id:    (specialty_id as string).trim(),
        subject:         (subject as string).trim(),
        olyvia_folder:   typeof olyvia_folder === 'string' ? olyvia_folder.trim() || null : null,
      })
      .select()
      .single();

    if (error) {
      if (error.code === '23505') {
        return NextResponse.json(
          { error: `A slide with record_id ${record_id} already exists in the catalog` },
          { status: 409 },
        );
      }
      throw new Error(error.message);
    }

    return NextResponse.json({ slide: data }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
