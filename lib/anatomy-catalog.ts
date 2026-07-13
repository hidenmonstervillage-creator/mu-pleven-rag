// ── 3D anatomy catalog ──────────────────────────────────────────────────────
// Per-model topic map for the self-hosted AnatomyTOOL Open3DModel GLBs
// (CC BY-SA 4.0). Each topic isolates one or more scene groups within a model.
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
];

export function findModel(id: string): AnatomyModelEntry | undefined {
  return ANATOMY_MODELS.find((m) => m.id === id);
}
