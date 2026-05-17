import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// Rough token estimate: 1 token ≈ 4 chars for mixed BG/EN medical text.
function estimateTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
}

// Send one batch to the OpenAI embeddings API.
// If the estimated token count exceeds 250 000 (below the 300k hard limit),
// split the batch in half and recurse until each sub-batch is safe.
async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (estimateTokens(texts) > 250_000 && texts.length > 1) {
    const mid = Math.floor(texts.length / 2);
    const left  = await embedBatch(texts.slice(0, mid));
    const right = await embedBatch(texts.slice(mid));
    return [...left, ...right];
  }

  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: texts,
  });
  return response.data
    .sort((a, b) => a.index - b.index)
    .map((item) => item.embedding);
}

// Batch embed all texts, processing at most `batchSize` chunks per API call.
// Default batch size is 50 — keeps requests well under the 300k token cap
// even for dense medical-textbook chunks (~500 tokens each → 25k tokens/batch).
export async function embedTexts(
  texts: string[],
  batchSize = 50
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await embedBatch(batch);
    allEmbeddings.push(...embeddings);
  }

  return allEmbeddings;
}
