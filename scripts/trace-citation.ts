/**
 * scripts/trace-citation.ts  —  THROWAWAY DIAGNOSTIC (read-only, no DB writes)
 * ---------------------------------------------------------------------------
 * Purpose: trace the citation-accuracy pipeline end to end for two real queries
 * and show EXACTLY what page number lands on a source card vs. what GPT writes
 * inline in the answer.
 *
 * What is REAL production code here (imported, not reimplemented):
 *   • embedText()            ← lib/embeddings.ts           (query embedding)
 *   • match_chunks RPC       ← supabase.rpc(...) same args  (retrieval)
 *
 * What is MIRRORED verbatim from app/api/chat/route.ts (that file cannot be
 * imported without modifying it, which is out of scope), with line refs:
 *   • similarity >= 0.2 filter            route.ts:49-51
 *   • max-2-chunks-per-document dedupe    route.ts:53-67
 *   • top-5 by similarity                 route.ts:69-72
 *   • gpt-4o-mini rerank (score >= 6)     route.ts:74-109
 *   • context build + system prompt       route.ts:111-125
 *   • gpt-4o answer                       route.ts:127-143   (stream:false here)
 *
 * Run:  npx tsx scripts/trace-citation.ts
 * Uses .env.local (OpenAI key + Supabase service role).
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Load .env.local into process.env BEFORE importing modules that build
//    OpenAI/Supabase clients at module-load time (lib/embeddings, lib/supabase).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
for (const raw of readFileSync(path.join(ROOT, '.env.local'), 'utf8').split('\n')) {
  const l = raw.trim();
  if (!l || l.startsWith('#')) continue;
  const eq = l.indexOf('=');
  if (eq < 0) continue;
  let v = l.slice(eq + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  process.env[l.slice(0, eq).trim()] = v;
}

// ── Deps are dynamically imported inside main() AFTER env is populated.
//    lib/embeddings + lib/supabase construct their OpenAI/Supabase clients at
//    module-load, so they must not be imported until .env.local is in env.
//    (No top-level await: tsx compiles .ts as CJS in this package.)
let embedText: (text: string) => Promise<number[]>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let openai: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let supabase: any;

// Minimal shape of a match_chunks row (mirrors lib/types.ts SourceChunk).
interface Row {
  id: string;
  content: string;
  page_number: number | null;
  document_id: string;
  clean_title: string;
  file_type: 'textbook' | 'lecture';
  storage_url: string | null;
  similarity: number;
}

const line = (ch = '─') => ch.repeat(92);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

async function trace(query: string, facultyId: string, specialtyId: string, subject: string) {
  console.log('\n\n' + line('='));
  console.log(`QUERY: ${query}`);
  console.log(`FILTER: faculty=${facultyId} | specialty=${specialtyId} | subject=${subject}`);
  console.log(line('='));

  // (a) embedding + retrieval — REAL production path
  const queryEmbedding = await embedText(query);
  console.log(`\n[a] embedText → vector(${queryEmbedding.length})`);
  console.log(`    match_chunks args: { match_faculty:"${facultyId}", match_specialty:"${specialtyId}", match_subject:"${subject}", match_count:8 }`);

  const { data, error } = await supabase.rpc('match_chunks', {
    query_embedding: queryEmbedding,
    match_faculty: facultyId,
    match_specialty: specialtyId,
    match_subject: subject,
    match_count: 8,
  });
  if (error) {
    console.error('    RPC ERROR:', error);
    return;
  }
  const rawChunks = (data ?? []) as Row[];

  // Enrich with chunk_index — match_chunks does NOT return it (see migration 0016
  // returns-table), so look it up directly for reporting.
  const idxById = new Map<string, number | null>();
  if (rawChunks.length) {
    const { data: ci } = await supabase
      .from('chunks')
      .select('id,chunk_index')
      .in('id', rawChunks.map((c) => c.id));
    for (const r of (ci ?? []) as { id: string; chunk_index: number | null }[]) idxById.set(r.id, r.chunk_index);
  }
  const ci = (id: string) => (idxById.has(id) ? idxById.get(id) : '?');

  // (b) RAW match_chunks results in rank order
  console.log(`\n[b] RAW match_chunks — ${rawChunks.length} rows (rank order):`);
  rawChunks.forEach((c, i) => {
    console.log(
      `  #${i} sim=${c.similarity.toFixed(4)} page=${c.page_number} chunk_index=${ci(c.id)} | ${c.clean_title}`
    );
    console.log(`      "${oneLine(c.content).slice(0, 180)}"`);
  });

  // ── MIRRORED route.ts:49-72 — filter, dedupe, top5 ──────────────────────────
  const aboveThreshold = rawChunks.filter((c) => (c.similarity ?? 0) >= 0.2);
  const byDocument = new Map<string, Row[]>();
  for (const chunk of aboveThreshold) {
    const docKey = chunk.document_id ?? chunk.clean_title;
    const group = byDocument.get(docKey) ?? [];
    group.push(chunk);
    byDocument.set(docKey, group);
  }
  const deduplicated: Row[] = [];
  for (const group of Array.from(byDocument.values())) {
    deduplicated.push(...group.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, 2));
  }
  const preRanked = deduplicated.sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0)).slice(0, 5);
  console.log(`\n    (filter>=0.2 → ${aboveThreshold.length}; dedupe max2/doc → ${deduplicated.length}; top5 → ${preRanked.length})`);

  // ── MIRRORED route.ts:74-109 — gpt-4o-mini rerank ───────────────────────────
  let sources: Row[] = preRanked;
  let rerankRaw = '(rerank skipped — no chunks)';
  if (preRanked.length > 0) {
    try {
      const chunkList = preRanked.map((c, i) => `[${i}] ${c.content.slice(0, 300)}`).join('\n\n');
      const rr = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        max_tokens: 100,
        temperature: 0,
        messages: [
          {
            role: 'user',
            content: `Given this question: '${query}'\nRate each of these text chunks from 0-10 for relevance to the question.\nReturn ONLY a JSON array of numbers, one per chunk, in the same order.\nExample: [8, 2, 9, 1, 5, 3, 7, 4]\n\n${chunkList}`,
          },
        ],
      });
      rerankRaw = rr.choices[0]?.message?.content?.trim() ?? '';
      // MIRRORS route.ts fix: strip ```json fence, extract first [...] array.
      const cleaned = rerankRaw.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
      const arrayMatch = cleaned.match(/\[[\s\S]*?\]/);
      const scores: number[] = JSON.parse(arrayMatch ? arrayMatch[0] : cleaned);
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
        console.warn(`    rerank unexpected shape → fallback. Raw: ${rerankRaw}`);
      }
    } catch (err) {
      console.warn('    rerank failed → fallback pgvector order:', err);
    }
  }

  // (c) reranked order
  console.log(`\n[c] RERANK (gpt-4o-mini raw="${rerankRaw}") → final ${sources.length} sources:`);
  sources.forEach((c, i) => {
    console.log(`  #${i} sim=${c.similarity.toFixed(4)} page=${c.page_number} chunk_index=${ci(c.id)} | ${c.clean_title}`);
  });

  // ── MIRRORED route.ts:111-143 — context + answer ────────────────────────────
  const contextParts = sources.map((chunk, i) => {
    const typeLabel = chunk.file_type === 'textbook' ? 'Учебник' : 'Лекция';
    // MIRRORS route.ts: page numbers withheld from the model (shown only on cards).
    return `[${i + 1}] ${typeLabel}: ${chunk.clean_title}\n${chunk.content}`;
  });
  const context = contextParts.length > 0
    ? contextParts.join('\n\n---\n\n')
    : 'Няма намерени релевантни материали за тази тема в избрания предмет.';
  const systemPrompt = `Ти си AI академичен асистент на Медицински университет Плевен. Отговаряй ВИНАГИ на български език. Използвай САМО информацията от предоставения контекст по-долу. Не измисляй информация. Основавай всяко твърдение на предоставените източници и ги посочвай по техния номер — например '[1]' или 'според източник 1', а НЕ по номер на страница. НЕ измисляй и НЕ посочвай номера на страници (стр.) в отговора си — препратките към страниците се показват отделно на студента върху картите с източници. Отговаряй подробно и академично. Използвай само най-релевантните части от контекста. Не споменавай източници, които не са пряко свързани с въпроса.

КОНТЕКСТ:
${context}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: query },
    ],
    temperature: 0.3,
    max_tokens: 2000,
  });
  const answer = completion.choices[0]?.message?.content ?? '';

  // (d) full answer
  console.log(`\n[d] FINAL ANSWER (gpt-4o):\n${line()}\n${answer}\n${line()}`);

  // (e) source-card pages — mirrors SourceCard.tsx:50-54 ("стр. {page_number}")
  console.log(`\n[e] SOURCE-CARD PAGES (what renders on each card):`);
  sources.forEach((c, i) =>
    console.log(`    card #${i}: "${c.clean_title}" → ${c.page_number ? `стр. ${c.page_number}` : '(no page shown)'}`)
  );

  // (f) inline page refs GPT wrote in the answer
  const inline = answer.match(/стр\.\s*\d+|page\s*\d+/gi) ?? [];
  console.log(`\n[f] INLINE PAGE REFS in answer: ${inline.length ? inline.join(', ') : '(none)'}`);

  // (g) top-cited chunk: full stored content + page_number
  const top = sources[0];
  if (top) {
    console.log(`\n[g] TOP-CITED CHUNK (final rank #0):`);
    console.log(`    clean_title = ${top.clean_title}`);
    console.log(`    page_number = ${top.page_number}   chunk_index = ${ci(top.id)}   chunk_id = ${top.id}`);
    console.log(`    FULL stored content:\n${line('·')}\n${top.content}\n${line('·')}`);
  }
}

async function main() {
  // Dynamic imports AFTER env is populated (see note near top).
  const emb = await import('../lib/embeddings');
  const sb = await import('../lib/supabase');
  const OpenAI = (await import('openai')).default;
  embedText = emb.embedText;
  supabase = sb.createServiceClient();
  openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Real subject strings verified against the DB (medicina/medicina).
  await trace('Какво представлява митозата и какви са нейните фази?', 'medicina', 'medicina', 'Цитология');
  await trace('Какви са морфологичните белези на острото възпаление?', 'medicina', 'medicina', 'Патоанатомия и цитопатология');

  console.log('\n\nDONE.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
