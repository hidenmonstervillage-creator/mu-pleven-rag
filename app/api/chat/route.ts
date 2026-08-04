import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { createServiceClient } from '@/lib/supabase';
import { embedText } from '@/lib/embeddings';
import { ChatRequest, SourceChunk } from '@/lib/types';
import { docsForSubject } from '@/lib/subject-coverage';
import { filterTocChunks } from '@/lib/toc-filter';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = 'nodejs';
export const maxDuration = 60;

// ── NDJSON notice ─────────────────────────────────────────────────────────────
//
// Any response this route gives — success, empty subject, or failure — has to speak
// the same frame contract the client reads (app/page.tsx, components/ChatArea.tsx):
// a sources frame, then text frames, then done. A plain JSON body hangs the reader.
// Both non-answer paths go through here so neither can drift from that shape.
function ndjsonNotice(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'sources', sources: [] }) + '\n'));
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', content: text }) + '\n'));
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
      controller.close();
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-cache' },
  });
}

// Shown when the pipeline breaks for a technical reason. Deliberately worded so a
// reader can tell it apart from the zero-coverage notice: it states the material
// EXISTS, so an outage cannot be mistaken for a gap in the library.
const TECHNICAL_FAILURE = (subject: string) =>
  `Материалите по «${subject}» са налични, но заявката не може да бъде обработена ` +
  'в момента поради временен технически проблем. Моля, опитайте отново след малко.';

export async function POST(req: NextRequest) {
  const body: ChatRequest = await req.json();
  const { message, facultyId, specialtyId, subject, conversationHistory } = body;

  if (!message || !facultyId || !specialtyId || !subject) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 0: zero-coverage short-circuit.
  //
  // Only 74 of 396 taxonomy triples have any literature. For the other 322 the
  // retrieval path cannot succeed, so we used to hand gpt-4o an empty context and
  // let the system prompt force a refusal — which meant the model PHRASED the
  // refusal itself and the wording drifted between runs. Answer deterministically
  // instead, and skip the embedding + match_chunks + generation round trips
  // entirely (~4-6s saved on a query that could never work).
  //
  // Coverage is the build-time snapshot in lib/subject-coverage.ts, keyed on the
  // full triple — subject names are not unique across faculties.
  //
  // This still has to speak the NDJSON frame contract that app/page.tsx and
  // components/ChatArea.tsx read: sources, then text, then done. Returning plain
  // JSON here would hang the client's stream reader.
  if (docsForSubject(facultyId, specialtyId, subject) === 0) {
    return ndjsonNotice(
      'Системата съдържа литературата от официалния конспект за дигитализация ' +
      `на МУ-Плевен. За «${subject}» няма индексирани материали.`,
    );
  }

  try {
  const supabase = createServiceClient();

  // Step 1: embed the user question
  const queryEmbedding = await embedText(message);

  // Step 2: retrieve top 8 relevant chunks via pgvector similarity search
  const { data: rawChunks, error: rpcError } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_faculty: facultyId,
    match_specialty: specialtyId,
    match_subject: subject,
    match_count: 8,
  });

  if (rpcError) {
    // Was a plain JSON 500, which the client's NDJSON reader cannot parse — it
    // surfaced as a dead spinner rather than a message. Same treatment as any other
    // pre-stream failure now.
    console.error('[chat] match_chunks RPC error', { facultyId, specialtyId, subject, rpcError });
    return ndjsonNotice(TECHNICAL_FAILURE(subject));
  }

  // Step 2a: filter out low-relevance chunks (similarity < 0.2)
  // Threshold lowered from 0.3 → 0.2: text-embedding-3-small yields lower cosine
  // scores on Bulgarian text, so valid anatomy matches legitimately land ~0.25–0.28
  // and were being wrongly filtered to empty at 0.3.
  const aboveThreshold = ((rawChunks ?? []) as SourceChunk[]).filter(
    (c) => (c.similarity ?? 0) >= 0.2
  );

  // Step 2a-bis: drop contents/index pages BEFORE dedupe and rerank.
  //
  // ~4.6% of the corpus is front/back matter that was chunked and embedded like
  // body text. A contents page literally IS a list of the type names, so for
  // "какви са видовете X" it both scores high on cosine similarity and reads as
  // maximally relevant to the gpt-4o-mini reranker — while explaining nothing.
  // Measured: „какви са видовете химични връзки" retrieved 3 genuine prose chunks
  // at ranks 3/5/6 and the reranker discarded all three in favour of two contents
  // pages, which became the citations.
  //
  // Filtering here (not after top-5) matters: the top-5 then backfills with prose
  // instead of shrinking. See lib/toc-filter.ts for the precision-first detector
  // and the >=3 safety floor.
  const tocFiltered = filterTocChunks(
    aboveThreshold,
    (c) => c.content,
    (c) => c.similarity ?? 0,
    3,
  );
  for (const r of tocFiltered.removed) {
    console.log(
      `[chat] dropped contents/index chunk: subject=${JSON.stringify(subject)} ` +
      `doc=${JSON.stringify(r.item.clean_title)} page=${r.item.page_number} ` +
      `sim=${(r.item.similarity ?? 0).toFixed(4)} score=${r.verdict.score} ` +
      `reasons=[${r.verdict.reasons.join('; ')}]`,
    );
  }
  if (tocFiltered.floorEngaged) {
    console.warn(
      `[chat] TOC filter hit the safety floor for subject=${JSON.stringify(subject)} — ` +
      'restored highest-similarity contents chunks to keep >=3 candidates',
    );
  }
  const contentChunks = tocFiltered.kept;

  // Step 2b: deduplicate by document — keep max 2 highest-scoring chunks per document
  const byDocument = new Map<string, SourceChunk[]>();
  for (const chunk of contentChunks) {
    const docKey = chunk.document_id ?? chunk.clean_title;
    const group = byDocument.get(docKey) ?? [];
    group.push(chunk);
    byDocument.set(docKey, group);
  }
  const deduplicated: SourceChunk[] = [];
  for (const group of Array.from(byDocument.values())) {
    const top2 = group
      .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
      .slice(0, 2);
    deduplicated.push(...top2);
  }

  // Step 2c: take top 5 overall by similarity, sorted descending
  const preRanked: SourceChunk[] = deduplicated
    .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))
    .slice(0, 5);

  // Step 3: rerank with GPT-4o-mini
  let sources: SourceChunk[] = preRanked;
  if (preRanked.length > 0) {
    try {
      const chunkList = preRanked
        .map((c, i) => `[${i}] ${c.content.slice(0, 300)}`)
        .join('\n\n');

      const rerankResponse = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `Given this question: '${message}'\nRate each of these text chunks from 0-10 for relevance to the question.\nReturn ONLY a JSON array of numbers, one per chunk, in the same order.\nExample: [8, 2, 9, 1, 5, 3, 7, 4]\n\n${chunkList}`,
          },
        ],
      });

      const raw = rerankResponse.choices[0]?.message?.content?.trim() ?? '';

      // gpt-4o-mini frequently wraps its answer in a ```json ... ``` markdown
      // fence, so a bare JSON.parse(raw) throws on every request and retrieval
      // silently falls back to raw cosine order. Strip any fence, then extract
      // the first [...] array before parsing.
      const cleaned = raw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
      const scores: number[] = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);

      // These are relevance scores (0–10), one per candidate chunk — NOT indices.
      // Duplicate scores and values above the candidate count are legitimate
      // (e.g. [6, 1, 8, 0]), so we only require an array of finite numbers whose
      // length matches the candidate list.
      const validScores =
        Array.isArray(scores) &&
        scores.length === preRanked.length &&
        scores.every((s) => typeof s === 'number' && Number.isFinite(s));

      if (validScores) {
        const scored = preRanked.map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }));
        scored.sort((a, b) => b.score - a.score);

        const passing = scored.filter((s) => s.score >= 6);
        const final = passing.length >= 2 ? passing : scored.slice(0, 2);
        sources = final.map((s) => s.chunk);
      } else {
        console.warn(
          `Rerank returned unexpected shape — using pgvector order. ` +
          `Expected ${preRanked.length} numbers, got: ${raw}`
        );
      }
    } catch (err) {
      // Parse or API failure — fall back to pgvector order, logged (not silent)
      // so a future regression is visible instead of quietly degrading ranking.
      console.warn('Reranking failed, using pgvector order:', err);
    }
  }

  // Step 5: build context string with source labels
  const contextParts = sources.map((chunk, i) => {
    const typeLabel = chunk.file_type === 'textbook' ? 'Учебник' : 'Лекция';
    // Page numbers are deliberately withheld from the model — they are shown to
    // the student only on the source cards (SourceCard.tsx). Keep the [n] label
    // so the model can still reference which source a claim came from.
    return `[${i + 1}] ${typeLabel}: ${chunk.clean_title}\n${chunk.content}`;
  });

  const context = contextParts.length > 0
    ? contextParts.join('\n\n---\n\n')
    : 'Няма намерени релевантни материали за тази тема в избрания предмет.';

  const systemPrompt = `Ти си AI академичен асистент на Медицински университет Плевен. Отговаряй ВИНАГИ на български език. Използвай САМО информацията от предоставения контекст по-долу. Не измисляй информация. Основавай всяко твърдение на предоставените източници и ги посочвай по техния номер — например '[1]' или 'според източник 1', а НЕ по номер на страница. НЕ измисляй и НЕ посочвай номера на страници (стр.) в отговора си — препратките към страниците се показват отделно на студента върху картите с източници. Отговаряй подробно и академично. Използвай само най-релевантните части от контекста. Не споменавай източници, които не са пряко свързани с въпроса.

КОНТЕКСТ:
${context}`;

  // Step 6: stream GPT-4o response
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    })),
    { role: 'user', content: message },
  ];

  // Step 7: stream response, sources FIRST
  //
  // The gpt-4o create() call used to be awaited here, before the ReadableStream was
  // constructed — so the sources frame could not leave the server until the LLM
  // connection was established. Measured cost: ~700-1000ms of dead air on every request
  // (production TTFB 1956-2836ms vs first-text 1968-2845ms — they were the same moment).
  // Opening the stream first and issuing the LLM call from inside start() lets the
  // sources frame go out as soon as retrieval + rerank finish.
  //
  // Consequence that must be handled: the response headers are now already sent when the
  // LLM call runs, so a throw can no longer become a 500. It has to be reported inside
  // the stream instead. The NDJSON frame shapes are a client contract
  // (components/ChatArea.tsx / app/page.tsx), so the failure is reported as a normal
  // `text` frame followed by `done` rather than a new frame type.
  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      // Sources go out immediately — before the LLM round trip.
      const sourcesPayload = JSON.stringify({ type: 'sources', sources }) + '\n';
      controller.enqueue(encoder.encode(sourcesPayload));

      try {
        const stream = await openai.chat.completions.create({
          model: 'gpt-4o',
          messages,
          stream: true,
          temperature: 0.3,
          max_tokens: 2000,
        });

        // Stream the text tokens
        for await (const chunk of stream) {
          const delta = chunk.choices[0]?.delta?.content ?? '';
          if (delta) {
            const textPayload = JSON.stringify({ type: 'text', content: delta }) + '\n';
            controller.enqueue(encoder.encode(textPayload));
          }
        }
      } catch (err) {
        console.error('Generation failed after headers were sent:', err);
        const msg = 'Възникна грешка при генерирането на отговора. Моля, опитайте отново.';
        controller.enqueue(encoder.encode(JSON.stringify({ type: 'text', content: msg }) + '\n'));
      }

      // Signal end
      controller.enqueue(encoder.encode(JSON.stringify({ type: 'done' }) + '\n'));
      controller.close();
    },
  });

  return new Response(readableStream, {
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-cache',
    },
  });

  } catch (err) {
    // Anything thrown BEFORE the stream opens — embedding, retrieval, rerank,
    // building the request — used to escape as an unhandled exception, which Next
    // turns into a 500 with an EMPTY body. The client's reader gets nothing and the
    // UI sits on a spinner until it dies. On 2026-08-03 an exhausted OpenAI credit
    // balance did exactly that for 22 seconds on every populated subject.
    //
    // Failures once the stream IS open are handled separately inside start().
    console.error('[chat] pre-stream failure', {
      facultyId, specialtyId, subject,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return ndjsonNotice(TECHNICAL_FAILURE(subject));
  }
}
