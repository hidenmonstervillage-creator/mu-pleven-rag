-- ============================================================================
-- retrieval_explain_2.sql — DIAGNOSTIC ONLY. Read-only; creates/changes nothing.
--
-- PURPOSE: separate two competing explanations for why, post-0018 and post-remap,
-- "Анатомия и хистология" (28,862 chunks) is slow while "Физиология" (21,803
-- chunks — only 25% smaller) is fast.
--
--   H1 PLANNER CROSSOVER — Анатомия is ~10.4% of the table, Физиология ~7.8%.
--      Past some selectivity threshold the planner abandons chunks_taxonomy_idx
--      and reverts to a Seq Scan of all 278,800 rows.
--        → Expect: Seq Scan on the slow one, Index Scan on the fast one.
--
--   H2 WORKING SET EXCEEDS CACHE — embeddings alone are ~169 MB for Анатомия vs
--      ~128 MB for Физиология. If shared_buffers sits between those, one fits and
--      one never does.
--        → Expect: SAME scan node on both, but the slow one keeps showing large
--          `shared read=` on the SECOND (warm) run while the fast one shows `hit=`.
--
--   Both predict a slow query. Only BUFFERS on a REPEATED run tells them apart.
--   Note a count(*) EXPLAIN CANNOT decide this: it never touches the embedding
--   column, so it skips the detoast + distance work that dominates the real query.
--
-- SUPPORTING EVIDENCE ALREADY GATHERED (client-side timings, 2026-07-31):
--   Физиология  5787 → 1710 → 427 → 422 → 586 ms   warms up ~13x
--   Анатомия    6262 → 4533 → 4331 → 4261 ms       plateaus, never warms (1.5x)
--   Физиология immediately after Анатомия: 3949 → … → 393 ms  (evicted, re-warms)
--   => Анатомия never benefiting from repetition is consistent with EITHER a Seq
--      Scan (intrinsic cost) OR a working set that cannot fit. Hence this file.
--
-- HOW TO RUN: paste section by section into the Supabase SQL Editor. For §3 and §4
-- run EACH explain TWICE and keep BOTH outputs — the second run is the one that
-- decides H1 vs H2.
-- ============================================================================


-- ── 1. Instance size / memory settings ──────────────────────────────────────
-- shared_buffers is the number that matters: compare it to the ~169 MB and
-- ~128 MB working-set estimates above.
select name, setting, unit, source
from pg_settings
where name in (
  'shared_buffers', 'effective_cache_size', 'work_mem', 'maintenance_work_mem',
  'random_page_cost', 'seq_page_cost', 'max_parallel_workers_per_gather',
  'statement_timeout', 'default_statistics_target'
)
order by name;

-- total RAM as seen by the instance (Supabase exposes this on most plans)
select
  (select setting::bigint * 8192 from pg_settings where name = 'shared_buffers') as shared_buffers_bytes,
  pg_size_pretty((select setting::bigint * 8192 from pg_settings where name = 'shared_buffers')) as shared_buffers_pretty,
  pg_size_pretty((select setting::bigint * 8192 from pg_settings where name = 'effective_cache_size')) as effective_cache_size_pretty;


-- ── 2. Sizes: is the working set plausibly bigger than cache? ───────────────
select
  c.relname,
  pg_size_pretty(pg_total_relation_size(c.oid))            as total,
  pg_size_pretty(pg_relation_size(c.oid))                  as heap,
  pg_size_pretty(coalesce(pg_relation_size(t.oid), 0))     as toast,
  pg_size_pretty(pg_indexes_size(c.oid))                   as indexes,
  c.reltuples::bigint                                      as est_rows
from pg_class c
left join pg_class t on t.oid = c.reltoastrelid
where c.relname = 'chunks';

-- per-subject share of the table
select subject, count(*) as chunks,
       round(100.0 * count(*) / sum(count(*)) over (), 1) as pct_of_table
from chunks
where faculty_id = 'medicina' and specialty_id = 'medicina'
group by subject
order by chunks desc
limit 10;


-- ── 3. THE DECIDER (a): SLOW subject — Анатомия и хистология (28,862, 10.4%) ─
-- RUN THIS TWICE. Compare run 1 vs run 2.
--   • Seq Scan on both runs                        → H1 (planner crossover)
--   • Index Scan but run 2 still has big `read=`   → H2 (working set > cache)
--   • Index Scan and run 2 is mostly `hit=` + fast → neither; look at CPU/detoast
explain (analyze, buffers, verbose)
select
  c.id, c.content, c.page_number, c.document_id,
  d.clean_title, d.file_type, d.storage_url,
  1 - (c.embedding <=> (select embedding from chunks limit 1)) as similarity
from chunks c
join documents d on d.id = c.document_id
where c.faculty_id   = 'medicina'
  and c.specialty_id = 'medicina'
  and c.subject      = 'Анатомия и хистология'
order by c.embedding <=> (select embedding from chunks limit 1)
limit 8;


-- ── 3b. THE DECIDER (b): FAST subject — Физиология (21,803, 7.8%) ───────────
-- Same shape, only the subject differs. RUN THIS TWICE as well.
explain (analyze, buffers, verbose)
select
  c.id, c.content, c.page_number, c.document_id,
  d.clean_title, d.file_type, d.storage_url,
  1 - (c.embedding <=> (select embedding from chunks limit 1)) as similarity
from chunks c
join documents d on d.id = c.document_id
where c.faculty_id   = 'medicina'
  and c.specialty_id = 'medicina'
  and c.subject      = 'Физиология'
order by c.embedding <=> (select embedding from chunks limit 1)
limit 8;


-- ── 4. Is chunks_taxonomy_idx being used AT ALL? ────────────────────────────
-- Cheap, decisive supporting evidence for H1. If idx_scan is high the planner is
-- choosing the index generally; if it is ~0 the index is being ignored.
select
  indexrelname as index,
  idx_scan     as times_used,
  idx_tup_read,
  idx_tup_fetch,
  pg_size_pretty(pg_relation_size(indexrelid)) as size
from pg_stat_user_indexes
where relname = 'chunks'
order by idx_scan desc;

-- table-level: how much of the access is seq vs index?
select seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
       n_live_tup, n_dead_tup, last_autovacuum, last_autoanalyze
from pg_stat_user_tables
where relname = 'chunks';


-- ── 5. Force the index and compare — settles H1 directly ───────────────────
-- If enable_seqscan=off makes the SLOW subject fast, the planner was choosing
-- badly (H1) and the fix is planner tuning. If it stays slow, the cost is real
-- (H2 / intrinsic) and no amount of planner nudging will help.
-- Session-scoped; reverts when you close the tab.
set enable_seqscan = off;

explain (analyze, buffers)
select
  c.id,
  1 - (c.embedding <=> (select embedding from chunks limit 1)) as similarity
from chunks c
where c.faculty_id   = 'medicina'
  and c.specialty_id = 'medicina'
  and c.subject      = 'Анатомия и хистология'
order by c.embedding <=> (select embedding from chunks limit 1)
limit 8;

reset enable_seqscan;

-- ============================================================================
-- WHAT EACH OUTCOME IMPLIES (decide from the output, not from preference)
--
--   A) Slow = Seq Scan, Fast = Index Scan, and §5 makes it fast
--      → H1 planner crossover. Fix is cheap and exact-preserving:
--        lower random_page_cost (e.g. 4 → 1.1, correct for SSD/network storage),
--        and/or raise default_statistics_target on the taxonomy columns.
--        No approximation, no new index type.
--
--   B) Both Index Scan, slow one still shows big `read=` on run 2
--      → H2 working set > shared_buffers. Planner tuning will NOT help.
--        Options: bigger Supabase compute (more shared_buffers) — the only fix
--        that keeps exact KNN; or reduce bytes read per query, which means
--        partial HNSW per hot subject (Stage 2 in 0018) or halving vector width
--        (text-embedding-3-small supports 768 dims via `dimensions`, but that is
--        a re-embed of the whole corpus and changes recall).
--
--   C) §5 forces Index Scan but it is still slow AND mostly `hit=`
--      → cost is CPU: 28,862 distance computations + detoast per query. Only ANN
--        (partial HNSW) removes that. Exact KNN cannot be made cheaper.
--
--   Mixed signals are possible — e.g. Seq Scan chosen BECAUSE the planner knows
--   the index would not be cached. Report both runs of both subjects and §4/§5
--   and the picture resolves.
-- ============================================================================
