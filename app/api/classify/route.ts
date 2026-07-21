import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { FACULTIES } from '@/lib/faculties';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = 'nodejs';

// ── Separator that does not appear in any faculty/specialty/subject string ──────
const SEP = '||';

// ── Build the exhaustive list of canonical triples at module load time ──────────
// Each triple: "faculty_id||specialty_id||subject"
// This list is used as the JSON Schema enum, so the LLM is structurally
// forbidden from emitting any value not present here. Subject drift becomes
// a compile-time impossibility rather than a runtime hazard.

function buildTriples(): string[] {
  const out: string[] = [];
  for (const faculty of FACULTIES) {
    for (const specialty of faculty.specialties) {
      for (const subject of specialty.subjects) {
        out.push(`${faculty.id}${SEP}${specialty.id}${SEP}${subject}`);
      }
    }
  }
  return out;
}

const ALL_TRIPLES = buildTriples(); // ~250 entries, computed once

// ── System prompt (few-shot anchored) ─────────────────────────────────────────

const SYSTEM_PROMPT = `You are a classifier for Bulgarian and English medical academic filenames.

Given a filename, choose the SINGLE most appropriate canonical triple from the enum.
Each triple has the form:  faculty_id||specialty_id||subject_name

Few-shot examples:
• "Anatomiya_i_Histologia_Uchebnik.pdf"
  → triple: "medicina||medicina||Анатомия и хистология", confidence: 95, file_type: "textbook"

• "Lehninger_Principles_Of_Biochemistry_Sixth_Edition.pdf"
  → triple: "medicina||medicina||Биохимия", confidence: 88, file_type: "textbook"

• "Mikrobiologia_Lektsii_2023.pptx"
  → triple: "medicina||medicina||Микробиология", confidence: 90, file_type: "lecture"

• "Oxford_Handbook_Of_Nutrition_And_Dietetics.pdf"
  → triple: "foz||opazvane||Хранене и диететика", confidence: 82, file_type: "textbook"

• "Oxford_English_For_Careers_Nursing_Students.pdf"
  → triple: "fzg||sestra||Английски език", confidence: 75, file_type: "textbook"

Rules:
- confidence: integer 0–100 — how certain you are this triple is correct
- file_type: set to "lecture" if filename contains лекц / lecture / slides / презентац / .pptx;
  otherwise set to "textbook"
- You MUST return exactly one triple from the allowed enum — no free-form text is accepted`;

// ── POST /api/classify ─────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { filename } = body as { filename: string };

  if (!filename) {
    return Response.json({ error: 'filename required' }, { status: 400 });
  }

  try {
    // response_format uses JSON Schema with an enum constraint on `triple`.
    // OpenAI's structured-output engine guarantees the model can only emit a
    // value that is already in ALL_TRIPLES, making drift structurally impossible.
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0,
      max_tokens: 200,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Filename: "${filename}"` },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      response_format: {
        type: 'json_schema',
        json_schema: {
          name:   'classify_result',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              triple: {
                type: 'string',
                // The enum is the complete list of valid triples — the model
                // cannot output anything outside this set.
                enum: ALL_TRIPLES,
              },
              confidence: {
                // Integer 0-100, self-reported by the model
                type: 'integer',
              },
              file_type: {
                type: 'string',
                enum: ['textbook', 'lecture'],
              },
            },
            required: ['triple', 'confidence', 'file_type'],
            additionalProperties: false,
          },
        },
      } as Parameters<typeof openai.chat.completions.create>[0]['response_format'],
    });

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error('Empty response from OpenAI');

    const parsed = JSON.parse(raw) as {
      triple:     string;
      confidence: number;
      file_type:  'textbook' | 'lecture';
    };

    // Split "faculty_id||specialty_id||subject" back into three fields
    const parts = parsed.triple.split(SEP);
    if (parts.length !== 3) {
      throw new Error(`Unexpected triple format: "${parsed.triple}"`);
    }
    const [faculty_id, specialty_id, subject] = parts;

    // Defense-in-depth: if the triple somehow slipped past the enum constraint,
    // cap confidence to ≤ 0.5 so the UI forces manual review.
    const isCanonical = ALL_TRIPLES.includes(parsed.triple);
    const rawPct      = Math.min(100, Math.max(0, parsed.confidence ?? 0));

    return Response.json({
      faculty_id,
      specialty_id,
      subject,
      // LLM returns 0-100; admin UI uses a 0-1 scale (threshold: 0.7 = 70%)
      confidence: (rawPct / 100) * (isCanonical ? 1 : 0.5),
      file_type:  parsed.file_type,
    });

  } catch (err) {
    console.error('[/api/classify] error:', err);
    // Return a well-structured failure so the admin UI falls back to manual
    // selection rather than silently propagating garbage.
    return Response.json(
      {
        error:        'Auto-classification failed',
        faculty_id:   null,
        specialty_id: null,
        subject:      null,
        confidence:   0,
      },
      { status: 500 },
    );
  }
}
