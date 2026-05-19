import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

// ── PATCH /api/documents/[id] ─────────────────────────────────────────────────
// Reassign a document to a different (faculty_id, specialty_id, subject).
// Does NOT re-embed — the chunks keep their original embeddings; only the
// metadata used for retrieval filtering is updated.

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const body = await req.json() as {
      faculty_id?: unknown;
      specialty_id?: unknown;
      subject?: unknown;
    };

    const { faculty_id, specialty_id, subject } = body;

    if (
      typeof faculty_id  !== 'string' || !faculty_id.trim()  ||
      typeof specialty_id !== 'string' || !specialty_id.trim() ||
      typeof subject      !== 'string' || !subject.trim()
    ) {
      return NextResponse.json(
        { error: 'faculty_id, specialty_id and subject are required non-empty strings' },
        { status: 400 },
      );
    }

    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from('documents')
      .update({
        faculty_id:   faculty_id.trim(),
        specialty_id: specialty_id.trim(),
        subject:      subject.trim(),
      })
      .eq('id', params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    if (!data) return NextResponse.json({ error: 'Document not found' }, { status: 404 });

    return NextResponse.json({ success: true, document: data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── DELETE /api/documents/[id] ────────────────────────────────────────────────

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const supabase = createServiceClient();

    // Fetch the document first so we have its storage_url for Hetzner cleanup
    const { data: doc, error: fetchErr } = await supabase
      .from('documents')
      .select('id, storage_url')
      .eq('id', params.id)
      .single();

    if (fetchErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    // Delete from Supabase — chunks cascade via FK constraint
    const { error: deleteErr } = await supabase
      .from('documents')
      .delete()
      .eq('id', params.id);

    if (deleteErr) throw new Error(deleteErr.message);

    // Best-effort: delete the physical file from Hetzner
    try {
      const storageUrl = String(doc.storage_url ?? '');
      // storage_url is like http://178.105.161.66/documents/fid/sid/subj/file.pdf
      const match = storageUrl.match(/\/documents\/(.+)$/);
      if (match) {
        await fetch(`http://178.105.161.66/documents/${match[1]}`, {
          method: 'DELETE',
          headers: {
            'x-api-key': process.env.HETZNER_API_KEY ?? 'mup-upload-secret-2024',
          },
        });
      }
    } catch {
      // Non-fatal — Supabase row is already gone
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
