-- ============================================================================
-- Migration 0013 — Replace IVFFlat with HNSW + fix filtered-search recall
-- ============================================================================
--
-- PROBLEM (diagnosed 2026-07-02):
--   The chunks.embedding index is IVFFlat (lists=100, default probes=1). Each
--   query scans ~1 of 100 lists (~1% of 72k chunks), and match_chunks applies
--   the faculty/specialty/subject filter AFTER the index scan. Because any one
--   subject is a small fraction of the table and its chunks are scattered across
--   all lists, filtered queries reach only 1–5% of a subject's chunks — and the
--   same question can return 0 or 8 results depending on tiny embedding jitter.
--
-- FIX:
--   1. Build an HNSW index (better graph-based ANN, handles filters far better).
--   2. Raise hnsw.ef_search and enable iterative_scan INSIDE match_chunks so the
--      post-subject-filter still yields the requested match_count rows.
--   3. Drop the old IVFFlat index (only after HNSW is built).
--
-- HOW TO RUN:
--   Paste this whole file into the Supabase SQL Editor and Run. The HNSW build
--   over ~72k rows takes a few minutes. Reads (chat retrieval) keep working
--   throughout via the still-present IVFFlat index — CREATE INDEX blocks only
--   writes to chunks (which happen only during ingestion, not chat).
--
--   If step 2 errors with "access method hnsw does not exist", your pgvector is
--   older than 0.5.0 — run  ALTER EXTENSION vector UPDATE;  first, then re-run.
-- ============================================================================

-- Session tuning to speed up the build (safe; session-local).
set maintenance_work_mem = '256MB';   -- raise to 512MB–1GB if the instance has room
set max_parallel_maintenance_workers = 2;
set statement_timeout = 0;            -- HNSW build can exceed the default timeout

-- ── 1. Inspect the current embedding index (for the record) ─────────────────
select indexname, indexdef
from pg_indexes
where tablename = 'chunks' and indexdef ilike '%embedding%';

-- ── 2. Build the HNSW index (sensible defaults) ─────────────────────────────
create index if not exists chunks_embedding_hnsw_idx
  on chunks using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

-- ── 3. Rewrite match_chunks to make filtered HNSW search reach enough rows ──
--    Same signature / return type as before — the app and REST RPC are unchanged.
create or replace function match_chunks(
  query_embedding vector(1536),
  match_faculty text,
  match_specialty text,
  match_subject text,
  match_count int default 10
)
returns table (
  id uuid,
  content text,
  page_number integer,
  document_id uuid,
  clean_title text,
  file_type text,
  storage_url text,
  similarity float
)
language plpgsql
stable
as $$
begin
  -- Explore many more candidates before the subject filter is applied, so a
  -- subject that is only a few % of the table still yields match_count rows.
  set local hnsw.ef_search = 200;

  -- pgvector >= 0.8: keep scanning the graph until match_count rows pass the
  -- filter (the proper fix for selective post-filters). Ignored on older builds.
  begin
    set local hnsw.iterative_scan = 'relaxed_order';
  exception when others then
    null;  -- older pgvector without iterative_scan — ef_search alone still helps
  end;

  return query
    select
      c.id,
      c.content,
      c.page_number,
      c.document_id,
      d.clean_title,
      d.file_type,
      d.storage_url,
      1 - (c.embedding <=> query_embedding) as similarity
    from chunks c
    join documents d on c.document_id = d.id
    where d.faculty_id   = match_faculty
      and d.specialty_id = match_specialty
      and d.subject      = match_subject
    order by c.embedding <=> query_embedding
    limit match_count;
end;
$$;

-- ── 4. Drop the old IVFFlat index (robust to its auto-generated name) ───────
do $$
declare
  ivf_name text;
begin
  select indexname into ivf_name
  from pg_indexes
  where tablename = 'chunks'
    and indexdef ilike '%ivfflat%'
    and indexdef ilike '%embedding%'
  limit 1;

  if ivf_name is not null then
    execute format('drop index %I', ivf_name);
    raise notice 'Dropped IVFFlat index: %', ivf_name;
  else
    raise notice 'No IVFFlat index found on chunks.embedding (already dropped?)';
  end if;
end $$;

-- ── 5. Confirm final index state ────────────────────────────────────────────
select indexname, indexdef
from pg_indexes
where tablename = 'chunks' and indexdef ilike '%embedding%';
