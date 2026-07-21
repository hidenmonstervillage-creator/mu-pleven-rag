# GAPS.md — Honest weakness audit

> Ordered most-severe first. Each gap: **what**, **where**, **why it matters**, and a **small-scoped fix** a less-capable model can execute as one isolated task.
> Severity flags: 🔴 critical · 🟠 high · 🟡 medium · ⚪ low. Security items are tagged **[SEC]**.

---

## 🔴 1. No tests. None. No framework.
- **What:** `package.json` has only `dev/build/start/lint`. There is no test runner, no test files, no CI. Every retrieval constant, the NDJSON stream contract, chunking, and classification are unverified by anything but manual clicking.
- **Where:** whole repo; `package.json` scripts.
- **Why it matters:** The load-bearing logic (`app/api/chat/route.ts` filtering/dedupe/rerank, `lib/chunker.ts` chunk boundaries, `lib/cleaner.ts` filename cleaning) can regress with zero signal. A one-line change to the similarity threshold or the rerank cutoff silently degrades every answer.
- **Small-scoped fix:** Add Vitest (`npm i -D vitest`) and one pure-function test file. Start with `lib/cleaner.ts` — `cleanFilename` is pure and easy: assert `GRAY'S~1.PDF` → cleaned title, hex-hash stripping, `--`-tail removal. This establishes the harness without touching runtime code. Add `"test": "vitest run"` to scripts.

## 🔴 2. [SEC] Upload API key is shipped to the browser
- **What:** `app/admin/page.tsx` uses `NEXT_PUBLIC_HETZNER_API_KEY ?? 'mup-upload-secret-2024'` and sends it as `x-api-key` directly from client JS to the Hetzner upload endpoint. Anything `NEXT_PUBLIC_*` is in the client bundle; the fallback secret is hardcoded in source.
- **Where:** `app/admin/page.tsx:13-14` (and the XHR wrapper `:50`), `app/api/upload-proxy/route.ts`.
- **Why it matters:** Anyone who opens the admin page (or reads the JS bundle) obtains the upload key and can push arbitrary files to the storage backend. The hardcoded default means even without the env var set, the key is public in git history.
- **Small-scoped fix:** Route *all* uploads through the server-side `/api/upload-proxy` (which already exists) using a **non-`NEXT_PUBLIC`** `HETZNER_API_KEY`, and delete the client-side key + hardcoded fallback. Rotate the key afterward. (Scope: swap the client XHR target to the proxy, drop the two constants.)

## 🔴 3. [SEC] No authentication on `/admin` or the write APIs
- **What:** There is no `middleware.ts` and no auth check in `app/admin/page.tsx`, `/api/ingest`, `/api/classify`, or `/api/upload-proxy`. The admin console and every content-mutating endpoint are open to anyone who knows the URL.
- **Where:** `app/admin/page.tsx`, `app/api/ingest/route.ts`, `app/api/classify/route.ts`, `app/api/upload-proxy/route.ts` (no auth guard anywhere).
- **Why it matters:** Unauthenticated users can ingest documents, spend OpenAI embedding budget, and pollute the library. `/api/chat` is likewise open — unmetered gpt-4o cost exposure.
- **Small-scoped fix:** Add a single `middleware.ts` that gates `/admin` and `/api/(ingest|classify|upload-proxy)` behind a shared secret header or Supabase auth session, returning 401 otherwise. One new file; no route logic changes.

## 🟠 4. Manual migrations = schema drift with no guardrail
- **What:** Migrations are applied by hand in the Supabase SQL Editor. The folder starts at `0010` (0001–0009 not in repo), so the files are not a complete or authoritative schema. No `schema.sql` snapshot exists.
- **Where:** `supabase/migrations/0010–0017`.
- **Why it matters:** A new environment cannot be rebuilt from the repo. Two developers can diverge. A migration can be forgotten or applied out of order with no error until retrieval breaks.
- **Small-scoped fix:** Add `supabase/schema.sql` — a `pg_dump --schema-only` snapshot of the live DB — and a `README` note that it is the source of truth. Read-only export; no runtime change.

## 🟠 5. [SEC] Hardcoded upstream credentials and IPs
- **What:** OlyVia proxy embeds default microscope credentials (guest login / password) and a hardcoded upstream `194.141.67.249:8085` over plain HTTP; Hetzner IP `178.105.161.66` / tunnel URL is likewise hardcoded with a secret default.
- **Where:** `app/api/olyvia/[...path]/route.ts`, `app/admin/page.tsx:10-14`.
- **Why it matters:** Credentials in source leak via git history; plain-HTTP upstreams are interceptable; hardcoded IPs break silently when the upstream moves (the Hetzner URL is a rotating `trycloudflare.com` tunnel).
- **Small-scoped fix:** Move all four values (OlyVia host, OlyVia creds, Hetzner URL, Hetzner key) into env vars with no hardcoded fallbacks; fail loudly if unset. Pure config extraction.

## 🟠 6. Ingestion has no dedup / idempotency guard
- **What:** `/api/ingest` inserts a new `documents` row every time; nothing checks whether the same file/title already exists. Health-check tooling found multiple duplicate titles (same textbook ingested repeatedly), some cross-subject.
- **Where:** `app/api/ingest/route.ts` (insert path); evidence in `coverage-report.md` / dedupe scripts (`scripts/dedupe-cytology.mjs`).
- **Why it matters:** Duplicates inflate chunk counts, waste embedding spend, and bias retrieval (the same passage can occupy multiple of the top-5 slots, crowding out other sources despite the max-2-per-document rule which only dedupes *within* a document id).
- **Small-scoped fix:** Before insert, query `documents` for an existing row with the same `clean_title` + `faculty/specialty/subject`; if found, return a `duplicate` status instead of inserting. The admin UI already models a `'duplicate'` upload status, so the client can render it.

## 🟠 7. Broken / image-only PDFs "succeed" with 0 chunks
- **What:** If extraction yields no text (scanned/image PDF, parser failure), ingest still creates the document with `chunksCreated: 0` and reports success. No OCR, no warning surfaced.
- **Where:** `app/api/ingest/route.ts` (post-extraction path). Evidence: health-check "BROKEN (<20 chunks)" bucket.
- **Why it matters:** The library shows a document that contributes nothing to answers. Students and staff believe the material is covered when it isn't.
- **Small-scoped fix:** If `chunks.length === 0` after extraction, do **not** insert the document; return an explicit `error`/`skipped` status ("no extractable text — likely scanned"). One conditional in the ingest route.

## 🟡 8. Unbounded conversation history inflates cost and can overflow context
- **What:** The client sends prior turns to `/api/chat`; there is no truncation/window. Long chats grow the prompt every turn.
- **Where:** `app/api/chat/route.ts` (history handling), `components/ChatArea.tsx` / `app/page.tsx` (client accumulates messages).
- **Why it matters:** Token cost grows linearly with chat length; a very long session can approach model context limits and degrade answers.
- **Small-scoped fix:** Cap history to the last N turns (e.g. 6) before building the messages array in `app/api/chat/route.ts`. One slice.

## 🟡 9. Rerank depends on parsing free-form LLM output
- **What:** The gpt-4o-mini rerank step parses model output to extract per-chunk scores. It's wrapped in try/catch (falls back to top 2), but the parse is fragile to format drift.
- **Where:** `app/api/chat/route.ts` (rerank block).
- **Why it matters:** When parsing fails, retrieval silently collapses to "top 2 by cosine," quietly lowering answer quality with no telemetry.
- **Small-scoped fix:** Constrain the rerank call with `response_format: { type: 'json_schema', strict: true }` returning `{id, score}[]`, mirroring the pattern already proven in `/api/classify`. Removes the brittle parse.

## 🟡 10. `next` version pinned to a patch that will rot; no dependency policy
- **What:** `next@14.2.35`, React 18, and several PDF libs are pinned with no lockfile-review or update cadence noted. `serverComponentsExternalPackages` lists four overlapping PDF extractors (`pdf-parse`, `pdfjs-dist`, `officeparser`, `unpdf`) — redundancy that widens the dependency surface.
- **Where:** `package.json`, `next.config.mjs`.
- **Why it matters:** Four PDF libraries for one job is maintenance load and bundle risk; `pdf-parse` may be dead weight if `unpdf` is the real extractor.
- **Small-scoped fix:** Audit which extractor `lib/chunker.ts` actually uses at runtime; if `pdf-parse` is unused, remove it from deps and `serverComponentsExternalPackages`. Verify build still passes. (Confirm against the in-flight chunker work first — do not edit `lib/chunker.ts`.)

## 🟡 11. `tsconfig.json` has no `target` → modern-JS footguns
- **What:** Missing `target` downlevels to ~ES5 behaviour. Already caused compile failures with `[...map.entries()]` and `\p{…}`/`u`-flag regex.
- **Where:** `tsconfig.json`.
- **Why it matters:** Every contributor must remember to avoid idioms the config silently rejects — an invisible, repeat-offender trap.
- **Small-scoped fix:** Add `"target": "ES2020"` (Next 14 + Node runtime support it) and rebuild. If the build is clean, this removes the whole class of gotcha. Single-line change; verify `npm run build`.

## 🟡 12. Two divergent taxonomies kept in sync by hand
- **What:** `lib/faculties.ts` (full, RAG) and `lib/slides-faculties.ts` (restricted, slides) duplicate faculty/specialty/subject data. Historical string mismatches (e.g. "Цитология") had to be reconciled manually.
- **Where:** `lib/faculties.ts`, `lib/slides-faculties.ts`.
- **Why it matters:** Drift between them causes a slide subject that no chat subject matches (or vice-versa), so cross-feature linking silently fails.
- **Small-scoped fix:** Derive `slides-faculties` as a filtered view of `faculties` (a `.filter()` over the single source) instead of a hand-maintained copy. Contained to one file.

## 🟡 13. `cleanFilename` produces junk titles on adversarial names
- **What:** Some stored `clean_title`s are still garbage (e.g. `---__-~1.PDF`) — `cleanFilename` strips components but can leave an empty/meaningless residue.
- **Where:** `lib/cleaner.ts`.
- **Why it matters:** Junk titles show in the source citations students see, undermining trust.
- **Small-scoped fix:** After cleaning, if the result is empty or non-alphanumeric, fall back to the original filename (minus extension). Add this as the test case that seeds gap #1's Vitest file.

## ⚪ 14. One-off maintenance scripts accumulating with no docs
- **What:** `scripts/` holds ~13 ad-hoc `.mjs` (assign/import/finalize/verify/dedupe/diagnose-slides, several `*-reingest`). Overlapping purposes, no README, several untracked/in-flight.
- **Where:** `scripts/`.
- **Why it matters:** A newcomer can't tell which are current, safe, or destructive. `/api/documents/[id]/reingest` overlaps the reingest scripts.
- **Small-scoped fix:** Add `scripts/README.md` — one line per script: purpose, whether it mutates the DB, and current/deprecated. Documentation only; do **not** modify the in-flight `*-reingest.mjs` files.

## ⚪ 15. Generated artifacts committed alongside source
- **What:** `STATE-REPORT.md`, `coverage-report.md` (generated/stale — header still says 109 docs / 69564 chunks though the DB has ~96 docs) and generated `lib/anatomy-structures.ts` live in the tree with hand-written files.
- **Where:** repo root + `lib/`.
- **Why it matters:** Stale generated reports mislead; unclear which files are safe to hand-edit.
- **Small-scoped fix:** Add a header comment `// GENERATED — do not edit; run scripts/gen-anatomy-structures.mjs` to generated files, and note in CLAUDE.md that the two reports are generated snapshots. (Leave the in-flight report files themselves untouched.)

## ⚪ 16. `maxDuration=300` may exceed the Vercel plan cap
- **What:** `/api/ingest` declares `maxDuration=300`, but Vercel Hobby caps functions at 60s (300s needs Pro).
- **Where:** `app/api/ingest/route.ts`.
- **Why it matters:** If deployed on Hobby, large-textbook ingests are killed mid-embed, leaving partial `chunks` with no rollback.
- **Small-scoped fix:** Confirm the Vercel plan; if Hobby, either move ingest fully to the external server or process in resumable batches. (Investigation task — verify plan before changing the number.)
