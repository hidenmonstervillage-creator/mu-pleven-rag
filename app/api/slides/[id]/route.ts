import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── PATCH /api/slides/[id] ─────────────────────────────────────────────────────
// Updates slide metadata fields and/or replaces subject mappings.
//
// Body (all fields optional):
//   slide_name, organ, konspekt_number, stain, olyvia_folder   — slide fields
//   subjects: Array<{faculty_id, specialty_id, subject}>        — replaces ALL mappings

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const supabase = createServiceClient();

    // ── 1. Update slide fields ─────────────────────────────────────────────
    const allowed = ['slide_name', 'organ', 'konspekt_number', 'stain', 'olyvia_folder'] as const;
    const updates: Record<string, string | null> = {};
    for (const key of allowed) {
      if (key in body) {
        const val = body[key];
        updates[key] = typeof val === 'string' ? val.trim() || null : null;
      }
    }

    if (Object.keys(updates).length > 0) {
      const { error } = await supabase
        .from('slides')
        .update(updates)
        .eq('id', params.id);
      if (error) throw new Error(error.message);
    }

    // ── 2. Replace subject mappings if provided ────────────────────────────
    if ('subjects' in body) {
      const subjects = body.subjects;
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

      const { error: delErr } = await supabase
        .from('slide_subjects')
        .delete()
        .eq('slide_id', params.id);
      if (delErr) throw new Error(delErr.message);

      const { error: insErr } = await supabase
        .from('slide_subjects')
        .insert(
          (subjects as Array<{ faculty_id: string; specialty_id: string; subject: string }>)
            .map(s => ({
              slide_id:    params.id,
              faculty_id:  s.faculty_id.trim(),
              specialty_id: s.specialty_id.trim(),
              subject:     s.subject.trim(),
            })),
        );
      if (insErr) throw new Error(insErr.message);
    }

    // ── 3. Return updated slide with subjects ──────────────────────────────
    const { data, error } = await supabase
      .from('slides')
      .select(`
        id, record_id, slide_name, organ, konspekt_number, stain, olyvia_folder, created_at,
        slide_subjects ( id, faculty_id, specialty_id, subject )
      `)
      .eq('id', params.id)
      .single();

    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'Slide not found' }, { status: 404 });

    return NextResponse.json({ slide: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE /api/slides/[id] ────────────────────────────────────────────────────
// Removes the slide from the catalog. slide_subjects rows are deleted via CASCADE.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const supabase = createServiceClient();

    const { error } = await supabase
      .from('slides')
      .delete()
      .eq('id', params.id);

    if (error) throw new Error(error.message);

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
