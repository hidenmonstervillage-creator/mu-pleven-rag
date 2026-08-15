// ── Grounding gate ────────────────────────────────────────────────────────────
//
// When retrieval misses the topic, gpt-4o answers from training knowledge behind
// real-looking citations. In the 140-run triage sweep that happened 13 times, and
// every one of those 13 retrieved same-discipline material — the citations were
// topically adjacent, never absurd. Similarity scores cannot separate them
// (AUC 0.856, and the strictest non-damaging threshold catches 3 of 13).
//
// What does separate them is how much of the ANSWER's own vocabulary appears in
// the retrieved text. Measured over the sweep: AUC 0.946, and at the operating
// point below, 11 of the 13 are caught with ZERO false refusals among the 106
// grounded answers, plus 12/13 with 0/4 on a held-out refire set.
//
// WHAT THIS GATE DOES NOT COVER — say it out loud, because it is invisible from
// the outside: the metric is Cyrillic-to-Cyrillic. About 45% of the corpus is
// English-language textbooks (197 of 439 sampled documents, 33 of 75 populated
// triples). When an answer is built from English sources the gate DECLINES to
// judge and the answer streams unchecked. A declined judgement looks exactly like
// a passed one. This protects the Bulgarian half of the library and nothing else.
// The cross-lingual alternative was evaluated and rejected for now: an English
// grounded answer scores about the same as a Bulgarian ungrounded one, so a single
// cosine threshold cannot serve both, and the only English negative in the data
// is a single run. See scratchpad/sprint/03c-crosslingual.md.
//
// Morphology: Bulgarian inflects heavily and agglutinates the definite article
// (химиотерапия → химиотерапията → химиотерапиите), so whole-token matching would
// understate overlap badly. Stems are the first 5 characters, which survives the
// common endings without colliding much at medical-vocabulary length. A character
// 4-gram variant agreed to within 0.003 AUC, which is the evidence the stemmer is
// not inventing the signal.

export interface GateConfig {
  /** Flush early, unchecked, once coverage is comfortably clear at this length. */
  earlyReleaseChars: number;
  earlyReleaseCov: number;
  /** Where the binding decision is taken. */
  decisionChars: number;
  floorCov: number;
  /** Applicability guards — below any of these the gate declines to judge. */
  minCyrillicRatio: number;
  minSourceStems: number;
  minNovelStems: number;
  minAnswerChars: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  earlyReleaseChars: 400,
  // Safe because the highest coverage any of the 13 ungrounded answers reached at
  // 400 characters was 0.542. Releases 64% of good answers at full speed.
  earlyReleaseCov: 0.70,
  decisionChars: 800,
  // 0.40 rather than 0.45: 0.45 buys one extra catch and costs the only false
  // refusal seen at this prefix. On a demo, wrongly refusing a good answer is
  // worse than missing a bad one.
  floorCov: 0.40,
  minCyrillicRatio: 0.5,
  minSourceStems: 30,
  minNovelStems: 15,
  // Honest refusals are short — the four in the sweep run 213–503 characters and
  // score 0.000–0.278, so an unguarded gate would replace gpt-4o's own contextual
  // refusal with a canned one. The shortest substantive answer in the sweep is
  // 509 characters and the shortest ungrounded one is 631, so a floor here
  // declines every short answer without shielding anything the gate targets.
  minAnswerChars: 550,
};

export type GateAction = 'wait' | 'release' | 'refuse' | 'decline';

export interface GateVerdict {
  action: GateAction;
  /** Coverage actually measured, when one was measured. */
  cov: number | null;
  novelStems: number | null;
  /** Short machine-readable reason, for logs. */
  reason: string;
}

export interface SourceProfile {
  stems: Set<string>;
  cyrillicRatio: number;
  applicable: boolean;
  reason: string;
}

const STOP = new Set(
  ('и на за с в от при се е да като по или че това които което който са не но до след преди между чрез ' +
    'също може могат има имат бъде този тази тези това всички всяка всеки техните тяхната поради така когато ако тъй само ' +
    'още най повече много друг други една един едно към над под без през около срещу освен според затова обаче докато ' +
    'където каквото тогава сега често рядко трябва бъдат били беше са били съответно например включително основно главно ' +
    'спрямо върху между тяхното своето своята техния източник източници').split(/\s+/),
);

function stemsOf(text: string): Set<string> {
  const words = (text ?? '').toLowerCase().match(/[а-яё]+/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    if (w.length >= 4 && !STOP.has(w)) out.add(w.slice(0, 5));
  }
  return out;
}

/** Built once per request from the chunks that were actually sent to the model. */
export function buildSourceProfile(
  sourceTexts: string[],
  config: GateConfig = DEFAULT_GATE_CONFIG,
): SourceProfile {
  const joined = sourceTexts.join('\n');
  const cyr = (joined.match(/[а-яё]/gi) ?? []).length;
  const lat = (joined.match(/[a-z]/gi) ?? []).length;
  const cyrillicRatio = cyr + lat === 0 ? 0 : cyr / (cyr + lat);
  const stems = stemsOf(joined);

  if (cyrillicRatio < config.minCyrillicRatio) {
    return { stems, cyrillicRatio, applicable: false, reason: 'sources are not Cyrillic' };
  }
  if (stems.size < config.minSourceStems) {
    return { stems, cyrillicRatio, applicable: false, reason: 'too little source text to judge against' };
  }
  return { stems, cyrillicRatio, applicable: true, reason: 'ok' };
}

/**
 * Fraction of the answer's content vocabulary — excluding anything the question
 * already supplied — that also appears in the sources. Subtracting the question
 * matters: an answer can echo the question without being grounded in anything.
 */
export function measureCoverage(
  answerText: string,
  questionStems: Set<string>,
  sourceStems: Set<string>,
): { cov: number; novelStems: number } {
  const answerStems = stemsOf(answerText);
  let novel = 0;
  let hit = 0;
  for (const s of Array.from(answerStems)) {
    if (questionStems.has(s)) continue;
    novel++;
    if (sourceStems.has(s)) hit++;
  }
  return { cov: novel === 0 ? 1 : hit / novel, novelStems: novel };
}

export function questionStemsOf(question: string): Set<string> {
  return stemsOf(question);
}

/**
 * The decision, called repeatedly as the answer accumulates and once more when the
 * upstream stream ends.
 *
 * Every path that is not an explicit `refuse` lets the answer through. There is no
 * state here and no I/O — the caller owns the buffer.
 */
export function evaluateGate(
  answerSoFar: string,
  streamEnded: boolean,
  profile: SourceProfile,
  questionStems: Set<string>,
  config: GateConfig = DEFAULT_GATE_CONFIG,
): GateVerdict {
  if (!profile.applicable) {
    return { action: 'decline', cov: null, novelStems: null, reason: profile.reason };
  }

  const decide = (text: string, at: string): GateVerdict => {
    const { cov, novelStems } = measureCoverage(text, questionStems, profile.stems);
    if (novelStems < config.minNovelStems) {
      return { action: 'decline', cov, novelStems, reason: `too few novel content words at ${at}` };
    }
    return cov < config.floorCov
      ? { action: 'refuse', cov, novelStems, reason: `coverage ${cov.toFixed(3)} below floor at ${at}` }
      : { action: 'release', cov, novelStems, reason: `coverage ${cov.toFixed(3)} at ${at}` };
  };

  if (!streamEnded) {
    if (answerSoFar.length >= config.decisionChars) {
      return decide(answerSoFar.slice(0, config.decisionChars), 'decision point');
    }
    if (answerSoFar.length >= config.earlyReleaseChars) {
      const slice = answerSoFar.slice(0, config.earlyReleaseChars);
      const { cov, novelStems } = measureCoverage(slice, questionStems, profile.stems);
      // Only ever an early EXIT, never an early refusal — a low score this early
      // is not evidence, it is a preamble.
      if (novelStems >= config.minNovelStems && cov >= config.earlyReleaseCov) {
        return { action: 'release', cov, novelStems, reason: `early release, coverage ${cov.toFixed(3)}` };
      }
    }
    return { action: 'wait', cov: null, novelStems: null, reason: 'accumulating' };
  }

  // The stream finished before the decision point.
  //
  // Short answers are declined rather than judged. The gate targets long, confident,
  // ungrounded answers; a short answer is usually the model refusing in its own
  // words, and overwriting that with a canned refusal would be a strict loss.
  if (answerSoFar.length < config.minAnswerChars) {
    return { action: 'decline', cov: null, novelStems: null, reason: 'answer too short to judge' };
  }

  // Between the floor and the decision point the answer is COMPLETE, so coverage is
  // measured on the whole of it — a more reliable measurement than any prefix, not
  // a less reliable one. Enforced for the same reason.
  return decide(answerSoFar.slice(0, config.decisionChars), 'stream end');
}
