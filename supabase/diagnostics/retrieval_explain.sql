-- ============================================================================
-- retrieval_explain.sql — DIAGNOSTIC ONLY. Read-only; creates/changes nothing.
-- Paste into the Supabase SQL Editor and run top to bottom, then send me the output.
--
-- Purpose: confirm (or refute) the black-box diagnosis of match_chunks slowness
-- before we commit to migration 0018.
-- ============================================================================

-- ── 1. What indexes actually exist on chunks / documents? ───────────────────
-- Expectation from the migration history: chunks has ONLY its primary key —
-- no index on document_id (0013 added HNSW, 0016 dropped it; IVFFlat dropped in 0013),
-- and no index on the embedding column at all.
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public' and tablename in ('chunks', 'documents')
order by tablename, indexname;

-- ── 2. Table / TOAST sizes — is the embedding column stored out-of-line? ────
-- This decides whether a seq scan of chunks is cheap (embeddings in TOAST) or
-- catastrophic (embeddings inline).
select
  c.relname,
  pg_size_pretty(pg_total_relation_size(c.oid))                as total,
  pg_size_pretty(pg_relation_size(c.oid))                      as heap_only,
  pg_size_pretty(coalesce(pg_relation_size(t.oid), 0))         as toast,
  c.reltuples::bigint                                          as est_rows
from pg_class c
left join pg_class t on t.oid = c.reltoastrelid
where c.relname in ('chunks', 'documents');

-- storage mode of the embedding column: 'x' = EXTENDED (compressed, out-of-line)
select attname, atttypid::regtype as type, attstorage
from pg_attribute
where attrelid = 'public.chunks'::regclass and attname in ('embedding', 'content', 'document_id');

-- ── 3. Statement timeout, globally and per role ─────────────────────────────
show statement_timeout;                       -- this session (SQL Editor)
select rolname, rolconfig
from pg_roles
where rolname in ('anon', 'authenticated', 'service_role', 'authenticator', 'postgres');

-- ── 4. THE MAIN EVENT: EXPLAIN (ANALYZE, BUFFERS) on the worst subject ──────
-- Химия = 21,389 chunks across 32 documents (the largest subject).
-- We use an existing chunk's embedding as the probe vector so no 1536-dim literal
-- has to be pasted. It is evaluated once as an InitPlan, so the plan shape matches
-- what match_chunks does with its parameter.
--
-- Run this TWICE: the first run is cold (I/O visible in BUFFERS as `read=`),
-- the second is warm (`hit=`). Send me both.

explain (analyze, buffers, verbose)
select
  c.id,
  c.content,
  c.page_number,
  c.document_id,
  d.clean_title,
  d.file_type,
  d.storage_url,
  1 - (c.embedding <=> (select embedding from chunks where id = 'dafb984c-027c-4686-9150-99e6ea63754f')) as similarity
from chunks c
join documents d on c.document_id = d.id
where d.faculty_id   = 'medicina'
  and d.specialty_id = 'medicina'
  and d.subject      = 'Химия'
order by c.embedding <=> (select embedding from chunks where id = 'dafb984c-027c-4686-9150-99e6ea63754f')
limit 8;

-- ── 5. Same query WITHOUT the ORDER BY, to separate filter cost from KNN cost ─
-- If this is fast and (4) is slow, the time is in detoast + distance computation,
-- not in finding the rows. If BOTH are slow, the join/scan is the problem.
explain (analyze, buffers)
select count(*)
from chunks c
join documents d on c.document_id = d.id
where d.faculty_id   = 'medicina'
  and d.specialty_id = 'medicina'
  and d.subject      = 'Химия';

-- ── 6. Chunk distribution per subject — how far does this scale? ────────────
select d.faculty_id, d.specialty_id, d.subject,
       count(distinct d.id) as docs, count(c.id) as chunks
from documents d
join chunks c on c.document_id = d.id
group by 1, 2, 3
order by chunks desc
limit 15;
