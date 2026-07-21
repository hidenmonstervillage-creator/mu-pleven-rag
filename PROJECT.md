# PROJECT.md — MU-Pleven AI Library

> Senior-engineer onboarding for the МУ-Плевен (Medical University of Pleven) AI academic assistant.
> Read this once to build a mental model. For operational rules see [CLAUDE.md](./CLAUDE.md); for the known-issues backlog see [GAPS.md](./GAPS.md).

---

## 1. What this is, in plain language

This is a **Bulgarian-language academic assistant for medical-university students**. A student picks their **Faculty → Specialty → Subject** from dropdowns, asks a question in Bulgarian, and gets an answer grounded in the actual textbooks and lecture slides for that subject — with citations (document + page) they can click to open the source PDF at the right page.

It is a **RAG (Retrieval-Augmented Generation) system**: the answer is not "whatever GPT knows," it is "what the uploaded course materials say," retrieved by semantic search and summarised by an LLM. This matters because the audience is medical students who need *sourced, correct* answers tied to their curriculum, not general-internet knowledge.

On top of the core Q&A, three secondary features exist:

- **Slide library** — histology/pathology microscope slides, browsable per subject, viewed through an embedded proxy to the university's **OlyVia** digital-microscope server.
- **3D anatomy viewer** — self-hosted anatomical GLB models (Three.js) with region/system/structure isolation, so a student can spin up "show me the femur" style views.
- **Admin console** (`/admin`) — the staff-facing upload + library-management UI (1700+ lines): upload PDFs/PPTX, auto-classify them into the taxonomy, manage documents/slides.

The primary user is a **student** (read-only chat + viewers). The secondary user is **staff/admin** (uploading and organising content).

---

## 2. Tech stack — what and why

| Layer | Choice | Why it was chosen (inferred) |
|---|---|---|
| Framework | **Next.js 14 App Router** (14.2.35), React 18 | One deployable unit for UI + API routes. Server routes hold secrets (service-role key, OpenAI key) and stream responses. App Router gives per-route `runtime`/`maxDuration` control, which the RAG + ingest routes rely on. |
| Language | **TypeScript** (strict) | Type safety across the taxonomy + DB row shapes. Note: **no explicit `target`** in tsconfig → downlevels aggressively; see gotchas. |
| Styling | **Tailwind CSS** + `@tailwindcss/typography` | Utility-first, fast iteration. Brand colour `#7B1C1C` (МУ-Плевен maroon), Inter font. Chat answers render markdown via `prose`. |
| DB / storage | **Supabase** (Postgres + **pgvector** + Storage) | Managed Postgres with vector search in one place. Storage holds the raw PDFs; `pgvector` holds the embeddings. Service-role client used server-side only. |
| Embeddings | **OpenAI `text-embedding-3-small`** (1536-dim) | Cheap, good multilingual (incl. Bulgarian) embeddings. 1536 dims fixes the `vector(1536)` column width. |
| Retrieval | **pgvector cosine** via `match_chunks` RPC (EXACT KNN) | Exact search chosen deliberately over the HNSW index after an approximate-index accuracy saga (see §5). At current scale (~65k chunks) exact is fast enough and correct. |
| LLM | **gpt-4o-mini** (classify + rerank), **gpt-4o** (final answer, streamed) | Cheap model for structured/scoring tasks; capable model for the student-facing answer. Answer is streamed as NDJSON for perceived speed. |
| PDF/PPTX extraction | **unpdf / pdfjs-dist / officeparser / pdf-parse** | Position-aware text reconstruction (unpdf `extractTextItems`) to preserve reading order; officeparser for PPTX. Marked as `serverComponentsExternalPackages` so they aren't bundled. |
| 3D | **Three.js** + Draco-compressed self-hosted GLB | CC BY-SA anatomy models served from `public/models`, decoded with the self-hosted Draco decoder in `public/draco`. Self-hosted to avoid CDN/licensing/runtime dependencies. |
| Big-file upload | **Hetzner upload server** (external) via Cloudflare tunnel | Vercel has a request-body size cap; large textbooks are uploaded browser → external server → Supabase Storage to bypass it. The Next app only receives the resulting `storageUrl`. |
| Hosting | **Vercel** (`git push origin main` → deploy) | Zero-config Next.js hosting; per-route `maxDuration`. No `vercel.json`, no CI. |

---

## 3. Architecture — how it fits together

### 3.1 High-level component map

```
                         ┌──────────────────────────── BROWSER (student) ───────────────────────────┐
                         │  app/page.tsx  ── TopBar (Faculty▸Specialty▸Subject cascade)              │
                         │       │           ChatArea (markdown + SourceCards)                        │
                         │       │           SlidePanel / SlideViewer   AnatomyViewer (Three.js)      │
                         └───────┼───────────────────────────────────────────────────────────────────┘
                                 │ NDJSON stream
                     ┌───────────▼───────────┐
                     │  POST /api/chat        │  embedText → match_chunks RPC → filter/dedupe →
                     │  (runtime=nodejs,      │  gpt-4o-mini rerank → gpt-4o STREAM (Bulgarian prompt)
                     │   maxDuration=60)      │
                     └───────────┬───────────┘
                                 │  SQL RPC (cosine KNN, scoped by faculty/specialty/subject)
                     ┌───────────▼──────────────────────────── SUPABASE ─────────────────────────────┐
                     │  Postgres + pgvector                                                            │
                     │    documents ─1:N─ chunks(embedding vector(1536))   slides ─N:M─ slide_subjects │
                     │  Storage:  raw PDFs (served back to PDFViewer)                                  │
                     └───────────▲───────────────────────────────────────────────────────────────────┘
                                 │  bulk insert (documents + chunks)
                     ┌───────────┴───────────┐
                     │  POST /api/ingest      │  download storageUrl → extract pages → chunkPages →
                     │  (maxDuration=300)     │  embedTexts (batched, 429-retry) → bulk insert
                     └───────────▲───────────┘
                                 │ storageUrl + metadata
   ┌──────────── ADMIN (/admin) ┴──────────────┐        ┌───── POST /api/classify ─────┐
   │  upload UI → /api/upload-proxy →           │        │  gpt-4o-mini + JSON-schema    │
   │  Hetzner (Cloudflare tunnel) → Storage     │        │  enum of ALL taxonomy triples │
   │  → /api/classify (suggest placement)       │───────▶│  → {faculty,specialty,subject,│
   │  → /api/ingest (embed + store)             │        │     confidence}               │
   └────────────────────────────────────────────┘        └───────────────────────────────┘

   Side proxies:  /api/olyvia/[...path] → OlyVia microscope server (194.141.67.249:8085, session auth)
                  /api/pdf              → streams stored PDFs to the in-app PDFViewer
```

### 3.2 The three data flows that matter

**A. Ask a question (the core path).**
`ChatArea` POSTs `{faculty, specialty, subject, message, history}` to `/api/chat`. The route:
1. `embedText(query)` → 1536-dim vector.
2. `match_chunks` RPC — cosine KNN **scoped to the selected faculty/specialty/subject**, `match_count: 8`.
3. Filter `similarity >= 0.2` (deliberately low — Bulgarian text embeds with lower cosine scores than English).
4. Dedupe to **max 2 chunks per document**, keep top 5.
5. **gpt-4o-mini rerank** — score each chunk's relevance; keep score ≥ 6, else fall back to top 2. Wrapped in try/catch so a rerank failure degrades gracefully to the pre-rerank set.
6. Stream the answer from **gpt-4o** (temp 0.3) under a Bulgarian system prompt ("Ти си AI академичен асистент на Медицински университет Плевен…") as NDJSON: first a `{type:'sources'}` frame, then many `{type:'text',content}` deltas, then `{type:'done'}`.

**B. Add a document (the ingest path).**
Admin uploads a file. Because it can be a huge textbook, the bytes go **browser → Hetzner upload server (via Cloudflare tunnel) → Supabase Storage**, *not* through Vercel. The admin UI then calls `/api/classify` to suggest placement, and finally `/api/ingest` with the `storageUrl` + chosen metadata. Ingest downloads the file, extracts **position-aware page text**, `chunkPages` (~500 tokens, 50 overlap), embeds in batches (with 429 back-off), and bulk-inserts `documents` + `chunks`.

**C. Classify a document.**
`/api/classify` sends the filename/first-page text to gpt-4o-mini with a **JSON-schema whose `enum` is the full list of canonical `faculty||specialty||subject` triples**. Because the model can only return a value from the enum, **taxonomy drift is structurally impossible** — the classifier cannot invent a subject that doesn't exist. Returns a `confidence` (threshold ~0.7).

---

## 4. Key design decisions (and the reasoning you should not undo lightly)

1. **Exact vector search, not an approximate index.** `match_chunks` (migration `0016`) is `language sql stable` exact KNN after the HNSW index produced wrong/empty results. The migration comment records the whole saga. At ~65k chunks this is correct and fast. *Do not "optimise" it back to HNSW without re-reading 0013–0016.*

2. **Classification enum = the taxonomy.** Placing every valid triple in a JSON-schema `enum` makes misclassification into a *non-existent* bucket impossible. The trade-off: the enum is large and must be regenerated when the taxonomy (`lib/faculties.ts`) changes.

3. **Similarity threshold lowered to 0.2.** Bulgarian text yields lower cosine similarity than English; 0.3 dropped valid results. This is a language-specific tuning constant, not a bug.

4. **Big uploads bypass Vercel.** The external Hetzner server exists solely to dodge Vercel's body-size limit for multi-hundred-MB textbooks. The app is decoupled from it — it only ever sees a `storageUrl`.

5. **Manual migrations.** SQL migrations in `supabase/migrations/` are applied **by hand in the Supabase SQL Editor**, not auto-run. The DB is the live source of truth; the files are the record. (See GAPS — this is a real drift risk.)

6. **Self-hosted 3D + Draco.** Anatomy models and the Draco decoder are checked into `public/` to avoid runtime CDN/licensing dependencies and keep the viewer working offline-of-CDN.

7. **Streaming NDJSON, not SSE or JSON.** The chat contract is newline-delimited JSON frames so sources arrive before text and text arrives incrementally — a deliberate, simple wire format the client parses by lines.

---

## 5. Critical / load-bearing paths (change with care)

- **`app/api/chat/route.ts`** — the product. Every retrieval constant (match_count 8, similarity 0.2, max 2/doc, top 5, rerank≥6) is tuned. Changing any one shifts answer quality. The NDJSON frame shape is a client contract.
- **`supabase/migrations/0016_match_chunks_exact.sql`** — the retrieval SQL. The RPC signature (`query_embedding`, `match_faculty/specialty/subject`, `match_count`) is called from the chat route; changing the signature breaks retrieval silently.
- **`lib/faculties.ts`** (~552 lines) — the canonical taxonomy. It drives the TopBar dropdowns, the classify enum, and the scoping keys used in `documents`/`chunks`. A rename here orphans existing rows (they're stored by string id/subject).
- **`app/api/ingest/route.ts` + `lib/chunker.ts` + `lib/embeddings.ts`** — how content enters the system. Chunk size/overlap and the embedding model must stay consistent with what's already stored, or new chunks won't be comparable to old ones.
- **`app/api/olyvia/[...path]/route.ts`** — session-authenticated proxy with HTML rewriting; brittle against upstream markup/URL changes.

**Comparatively safe to change:** presentational components (`ChatArea`, `TopBar`, `Logo`, `SourceCard`, welcome screen copy), Tailwind styling, the anatomy catalog data, and admin-UI layout — as long as the API contracts above are respected.

---

## 6. Surprising / non-obvious gotchas

- **`tsconfig.json` has no `target`.** It downlevels to roughly ES5 behaviour. This has already bitten the code: `[...map.entries()]` and `\p{…}` / `u`-flag regex fail to compile. Use `Array.from(map.entries())` and literal `\u` character ranges. (See GAPS for the fix.)
- **Migrations are not run automatically.** A fresh checkout's SQL files do **not** equal the live DB. The migration folder starts at `0010` — earlier migrations aren't in the repo. Never assume "the migration exists in the folder" means "the DB has it," or vice-versa.
- **GLTFLoader renames nodes.** Three.js sanitises node names (spaces→`_`, strips `[]./:`). The anatomy catalog stores already-sanitised names and re-applies `sanitizeName()` at match time — matching against raw model names will fail.
- **Retrieval is silently scoped.** If a subject has **no documents**, chat returns nothing useful — and most subjects have none: content coverage is ~8% (see `coverage-report.md`). The system "works" but only for the ~32 subjects that actually have material.
- **Image-only / broken PDFs ingest to 0 chunks silently.** There's no OCR and no hard failure — a scanned textbook can "succeed" while contributing nothing.
- **The Hetzner upload URL is a Cloudflare *tunnel* URL** (`*.trycloudflare.com`) that can rotate. Hardcoded upstream IPs (OlyVia, Hetzner) are plain HTTP and change-fragile.
- **Two taxonomies exist.** `lib/faculties.ts` (full, for RAG) and `lib/slides-faculties.ts` (restricted, for the slide library). They must be kept consistent by hand.
- **In-flight uncommitted work.** `app/api/classify/route.ts` and `lib/chunker.ts` have substantial *uncommitted* modifications, plus several `scripts/*-reingest.mjs`, `STATE-REPORT.md`, and `coverage-report.md` are untracked. This is an active re-ingestion/extraction-quality effort. **Do not commit or "clean up" these files** — treat them as someone else's open branch.

---

## 7. Where to look first (file map)

| Area | Files |
|---|---|
| Core chat / RAG | `app/api/chat/route.ts`, `lib/embeddings.ts`, `supabase/migrations/0016_*.sql` |
| Ingestion | `app/api/ingest/route.ts`, `lib/chunker.ts`, `lib/cleaner.ts` |
| Classification | `app/api/classify/route.ts`, `lib/faculties.ts` |
| Taxonomy | `lib/faculties.ts` (RAG), `lib/slides-faculties.ts` (slides) |
| Slides / microscope | `app/api/olyvia/[...path]/route.ts`, `components/SlidePanel.tsx`, `components/SlideViewer.tsx` |
| 3D anatomy | `components/AnatomyViewer.tsx`, `lib/anatomy-catalog.ts`, `lib/anatomy-match.ts`, `lib/anatomy-structures.ts` (generated), `public/models`, `public/draco` |
| Admin UI | `app/admin/page.tsx` (~1722 lines), `app/api/upload-proxy/route.ts` |
| Client | `app/page.tsx`, `components/TopBar.tsx`, `components/ChatArea.tsx`, `components/PDFViewer.tsx`, `components/SourceCard.tsx` |
| Infra config | `next.config.mjs`, `tsconfig.json`, `tailwind.config.ts`, `app/globals.css`, `lib/supabase.ts` |
| DB | `supabase/migrations/0010–0017` (applied manually) |
