// ── Question → slide matching (SERVER-ONLY) ───────────────────────────────────
// Accent-tolerant, light Bulgarian stemming. Moved out of components/SlidePanel
// so the stop-list, stemmer and matcher never ship in the client bundle; the
// panel now asks /api/slides/suggest. Logic is unchanged.

import type { SubjectSlideRow } from './slides-for-subject';

const STOP = new Set([
  'и', 'на', 'за', 'от', 'с', 'в', 'до', 'по', 'при', 'към', 'или', 'ми', 'ме',
  'разкажи', 'кажи', 'какво', 'какви', 'каква', 'как', 'the', 'of', 'in', 'et',
  'and', 'a', 'an', 'tell', 'me', 'about', 'what', 'tissue', 'тъкан',
]);

export function normText(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')  // strip combining diacritics
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ')          // keep Latin, digits, Cyrillic
    .trim();
}

// Strip common Bulgarian definite-article / plural / case endings.
const BG_ENDINGS = ['овете', 'ищата', 'ията', 'ите', 'ята', 'ове', 'ът', 'ят', 'та', 'то', 'ето', 'ата', 'ия', 'а', 'о', 'е', 'и', 'ъ', 'я'];
export function stem(w: string): string {
  for (const e of BG_ENDINGS) {
    if (w.length > e.length + 2 && w.endsWith(e)) return w.slice(0, -e.length);
  }
  return w;
}

// Organ keywords are the CANONICAL base form — do NOT stem them (stemming e.g.
// "аорта" → "аор" would break matching). Inflection is handled in tokenMatch,
// where the (stemmed) query word starts-with the organ base.
function keywords(str: string): string[] {
  return normText(str).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));
}

function tokenMatch(qw: string, k: string): boolean {
  return qw === k || (k.length >= 4 && qw.startsWith(k)) || (qw.length >= 4 && k.startsWith(qw));
}

// A slide matches if a distinctive keyword (stem ≥6) of its organ or organ_bg is
// present in the question; for organs made only of short words, require all of
// them (keeps precision high — a missed suggestion is fine, a wrong one is not).
export function matchesQuestion(qWords: string[], slide: SubjectSlideRow): boolean {
  const test = (str: string) => {
    const kws = keywords(str);
    if (kws.length === 0) return false;
    const strong = kws.filter((k) => k.length >= 6);
    if (strong.length > 0) return strong.some((k) => qWords.some((qw) => tokenMatch(qw, k)));
    return kws.every((k) => qWords.some((qw) => tokenMatch(qw, k)));
  };
  return test(slide.organ_bg ?? '') || test(slide.organ ?? '');
}

// Up to 3 suggestions with distinct organ labels, in list order. Returns the
// slides' record_ids — the client already holds the rows for the subject.
export function suggestSlides(question: string, slides: SubjectSlideRow[]): number[] {
  if (!question.trim() || slides.length === 0) return [];
  const qWords = normText(question).split(' ').filter(Boolean).map(stem);
  const out: number[] = [];
  const seen = new Set<string>();
  for (const s of slides) {
    if (!matchesQuestion(qWords, s)) continue;
    const label = s.organ_bg || s.organ || s.slide_name || '';
    if (seen.has(label)) continue;
    seen.add(label);
    out.push(s.record_id);
    if (out.length >= 3) break;
  }
  return out;
}
