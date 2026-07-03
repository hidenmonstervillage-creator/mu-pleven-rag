-- ============================================================================
-- Migration 0016 — Exact vector search (drop HNSW), the correct tool at 72k rows
-- ============================================================================
--
-- WHY WE'RE HERE:
--   0013 built an HNSW index; 0014/0015 tuned ef_search + iterative_scan to make
--   filtered search reach a subject's chunks. Verification exposed the hard limit
--   of HNSW + a SELECTIVE metadata filter:
--     • With bounded ef_search=400 (no iterative_scan), some anatomy queries
--       returned 0 rows at the app's count=8 — their matching chunks rank BEYOND
--       the 400 globally-nearest (the global top-400 are dominated by other
--       subjects), so the post-filter leaves nothing. The SAME query at
--       count=1000 returns 1000 rows, because pgvector switches to an EXACT
--       seq-scan for large limits. Proof the chunks exist and match — HNSW just
--       can't surface them under the filter, and no finite ef_search guarantees it.
--     • With iterative_scan on (0014), those queries did return rows but some
--       count=8 anatomy queries hit the statement timeout (HTTP 500).
--
-- THE FIX:
--   The chunks table is only ~72k rows and the subject filter is selective
--   (≤ ~6,800 chunks per subject). Exact KNN over one subject's chunks is both
--   FAST and 100% correct for every subject/query — no ANN recall gaps, no
--   ef_search tuning, no timeouts, immune to the duplicate-cluster distortion.
--   Drop the HNSW index so the planner always does exact filter-then-sort.
--
--   (If chunks ever grows past a few hundred thousand rows, revisit ANN with a
--    filter-aware approach: subject denormalised onto chunks + partial indexes.)
--
-- HOW TO RUN: paste into Supabase SQL Editor and Run. Instant.
-- ============================================================================

-- 1. Drop the HNSW index — otherwise the planner still uses it for small LIMITs
--    and reintroduces the under-retrieval.
drop index if exists chunks_embedding_hnsw_idx;

-- 2. Restore match_chunks to a plain, exact SQL function (no SET → STABLE is fine).
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
language sql
stable
as $$
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
$$;

-- 3. Confirm no embedding ANN index remains (should return the exact-scan setup).
select indexname, indexdef
from pg_indexes
where tablename = 'chunks' and indexdef ilike '%embedding%';
