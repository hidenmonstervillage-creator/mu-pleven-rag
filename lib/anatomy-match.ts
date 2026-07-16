// ── Chat question → 3D anatomy topic matching ───────────────────────────────
// Region/system synonyms (Bulgarian + English/Latin) for high-precision matches,
// plus the generated distinctive-structure-token index for specific structures
// (e.g. "brachioradialis"). Mirrors the slide auto-suggest normalization.

import { AnatomyModelEntry, AnatomyTopic, findModel } from './anatomy-catalog';
import { STRUCTURE_TOKENS } from './anatomy-structures';

export interface AnatomyMatch {
  model: AnatomyModelEntry;
  topic: AnatomyTopic;
  label: string;
  score: number;
}

// ── Normalization (Latin diacritics + Cyrillic; light Bulgarian stemming) ─────
function normText(s: string): string {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ')
    .trim();
}
const BG_ENDINGS = ['овете', 'ищата', 'ията', 'ите', 'ята', 'ове', 'ът', 'ят', 'та', 'то', 'ето', 'ата', 'ия', 'а', 'о', 'е', 'и', 'ъ', 'я'];
function stem(w: string): string {
  for (const e of BG_ENDINGS) if (w.length > e.length + 2 && w.endsWith(e)) return w.slice(0, -e.length);
  return w;
}
function tokenMatch(qw: string, k: string): boolean {
  return qw === k || (k.length >= 4 && qw.startsWith(k)) || (qw.length >= 4 && k.startsWith(qw));
}
function toTokens(s: string): string[] {
  return normText(s).split(' ').filter((w) => w.length >= 2).map(stem);
}
// Synonyms are canonical base forms — do NOT stem them (stemming "ръка"→"рък"
// would break "ръката"). Inflection is handled by tokenMatch's symmetric prefix.
function synTokens(s: string): string[] {
  return normText(s).split(' ').filter((w) => w.length >= 2);
}
// A synonym phrase matches if every one of its (stemmed) words is present.
function phraseMatches(phraseTokens: string[], qTokens: string[]): boolean {
  return phraseTokens.length > 0 && phraseTokens.every((p) => qTokens.some((q) => tokenMatch(q, p)));
}

// ── Region synonyms → model (+ region for the multi-region upper-limb) ─────────
interface RegionDef { syn: string[]; modelId: string; region?: string; }
const REGIONS: RegionDef[] = [
  // upper limb regions (all in upper-limb.glb)
  { syn: ['forearm', 'antebrachium', 'предмишница'], modelId: 'upper-limb', region: 'Forearm' },
  { syn: ['upper arm', 'brachium', 'мишница'], modelId: 'upper-limb', region: 'Arm' },
  { syn: ['shoulder', 'pectoral girdle', 'рамо', 'раменен', 'раменния', 'раменна'], modelId: 'upper-limb', region: 'Pectoral girdle' },
  { syn: ['thorax', 'thoracic', 'гръден кош', 'торакс', 'ребра'], modelId: 'upper-limb', region: 'Thorax' },
  { syn: ['гръб', 'гърба'], modelId: 'upper-limb', region: 'Back' },
  // dedicated hand model (preferred over upper-limb "Hand and wrist")
  { syn: ['hand', 'wrist', 'carpus', 'длан', 'китка', 'ръка'], modelId: 'hand' },
  // skull / head
  { syn: ['skull base', 'cranial base', 'основа на черепа', 'черепна основа'], modelId: 'colored-skull-base' },
  { syn: ['skull', 'cranium', 'craniel', 'краниум', 'череп', 'черепен', 'черепна'], modelId: 'overview-colored-skull' },
  // lower limb (single, system-grouped)
  { syn: ['lower limb', 'leg', 'thigh', 'крак', 'долен крайник', 'бедро', 'подбедрица'], modelId: 'lower-limb' },
  { syn: ['knee', 'коляно'], modelId: 'lower-limb' },
  { syn: ['hip', 'тазобедрен', 'ханш'], modelId: 'lower-limb' },
  { syn: ['ankle', 'foot', 'глезен', 'ходило', 'стъпало'], modelId: 'lower-limb' },
  // spine / skeleton
  { syn: ['vertebra', 'vertebrae', 'прешлен'], modelId: 'vertebrae' },
  { syn: ['spine', 'spinal column', 'гръбнак', 'гръбначен', 'гръбначния стълб'], modelId: 'overview-skeleton' },
  { syn: ['skeleton', 'скелет'], modelId: 'overview-skeleton' },
  // trunk muscles (thorax / abdomen / back) — muscles-thorax-abdomen.glb
  { syn: ['trunk', 'torso', 'truncus', 'торс', 'тяло', 'гръден кош', 'корем', 'гръб', 'коремни мускули', 'гръдни мускули'], modelId: 'muscles-trunk', region: 'Trunk' },
  // muscle attachments / insertions & origins — muscle-attachments.glb
  { syn: ['muscle attachments', 'insertions', 'origins', 'залавни места', 'мускулни залавни места', 'прикрепване на мускули', 'инсерции'], modelId: 'muscle-attachments', region: 'Muscle attachments' },
  // heart chambers — heart.glb
  { syn: ['heart', 'cardiac', 'cor', 'сърце', 'сърдечен', 'предсърдие', 'камера на сърцето', 'сърдечни камери'], modelId: 'heart', region: 'Heart' },
  // organs (BodyParts3D)
  { syn: ['brain', 'cerebrum', 'encephalon', 'мозък', 'главен мозък', 'мозъчен'], modelId: 'brain', region: 'Brain' },
  { syn: ['lung', 'lungs', 'pulmo', 'бял дроб', 'бели дробове', 'дробове'], modelId: 'lungs', region: 'Lungs' },
  { syn: ['kidney', 'kidneys', 'ren', 'бъбрек', 'бъбреци'], modelId: 'kidneys', region: 'Kidneys' },
  { syn: ['liver', 'hepar', 'черен дроб', 'чернодробен'], modelId: 'liver', region: 'Liver' },
];
const REGION_TOKENS = REGIONS.map((r) => ({ ...r, synT: r.syn.map(synTokens) }));

// ── System synonyms → canonical system word ───────────────────────────────────
const SYSTEMS: Array<{ system: string; syn: string[] }> = [
  { system: 'muscles', syn: ['muscle', 'muscles', 'musculus', 'мускул', 'мускули', 'мускулатура'] },
  { system: 'bones', syn: ['bone', 'bones', 'osseous', 'кост', 'кости', 'костен', 'костна'] },
  { system: 'nerves', syn: ['nerve', 'nerves', 'nervus', 'нерв', 'нерви', 'инервация'] },
  { system: 'arteries', syn: ['artery', 'arteries', 'arteria', 'артерия', 'артерии'] },
  { system: 'veins', syn: ['vein', 'veins', 'vena', 'вена', 'вени'] },
  { system: 'cartilages', syn: ['cartilage', 'cartilages', 'хрущял', 'хрущяли'] },
  { system: 'ligaments', syn: ['ligament', 'ligaments', 'връзка', 'връзки', 'лигамент', 'лигаменти'] },
  { system: 'fascia', syn: ['fascia', 'fasciae', 'фасция', 'фасции'] },
  { system: 'heart', syn: ['heart', 'cardiac', 'сърце', 'сърдечен'] },
  { system: 'brain', syn: ['brain', 'cerebral', 'мозък', 'мозъчен'] },
  { system: 'lungs', syn: ['lung', 'lungs', 'pulmonary', 'бял дроб', 'бели дробове'] },
  { system: 'kidneys', syn: ['kidney', 'kidneys', 'renal', 'бъбрек', 'бъбреци'] },
  { system: 'liver', syn: ['liver', 'hepatic', 'черен дроб', 'чернодробен'] },
];
const SYSTEM_TOKENS = SYSTEMS.map((s) => ({ ...s, synT: s.syn.map(synTokens) }));

// Region/system synonym words (stemmed) — excluded from structure-token matching
// so generic words like "hand"/"bones" don't fire as specific-structure hits.
const SYN_WORDS = new Set<string>();
for (const grp of [...REGIONS.map((r) => r.syn), ...SYSTEMS.map((s) => s.syn)])
  for (const phrase of grp) for (const w of synTokens(phrase)) { SYN_WORDS.add(w); SYN_WORDS.add(stem(w)); }

// ── Catalog resolution helpers ────────────────────────────────────────────────
function topicForGroup(model: AnatomyModelEntry, group: string): AnatomyTopic | undefined {
  return model.topics.find((t) => t.groups.length === 1 && t.groups[0] === group);
}
function regionAllTopic(model: AnatomyModelEntry, region: string): AnatomyTopic | undefined {
  return model.topics.find((t) => t.region === region && t.groups.length > 1 && !t.whole);
}
function wholeTopic(model: AnatomyModelEntry): AnatomyTopic | undefined {
  return model.topics.find((t) => t.whole);
}
// upper-limb group suffix for a system (ligaments/fascia live in a combined group)
function ulSuffix(system: string): string {
  if (system === 'ligaments' || system === 'fascia') return 'capsules, ligaments, fasciae';
  return system;
}
function cap(s: string): string { return s[0].toUpperCase() + s.slice(1); }

function resolveTopic(model: AnatomyModelEntry, region: string | undefined, system: string | undefined): AnatomyTopic | undefined {
  if (model.id === 'upper-limb') {
    if (region && system) { const t = topicForGroup(model, `${region} - ${ulSuffix(system)}`); if (t) return t; }
    if (region) { const t = regionAllTopic(model, region); if (t) return t; }
    return wholeTopic(model);
  }
  if (system) { const t = topicForGroup(model, cap(system)); if (t) return t; }
  return wholeTopic(model);
}

// ── Public: match a chat question to up to 3 anatomy topics ───────────────────
export function matchAnatomy(question: string): AnatomyMatch[] {
  const qTokens = toTokens(question);
  if (qTokens.length === 0) return [];

  // region + system detection
  const regionHits = REGION_TOKENS.filter((r) => r.synT.some((pt) => phraseMatches(pt, qTokens)));
  const systemHit = SYSTEM_TOKENS.find((s) => s.synT.some((pt) => phraseMatches(pt, qTokens)))?.system;

  const out: AnatomyMatch[] = [];
  const seen = new Set<string>();
  const add = (model: AnatomyModelEntry | undefined, topic: AnatomyTopic | undefined, score: number) => {
    if (!model || !topic) return;
    const key = `${model.id}|${topic.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ model, topic, label: topic.label, score });
  };

  // 1) region (+ system) hits — highest precision when both present
  for (const r of regionHits) {
    const model = findModel(r.modelId);
    add(model, model && resolveTopic(model, r.region, systemHit), systemHit ? 92 : 62);
  }

  // 2) specific structure token hits
  const regionModelIds = new Set(regionHits.map((r) => r.modelId));
  for (const tok of qTokens) {
    if (SYN_WORDS.has(tok)) continue; // region/system words handled above
    const hits = STRUCTURE_TOKENS[tok];
    if (!hits) continue;
    for (const mg of hits) {
      const [modelId, group] = mg.split('|');
      const model = findModel(modelId);
      if (!model) continue;
      const topic = topicForGroup(model, group) ?? wholeTopic(model);
      add(model, topic, regionModelIds.has(modelId) ? 96 : 80);
    }
  }

  return out.sort((a, b) => b.score - a.score).slice(0, 3);
}
