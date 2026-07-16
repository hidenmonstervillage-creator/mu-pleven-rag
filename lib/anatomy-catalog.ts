// ── 3D anatomy catalog ──────────────────────────────────────────────────────
// Per-model topic map for the self-hosted GLBs. Each topic isolates one or more
// scene groups within a model.
//
// MODEL SOURCES / ATTRIBUTION (both CC BY-SA — attribution is required):
//   • AnatomyTOOL Open3DModel — CC BY-SA 4.0 (limbs, skull, skeleton, muscles).
//   • BodyParts3D, © The Database Center for Life Science, licensed under
//     CC Attribution-Share Alike 2.1 Japan (heart, brain, lungs, kidneys, liver).
//
// NAME SANITIZATION: Three's GLTFLoader rewrites node names — whitespace → "_"
// and the reserved chars []./:  are stripped (so "Arm - muscles" becomes
// "Arm_-_muscles", and a laterality suffix ".r" becomes a glued "r"). The
// catalog stores CLEAN group names; sanitizeName() converts them to the runtime
// form for matching. Matching is EXACT (never substring — "Arm - nerves" is a
// substring of "Forearm - nerves").

export interface AnatomyTopic {
  id: string;
  label: string;          // display (English/Latin for now; BG translation later)
  groups: string[];       // clean group names to isolate; empty ⇒ whole model
  region?: string;        // e.g. "Forearm" — for panel grouping + future chat mapping
  system?: string;        // e.g. "muscles"
  whole?: boolean;        // show the entire model
}

export interface AnatomyModelEntry {
  id: string;
  file: string;           // resolves to /models/<file>.glb
  label: string;          // model display name
  bodyRegion: string;     // top-level section for the browse panel
  topics: AnatomyTopic[];
}

// ── Sanitizers ────────────────────────────────────────────────────────────────

/** Mirror THREE.PropertyBinding.sanitizeNodeName: whitespace→"_", strip []./: */
export function sanitizeName(name: string): string {
  return name.replace(/\s/g, '_').replace(/[[\].:/]/g, '');
}

/** De-sanitize a structure name for display: "_"→space, resolve ".r"/".l" laterality. */
export function cleanStructureName(raw: string): string {
  let s = (raw || '').replace(/_/g, ' ').trim();
  const lat = s.match(/\.(r|l)$/i); // original glTF names carry ".r"/".l"
  if (lat) s = s.slice(0, -2).trim() + (lat[1].toLowerCase() === 'r' ? ' (R)' : ' (L)');
  return s.replace(/\s+/g, ' ').trim();
}

// ── upper-limb.glb — 43 "Region - System" groups ──────────────────────────────
// Region → the systems present for it (verified against the GLB).

const UL_REGIONS: Array<{ region: string; systems: string[] }> = [
  { region: 'Pectoral girdle', systems: ['bones', 'muscles', 'nerves', 'arteries', 'veins', 'cartilages', 'capsules, ligaments, fasciae', 'synovia, bursae'] },
  { region: 'Arm',             systems: ['bones', 'muscles', 'nerves', 'arteries', 'veins', 'cartilages', 'capsules, ligaments, fasciae', 'synovia, bursae'] },
  { region: 'Forearm',         systems: ['bones', 'muscles', 'nerves', 'arteries', 'veins', 'cartilages', 'capsules, ligaments, fasciae', 'synovia, bursae'] },
  { region: 'Hand and wrist',  systems: ['bones', 'muscles', 'nerves', 'arteries', 'veins', 'cartilages', 'capsules, ligaments, fasciae', 'synovia, bursae'] },
  { region: 'Head and neck',   systems: ['bones', 'nerves', 'arteries', 'cartilages'] },
  { region: 'Thorax',          systems: ['bones', 'nerves', 'arteries', 'veins', 'cartilages'] },
  { region: 'Back',            systems: ['bones', 'cartilages'] },
];

function upperLimbTopics(): AnatomyTopic[] {
  const topics: AnatomyTopic[] = [];
  // whole model
  topics.push({ id: 'ul-all', label: 'Upper limb — everything', groups: [], whole: true, region: 'Upper limb' });
  for (const { region, systems } of UL_REGIONS) {
    const groups = systems.map((s) => `${region} - ${s}`);
    const slug = region.toLowerCase().replace(/[^a-z]+/g, '-');
    // whole region (all systems)
    topics.push({ id: `ul-${slug}-all`, label: `${region} — all structures`, groups, region });
    // per system
    for (const s of systems) {
      topics.push({
        id: `ul-${slug}-${s.replace(/[^a-z]+/g, '-')}`,
        label: `${region} — ${s}`,
        groups: [`${region} - ${s}`],
        region,
        system: s,
      });
    }
  }
  return topics;
}

// ── Single-word system-group models (hand, lower-limb) ────────────────────────

function systemTopics(prefix: string, regionLabel: string, systems: string[]): AnatomyTopic[] {
  const topics: AnatomyTopic[] = [
    { id: `${prefix}-all`, label: `${regionLabel} — everything`, groups: [], whole: true, region: regionLabel },
  ];
  for (const s of systems) {
    topics.push({
      id: `${prefix}-${s.toLowerCase()}`,
      label: `${regionLabel} — ${s}`,
      groups: [s],
      region: regionLabel,
      system: s.toLowerCase(),
    });
  }
  return topics;
}

// ── The catalog ───────────────────────────────────────────────────────────────

export const ANATOMY_MODELS: AnatomyModelEntry[] = [
  {
    id: 'upper-limb',
    file: 'upper-limb',
    label: 'Upper limb',
    bodyRegion: 'Limbs',
    topics: upperLimbTopics(),
  },
  {
    id: 'lower-limb',
    file: 'lower-limb',
    label: 'Lower limb',
    bodyRegion: 'Limbs',
    topics: systemTopics('ll', 'Lower limb',
      ['Bones', 'Muscles', 'Nerves', 'Arteries', 'Veins', 'Cartilages', 'Ligaments', 'Fascia', 'Bursae', 'Overlays']),
  },
  {
    id: 'hand',
    file: 'hand',
    label: 'Hand',
    bodyRegion: 'Limbs',
    topics: systemTopics('hand', 'Hand',
      ['Bones', 'Muscles', 'Nerves', 'Arteries', 'Veins', 'Cartilages', 'Ligaments', 'Fascia', 'Bursae', 'Overlays']),
  },
  {
    id: 'overview-skeleton',
    file: 'overview-skeleton',
    label: 'Skeleton (overview)',
    bodyRegion: 'Skeleton',
    topics: [
      { id: 'sk-all', label: 'Whole skeleton', groups: [], whole: true, region: 'Skeleton' },
      { id: 'sk-bones', label: 'Skeleton — axial bones', groups: ['Bones'], region: 'Skeleton', system: 'bones' },
      { id: 'sk-bones-r', label: 'Skeleton — appendicular (right) bones', groups: ['Bones_right'], region: 'Skeleton', system: 'bones' },
      { id: 'sk-cart-r', label: 'Skeleton — costal cartilages (right)', groups: ['Cartilages_right'], region: 'Skeleton', system: 'cartilages' },
    ],
  },
  {
    id: 'overview-colored-skull',
    file: 'overview-colored-skull',
    label: 'Skull (coloured)',
    bodyRegion: 'Head',
    topics: [
      { id: 'skull-all', label: 'Skull — whole', groups: [], whole: true, region: 'Head' },
      { id: 'skull-bones', label: 'Skull — median/axial bones', groups: ['Bones'], region: 'Head', system: 'bones' },
      { id: 'skull-bones-r', label: 'Skull — paired (right) bones', groups: ['Bones_right'], region: 'Head', system: 'bones' },
    ],
  },
  {
    id: 'colored-skull-base',
    file: 'colored-skull-base',
    label: 'Skull base (coloured)',
    bodyRegion: 'Head',
    topics: [
      { id: 'skullbase-all', label: 'Skull base — whole', groups: [], whole: true, region: 'Head' },
      { id: 'skullbase-bones', label: 'Skull base — bones', groups: ['Bones'], region: 'Head', system: 'bones' },
    ],
  },
  {
    id: 'exploded-skull',
    file: 'exploded-skull',
    label: 'Skull (exploded view)',
    bodyRegion: 'Head',
    topics: [
      { id: 'exskull-all', label: 'Exploded skull — whole', groups: [], whole: true, region: 'Head' },
      { id: 'exskull-bones', label: 'Exploded skull — bones', groups: ['Bones'], region: 'Head', system: 'bones' },
    ],
  },
  {
    id: 'vertebrae',
    file: 'vertebrae',
    label: 'Typical vertebrae',
    bodyRegion: 'Skeleton',
    topics: [
      { id: 'vert-all', label: 'Typical vertebrae (C / T / L)', groups: [], whole: true, region: 'Spine' },
    ],
  },
  {
    // muscles-thorax-abdomen.glb — descriptive single-style groups (NOT compound
    // "Region - system"), so each group is an explicit per-group topic.
    // Confirmed: sanitizeName("Muscles of thorax") → "Muscles_of_thorax", which
    // matches the loader's runtime node names (three's PropertyBinding does the
    // same whitespace→"_" transform).
    id: 'muscles-trunk',
    file: 'muscles-trunk',
    label: 'Muscles of thorax, abdomen & back',
    bodyRegion: 'Trunk',
    topics: [
      { id: 'mtr-all',     label: 'Trunk muscles — everything', groups: [],                        whole: true, region: 'Trunk' },
      { id: 'mtr-thorax',  label: 'Muscles of thorax',          groups: ['Muscles of thorax'],     region: 'Trunk', system: 'muscles' },
      { id: 'mtr-abdomen', label: 'Muscles of abdomen',         groups: ['Muscles of abdomen'],    region: 'Trunk', system: 'muscles' },
      { id: 'mtr-back',    label: 'Muscles of back',            groups: ['Muscles of back'],       region: 'Trunk', system: 'muscles' },
      { id: 'mtr-ul',      label: 'Muscles of upper limb',      groups: ['Muscles of upper limb'], region: 'Trunk', system: 'muscles' },
      { id: 'mtr-bones',   label: 'Bones',                      groups: ['Bones'],                 region: 'Trunk', system: 'bones' },
      { id: 'mtr-fascia',  label: 'Fascia',                     groups: ['Fascia'],                region: 'Trunk', system: 'fascia' },
      { id: 'mtr-artic',   label: 'Articular system',           groups: ['Articular system'],      region: 'Trunk', system: 'articular' },
    ],
  },
  {
    // muscle-attachments.glb (insertions & origins) — descriptive single-style
    // groups → explicit per-group topics. id === file === 'muscle-attachments'
    // (keep them equal so the generated 'muscle-attachments|<group>' tokens
    // resolve via findModel). sanitizeName("Muscles of the Neck") →
    // "Muscles_of_the_Neck" etc. matches the loader's runtime node names.
    id: 'muscle-attachments',
    file: 'muscle-attachments',
    label: 'Muscle attachments (insertions & origins)',
    bodyRegion: 'Full body',
    topics: [
      { id: 'ma-all',     label: 'Muscle attachments — everything', groups: [],                        whole: true, region: 'Muscle attachments' },
      { id: 'ma-head',    label: 'Muscles of head',       groups: ['Muscles of Head'],       region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-neck',    label: 'Muscles of the neck',   groups: ['Muscles of the Neck'],   region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-back',    label: 'Muscles of back',       groups: ['Muscles of Back'],       region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-thorax',  label: 'Muscles of thorax',     groups: ['Muscles of Thorax'],     region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-abdomen', label: 'Muscles of abdomen',    groups: ['Muscles of Abdomen'],    region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-ul',      label: 'Muscles of upper limb', groups: ['Muscles of Upper limb'], region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-ll',      label: 'Muscles of lower limb', groups: ['Muscles of Lower limb'], region: 'Muscle attachments', system: 'muscles' },
      { id: 'ma-bones',   label: 'Bones and cartilages',  groups: ['Bones and cartilages'],  region: 'Muscle attachments', system: 'bones' },
    ],
  },
  {
    // heart.glb (BodyParts3D partof, CC-BY-SA 2.1 JP) — 5 non-overlapping named
    // chambers + fibrous skeleton. id === file === 'heart'. sanitizeName maps
    // "right atrium" → "right_atrium" etc. to the loader's runtime node names.
    id: 'heart',
    file: 'heart',
    label: 'Heart (chambers)',
    bodyRegion: 'Thoracic organs',
    topics: [
      { id: 'heart-all', label: 'Heart — everything', groups: [],                            whole: true, region: 'Heart' },
      { id: 'heart-ra',  label: 'Right atrium',       groups: ['right atrium'],              region: 'Heart', system: 'heart' },
      { id: 'heart-la',  label: 'Left atrium',        groups: ['left atrium'],               region: 'Heart', system: 'heart' },
      { id: 'heart-rv',  label: 'Right ventricle',    groups: ['right ventricle'],           region: 'Heart', system: 'heart' },
      { id: 'heart-lv',  label: 'Left ventricle',     groups: ['left ventricle'],            region: 'Heart', system: 'heart' },
      { id: 'heart-fs',  label: 'Fibrous skeleton',   groups: ['fibrous skeleton of heart'], region: 'Heart', system: 'heart' },
    ],
  },
  {
    // brain.glb (BodyParts3D) — major subdivisions. Dropped: whole "brain"
    // (container), "brainstem" (⊇ midbrain+pons+medulla), "hypothalamus"
    // (⊆ diencephalon) — all pure supersets/subsets that would overlap.
    id: 'brain',
    file: 'brain',
    label: 'Brain',
    bodyRegion: 'Head & neck organs',
    topics: [
      { id: 'brain-all',   label: 'Brain — everything',  groups: [],                      whole: true, region: 'Brain' },
      { id: 'brain-cer',   label: 'Cerebrum',            groups: ['cerebrum'],            region: 'Brain', system: 'brain' },
      { id: 'brain-cbl',   label: 'Cerebellum',          groups: ['cerebellum'],          region: 'Brain', system: 'brain' },
      { id: 'brain-mid',   label: 'Midbrain',            groups: ['midbrain'],            region: 'Brain', system: 'brain' },
      { id: 'brain-pons',  label: 'Pons',                groups: ['pons'],                region: 'Brain', system: 'brain' },
      { id: 'brain-med',   label: 'Medulla oblongata',   groups: ['medulla oblongata'],   region: 'Brain', system: 'brain' },
      { id: 'brain-dien',  label: 'Diencephalon',        groups: ['diencephalon'],        region: 'Brain', system: 'brain' },
      { id: 'brain-vent',  label: 'Ventricular system',  groups: ['ventricular system'],  region: 'Brain', system: 'brain' },
    ],
  },
  {
    // lungs.glb (BodyParts3D) — right/left lung. BodyParts3D "partof" has no
    // separate lobe concepts, so lobes are not offered.
    id: 'lungs',
    file: 'lungs',
    label: 'Lungs',
    bodyRegion: 'Thoracic organs',
    topics: [
      { id: 'lungs-all', label: 'Lungs — everything', groups: [],             whole: true, region: 'Lungs' },
      { id: 'lungs-r',   label: 'Right lung',         groups: ['right lung'], region: 'Lungs', system: 'lungs' },
      { id: 'lungs-l',   label: 'Left lung',          groups: ['left lung'],  region: 'Lungs', system: 'lungs' },
    ],
  },
  {
    // kidneys.glb (BodyParts3D) — right/left kidney (no cortex/medulla/pelvis
    // as separate "partof" concepts).
    id: 'kidneys',
    file: 'kidneys',
    label: 'Kidneys',
    bodyRegion: 'Abdominal organs',
    topics: [
      { id: 'kid-all', label: 'Kidneys — everything', groups: [],               whole: true, region: 'Kidneys' },
      { id: 'kid-r',   label: 'Right kidney',         groups: ['right kidney'], region: 'Kidneys', system: 'kidneys' },
      { id: 'kid-l',   label: 'Left kidney',          groups: ['left kidney'],  region: 'Kidneys', system: 'kidneys' },
    ],
  },
  {
    // liver.glb (BodyParts3D) — the two main lobes. Dropped: whole "liver"
    // (container) and "caudate lobe" (⊆ left lobe). NOTE: the lobes span ~42 of
    // the whole-liver's 60 element surfaces, so non-lobar structures (vessels,
    // bare area, porta) are not included. Quadrate lobe absent from the source.
    id: 'liver',
    file: 'liver',
    label: 'Liver (lobes)',
    bodyRegion: 'Abdominal organs',
    topics: [
      { id: 'liver-all', label: 'Liver — everything', groups: [],                       whole: true, region: 'Liver' },
      { id: 'liver-r',   label: 'Right lobe',         groups: ['right lobe of liver'],  region: 'Liver', system: 'liver' },
      { id: 'liver-l',   label: 'Left lobe',          groups: ['left lobe of liver'],   region: 'Liver', system: 'liver' },
    ],
  },
];

export function findModel(id: string): AnatomyModelEntry | undefined {
  return ANATOMY_MODELS.find((m) => m.id === id);
}
