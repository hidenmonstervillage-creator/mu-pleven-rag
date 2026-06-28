import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── PATCH /api/slides/[id] ─────────────────────────────────────────────────────
// Updates any subset of a slide's fields. Typically used to:
//   • reassign to a different subject (same as /api/documents/[id] PATCH pattern)
//   • fix organ / konspekt_number / stain after initial entry

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json() as Record<string, unknown>;

    // Build the update object from whatever fields were sent
    const allowed = [
      'slide_name', 'organ', 'konspekt_number', 'stain',
      'faculty_id', 'specialty_id', 'subject', 'olyvia_folder',
    ] as const;

    const updates: Record<string, string | null> = {};
    for (const key of allowed) {
      if (key in body) {
        const val = body[key];
        updates[key] = typeof val === 'string' ? val.trim() || null : null;
      }
    }

    // Extra validation: if reassigning subject, all three hierarchy fields must be present together
    const hasSubjectField = 'subject' in updates || 'faculty_id' in updates || 'specialty_id' in updates;
    if (hasSubjectField) {
      const needsBoth = !updates.faculty_id || !updates.specialty_id || !updates.subject;
      if (needsBoth) {
        return NextResponse.json(
          { error: 'When updating subject mapping, faculty_id, specialty_id and subject are all required' },
          { status: 400 },
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: 'No updatable fields provided' }, { status: 400 });
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from('slides')
      .update(updates)
      .eq('id', params.id)
      .select()
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
// Removes the slide from our catalog. Does NOT touch OlyVia — the original
// slide on the microscopy server is unaffected.

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
