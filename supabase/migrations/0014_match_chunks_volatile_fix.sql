-- ============================================================================
-- Migration 0014 — Fix match_chunks: STABLE → VOLATILE
-- ============================================================================
--
-- Migration 0013 rewrote match_chunks as a plpgsql STABLE function that calls
-- SET LOCAL (hnsw.ef_search / hnsw.iterative_scan). PostgreSQL forbids SET in a
-- non-VOLATILE function, so every call failed with:
--     ERROR 0A000: SET is not allowed in a non-volatile function
-- which surfaced as HTTP 400 from PostgREST and 0 rows in the app.
--
-- Fix: declare the function VOLATILE. Nothing else changes. VOLATILE is correct
-- here anyway (the function issues SET LOCAL) and is fine for a POST-only RPC.
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
