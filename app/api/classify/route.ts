import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { FACULTIES } from '@/lib/faculties';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = 'nodejs';

interface ClassifyResult {
  faculty_id: string;
  specialty_id: string;
  subject: string;
  confidence: number;
  file_type: 'textbook' | 'lecture';
}

// Build a structured subject list for the prompt
function buildSubjectList(): string {
  const lines: string[] = [];
  for (const faculty of FACULTIES) {
    for (const specialty of faculty.specialties) {
      if (specialty.subjects.length === 0) continue;
      for (const subject of specialty.subjects) {
        lines.push(
          `- "${subject}" → faculty_id: "${faculty.id}", specialty_id: "${specialty.id}" (${faculty.name} / ${specialty.name})`
        );
      }
    }
  }
  return lines.join('\n');
}

export async function POST(req: NextRequest) {
  const body = await req.json();
  const { filename } = body as { filename: string };

  if (!filename) {
    return Response.json({ error: 'filename required' }, { status: 400 });
  }

  const subjectList = buildSubjectList();

  const prompt = `Given this Bulgarian medical textbook or lecture filename: '${filename}'

Match it to one of these subjects (use the exact string):
${subjectList}

Rules:
- file_type: use "lecture" if the filename contains words like лекция, lecture, slides, презентация, ppt; otherwise "textbook"
- confidence: 0-1 reflecting how certain you are about the subject match
- If you cannot determine the subject with confidence ≥ 0.7, still return your best guess but set confidence below 0.7

Return ONLY valid JSON with no markdown fences:
{"faculty_id":"string","specialty_id":"string","subject":"string","confidence":0.0,"file_type":"textbook"}`;

  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      max_tokens: 150,
      temperature: 0,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.choices[0]?.message?.content?.trim() ?? '';
    // Strip markdown fences if model wraps the JSON anyway
    const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    const result: ClassifyResult = JSON.parse(clean);

    // Validate that the returned subject actually exists in our list
    let valid = false;
    for (const faculty of FACULTIES) {
      for (const specialty of faculty.specialties) {
        if (
          specialty.subjects.includes(result.subject) &&
          faculty.id === result.faculty_id &&
          specialty.id === result.specialty_id
        ) {
          valid = true;
          break;
        }
      }
    }
    if (!valid) result.confidence = Math.min(result.confidence, 0.5);

    return Response.json(result);
  } catch (err) {
    console.error('[/api/classify] error:', err);
    return Response.json({ error: 'Classification failed' }, { status: 500 });
  }
}
