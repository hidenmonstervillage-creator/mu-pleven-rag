/**
 * scripts/ocr-coherence-judge.mjs — READ-ONLY spike diagnostic
 *
 * LLM coherence gate for the Bulgarian library OCR pipeline. Extracts one or more
 * full pages from an OCR'd PDF and asks gpt-4o-mini whether each is coherent
 * Bulgarian medical text or OCR garbage. Used to prove a repaired (image-only →
 * OCR'd) document actually contains real text, not scrambled mojibake.
 *
 * IMPORTANT: extract with `pdftotext -enc UTF-8` — the mingw pdftotext defaults to
 * a non-UTF-8 encoding that SILENTLY drops every Cyrillic byte (reads as 0% alpha).
 *
 * Usage:
 *   pdftotext -enc UTF-8 -f 64 -l 64 fixed.pdf page64.txt
 *   node scripts/ocr-coherence-judge.mjs page64.txt [more-pages.txt ...]
 *
 * Requires OPENAI_API_KEY in .env.local. Run from the repo root so `openai`
 * resolves from node_modules.
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import OpenAI from 'openai';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

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
const openai = new OpenAI({ apiKey: ENV.OPENAI_API_KEY });

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/ocr-coherence-judge.mjs <page1.txt> [page2.txt ...]');
  console.error('  (extract pages with:  pdftotext -enc UTF-8 -f N -l N fixed.pdf pageN.txt)');
  process.exit(1);
}

const PROMPT = 'Is the following coherent Bulgarian medical text, or OCR garbage ' +
  '(scrambled/nonsense words)? Reply exactly COHERENT or GARBAGE, then one sentence why.';

let anyGarbage = false;
for (const file of files) {
  const text = readFileSync(file, 'utf-8');
  const r = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    temperature: 0,
    max_tokens: 120,
    messages: [{ role: 'user', content: `${PROMPT}\n\n${text}` }],
  });
  const verdict = r.choices[0]?.message?.content?.trim() ?? '';
  if (/^GARBAGE/i.test(verdict)) anyGarbage = true;
  console.log(`\n=== ${file} ===`);
  console.log(verdict);
}

process.exit(anyGarbage ? 2 : 0); // non-zero exit if any page judged GARBAGE
