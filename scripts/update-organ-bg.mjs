/**
 * scripts/update-organ-bg.mjs
 *
 * For every slide:
 *   1. cleanOrgan(organ)  — strip the leftover "_#N_stain" / "- HE - N" noise so
 *      the Latin display reads cleanly ("Aorta_#50_HE" → "Aorta"). slide_name is
 *      left UNTOUCHED (it is the OlyVia reference).
 *   2. Look the cleaned core up in the approved Bulgarian dictionary (punctuation-
 *      insensitive match) → organ_bg.
 *   3. Write organ = cleaned, organ_bg = bg.
 *
 * Requires migration 0017 (slides.organ_bg). Reads .env.local. Node 18+.
 *
 * Usage:
 *   node scripts/update-organ-bg.mjs         # DRY RUN — report only, no writes
 *   node scripts/update-organ-bg.mjs --yes   # execute the updates
 */
import { readFileSync }    from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath }   from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');
const YES       = process.argv.includes('--yes');
function parseEnvFile(path) {
  let content; try { content = readFileSync(path, 'utf-8'); } catch { return {}; }
  const env = {};
  for (const raw of content.split('\n')) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('='); if (eq === -1) continue;
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    env[line.slice(0, eq).trim()] = val;
  }
  return env;
}
const ENV = parseEnvFile(resolve(ROOT, '.env.local'));
const U = ENV.NEXT_PUBLIC_SUPABASE_URL, K = ENV.SUPABASE_SERVICE_ROLE_KEY;

async function sb(path, opts = {}) {
  const res = await fetch(`${U}/rest/v1${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', apikey: K, Authorization: `Bearer ${K}`, ...(opts.headers ?? {}) },
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: res.ok, status: res.status, data, text };
}

// ── Noise stripping ───────────────────────────────────────────────────────────
const STAIN = String.raw`HE|НЕ|НE|HЕ|H&E|PAS|Azan|VG|Van\s+Gieson|Orcein|Giemsa|Gimsa|Congo\s*R(?:ed)?|Methyl\s+violet|Perls|Pearls|Alcian\s+blue|Mucicarmine|Sudan\s+III|AgNO3|Ag|Au|FeH|OsO4|Nissl|Schmorl|PAF|Alkaline\s+Phosphatase|MethylGreen-?Pironin`;
const NUM = String.raw`\d+\s*[a-zа-я]?`;
const DEM = String.raw`dem\.?|demonstration|revision|TBC|stain`;
const SEP = String.raw`[\s\-–—,\/&\.]+`;
const TAIL = new RegExp(`(?:${SEP}(?:${STAIN}|${NUM}|${DEM}))+\\s*$`, 'i');

function cleanOrgan(raw) {
  let s = (raw || '').trim();
  // Anatomy underscore/hash form: take the core before konspekt/number/stain.
  const anat = s.match(/^(.*?)(?:_#|_\d|#\d)/s);
  if (anat && anat[1].trim()) {
    return anat[1].replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
  }
  // Pathology: repeatedly peel the trailing stain/number/dem noise block.
  let prev;
  do { prev = s; s = s.replace(TAIL, '').trim(); } while (s !== prev);
  return s.replace(/[\s\-–—,\/&\.]+$/, '').trim();
}

// Punctuation-insensitive key so cleaned cores match dictionary keys robustly.
function norm(s) {
  return (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// ── Approved Bulgarian dictionary (readable keys; matched via norm()) ─────────
const DICT_RAW = {
  // Anatomy / normal histology
  'Aorta': 'Аорта',
  'Appendix': 'Апендикс',
  'Arteria et vena': 'Артерия и вена',
  'Blood': 'Кръв',
  'Bone marrow': 'Костен мозък',
  'Cavum nasi': 'Носна кухина',
  'Cerebellum': 'Малък мозък',
  'Cerebrum': 'Краен мозък',
  'Cor': 'Сърце',
  'Heart': 'Сърце',
  'Cornea': 'Роговица',
  'Cutis-FP': 'Кожа (длан/ходило — дебела кожа)',
  'Ductus deferens': 'Семеотвеждащ канал',
  'Duodenum': 'Дванадесетопръстник',
  'Epiglottis': 'Надгръклянник (епиглотис)',
  'Epiphysis': 'Епифиза (пинеална жлеза)',
  'Funiculus umbilicalis': 'Пъпна връв',
  'Ganglion spinale': 'Гръбначномозъчен ганглий',
  'Gaster-Fundus': 'Стомах (фундус)',
  'Gaster-Pylorus': 'Стомах (пилор)',
  'Glandula mammaria': 'Млечна жлеза',
  'Glandula mammaria-Lac': 'Млечна жлеза (лактираща)',
  'Glandula parotis': 'Околоушна (паротидна) жлеза',
  'Glandula sublingualis': 'Подезична жлеза',
  'Glandula submandibularis': 'Подчелюстна жлеза',
  'Glandula suprarenalis': 'Надбъбречна жлеза',
  'Glandula thyroidea': 'Щитовидна жлеза',
  'Hepar': 'Черен дроб',
  'Liver': 'Черен дроб',
  'Hypoderma': 'Подкожие (хиподерма)',
  'Hypophysis': 'Хипофиза',
  'Intestinum crassum': 'Дебело черво',
  'Large intestine': 'Дебело черво',
  'Intestinum tenue': 'Тънко черво',
  'Small intestine': 'Тънко черво',
  'Kidney': 'Бъбрек',
  'Ren': 'Бъбрек',
  'Labium': 'Устна',
  'Larynx': 'Гръклян (ларинкс)',
  'Lien': 'Далак',
  'Spleen': 'Далак',
  'Lingua': 'Език',
  'Lung': 'Бял дроб',
  'Pulmo-Adult': 'Бял дроб (възрастен)',
  'Pulmo-Embryo': 'Бял дроб (ембрионален)',
  'Lymph node': 'Лимфен възел',
  'Nodus lymphaticus': 'Лимфен възел',
  'Medulla spinalis': 'Гръбначен мозък',
  'Spinal cord': 'Гръбначен мозък',
  'Nervus': 'Нерв',
  'Oculus': 'Око',
  'Oesophagus': 'Хранопровод',
  'Omentum majus': 'Голямо було (оментум)',
  'Os': 'Кост',
  'Ovarium': 'Яйчник',
  'Ovary': 'Яйчник',
  'Pancreas': 'Панкреас (задстомашна жлеза)',
  'Pancreras': 'Панкреас (задстомашна жлеза)',
  'Penis': 'Полов член (пенис)',
  'Placenta': 'Плацента',
  'Prostata': 'Простата',
  'Brain': 'Главен мозък',
  'Tendo': 'Сухожилие',
  'Testis': 'Тестис (семенник)',
  'Thymus': 'Тимус',
  'Tonsila': 'Сливица (тонзила)',
  'Trachea': 'Трахея (дихателна тръба)',
  'Tuba uterina': 'Маточна тръба (Фалопиева)',
  'Ureter': 'Пикочопровод (уретер)',
  'Uterus': 'Матка',
  'Vagina': 'Влагалище',
  'Vesica fellea': 'Жлъчен мехур',
  'Vesica urinaria': 'Пикочен мехур',

  // Pathology
  '"Foreign body" granuloma': 'Гранулом от чуждо тяло',
  '"Ball and ring" haemorrhages of the brain': 'Кълбовидни и пръстеновидни кръвоизливи в мозъка',
  'Actinomycosis': 'Актиномикоза',
  'Acute fibrinous pericarditis': 'Остър фибринозен перикардит',
  'Acute perivascular encephalitis': 'Остър периваскуларен енцефалит',
  'Acute phlegmonous appendicitis': 'Остър флегмонозен апендицит',
  'Acute purulent nephritis pyelonephritis': 'Остър гноен нефрит/пиелонефрит',
  'Acute pyogenic meningitis': 'Остър гноен менингит',
  'Adenocarcinoma of colon': 'Аденокарцином на дебелото черво',
  'Adenocarcinoma of the large bowel': 'Аденокарцином на дебелото черво',
  'Adenomatous hyperplasia of endometrial mucosa': 'Аденоматозна хиперплазия на ендометриума',
  'Advanced gastric cancer-diffuse type – signed ring cell': 'Напреднал стомашен карцином, дифузен (пръстеновидноклетъчен)',
  'Allergic nasal polyp': 'Алергичен носен полип',
  'Amyloidosis of kidney': 'Амилоидоза на бъбрека',
  'Anthracosis of the lung': 'Антракоза на белия дроб',
  'Atherosclerotic plaque of the aorta': 'Атеросклеротична плака на аортата',
  'Bacterial myocarditis': 'Бактериален миокардит',
  'Basal cell carcinoma of the skin': 'Базалноклетъчен карцином на кожата',
  "Brenner's tumour": 'Тумор на Бренер',
  'Brown induration of the lung': 'Кафява индурация на белия дроб',
  'Calc deposition in atheromatous plaque': 'Калциеви отлагания в атероматозна плака',
  'Caseous necrosis of the lymph node': 'Казеозна некроза на лимфен възел',
  'Caseous tuberculous lymphadenitis': 'Казеозен туберкулозен лимфаденит',
  'Caseous tuberculous pneumonia – lung': 'Казеозна туберкулозна пневмония (бял дроб)',
  'Cavernous hemangioma of liver': 'Кавернозен хемангиом на черния дроб',
  'Cervical adenomatous polypus': 'Аденоматозен полип на маточната шийка',
  'Chondroma': 'Хондром',
  'Choriocarcinoma': 'Хориокарцином',
  'Chronic atrophic gastritis': 'Хроничен атрофичен гастрит',
  'Chronic congestion in the liver': 'Хронична венозна конгестия на черния дроб',
  'Chronic congestion of the liver': 'Хронична венозна конгестия на черния дроб',
  'Chronic congestion of the lung': 'Хронична венозна конгестия на белия дроб',
  'Chronic gastric ulcer': 'Хронична стомашна язва',
  'Chronic gastritis-Helicobacter Pylori': 'Хроничен гастрит (Helicobacter pylori)',
  'Chronic lymphocytic leukaemia – liver': 'Хронична лимфоцитна левкемия (черен дроб)',
  'Chronic myelogenous leukaemia – liver': 'Хронична миелоидна левкемия (черен дроб)',
  'Chronic pyelonephritis': 'Хроничен пиелонефрит',
  'Chronic viral hepatitis': 'Хроничен вирусен хепатит',
  'Cirrhosis of the liver': 'Чернодробна цироза',
  'Coagulative necrosis of the heart': 'Коагулационна некроза на сърцето',
  'Complete hydatiform mole': 'Пълна гроздовидна бременност (мола хидатидоза)',
  'Diabetes mellitus – diabetic nephropathy – kidney': 'Захарен диабет – диабетна нефропатия (бъбрек)',
  'Diffuse large B-cell lymphoma (DLBL )': 'Дифузен едроклетъчен B-клетъчен лимфом',
  'Diffuse pattern in leiomyoma': 'Дифузен строеж на леомиом',
  'Dysplastic changes in uterine cervix': 'Дисплазия на маточната шийка',
  'Endometrial adenocarcinoma': 'Аденокарцином на ендометриума',
  'Endometriosis of the uterus': 'Ендометриоза на матката',
  'Fat necrosis': 'Мастна некроза',
  'Fatty changes (steatosis) of the liver': 'Мастна дистрофия (стеатоза) на черния дроб',
  'Fibrino-purulent peritonitis': 'Фибринозно-гноен перитонит',
  'Fibrinoid necrosis - peptic ulcer - stomach': 'Фибриноидна некроза – пептична язва на стомаха',
  'Fibrinous pericarditis': 'Фибринозен перикардит',
  'Fibrinous pneumonia (crupous)': 'Фибринозна (крупозна) пневмония',
  'Fibroadenoma of the breast': 'Фиброаденом на млечната жлеза',
  'Fibrocystic disease of the breast': 'Фиброкистична болест на млечната жлеза',
  'Fibroma of the ovary': 'Фибром на яйчника',
  'Focal serous pneumonia': 'Огнищна серозна пневмония',
  'Follicular hyperplasia of lymph node': 'Фоликуларна хиперплазия на лимфен възел',
  'GIST gastro-intestinal stromal tumor': 'Гастроинтестинален стромален тумор (GIST)',
  'Glioblastoma': 'Глиобластом',
  'Granulation tissue': 'Гранулационна тъкан',
  'Granulomatous lymphadenitis – cat-scratch disease': 'Грануломатозен лимфаденит (котешко одраскване)',
  'Granulomatous orchitis': 'Грануломатозен орхит',
  "Grave's disease -diffuse toxic goitre": 'Базедова болест (дифузна токсична гуша)',
  "Hashimoto's thyroiditis": 'Тиреоидит на Хашимото',
  'Hashimoto’s thyroiditis': 'Тиреоидит на Хашимото',
  'Hematogenous metastasis of adenocarcinoma in brain': 'Хематогенна метастаза на аденокарцином в мозъка',
  'Hemorrhages of the brain (type hematoma)': 'Мозъчен кръвоизлив (тип хематом)',
  'Hemorrhagic pulmonary infarction': 'Хеморагичен белодробен инфаркт',
  'Hepatocellular carcinoma': 'Хепатоцелуларен карцином',
  "Hodgkin's disease – nodular sclerosis": 'Болест на Ходжкин (нодуларна склероза)',
  'Hyaline changes in corpus albicans of the ovary': 'Хиалинни промени в corpus albicans на яйчника',
  'Hyaline changes in renal arterioles': 'Хиалинни промени в бъбречните артериоли',
  'Hyperplasia of endometrial mucosa': 'Хиперплазия на ендометриума',
  'Hypertrophy of heart': 'Хипертрофия на сърцето',
  'Idiopathic (multinucleated giant cell type) myocarditis': 'Идиопатичен гигантоклетъчен миокардит',
  "Immunohistochemical staining of tumour breast cell's receptors - ER": 'ИХХ – естрогенни рецептори (ER) при карцином на млечната жлеза',
  "Immunohistochemical staining of tumour breast cell's receptors - HER2": 'ИХХ – HER2 рецептори при карцином на млечната жлеза',
  'Interstitial non-specific myocarditis': 'Интерстициален неспецифичен миокардит',
  'Interstitial nonspecific myocarditis': 'Интерстициален неспецифичен миокардит',
  'Intradermal pigmented nevus': 'Интрадермален пигментен невус',
  'Invasive ductal carcinoma – NOS': 'Инвазивен дуктален карцином (NOS)',
  'Invasive lobular carcinoma': 'Инвазивен лобуларен карцином',
  'Ischemic renal infarction': 'Исхемичен бъбречен инфаркт',
  'Jaundice (icterus) of the liver': 'Иктер (жълтеница) на черния дроб',
  "Krukenberg's tumour": 'Тумор на Крукенберг',
  'Leiomyoma of the uterus': 'Леомиом на матката',
  'Uterine leiomyoma': 'Леомиом на матката',
  'Leiomyosarcoma': 'Леомиосарком',
  'Lipoma': 'Липом',
  'Lipomatosis of the heart': 'Липоматоза на сърцето',
  'Liposarcoma': 'Липосарком',
  'Liquefactive necrosis of the brain': 'Колликвационна некроза на мозъка',
  'Lobular pneumonia with abscess formation': 'Лобуларна пневмония с абсцес',
  'Lymph node metastasis of adenocarcinoma': 'Метастаза на аденокарцином в лимфен възел',
  'Malignant melanoma': 'Малигнен меланом',
  'MALT type B-cell lymphoma of the stomach': 'MALT B-клетъчен лимфом на стомаха',
  'Massive necrosis of the liver': 'Масивна чернодробна некроза',
  'Meningioma': 'Менингиом',
  'Micronodular cirrhosis of the liver': 'Микронодуларна чернодробна цироза',
  'Miliary tuberculosis of lung': 'Милиарна туберкулоза на белия дроб',
  'Mixed thrombus': 'Смесен тромб',
  'Mucinous borderline tumor': 'Муцинозен граничен (borderline) тумор',
  'Mucinous carcinoma of the stomach': 'Муцинозен карцином на стомаха',
  'Mucinous cystadenoma of the ovary': 'Муцинозен цистаденом на яйчника',
  'Ovary mucinous cystadenoma': 'Муцинозен цистаденом на яйчника',
  'Mucoviscidosis -cystic fibrosis of the pancreas': 'Муковисцидоза (кистозна фиброза) на панкреаса',
  'Myocardial infarction': 'Миокарден инфаркт',
  'Myocardial scar': 'Миокарден цикатрикс (белег)',
  'Neonatal respiratory distress syndrome  /RDS/ - lung': 'Неонатален респираторен дистрес синдром (бял дроб)',
  'Nested pattern in basal cell carcinoma': 'Гнездови строеж на базалноклетъчен карцином',
  'Neurinoma': 'Невринома (шваном)',
  'Non-invasive intraductal carcinoma /in  situ/ - DCIS comedo type': 'Неинвазивен интрадуктален карцином (DCIS, комедо тип)',
  'Non-toxic nodular colloid goitre': 'Нетоксична нодуларна колоидна гуша',
  'Organizing and recanalizing thrombus': 'Организиращ се и реканализиращ тромб',
  'Osteosarcoma': 'Остеосарком',
  'Pigmented nevus': 'Пигментен невус',
  'Plasmocytoma (extramedullary)': 'Плазмоцитом (екстрамедуларен)',
  'Prostate hypertrophy': 'Хиперплазия на простатата',
  'Prostatic hyperplasia.': 'Хиперплазия на простатата',
  'Prostatic carcinoma': 'Карцином на простатата',
  'Pulmonary edema': 'Белодробен оток',
  'Pulmonary emphysema': 'Белодробен емфизем',
  'Purulent nephritis': 'Гноен нефрит',
  'Renal cell carcinoma': 'Бъбречноклетъчен карцином',
  'Sarcoidosis of lymph  node': 'Саркоидоза на лимфен възел',
  'Seminoma of the testis': 'Семином на тестиса',
  'Seminomaof the testis.': 'Семином на тестиса',
  'Serous papillary adenocarcinoma of theovary': 'Серозен папиларен аденокарцином на яйчника',
  'Serous papillary cystadenoma of the ovary': 'Серозен папиларен цистаденом на яйчника',
  'Silicosis of lung': 'Силикоза на белия дроб',
  'Small cell carcinoma of the lung': 'Дребноклетъчен карцином на белия дроб',
  'Spontaneus abortion': 'Спонтанен аборт',
  'Squamous cell  cervical carcinoma': 'Плоскоклетъчен карцином на маточната шийка',
  'Squamous cell carcinoma of the lung': 'Плоскоклетъчен карцином на белия дроб',
  'Squamous cell carcinoma of the skin': 'Плоскоклетъчен карцином на кожата',
  'Squamous cell carcinomaof the penis.': 'Плоскоклетъчен карцином на пениса',
  'Squamous metaplasia in endocervix': 'Плоскоклетъчна метаплазия в ендоцервикса',
  'Squamous papilloma': 'Плоскоклетъчен папилом',
  'Steatonecrosis of the pancreas': 'Стеатонекроза на панкреаса',
  'Subacute glomerulonephritis': 'Подостър гломерулонефрит',
  'Teratoma of the ovary': 'Тератом на яйчника',
  'Thyroid papillary adenocarcinoma': 'Папиларен аденокарцином на щитовидната жлеза',
  'Tuberculosis miliaris renis': 'Милиарна туберкулоза на бъбрека',
  'Tuberculous  granuloma': 'Туберкулозен гранулом',
  'Tuberculous meningitis': 'Туберкулозен менингит',
  'Urothelial carcinoma': 'Уротелен карцином',
  'Viral pneumonia': 'Вирусна пневмония',
};

const DICT = new Map(Object.entries(DICT_RAW).map(([k, v]) => [norm(k), v]));
function lookupBg(cleaned) { return DICT.get(norm(cleaned)) ?? null; }

async function main() {
  console.log('\n══════════════════════════════════════════════════════════════');
  console.log(`  update-organ-bg  ${YES ? '(EXECUTE)' : '(DRY RUN)'}`);
  console.log('══════════════════════════════════════════════════════════════');

  const sel = await sb('/slides?select=id,record_id,organ&limit=2000');
  if (!sel.ok) { console.error('✗ fetch slides:', sel.status, sel.text.slice(0, 200)); process.exit(1); }
  const slides = sel.data;
  console.log(`Fetched ${slides.length} slides.\n`);

  let populated = 0;
  const blanks = [];
  const cleanedByRecord = new Map();

  for (const s of slides) {
    const cleaned = cleanOrgan(s.organ);
    const bg = lookupBg(cleaned);
    cleanedByRecord.set(s.record_id, { cleaned, bg });
    if (bg) populated++; else blanks.push({ record_id: s.record_id, organ: s.organ, cleaned });
  }

  console.log(`Would populate organ_bg: ${populated}/${slides.length}`);
  console.log(`Blank (no dictionary match): ${blanks.length}\n`);
  if (blanks.length) {
    console.log('── BLANKS (record_id | raw organ → cleaned) ───────────────────');
    const seen = new Set();
    for (const b of blanks) {
      const key = b.cleaned;
      if (seen.has(key)) continue; seen.add(key);
      console.log(`  [${b.record_id}] "${b.organ}"  →  cleaned: "${b.cleaned}"`);
    }
  }

  if (!YES) {
    console.log('\n(dry run — re-run with --yes to write. Requires migration 0017.)');
    return;
  }

  // Verify organ_bg column exists before writing.
  const probe = await sb('/slides?select=organ_bg&limit=1');
  if (!probe.ok && /organ_bg/i.test(probe.text)) {
    console.error('\n✗ slides.organ_bg does not exist — apply migration 0017 first. Aborting.');
    process.exit(1);
  }

  console.log('\nWriting organ (cleaned) + organ_bg …');
  let done = 0;
  for (const s of slides) {
    const { cleaned, bg } = cleanedByRecord.get(s.record_id);
    const body = { organ: cleaned, organ_bg: bg };
    const r = await sb(`/slides?id=eq.${s.id}`, {
      method: 'PATCH', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(body),
    });
    if (!r.ok) { console.error(`  ✗ ${s.record_id}: ${r.status} ${r.text.slice(0, 120)}`); continue; }
    done++;
    if (done % 40 === 0 || done === slides.length) process.stdout.write(`  ${done}/${slides.length}\r`);
  }
  console.log(`\n✓ Updated ${done} slides. organ_bg populated: ${populated}, blank: ${blanks.length}`);
}
main().catch((e) => { console.error('\n✗ Fatal:', e.message); process.exit(1); });
