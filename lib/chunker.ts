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

// Light post-processing for non-PDF paths (PPTX) where we still lack position data.
// Replaces bullet chars and collapses whitespace.  Does NOT apply the camelCase/digit
// heuristics — those were workarounds for the old flat-concat PDF extraction.
function normalizeText(text: string): string {
  return text
    .replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Position-aware PDF text reconstruction ────────────────────────────────────
//
// unpdf's extractText (and the underlying getPageText) concatenates all text
// items with no inter-item spaces, yielding runs like "RegionalAnatomyPelvis".
// extractTextItems exposes {str, x, y, width, height, fontSize, hasEOL} per
// item so we can infer word boundaries from glyph positions:
//
//   • Same line  (|Δy| < 0.5 × lineHeight) and a visible horizontal gap
//     (x > prevRightEdge + threshold) → insert a space before the item.
//   • Different line (|Δy| ≥ 0.5 × lineHeight) → insert a space so words
//     from successive lines don't merge ("headingbody").
//   • hasEOL flag → append a space after the item.
//
// threshold is tuned to ~15 % of the current font size.  Punctuation
// (commas, periods) attached to a word has a near-zero gap and is NOT
// separated — which is the correct behaviour.

interface RawTextItem {
  str:        string;
  x:          number;
  y:          number;
  width:      number;
  height:     number;
  fontSize:   number;
  fontFamily: string;
  dir:        string;
  hasEOL:     boolean;
}

function reconstructPageText(items: RawTextItem[]): string {
  if (items.length === 0) return '';

  let result       = '';
  let prevY        : number | null = null;
  let prevRightEdge: number | null = null;
  let prevFontSize : number | null = null;

  for (const item of items) {
    const { str, x, y, width, fontSize, hasEOL } = item;
    if (!str) continue;

    if (prevY === null) {
      // Very first item — no predecessor to compare against
      result += str;
    } else {
      const yDelta   = Math.abs(y - prevY);
      const refSize  = prevFontSize ?? fontSize ?? 12;
      const lineH    = Math.max(refSize, fontSize ?? 0, 1);

      if (yDelta > lineH * 0.5) {
        // Y moved by more than half a line → new text line; emit a space so
        // "Chapter 1" on one line and "Introduction" on the next don't merge.
        result += ' ';
      } else {
        // Same line: insert a space only when there is a visible gap.
        const gap       = x - (prevRightEdge ?? x);
        const threshold = (fontSize ?? refSize) * 0.15;
        if (gap > threshold) {
          result += ' ';
        }
      }

      result += str;
    }

    // hasEOL signals an explicit end-of-line in the content stream.
    if (hasEOL) result += ' ';

    prevY         = y;
    prevRightEdge = x + width;
    prevFontSize  = fontSize || prevFontSize;
  }

  return result
    .replace(/[•·‧∙◦▪▸◾‣⁃]/g, ' ')   // bullet/separator chars → space
    .replace(/\s+/g, ' ')              // collapse all whitespace
    .trim();
}

// Extract text from PDF using unpdf's low-level extractTextItems API.
// Each page's text items carry glyph positions, allowing reconstructPageText()
// to insert spaces where the renderer would have rendered a visual gap.
export async function extractPdfPages(buffer: Buffer): Promise<PageText[]> {
  const { extractTextItems } = await import('unpdf');

  const uint8Array = new Uint8Array(buffer);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { totalPages, items } = await extractTextItems(uint8Array) as {
    totalPages: number;
    items: RawTextItem[][];
  };

  const pages: PageText[] = [];
  for (let i = 0; i < totalPages; i++) {
    const pageItems = items[i] ?? [];
    const raw       = reconstructPageText(pageItems);
    const cleaned   = sanitizeText(raw);
    if (cleaned.trim().length > 20) {
      pages.push({ page: i + 1, text: cleaned });
    }
  }
  return pages;
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
