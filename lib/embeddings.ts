import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export async function embedText(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return response.data[0].embedding;
}

// Batch embed up to 2048 texts in a single API call (OpenAI limit).
// Splits larger arrays into sequential batches of batchSize.
export async function embedTexts(
  texts: string[],
  batchSize = 512
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const response = await openai.embeddings.create({
      model: 'text-embedding-3-small',
      input: batch,
    });
    // Results are returned in the same order as the input
    const batchEmbeddings = response.data
      .sort((a, b) => a.index - b.index)
      .map((item) => item.embedding);
    allEmbeddings.push(...batchEmbeddings);
  }

  return allEmbeddings;
}
