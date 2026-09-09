import { NextRequest, NextResponse } from 'next/server';
import { matchAnatomy } from '@/lib/anatomy-match';

export const dynamic = 'force-dynamic';

// ── POST /api/anatomy/suggest ────────────────────────────────────────────────
// Chat-driven 3D suggestion, evaluated server-side so lib/anatomy-match (BG
// stemmer, region/system synonym tables) and lib/anatomy-structures (the
// structure-token index) never ship to the browser. Fired by the client in
// parallel with /api/chat — the answer never waits on it.
//
// Body:  { question }
// Reply: { modelId, structureIds, matches }
//   modelId      — id of the top-ranked model (null when nothing matched)
//   structureIds — topic ids of every match, best first (max 3)
//   matches      — [{ modelId, topicId, label, score }] so the client can keep
//                  offering one chip per match, resolved against the catalog
//                  it already holds (lib/anatomy-catalog stays client-side).

const MAX_QUESTION_CHARS = 2000;

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as { question?: unknown };
  const question = typeof body.question === 'string' ? body.question.slice(0, MAX_QUESTION_CHARS) : '';
  if (!question.trim()) return NextResponse.json({ modelId: null, structureIds: [], matches: [] });

  const matches = matchAnatomy(question).map((m) => ({
    modelId: m.model.id,
    topicId: m.topic.id,
    label: m.label,
    score: m.score,
  }));
  return NextResponse.json({
    modelId: matches[0]?.modelId ?? null,
    structureIds: matches.map((m) => m.topicId),
    matches,
  });
}
