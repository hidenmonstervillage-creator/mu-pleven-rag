import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── GET /api/slides ────────────────────────────────────────────────────────────
// Returns all cataloged slides with their subject mappings.
// Optional filters: ?faculty_id=&specialty_id=&subject=&unassigned=true

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const facultyId    = searchParams.get('faculty_id')   ?? '';
    const specialtyId  = searchParams.get('specialty_id') ?? '';
    const subject      = searchParams.get('subject')      ?? '';
    const unassigned   = searchParams.get('unassigned') === 'true';

    const supabase = createServiceClient();

    // Subject-hierarchy filter: resolve matching slide_ids via junction table
    let slideIds: string[] | null = null;
    if (facultyId || specialtyId || subject) {
      let linkQ = supabase.from('slide_subjects').select('slide_id');
      if (facultyId)   linkQ = linkQ.eq('faculty_id',   facultyId);
      if (specialtyId) linkQ = linkQ.eq('specialty_id', specialtyId);
      if (subject)     linkQ = linkQ.eq('subject',      subject);
      const { data: links, error: linksErr } = await linkQ;
      if (linksErr) throw new Error(linksErr.message);
      slideIds = (links ?? []).map(l => l.slide_id);
      if (slideIds.length === 0) return NextResponse.json({ slides: [] });
    }

    // Unassigned filter: slides with no slide_subjects rows
    let excludeIds: string[] | null = null;
    if (unassigned) {
      const { data: assigned, error: assignErr } = await supabase
        .from('slide_subjects')
        .select('slide_id');
      if (assignErr) throw new Error(assignErr.message);
      excludeIds = Array.from(new Set((assigned ?? []).map(r => r.slide_id)));
    }

    let query = supabase
      .from('slides')
      .select(`
        id, record_id, slide_name, organ, konspekt_number, stain,
        olyvia_folder, parent_folder_id, created_at,
        slide_subjects ( id, faculty_id, specialty_id, subject )
      `)
      .order('record_id', { ascending: true });

    if (slideIds !== null)  query = query.in('id', slideIds);
    if (excludeIds !== null && excludeIds.length > 0) {
      query = query.not('id', 'in', `(${excludeIds.join(',')})`);
    }

    const { data, error } = await query;
    if (error) throw new Error(error.message);

    return NextResponse.json({ slides: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── POST /api/slides ───────────────────────────────────────────────────────────
// Creates a new slide entry plus one or more subject mappings.
//
// Body: {
//   record_id: number,
//   slide_name: string,
//   organ?: string,
//   konspekt_number?: string,
//   stain?: string,
//   olyvia_folder?: string,
//   subjects: Array<{ faculty_id: string, specialty_id: string, subject: string }>
// }

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;

    const record_id       = body.record_id;
    const slide_name      = body.slide_name;
    const organ           = body.organ           ?? null;
    const konspekt_number = body.konspekt_number ?? null;
    const stain           = body.stain           ?? null;
    const olyvia_folder   = body.olyvia_folder   ?? null;
    const subjects        = body.subjects;

    if (typeof record_id !== 'number' || !Number.isInteger(record_id) || record_id <= 0) {
      return NextResponse.json({ error: 'record_id must be a positive integer' }, { status: 400 });
    }
    if (typeof slide_name !== 'string' || !slide_name.trim()) {
      return NextResponse.json({ error: 'slide_name is required' }, { status: 400 });
    }
    if (!Array.isArray(subjects) || subjects.length === 0) {
      return NextResponse.json({ error: 'subjects must be a non-empty array' }, { status: 400 });
    }
    for (const s of subjects as Array<Record<string, unknown>>) {
      if (!s.faculty_id || !s.specialty_id || !s.subject) {
        return NextResponse.json(
          { error: 'Each subject mapping must have faculty_id, specialty_id, and subject' },
          { status: 400 },
        );
      }
    }

    const supabase = createServiceClient();

    // 1. Insert the slide row
    const { data: slide, error: slideErr } = await supabase
      .from('slides')
      .insert({
        record_id,
        slide_name:      slide_name.trim(),
        organ:           typeof organ === 'string'           ? organ.trim()           || null : null,
        konspekt_number: typeof konspekt_number === 'string' ? konspekt_number.trim() || null : null,
        stain:           typeof stain === 'string'           ? stain.trim()           || null : null,
        olyvia_folder:   typeof olyvia_folder === 'string'   ? olyvia_folder.trim()   || null : null,
      })
      .select('id')
      .single();

    if (slideErr) {
      if (slideErr.code === '23505') {
        return NextResponse.json(
          { error: `A slide with record_id ${record_id} already exists in the catalog` },
          { status: 409 },
        );
      }
      throw new Error(slideErr.message);
    }

    // 2. Insert subject mappings
    const { error: subjErr } = await supabase
      .from('slide_subjects')
      .insert(
        (subjects as Array<{ faculty_id: string; specialty_id: string; subject: string }>)
          .map(s => ({
            slide_id:    slide.id,
            faculty_id:  s.faculty_id.trim(),
            specialty_id: s.specialty_id.trim(),
            subject:     s.subject.trim(),
          })),
      );

    if (subjErr) throw new Error(subjErr.message);

    // 3. Return full slide with subjects
    const { data: full, error: fullErr } = await supabase
      .from('slides')
      .select(`
        id, record_id, slide_name, organ, konspekt_number, stain, olyvia_folder, created_at,
        slide_subjects ( id, faculty_id, specialty_id, subject )
      `)
      .eq('id', slide.id)
      .single();

    if (fullErr) throw new Error(fullErr.message);

    return NextResponse.json({ slide: full }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
