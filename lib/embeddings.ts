import OpenAI from 'openai';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rough token estimate: 1 token ≈ 4 chars for mixed BG/EN medical text.
function estimateTokens(texts: string[]): number {
  return texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
}

// ── 429 wait-time parser ──────────────────────────────────────────────────────
//
// OpenAI error messages look like:
//   "Rate limit exceeded. Please try again in 703ms."
//   "Rate limit exceeded. Please try again in 6.234s."
//
// The retry-after header (when present) contains seconds as an integer or float.
// If neither is parseable we fall back to exponential backoff: 1s, 2s, 4s, 8s, 16s.

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
// Extra buffer added to every parsed wait time so we don't hit the next window edge.
const WAIT_BUFFER_MS = 250;

function parseWaitMs(err: unknown, attempt: number): number {
  const fallback = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];

  // 1. Parse from error message body
  const msg = err instanceof Error ? err.message : '';
  const msgMatch = msg.match(/try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i);
  if (msgMatch) {
    const val = parseFloat(msgMatch[1]);
    const ms  = msgMatch[2].toLowerCase() === 'ms'
      ? Math.ceil(val)
      : Math.ceil(val * 1_000);
    return ms + WAIT_BUFFER_MS;
  }

  // 2. Parse from retry-after response header
  if (err instanceof OpenAI.APIError) {
    // The SDK exposes headers as a Headers-like object or a plain record
    const headers = err.headers as Record<string, string> | undefined;
    const raw = headers?.['retry-after'] ?? headers?.['Retry-After'];
    if (raw !== undefined && raw !== null) {
      const seconds = parseFloat(String(raw));
      if (!isNaN(seconds) && seconds > 0) {
        return Math.ceil(seconds * 1_000) + WAIT_BUFFER_MS;
      }
    }
  }

  return fallback;
}

// ── Core API call with per-batch 429 retry logic ──────────────────────────────
//
// batchNum is 1-based when called from embedTexts, 0 when called from embedText.
// On 429 the wait time is parsed from the error, logged, then slept before retry.
// Non-429 errors are re-thrown immediately (no retry).
// After MAX_RETRIES exhausted the error is re-thrown so the ingest pipeline
// records the document as failed — consistent with existing failure reporting.

const MAX_RETRIES = 5;

async function embedWithRetry(texts: string[], batchNum: number): Promise<number[][]> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const response = await openai.embeddings.create({
        model: 'text-embedding-3-small',
        input: texts,
      });
      return response.data
        .sort((a, b) => a.index - b.index)
        .map((item) => item.embedding);
    } catch (err) {
      const is429 =
        (err instanceof OpenAI.APIError && err.status === 429) ||
        (err instanceof Error && /\b429\b/.test(err.message));

      // Non-rate-limit errors propagate immediately — no point retrying.
      if (!is429) throw err;

      // Last attempt exhausted — surface to outer error handler.
      if (attempt === MAX_RETRIES - 1) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `[embeddings] batch ${batchNum} failed after ${MAX_RETRIES} retries (429): ${msg}`,
        );
      }

      const waitMs = parseWaitMs(err, attempt);
      console.log(
        `[embeddings] 429 on batch ${batchNum} — ` +
        `waiting ${waitMs}ms (retry ${attempt + 1}/${MAX_RETRIES})`,
      );
      await sleep(waitMs);
    }
  }
  // TypeScript: the loop above always returns or throws; this line is unreachable.
  throw new Error('[embeddings] unreachable');
}

// ── Token-guard split ─────────────────────────────────────────────────────────
//
// If the estimated token count exceeds 250 000 (conservative guard below the
// 300k hard limit), split in half and recurse until each sub-batch is safe.
// batchNum propagates through splits so 429 log lines stay coherent.

async function embedBatch(texts: string[], batchNum: number): Promise<number[][]> {
  if (texts.length === 0) return [];

  if (estimateTokens(texts) > 250_000 && texts.length > 1) {
    const mid   = Math.floor(texts.length / 2);
    const left  = await embedBatch(texts.slice(0, mid), batchNum);
    const right = await embedBatch(texts.slice(mid),     batchNum);
    return [...left, ...right];
  }

  return embedWithRetry(texts, batchNum);
}

// ── Public API ────────────────────────────────────────────────────────────────

// Batch embed all texts, processing at most `batchSize` chunks per API call.
// Default batch size is 50 — keeps requests well under the 300k token cap
// even for dense medical-textbook chunks (~500 tokens each → 25k tokens/batch).
//
// Inter-batch behaviour:
//   • 200ms sleep after each successful batch (proactive TPM pressure relief)
//   • On 429: parsed wait + exponential backoff, up to MAX_RETRIES per batch
export async function embedTexts(
  texts: string[],
  batchSize = 50,
): Promise<number[][]> {
  const allEmbeddings: number[][] = [];
  const totalBatches = Math.ceil(texts.length / batchSize);

  for (let i = 0; i < texts.length; i += batchSize) {
    const batchNum   = Math.floor(i / batchSize) + 1; // 1-based for log readability
    const batch      = texts.slice(i, i + batchSize);

    console.log(`[embeddings] batch ${batchNum}/${totalBatches} — ${batch.length} chunks`);
    const embeddings = await embedBatch(batch, batchNum);
    allEmbeddings.push(...embeddings);

    // Small inter-batch pause to reduce TPM pressure on the next request.
    // Skipped after the last batch — no next call to protect.
    const isLastBatch = i + batchSize >= texts.length;
    if (!isLastBatch) {
      await sleep(200);
    }
  }

  return allEmbeddings;
}

// Single-text helper used by the chat route to embed a user query.
// Also routes through embedWithRetry so query embeddings get the same
// 429 protection as ingest batches (batchNum 0 = "query" in logs).
export async function embedText(text: string): Promise<number[]> {
  const [embedding] = await embedWithRetry([text], 0);
  return embedding;
}
