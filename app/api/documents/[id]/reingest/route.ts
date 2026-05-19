import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { embedTexts } from '@/lib/embeddings';
import { extractPdfPages, extractPptxPages, chunkPages } from '@/lib/chunker';

export const runtime = 'nodejs';
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

// ── POST /api/documents/[id]/reingest ────────────────────────────────────────
//
// Re-processes an existing document: deletes all its current chunks, downloads
// the original file from Hetzner, re-extracts text, re-embeds and re-inserts.
// The document row itself (metadata, storage_url, etc.) is left untouched.
// No request body needed — all parameters come from the stored document record.

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } },
) {
  const docId = params.id;

  try {
    const supabase = createServiceClient();

    // ── Step 1: fetch document metadata ──────────────────────────────────────
    console.log(`[reingest] ${docId} — STEP 1: fetching document`);
    const { data: doc, error: docErr } = await supabase
      .from('documents')
      .select('id, filename, file_type, faculty_id, specialty_id, subject, storage_url')
      .eq('id', docId)
      .single();

    if (docErr || !doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    const filename   = doc.filename   as string;
    const storageUrl = doc.storage_url as string;

    // ── Step 2: delete existing chunks (batched) ─────────────────────────────
    //
    // A single DELETE … WHERE document_id = $1 scans the full 70k-row chunks
    // table (no index on the FK column) AND updates the HNSW pgvector index
    // for every matched row. On Supabase free tier the statement_timeout (~8 s)
    // kills the query before it finishes — even when there are 0 rows to delete.
    //
    // Fix: read chunk IDs in pages of 200 (LIMIT keeps each SELECT fast) then
    // delete each page by primary key (PK lookup = O(log n), no full scan).
    console.log(`[reingest] ${docId} — STEP 2: deleting existing chunks (batched)`);
    let deletedTotal = 0;
    for (;;) {
      const { data: idRows, error: fetchErr } = await supabase
        .from('chunks')
        .select('id')
        .eq('document_id', docId)
        .limit(200);

      if (fetchErr) {
        return NextResponse.json(
          { error: `Failed to fetch chunk IDs for deletion: ${fetchErr.message}` },
          { status: 500 },
        );
      }
      if (!idRows || idRows.length === 0) break; // nothing left

      const { error: delErr } = await supabase
        .from('chunks')
        .delete()
        .in('id', idRows.map((r) => r.id as string));

      if (delErr) {
        return NextResponse.json(
          { error: `Failed to delete chunk batch: ${delErr.message}` },
          { status: 500 },
        );
      }
      deletedTotal += idRows.length;
      console.log(`[reingest] ${docId} — deleted ${deletedTotal} chunks so far`);
    }
    console.log(`[reingest] ${docId} — STEP 2 done: ${deletedTotal} chunks deleted`);

    // ── Step 3: download file from Hetzner ───────────────────────────────────
    console.log(`[reingest] ${docId} — STEP 3: downloading ${storageUrl}`);
    const fileRes = await fetch(storageUrl);
    if (!fileRes.ok) {
      throw new Error(`File download failed: HTTP ${fileRes.status} ${fileRes.statusText}`);
    }
    const buffer = Buffer.from(await fileRes.arrayBuffer());
    console.log(`[reingest] ${docId} — downloaded ${buffer.length} bytes`);

    // ── Step 4: extract text ─────────────────────────────────────────────────
    const isPdf  = filename.toLowerCase().endsWith('.pdf');
    const isPptx = /\.(pptx|ppt)$/i.test(filename.toLowerCase());

    let pages: Array<{ page: number; text: string }>;
    if (isPdf) {
      console.log(`[reingest] ${docId} — STEP 4: extracting PDF pages`);
      pages = await extractPdfPages(buffer);
    } else if (isPptx) {
      console.log(`[reingest] ${docId} — STEP 4: extracting PPTX slides`);
      pages = await extractPptxPages(buffer);
    } else {
      return NextResponse.json({ error: 'Unsupported file type' }, { status: 400 });
    }
    console.log(`[reingest] ${docId} — STEP 4 OK: ${pages.length} pages`);

    // ── Step 5: chunk ─────────────────────────────────────────────────────────
    const chunks = chunkPages(pages);
    console.log(`[reingest] ${docId} — STEP 5: ${chunks.length} chunks`);

    if (chunks.length === 0) {
      console.log(`[reingest] ${docId} — DONE: no text extracted`);
      return NextResponse.json({ success: true, chunksCreated: 0 });
    }

    // ── Step 6: embed ─────────────────────────────────────────────────────────
    console.log(`[reingest] ${docId} — STEP 6: embedding ${chunks.length} chunks`);
    const embeddings = await embedTexts(chunks.map((c) => c.content));
    console.log(`[reingest] ${docId} — STEP 6 OK: ${embeddings.length} embeddings`);

    // ── Step 7: bulk insert chunks ────────────────────────────────────────────
    console.log(`[reingest] ${docId} — STEP 7: inserting chunks`);
    const DB_BATCH = 100;
    let chunksCreated = 0;

    for (let i = 0; i < chunks.length; i += DB_BATCH) {
      const batchRows = chunks.slice(i, i + DB_BATCH).map((chunk, j) => ({
        document_id: docId,
        // eslint-disable-next-line no-control-regex
        content:     chunk.content.replace(/\x00/g, ''),
        page_number: chunk.pageNumber,
        chunk_index: chunk.chunkIndex,
        embedding:   embeddings[i + j],
      }));
      const { error: insertErr } = await supabase.from('chunks').insert(batchRows);
      if (insertErr) {
        console.error(`[reingest] ${docId} — batch ${Math.floor(i / DB_BATCH) + 1} insert error:`, insertErr.message);
      } else {
        chunksCreated += batchRows.length;
      }
    }

    console.log(`[reingest] ${docId} — DONE: ${chunksCreated}/${chunks.length} chunks`);
    return NextResponse.json({ success: true, chunksCreated });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[reingest] ${docId} — UNHANDLED ERROR:`, message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
