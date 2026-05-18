import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const hetznerResponse = await fetch('http://178.105.161.66/upload', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.HETZNER_API_KEY ?? 'mup-upload-secret-2024',
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
