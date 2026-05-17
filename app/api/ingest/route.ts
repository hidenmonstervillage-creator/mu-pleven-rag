// ── Node.js / Vercel polyfills for browser APIs used by pdfjs-dist ──────────
// These must appear before any pdfjs-dist import (which happens inside chunker.ts).
if (typeof globalThis.DOMMatrix === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).DOMMatrix = class DOMMatrix {
    constructor() {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    static fromMatrix() { return new (globalThis as any).DOMMatrix(); }
  };
}

if (typeof globalThis.Path2D === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Path2D = class Path2D {};
}

if (typeof globalThis.ImageData === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).ImageData = class ImageData {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(public data: any, public width: number, public height: number) {}
  };
}

if (typeof globalThis.CanvasRenderingContext2D === 'undefined') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).CanvasRenderingContext2D = class CanvasRenderingContext2D {};
}
// ─────────────────────────────────────────────────────────────────────────────

import { NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase';
import { embedTexts } from '@/lib/embeddings';
import { extractPdfPages, extractPptxPages, chunkPages } from '@/lib/chunker';
import { cleanFilename } from '@/lib/cleaner';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    // ── Parse JSON body (no file bytes — file was uploaded directly from the browser) ──
    const body = await req.json() as {
      storageUrl: string;
      filename: string;
      facultyId: string;
      specialtyId: string;
      subject: string;
      fileType: 'textbook' | 'lecture';
    };
    const { storageUrl, filename, facultyId, specialtyId, subject, fileType } = body;

    console.log('[ingest] received:', { filename, facultyId, specialtyId, subject, fileType });

    if (!storageUrl || !filename || !facultyId || !specialtyId || !subject || !fileType) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const supabase = createServiceClient();

    // ── Step 1: download file from Supabase Storage ──
    console.log('[ingest] STEP 1 — downloading from storage URL');
    let buffer: Buffer;
    try {
      const fileRes = await fetch(storageUrl);
      if (!fileRes.ok) {
        throw new Error(`HTTP ${fileRes.status} ${fileRes.statusText}`);
      }
      buffer = Buffer.from(await fileRes.arrayBuffer());
      console.log('[ingest] STEP 1 OK — buffer size (bytes):', buffer.length);
    } catch (err) {
      const e = err as Error;
      console.error('[ingest] STEP 1 FAILED:', e.message);
      return NextResponse.json({ error: `File download failed: ${e.message}` }, { status: 500 });
    }

    // ── Step 2: extract text page by page ──
    const isPdf  = filename.toLowerCase().endsWith('.pdf');
    const isPptx = /\.(pptx|ppt)$/i.test(filename.toLowerCase());
    let pages: Array<{ page: number; text: string }> = [];

    if (isPdf) {
      console.log('[ingest] STEP 2 — extracting PDF pages...');
      try {
        pages = await extractPdfPages(buffer);
        console.log('[ingest] STEP 2 OK — pages:', pages.length);
      } catch (err) {
        const e = err as Error;
        console.error('[ingest] STEP 2 FAILED (PDF):', e.message, e.stack);
        return NextResponse.json({ error: `PDF extraction failed: ${e.message}` }, { status: 500 });
      }
    } else if (isPptx) {
      console.log('[ingest] STEP 2 — extracting PPTX slides...');
      try {
        pages = await extractPptxPages(buffer);
        console.log('[ingest] STEP 2 OK — slides:', pages.length);
      } catch (err) {
        const e = err as Error;
        console.error('[ingest] STEP 2 FAILED (PPTX):', e.message, e.stack);
        return NextResponse.json({ error: `PPTX extraction failed: ${e.message}` }, { status: 500 });
      }
    } else {
      return NextResponse.json(
        { error: 'Unsupported file type. Only PDF and PPTX are supported.' },
        { status: 400 }
      );
    }

    // ── Step 3: insert document record ──
    const cleanTitle = cleanFilename(filename);
    console.log('[ingest] STEP 3 — inserting document record:', cleanTitle);
    let documentId: string;
    try {
      const { data: docData, error: docError } = await supabase
        .from('documents')
        .insert({
          filename,
          clean_title: cleanTitle,
          file_type: fileType,
          faculty_id: facultyId,
          specialty_id: specialtyId,
          subject,
          storage_url: storageUrl,
          page_count: pages.length,
        })
        .select('id')
        .single();

      if (docError || !docData) {
        console.error('[ingest] STEP 3 FAILED:', docError?.message, JSON.stringify(docError));
        return NextResponse.json(
          { error: `Document insert failed: ${docError?.message ?? 'no data'}` },
          { status: 500 }
        );
      }
      documentId = docData.id as string;
      console.log('[ingest] STEP 3 OK — document ID:', documentId);
    } catch (err) {
      const e = err as Error;
      console.error('[ingest] STEP 3 EXCEPTION:', e.message);
      return NextResponse.json({ error: `Document insert exception: ${e.message}` }, { status: 500 });
    }

    // ── Step 4: chunk ──
    const chunks = chunkPages(pages);
    console.log('[ingest] STEP 4 — chunks:', chunks.length);

    if (chunks.length === 0) {
      console.log('[ingest] DONE — no text extracted (image-only PDF?)');
      return NextResponse.json({ success: true, documentId, chunksCreated: 0 });
    }

    // ── Step 5: batch embed ──
    console.log('[ingest] STEP 5 — batch embedding', chunks.length, 'chunks...');
    let embeddings: number[][];
    try {
      embeddings = await embedTexts(chunks.map((c) => c.content));
      console.log('[ingest] STEP 5 OK — embeddings:', embeddings.length);
    } catch (err) {
      const e = err as Error;
      console.error('[ingest] STEP 5 FAILED:', e.message);
      return NextResponse.json({ error: `Embedding failed: ${e.message}` }, { status: 500 });
    }

    // ── Step 6: bulk insert chunks ──
    console.log('[ingest] STEP 6 — bulk inserting chunks...');
    const DB_BATCH = 100;
    let chunksCreated = 0;
    try {
      for (let i = 0; i < chunks.length; i += DB_BATCH) {
        const batchRows = chunks.slice(i, i + DB_BATCH).map((chunk, j) => ({
          document_id: documentId,
          // eslint-disable-next-line no-control-regex
          content: chunk.content.replace(/\x00/g, ''),
          page_number: chunk.pageNumber,
          chunk_index: chunk.chunkIndex,
          embedding: embeddings[i + j],
        }));
        const { error: insertError } = await supabase.from('chunks').insert(batchRows);
        if (insertError) {
          console.error(`[ingest] STEP 6 batch ${Math.floor(i / DB_BATCH) + 1} FAILED:`, insertError.message);
        } else {
          chunksCreated += batchRows.length;
        }
      }
      console.log('[ingest] STEP 6 OK — chunks inserted:', chunksCreated);
    } catch (err) {
      const e = err as Error;
      console.error('[ingest] STEP 6 EXCEPTION:', e.message);
    }

    console.log('[ingest] DONE —', chunksCreated, '/', chunks.length, 'chunks');
    return NextResponse.json({ success: true, documentId, chunksCreated });

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[ingest] UNHANDLED EXCEPTION:', message);
    return NextResponse.json({ error: `Ingest failed: ${message}` }, { status: 500 });
  }
}
