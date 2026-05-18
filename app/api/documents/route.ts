import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createServiceClient();

    // Step 1 — fetch all documents ordered newest first
    const { data: docs, error } = await supabase
      .from('documents')
      .select('id, filename, clean_title, file_type, faculty_id, specialty_id, subject, storage_url, page_count, created_at')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    if (!docs || docs.length === 0) return NextResponse.json({ documents: [] });

    // Step 2 — fetch chunk counts for all documents in parallel
    const counts = await Promise.all(
      docs.map(async (doc) => {
        const { count, error: countErr } = await supabase
          .from('chunks')
          .select('*', { count: 'exact', head: true })
          .eq('document_id', doc.id);
        if (countErr) return 0;
        return count ?? 0;
      }),
    );

    const documents = docs.map((doc, i) => ({
      ...doc,
      chunk_count: counts[i],
    }));

    return NextResponse.json({ documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
