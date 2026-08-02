-- ============================================================================
-- Migration 0018 — Denormalise the taxonomy onto chunks + index the filter path
--
-- ⚠️ NOT YET APPLIED. Run supabase/diagnostics/retrieval_explain.sql FIRST and
--    confirm the plan matches the diagnosis below.
--
-- ⚠️ RUN THE PARTS BELOW ONE AT A TIME, IN ORDER. Do not paste the whole file in
--    one go. Each part is a separate unit of work so no single statement runs long
--    enough to hit the SQL Editor's statement_timeout, and so the big table is
--    never locked for minutes at a time.
--
-- WHY WE'RE HERE (measured, 2026-07-29)
--   chunks is now 229,349 rows (was 121,695). match_chunks joins chunks → documents
--   and filters on (faculty_id, specialty_id, subject).
--
--   The decisive measurement: the four benchmarked subjects did NOT grow at all
--   (56,710 chunks before and after) yet their p50 latency rose 4-7x:
--       Микробиология   9,197 chunks   317ms -> 2,632ms  (+730%)
--       Физиология     11,251 chunks   372ms -> 2,581ms  (+594%)
--       Анатомия…      14,873 chunks   417ms -> 2,768ms  (+564%)
--       Химия          21,389 chunks   516ms -> 2,783ms  (+439%)  ← now TIMES OUT
--   Their own data is unchanged; only the TABLE grew (+88%). That is the signature
--   of a whole-table scan, and Химия now returns
--       57014 "canceling statement due to statement timeout"
--   which the chat route surfaces as HTTP 500 → the Bulgarian error in the UI.
--
--   The migration history shows chunks has ONLY its primary key:
--     • supabase_setup.sql — IVFFlat index on embedding
--     • 0013 — created HNSW, dropped IVFFlat
--     • 0016 — dropped HNSW (filtered ANN under-retrieved)
--     • no migration ever created an index on chunks.document_id
--   The reingest route's own comment confirms this: "no index on the FK column".
--   So every query hash-joins the whole chunks table to find one subject's rows,
--   and every book added slows down every subject.
--
-- WHAT THIS DOES
--   1. Copies faculty_id / specialty_id / subject onto chunks (denormalise).
--   2. Indexes (faculty_id, specialty_id, subject) so a subject's rows are found by
--      index instead of scanning all 229,349.
--   3. Indexes chunks.document_id — fixes the join AND the documented slow DELETE
--      in /api/documents/[id]/reingest.
--   4. Rewrites match_chunks to filter chunks directly, with NO join on the filter.
--   5. Triggers keep the columns correct with NO application changes.
--
-- WHAT THIS DELIBERATELY DOES **NOT** DO
--   No ANN index. Ranking stays EXACT KNN — same operator, same candidate set, same
--   order — so retrieval quality is bit-for-bit identical. This is the path 0016's
--   own closing comment prescribes ("subject denormalised onto chunks + partial
--   indexes").
--
-- HONEST LIMITATION — READ THIS
--   This removes the join and the full-table scan, so a subject's cost stops
--   depending on the rest of the library. It does NOT make exact KNN constant-time:
--   we still detoast and compute distance for every chunk IN THE SUBJECT. Expect a
--   large improvement now, but at ~600k chunks the biggest subjects (~100k chunks)
--   will be slow again. See the Stage 2 note at the bottom.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PART 1 — columns + sync triggers.  FAST (seconds). Run as one block.
-- ════════════════════════════════════════════════════════════════════════════
begin;

alter table chunks
  add column if not exists faculty_id   text,
  add column if not exists specialty_id text,
  add column if not exists subject      text;

-- (a) new/moved chunks inherit the taxonomy from their parent document
create or replace function chunks_sync_taxonomy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  select d.faculty_id, d.specialty_id, d.subject
    into new.faculty_id, new.specialty_id, new.subject
  from documents d
  where d.id = new.document_id;
  return new;
end;
$$;

drop trigger if exists trg_chunks_sync_taxonomy on chunks;
create trigger trg_chunks_sync_taxonomy
  before insert or update of document_id on chunks
  for each row execute function chunks_sync_taxonomy();

-- (b) when a document is re-classified, cascade to its chunks.
--     This is what the konspekt remap does — it moved 113 documents last time.
create or replace function documents_cascade_taxonomy()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.faculty_id   is distinct from old.faculty_id
  or new.specialty_id is distinct from old.specialty_id
  or new.subject      is distinct from old.subject then
    update chunks
       set faculty_id   = new.faculty_id,
           specialty_id = new.specialty_id,
           subject      = new.subject
     where document_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_documents_cascade_taxonomy on documents;
create trigger trg_documents_cascade_taxonomy
  after update on documents
  for each row execute function documents_cascade_taxonomy();

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 2 — BATCHED BACKFILL of all 229,349 rows.  Run this block ON ITS OWN.
--
-- Why batched: a single UPDATE over 229k rows is one statement, so it is subject
-- to statement_timeout as a whole, and it holds a lock on chunks for its entire
-- duration. This loop does ~20,000 rows per UPDATE and prints progress.
--
-- ⚠️ IMPORTANT: a DO block is ITSELF a single statement, so the loop alone does
--    NOT escape statement_timeout — that is why the SET below is required. It
--    applies to this SQL Editor session only and reverts when the session ends.
--    The batching still matters: it bounds each UPDATE's lock and gives progress.
--
-- Progress appears in the SQL Editor's "Messages"/notices pane, one line per batch.
-- Safe to re-run: it only touches rows that still disagree with their document, so
-- a second run reports 0 and exits immediately.
-- ════════════════════════════════════════════════════════════════════════════
set statement_timeout = 0;

do $$
declare
  v_batch   int := 20000;
  v_rows    int;
  v_total   bigint := 0;
  v_pass    int := 0;
  v_started timestamptz := clock_timestamp();
begin
  -- Pass A: rows never populated (the bulk of the work on a first run).
  loop
    with batch as (
      select id from chunks where faculty_id is null limit v_batch
    )
    update chunks c
       set faculty_id   = d.faculty_id,
           specialty_id = d.specialty_id,
           subject      = d.subject
      from documents d, batch b
     where c.id = b.id
       and d.id = c.document_id;

    get diagnostics v_rows = row_count;
    exit when v_rows = 0;

    v_total := v_total + v_rows;
    v_pass  := v_pass + 1;
    raise notice 'backfill A: batch % — % rows (total %) — elapsed %',
      v_pass, v_rows, v_total, clock_timestamp() - v_started;
  end loop;

  -- Pass B: rows that exist but DISAGREE with their document (re-runs, or a
  -- document re-classified before the cascade trigger existed). Usually 0.
  loop
    with batch as (
      select c.id
      from chunks c
      join documents d on d.id = c.document_id
      where c.faculty_id   is distinct from d.faculty_id
         or c.specialty_id is distinct from d.specialty_id
         or c.subject      is distinct from d.subject
      limit v_batch
    )
    update chunks c
       set faculty_id   = d.faculty_id,
           specialty_id = d.specialty_id,
           subject      = d.subject
      from documents d, batch b
     where c.id = b.id
       and d.id = c.document_id;

    get diagnostics v_rows = row_count;
    exit when v_rows = 0;

    v_total := v_total + v_rows;
    v_pass  := v_pass + 1;
    raise notice 'backfill B: batch % — % rows (total %) — elapsed %',
      v_pass, v_rows, v_total, clock_timestamp() - v_started;
  end loop;

  raise notice 'BACKFILL COMPLETE — % rows in % batches, total time %',
    v_total, v_pass, clock_timestamp() - v_started;
end $$;

-- Expect 0. If non-zero, the backfill did not finish — re-run PART 2.
select count(*) as chunks_still_missing_taxonomy
from chunks where faculty_id is null or subject is null;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 3 — indexes.  Run EACH statement separately; each takes a while on 229k
-- rows. They are the payoff: the filter stops scanning the whole table.
--
-- Plain CREATE INDEX locks chunks against writes while it builds. That is fine
-- while ingestion is stopped. If you ever need to do this with ingestion running,
-- use CREATE INDEX CONCURRENTLY instead — but that CANNOT run inside a
-- transaction block, so run it alone, not wrapped in begin/commit.
-- ════════════════════════════════════════════════════════════════════════════
set statement_timeout = 0;

create index if not exists chunks_taxonomy_idx
  on chunks (faculty_id, specialty_id, subject);

create index if not exists chunks_document_id_idx
  on chunks (document_id);

analyze chunks;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 4 — match_chunks without the join on the filter path.  FAST.
-- Signature is UNCHANGED — app/api/chat/route.ts calls it with these exact named
-- parameters. Ranking is unchanged (exact KNN, same operator, same order).
-- ════════════════════════════════════════════════════════════════════════════
begin;

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
  join documents d on d.id = c.document_id   -- join is now only for display fields;
  where c.faculty_id   = match_faculty       -- the FILTER is on chunks itself
    and c.specialty_id = match_specialty
    and c.subject      = match_subject
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- PART 5 — verification. Expect: 0, 0, and both new indexes listed.
-- ════════════════════════════════════════════════════════════════════════════
select count(*) as chunks_missing_taxonomy
from chunks where faculty_id is null or subject is null;

select count(*) as chunks_disagreeing_with_document
from chunks c join documents d on d.id = c.document_id
where c.faculty_id   is distinct from d.faculty_id
   or c.specialty_id is distinct from d.specialty_id
   or c.subject      is distinct from d.subject;

select indexname, indexdef from pg_indexes
where schemaname = 'public' and tablename = 'chunks' order by indexname;

-- Confirm the planner now uses the index instead of scanning the table:
explain (analyze, buffers)
select count(*) from chunks
where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Химия';

-- ============================================================================
-- AFTERWARDS: from the repo run
--     node scripts/bench-retrieval.mjs --label after
--     node scripts/bench-retrieval.mjs --compare now after
-- to prove the fix rather than assume it. The "now" baseline was captured at
-- 229,349 chunks with Химия timing out.
--
-- APPLICATION IMPACT
--   /api/ingest    — NO CHANGE REQUIRED. The BEFORE INSERT trigger fills the three
--                    columns from the parent document (ingest already inserts the
--                    document row before its chunks, so the lookup always succeeds).
--   reingest route — NO CHANGE REQUIRED, and it gets faster: chunks_document_id_idx
--                    turns its batched DELETE into an index lookup.
--   chat route     — NO CHANGE. match_chunks keeps its exact signature and shape.
--   konspekt remap — NO CHANGE, and it now cascades to chunks automatically via
--                    trg_documents_cascade_taxonomy.
--
-- ROLLBACK
--   drop trigger trg_chunks_sync_taxonomy on chunks;
--   drop trigger trg_documents_cascade_taxonomy on documents;
--   drop function chunks_sync_taxonomy, documents_cascade_taxonomy;
--   drop index chunks_taxonomy_idx, chunks_document_id_idx;
--   alter table chunks drop column faculty_id, drop column specialty_id, drop column subject;
--   -- then re-create match_chunks from 0016.
--
-- ── STAGE 2 (NOT included here) — if/when O(subject) is still too slow ──────
--   The only way to beat O(subject size) is ANN. 0016 dropped HNSW because a
--   GLOBAL HNSW index + a selective metadata filter under-retrieved: pgvector
--   searched the globally-nearest ef_search vectors, those were dominated by other
--   subjects, and post-filtering left too few (sometimes zero) rows.
--
--   PARTIAL indexes avoid that failure mode by construction:
--       create index chunks_hnsw_himiya on chunks using hnsw (embedding vector_cosine_ops)
--         where faculty_id='medicina' and specialty_id='medicina' and subject='Химия';
--   Such an index contains ONLY that subject's vectors, so ef_search is spent
--   entirely inside the subject — there is no cross-subject dilution and therefore
--   no post-filter starvation. It is not "ANN + filter"; it is ANN over an index
--   that IS the filter.
--   Cost: one index per hot subject (only ~5 subjects exceed 10k chunks today), and
--   each must be created as subjects grow. Recall becomes approximate WITHIN the
--   subject, so validate against the exact results before adopting.
-- ============================================================================
