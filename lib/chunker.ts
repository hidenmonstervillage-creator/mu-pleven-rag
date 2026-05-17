export interface PageText {
  page: number;
  text: string;
}

export interface TextChunk {
  content: string;
  pageNumber: number;
  chunkIndex: number;
}

// Approximate token count (1 token ≈ 4 chars for mixed BG/EN text)
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// Strip null bytes and non-printable control characters that PostgreSQL rejects.
// Keeps tabs (\t), newlines (\n), carriage returns (\r); removes \0 and other C0/C1 controls.
function sanitizeText(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x00/g, '').replace(/[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ').trim();
}

// Restore word spacing lost during pdfjs-dist extraction.
// pdfjs-dist concatenates tokens without spaces in many PDFs, producing runs like
// "RegionalAnatomy•Pelvis547". This step:
//   1. Splits on bullet / middle-dot separator characters
//   2. Inserts a space at lowercase→uppercase boundaries  (e.g. "RegionalAnatomy" → "Regional Anatomy")
//   3. Inserts a space at letter↔digit boundaries          (e.g. "Pelvis547" → "Pelvis 547")
//   4. Collapses any resulting runs of whitespace
function normalizeText(text: string): string {
  return text
    // Common bullet / separator characters pdfjs-dist preserves literally
    .replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ')
    // camelCase join: lowercase followed by uppercase → insert space
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Letter → digit boundary
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    // Digit → letter boundary
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// Extract text from PDF using unpdf — no worker, safe for serverless/Vercel/Node.js
export async function extractPdfPages(buffer: Buffer): Promise<PageText[]> {
  const { extractText } = await import('unpdf');

  const uint8Array = new Uint8Array(buffer);
  const { text } = await extractText(uint8Array, { mergePages: false });

  if (Array.isArray(text)) {
    return text
      .map((pageText, index) => ({
        page: index + 1,
        text: normalizeText(sanitizeText(pageText ?? '')),
      }))
      .filter((p) => p.text.trim().length > 20);
  }

  // Fallback: single string (older unpdf versions or single-page PDFs)
  const cleaned = normalizeText(sanitizeText(text as unknown as string));
  return cleaned.trim().length > 20 ? [{ page: 1, text: cleaned }] : [];
}

// Extract text from PPTX slide by slide using officeparser
export async function extractPptxPages(buffer: Buffer): Promise<PageText[]> {
  const officeParser = await import('officeparser');

  // officeparser works with file paths or buffers; use buffer approach
  const text: string = await new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (officeParser as any).parseOffice(buffer, (data: string, err: Error) => {
      if (err) reject(err);
      else resolve(data);
    });
  });

  // officeparser joins slides with newlines — split on double newlines as slide boundary heuristic
  const slides = text.split(/\n{2,}/);
  return slides
    .map((slideText, index) => ({ page: index + 1, text: normalizeText(sanitizeText(slideText)) }))
    .filter((s) => s.text.length > 0);
}

// Split page texts into overlapping chunks of ~500 tokens with 50-token overlap
export function chunkPages(pages: PageText[], targetTokens = 500, overlapTokens = 50): TextChunk[] {
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;

  // Combine all page text into segments tagged with page numbers
  const segments: Array<{ page: number; sentence: string }> = [];
  for (const { page, text } of pages) {
    // Split into sentences/paragraphs
    const sentences = text.split(/(?<=[.!?।\n])\s+/).filter((s) => s.trim().length > 0);
    for (const sentence of sentences) {
      segments.push({ page, sentence });
    }
  }

  let i = 0;
  while (i < segments.length) {
    let tokenCount = 0;
    const chunkSegments: Array<{ page: number; sentence: string }> = [];

    // Collect segments until we hit the target token count
    while (i < segments.length && tokenCount < targetTokens) {
      chunkSegments.push(segments[i]);
      tokenCount += approxTokens(segments[i].sentence);
      i++;
    }

    if (chunkSegments.length === 0) break;

    const content = chunkSegments.map((s) => s.sentence).join(' ');
    // Use the page of the first segment as the representative page number
    const pageNumber = chunkSegments[0].page;

    chunks.push({ content, pageNumber, chunkIndex });
    chunkIndex++;

    // Step back by overlap amount
    const overlapBack = Math.ceil(overlapTokens / approxTokens(segments[i - 1]?.sentence || 'x'));
    i = Math.max(i - overlapBack, i - chunkSegments.length + 1);
    if (i <= 0) break;
  }

  return chunks;
}
