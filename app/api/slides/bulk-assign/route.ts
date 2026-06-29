import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── POST /api/slides/bulk-assign ───────────────────────────────────────────────
// Adds subject mappings to a group of slides (upsert — safe to call repeatedly).
//
// Body: {
//   parent_folder_id?: number    — target all slides with this parent_folder_id
//   record_ids?:       number[]  — OR target specific slides by record_id
//   subjects:          Array<{ faculty_id, specialty_id, subject }>
// }
// At least one of parent_folder_id / record_ids is required.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const { parent_folder_id, record_ids, subjects } = body as {
      parent_folder_id?: number;
      record_ids?: number[];
      subjects?: Array<{ faculty_id: string; specialty_id: string; subject: string }>;
    };

    if (!Array.isArray(subjects) || subjects.length === 0) {
      return NextResponse.json({ error: 'subjects must be a non-empty array' }, { status: 400 });
    }
    for (const s of subjects) {
      if (!s.faculty_id || !s.specialty_id || !s.subject) {
        return NextResponse.json(
          { error: 'Each subject mapping must have faculty_id, specialty_id, and subject' },
          { status: 400 },
        );
      }
    }
    if (parent_folder_id == null && (!Array.isArray(record_ids) || record_ids.length === 0)) {
      return NextResponse.json(
        { error: 'Provide parent_folder_id or a non-empty record_ids array' },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    // Resolve slide UUIDs
    let slideQuery = supabase.from('slides').select('id');
    if (parent_folder_id != null) {
      slideQuery = slideQuery.eq('parent_folder_id', parent_folder_id);
    } else {
      slideQuery = slideQuery.in('record_id', record_ids!);
    }
    const { data: slideRows, error: slideErr } = await slideQuery;
    if (slideErr) throw new Error(slideErr.message);
    if (!slideRows || slideRows.length === 0) {
      return NextResponse.json({ assigned: 0 });
    }

    // Build all subject-mapping rows (one row per slide × subject combination)
    const mappings = slideRows.flatMap(row =>
      subjects.map(s => ({
        slide_id:    row.id,
        faculty_id:  s.faculty_id.trim(),
        specialty_id: s.specialty_id.trim(),
        subject:     s.subject.trim(),
      })),
    );

    // Upsert (on conflict do nothing — idempotent)
    const { error: insErr } = await supabase
      .from('slide_subjects')
      .upsert(mappings, { onConflict: 'slide_id,faculty_id,specialty_id,subject', ignoreDuplicates: true });
    if (insErr) throw new Error(insErr.message);

    return NextResponse.json({ assigned: slideRows.length, subjects: subjects.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE /api/slides/bulk-assign ─────────────────────────────────────────────
// Removes ALL subject mappings from a group of slides (makes them unassigned again).
//
// Body: {
//   parent_folder_id?: number
//   record_ids?:       number[]
// }

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json() as Record<string, unknown>;
    const { parent_folder_id, record_ids } = body as {
      parent_folder_id?: number;
      record_ids?: number[];
    };

    if (parent_folder_id == null && (!Array.isArray(record_ids) || record_ids.length === 0)) {
      return NextResponse.json(
        { error: 'Provide parent_folder_id or a non-empty record_ids array' },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    let slideQuery = supabase.from('slides').select('id');
    if (parent_folder_id != null) {
      slideQuery = slideQuery.eq('parent_folder_id', parent_folder_id);
    } else {
      slideQuery = slideQuery.in('record_id', record_ids!);
    }
    const { data: slideRows, error: slideErr } = await slideQuery;
    if (slideErr) throw new Error(slideErr.message);
    if (!slideRows || slideRows.length === 0) {
      return NextResponse.json({ cleared: 0 });
    }

    const slideIds = slideRows.map(r => r.id);
    const { error: delErr } = await supabase
      .from('slide_subjects')
      .delete()
      .in('slide_id', slideIds);
    if (delErr) throw new Error(delErr.message);

    return NextResponse.json({ cleared: slideRows.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
