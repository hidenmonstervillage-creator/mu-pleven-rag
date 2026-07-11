# CLAUDE.md — Operating instructions for MU-Pleven AI Library

Bulgarian-language RAG academic assistant (Next.js 14 + Supabase/pgvector + OpenAI). Read this first every session.
For architecture see **[PROJECT.md](./PROJECT.md)** · for the known-issues backlog see **[GAPS.md](./GAPS.md)**.

---

## Commands
```bash
npm run dev      # local dev server (Next.js)
npm run build    # production build — use this to verify TS/compile before finishing
npm run lint     # next lint (eslint-config-next)
npm start        # run the production build
```
- **There are no tests** (no runner, no test script). Do not claim tests pass. Verify changes with `npm run build` and, when relevant, the preview server.
- **Deploy = `git push origin main`** (Vercel auto-deploys; no `vercel.json`, no CI).
- **DB migrations are applied MANUALLY** in the Supabase SQL Editor. Writing a file in `supabase/migrations/` does NOT run it. Never assume the folder matches the live DB (folder starts at `0010`).

## Environment
- Secrets live in `.env.local` (not committed): `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY`, Hetzner/OlyVia values.
- Server routes use `createServiceClient()` from `lib/supabase.ts` (service-role). **The service-role client is server-only — never import it into a client component.**

## Conventions actually followed
- **Language:** All user-facing UI copy and the chat system prompt are in **Bulgarian**. Keep it that way. Brand colour is `#7B1C1C` (maroon); font Inter.
- **Routing:** App Router. API routes set `export const runtime` / `maxDuration` explicitly per route — preserve these when editing.
- **Taxonomy is string-keyed:** documents/chunks are scoped by `faculty` / `specialty` / `subject` **strings** from `lib/faculties.ts`. Renaming a taxonomy entry orphans existing rows. Treat `lib/faculties.ts` as load-bearing.
- **Chat wire format:** NDJSON frames — `{type:'sources'}`, then many `{type:'text',content}`, then `{type:'done'}`. This is a client contract in `components/ChatArea.tsx` / `app/page.tsx`. Don't change frame shapes casually.
- **Error handling:** external LLM calls (rerank) are wrapped in try/catch with graceful fallback. Match that pattern — a failed enhancement should degrade, not 500.
- **Styling:** Tailwind utility classes inline. Markdown answers render via `react-markdown` inside `prose`.

## Gotchas (things that look like they work one way but don't)
- **`tsconfig.json` has NO `target`** → downlevels to ~ES5. **Do not** use `[...map.entries()]` or `\p{…}`/`u`-flag regex — they fail to compile. Use `Array.from(map.entries())` and literal `\u` char ranges. (See GAPS #11.)
- **Retrieval is exact KNN, not HNSW.** `match_chunks` (migration `0016`) is deliberately exact after an approximate-index accuracy saga (0013→0016). Do NOT reintroduce HNSW without reading those migration comments.
- **Similarity threshold is `0.2` on purpose** (Bulgarian embeds lower than English). It is not a bug — don't "fix" it up to 0.3.
- **GLTFLoader renames nodes** (spaces→`_`, strips `[]./:`). The anatomy catalog stores sanitized names and calls `sanitizeName()`. Match against sanitized names, never raw.
- **Empty-result chat is normal for uncovered subjects.** Only ~32 of 393 subjects have documents (~8% coverage). "No answer" usually means "no content for that subject," not a bug.
- **Big uploads bypass Vercel** (browser → Hetzner tunnel → Supabase Storage). The app only handles the resulting `storageUrl`.

## Rules — do not change without care
- **DO NOT touch the in-flight uncommitted work.** These files are an active re-ingestion/extraction effort — do not edit, commit, revert, or "clean up":
  - `app/api/classify/route.ts`, `lib/chunker.ts`
  - `scripts/bulk-reingest.mjs`, `scripts/full-reingest.mjs`, `scripts/local-reingest.mjs`, `scripts/test-extraction.mjs`
  - `STATE-REPORT.md`, `coverage-report.md`
- **Commit only the specific files for the task at hand.** Never stage the in-flight files above. Use `git add <explicit paths>`, never `git add -A`/`.`.
- **End every commit message with:** `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- **Load-bearing files — edit deliberately, verify with a build:** `app/api/chat/route.ts` (tuned retrieval constants + NDJSON contract), `supabase/migrations/0016_match_chunks_exact.sql` (RPC signature is called from chat), `lib/faculties.ts` (taxonomy), `lib/embeddings.ts` + `app/api/ingest/route.ts` (chunk size/embedding model must stay consistent with stored data).
- **Generated files — don't hand-edit:** `lib/anatomy-structures.ts` (regenerate via `scripts/gen-anatomy-structures.mjs`). `STATE-REPORT.md` / `coverage-report.md` are generated snapshots (and currently stale/in-flight).
- **Two taxonomies** (`lib/faculties.ts` full, `lib/slides-faculties.ts` restricted) must stay consistent — a change in one usually needs the other.

## When adding a document (ingest flow)
1. Upload goes browser → `/api/upload-proxy` / Hetzner → Supabase Storage (returns `storageUrl`).
2. `/api/classify` suggests `{faculty, specialty, subject, confidence}` from the enum of all taxonomy triples (confidence threshold ~0.7).
3. `/api/ingest` downloads, extracts position-aware page text, `chunkPages` (~500 tokens/50 overlap), embeds in batches (429 back-off), bulk-inserts `documents` + `chunks`.

## Pointers
- **[PROJECT.md](./PROJECT.md)** — architecture, data flows, design decisions, critical vs. safe-to-change paths, gotchas (the narrative).
- **[GAPS.md](./GAPS.md)** — prioritised weaknesses (no tests, client-exposed upload key, unauthenticated admin/APIs, manual-migration drift, ingest dedup) each with a small-scoped fix.

## Library OCR pipeline — proven runbook

Facts established by repairing book one end-to-end (image-only scan → OCR → storage →
existing re-ingest → live chat-route acceptance test, all passing). Spike scripts:
`scripts/find-broken.mjs` (lists 0-chunk docs) and `scripts/ocr-coherence-judge.mjs`
(gpt-4o-mini COHERENT/GARBAGE gate). **Never modify the ingest pipeline.**

- **Language: ALWAYS `ocrmypdf -l bul+eng`.** The books are bilingual (Bulgarian +
  English on the same page). `bul`-only garbles every English block into Cyrillic
  gibberish (which also fakes a ~100% Cyrillic ratio). Confirmed on book one.
- **Benchmark: ~2.5 s/page on 8 cores** (`--force-ocr --optimize 1`). Use this to size
  the scale run.
- **Compression:** `--force-ocr` bloats output ~2.3×. Anything over ~50 MB exceeds
  Supabase's object cap — recompress with Ghostscript BEFORE upload (downsample images
  to 150 dpi, `-dPDFSETTINGS=/ebook`); the OCR text layer survives. (Book one: 84 MB → 19 MB.)
- **Windows setup:** can't write into `C:\Program Files\Tesseract-OCR\tessdata`
  (permission denied) — use a user `TESSDATA_PREFIX` and **copy Tesseract's `configs/`
  dir into it too**, or ocrmypdf dies with `read_params_file: Can't open hocr`.
- **Cyrillic extraction:** mingw `pdftotext` defaults to non-UTF-8 and **SILENTLY drops
  all Cyrillic** (looks like 0% alphabetic). Always pass `-enc UTF-8`.
- **Junk text layers:** scans may carry a ~1-char/page junk text layer — that's why
  `--force-ocr` is required (plain OCR aborts with `PriorOcrFoundError`).

### Scale architecture (decided)
Process **ONE book at a time**, deleting local scratch between books (peak local storage
~a few GB — there is no 1 TB drive):

  copy PNGs to scratch → `img2pdf` → `ocrmypdf -l bul+eng` → Ghostscript compress →
  upload PDF to storage → ingest via the **existing** pipeline → DELETE local scratch →
  checkpoint book as done → next.

- **Download MUST run on the machine with university-LAN access** — rented boxes cannot
  reach the SMB share.
- **NEVER modify the ingest pipeline.**

### Open questions (decide on-site)
1. **Permanent server-side storage for ~60–100 GB of final PDFs** — CX23 disk is too
   small; price a Hetzner Volume or Storage Box.
2. **Book → subject mapping** — classifier vs. konspekt.
3. **Retrieval performance at ~10× chunk scale** — validate before mass ingest.
