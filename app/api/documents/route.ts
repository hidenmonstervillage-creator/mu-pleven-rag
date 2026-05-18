import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const supabase = createServiceClient();

    const { data, error } = await supabase
      .from('documents')
      .select(`
        id, filename, clean_title, file_type,
        faculty_id, specialty_id, subject,
        storage_url, page_count, created_at,
        chunks(count)
      `)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);

    const documents = (data ?? []).map((doc) => {
      const chunkArr = doc.chunks as Array<{ count: number }> | null;
      return {
        id:            doc.id,
        filename:      doc.filename,
        clean_title:   doc.clean_title,
        file_type:     doc.file_type,
        faculty_id:    doc.faculty_id,
        specialty_id:  doc.specialty_id,
        subject:       doc.subject,
        storage_url:   doc.storage_url,
        page_count:    doc.page_count,
        created_at:    doc.created_at,
        chunk_count:   chunkArr?.[0]?.count ?? 0,
      };
    });

    return NextResponse.json({ documents });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
