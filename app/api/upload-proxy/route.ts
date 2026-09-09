import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

// Admin-only (middleware). Note: Vercel caps the request body at 4.5 MB, so
// this path only works for small files; the admin page uploads large PDFs
// directly to the tunnel with a key obtained from /api/admin/upload-target.
export async function POST(req: NextRequest) {
  const apiKey = process.env.HETZNER_API_KEY;
  if (!apiKey) return NextResponse.json({ error: 'HETZNER_API_KEY is not configured' }, { status: 503 });
  try {
    const formData = await req.formData();

    const hetznerResponse = await fetch('http://178.105.161.66/upload', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
      },
      body: formData,
    });

    const result = await hetznerResponse.json();
    return NextResponse.json(result, { status: hetznerResponse.status });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
