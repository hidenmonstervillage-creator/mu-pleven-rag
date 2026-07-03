import { NextRequest } from 'next/server';
import OpenAI from 'openai';
import { createServiceClient } from '@/lib/supabase';
import { embedText } from '@/lib/embeddings';
import { ChatRequest, SourceChunk } from '@/lib/types';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const body: ChatRequest = await req.json();
  const { message, facultyId, specialtyId, subject, conversationHistory } = body;

  if (!message || !facultyId || !specialtyId || !subject) {
    return new Response(JSON.stringify({ error: 'Missing required fields' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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
    console.error('RPC error:', rpcError);
    return new Response(JSON.stringify({ error: 'Failed to retrieve context' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Step 2a: filter out low-relevance chunks (similarity < 0.2)
  // Threshold lowered from 0.3 → 0.2: text-embedding-3-small yields lower cosine
  // scores on Bulgarian text, so valid anatomy matches legitimately land ~0.25–0.28
  // and were being wrongly filtered to empty at 0.3.
  const aboveThreshold = ((rawChunks ?? []) as SourceChunk[]).filter(
    (c) => (c.similarity ?? 0) >= 0.2
  );

  // Step 2b: deduplicate by document — keep max 2 highest-scoring chunks per document
  const byDocument = new Map<string, SourceChunk[]>();
  for (const chunk of aboveThreshold) {
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
      const scores: number[] = JSON.parse(raw);

      if (Array.isArray(scores) && scores.length === preRanked.length) {
        const scored = preRanked.map((chunk, i) => ({ chunk, score: scores[i] ?? 0 }));
        scored.sort((a, b) => b.score - a.score);

        const passing = scored.filter((s) => s.score >= 6);
        const final = passing.length >= 2 ? passing : scored.slice(0, 2);
        sources = final.map((s) => s.chunk);
      }
    } catch (err) {
      // Reranking failed — fall back to pgvector order
      console.warn('Reranking failed, using pgvector order:', err);
    }
  }

  // Step 5: build context string with source labels
  const contextParts = sources.map((chunk, i) => {
    const typeLabel = chunk.file_type === 'textbook' ? 'Учебник' : 'Лекция';
    const pageLabel = chunk.page_number ? `, стр. ${chunk.page_number}` : '';
    return `[${i + 1}] ${typeLabel}: ${chunk.clean_title}${pageLabel}\n${chunk.content}`;
  });

  const context = contextParts.length > 0
    ? contextParts.join('\n\n---\n\n')
    : 'Няма намерени релевантни материали за тази тема в избрания предмет.';

  const systemPrompt = `Ти си AI академичен асистент на Медицински университет Плевен. Отговаряй ВИНАГИ на български език. Използвай САМО информацията от предоставения контекст по-долу. Не измисляй информация. Когато използваш информация от даден източник, го споменавай естествено в текста — например 'Според учебника по Анатомия (стр. 42)...' или 'Както е обяснено в лекцията по Физиология (стр. 15)...'. Отговаряй подробно и академично. Използвай само най-релевантните части от контекста. Не споменавай източници, които не са пряко свързани с въпроса.

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

  const stream = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages,
    stream: true,
    temperature: 0.3,
    max_tokens: 2000,
  });

  // Step 7: stream response with sources in the final chunk
  const encoder = new TextEncoder();

  const readableStream = new ReadableStream({
    async start(controller) {
      // First send the sources as a JSON header chunk
      const sourcesPayload = JSON.stringify({ type: 'sources', sources }) + '\n';
      controller.enqueue(encoder.encode(sourcesPayload));

      // Stream the text tokens
      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta?.content ?? '';
        if (delta) {
          const textPayload = JSON.stringify({ type: 'text', content: delta }) + '\n';
          controller.enqueue(encoder.encode(textPayload));
        }
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
}
