-- ============================================================================
-- Migration 0015 — match_chunks: bounded ef_search, drop iterative_scan
-- ============================================================================
--
-- Migration 0014 set hnsw.ef_search=200 + hnsw.iterative_scan='relaxed_order'.
-- That fixed cytology retrieval (top sim 0.37→0.63, reachability 1%→full) BUT
-- iterative_scan has UNBOUNDED, variable cost: to gather match_count rows that
-- pass the subject filter it keeps expanding the graph search, and for the
-- larger "Анатомия и хистология" subject some count=8 queries scanned deep
-- enough to hit the statement timeout (HTTP 500, code 57014). That's a
-- production hazard — the chat uses count=8.
--
-- FIX: use a single, bounded, generous ef_search and turn iterative_scan OFF.
--   • Predictable sub-second latency, no timeouts.
--   • ef_search=400 explores the 400 nearest chunks before the subject filter.
--     For in-domain student queries (the nearest neighbours ARE that subject)
--     this yields far more than the 8 rows the app needs, at true-nearest order.
--
-- HOW TO RUN: paste into Supabase SQL Editor and Run. Instant — no index work.
-- ============================================================================

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
volatile
as $$
begin
  -- Bounded exploration: enough candidates that the post-filter still yields
  -- match_count rows for in-domain queries, without iterative_scan's open-ended
  -- (timeout-prone) expansion. Tune here if needed: 400 → 600 raises recall for
  -- selective subjects at a small, still-bounded latency cost.
  set local hnsw.ef_search = 400;

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
