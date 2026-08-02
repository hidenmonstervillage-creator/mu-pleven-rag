-- ============================================================================
-- Migration 0019 — Partial HNSW indexes for the 9 tail-latency subjects
-- ============================================================================
--
-- WHY: bench pass3 (70 subjects, 15 warm runs each, 2026-08-02) found medians are
-- healthy everywhere (p50 76-354ms) but nine subjects have a p95 above 1.5s, peaking
-- at 4.9s. The cause is confirmed, not assumed — comparing match_count=8 against
-- match_count=30000 (which forces an exact scan) gives:
--
--     Анатомия и хистология  29,578   92ms vs 10083ms   109.6x   ANN INDEX IN USE
--     Химия                  26,699  105ms vs  6324ms    60.2x   ANN INDEX IN USE
--     Физиология             21,526 1222ms vs  1295ms     1.1x   exact scan
--     Фармакология           20,295 1108ms vs  3062ms     2.8x   exact scan
--     Биохимия               15,165 1537ms vs  1278ms     0.8x   exact scan
--
-- The two indexed subjects are the two LARGEST and the two FASTEST per chunk
-- (2.8-3.2 ms/1k vs 16-22 ms/1k unindexed). Partial HNSW works here; these nine
-- simply do not have one.
--
-- READ 0016 FIRST. It dropped a GLOBAL HNSW index for a good reason: with a selective
-- subject filter applied AFTER the index scan, the global top-N is dominated by other
-- subjects and filtered queries returned 0 rows. PARTIAL indexes do not have that
-- failure mode — each index contains only one subject's rows, so the filter is the
-- index predicate rather than a post-filter. Do not replace these with a global index.
--
-- PREREQUISITE: match_chunks must inline the taxonomy values as literals (EXECUTE
-- format(...)) so the planner can prove the partial predicate matches. That is already
-- the case — it is why chunks_hnsw_anatomiya is used at all.
--
-- SIZE ESTIMATE (1536 dims x 4 bytes = 6,144 B/vector, HNSW ~1.3x with m=16):
--     Физиология                    21,526 ->  172 MB
--     Фармакология                  20,295 ->  162 MB
--     Биохимия                      15,165 ->  121 MB
--     Патоанатомия и цитопатология  14,246 ->  114 MB
--     Микробиология                 13,859 ->  111 MB
--     Биология                      13,294 ->  106 MB
--     Хигиена, екология и проф.заб. 11,845 ->   95 MB
--     Патофизиология                 9,178 ->   73 MB
--     fzg/Анатомия                   3,469 ->   28 MB
--                                  122,877 -> ~982 MB total  (NOT the ~1.8 GB feared)
-- Already committed by the two existing indexes: 56,277 chunks -> ~449 MB.
--
-- HOW TO RUN — IMPORTANT:
--   CREATE INDEX CONCURRENTLY CANNOT run inside a transaction block, so this file has
--   NO BEGIN/COMMIT and MUST be run ONE STATEMENT AT A TIME in the SQL Editor.
--   Run section 0 first (headroom). Then, for each subject in order: run its CREATE,
--   then its VERIFY block, and only move on once indisvalid = true AND idx_scan > 0.
--   A CONCURRENTLY build that fails leaves an INVALID index behind that still consumes
--   space and is never used — section 3 shows how to find and drop those.
-- ============================================================================


-- ── 0. HEADROOM — run this BEFORE building anything ─────────────────────────
select pg_size_pretty(pg_database_size(current_database()))            as database_size,
       pg_size_pretty(pg_total_relation_size('chunks'))                as chunks_total,
       pg_size_pretty(pg_relation_size('chunks'))                      as chunks_heap,
       pg_size_pretty(pg_indexes_size('chunks'))                       as chunks_indexes;

select indexrelname,
       pg_size_pretty(pg_relation_size(indexrelid)) as size,
       idx_scan
from pg_stat_user_indexes
where relname = 'chunks'
order by pg_relation_size(indexrelid) desc;


-- ── 1. Session tuning for the builds (session-local; re-run per session) ─────
set maintenance_work_mem = '512MB';
set max_parallel_maintenance_workers = 2;
set statement_timeout = 0;


-- ── 2. The nine indexes, in p95 order (worst tail first) ────────────────────
-- 2.1  Фармакология — p50 343ms / p95 4866ms / 20,295 chunks
create index concurrently if not exists chunks_hnsw_farmakologiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Фармакология';

-- 2.2  Физиология — p50 354ms / p95 4375ms / 21,526 chunks
create index concurrently if not exists chunks_hnsw_fiziologiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Физиология';

-- 2.3  Микробиология — p50 269ms / p95 3061ms / 13,859 chunks
create index concurrently if not exists chunks_hnsw_mikrobiologiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Микробиология';

-- 2.4  Патоанатомия и цитопатология — p50 277ms / p95 2887ms / 14,246 chunks
create index concurrently if not exists chunks_hnsw_patoanatomiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Патоанатомия и цитопатология';

-- 2.5  Биохимия — p50 286ms / p95 2784ms / 15,165 chunks
create index concurrently if not exists chunks_hnsw_biohimiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Биохимия';

-- 2.6  Биология — p50 267ms / p95 2160ms / 13,294 chunks
create index concurrently if not exists chunks_hnsw_biologiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Биология';

-- 2.7  Хигиена, екология и професионални заболявания — p50 238ms / p95 1986ms / 11,845
create index concurrently if not exists chunks_hnsw_higiena
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Хигиена, екология и професионални заболявания';

-- 2.8  fzg/Анатомия — p50 133ms / p95 1896ms / 3,469 chunks (cheapest win: ~28 MB)
create index concurrently if not exists chunks_hnsw_fzg_anatomiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'fzg' and specialty_id = 'sestra' and subject = 'Анатомия';

-- 2.9  Патофизиология — p50 200ms / p95 1569ms / 9,178 chunks
create index concurrently if not exists chunks_hnsw_patofiziologiya
  on chunks using hnsw (embedding vector_cosine_ops) with (m = 16, ef_construction = 64)
  where faculty_id = 'medicina' and specialty_id = 'medicina' and subject = 'Патофизиология';


-- ── 3. VERIFY after EACH build — both checks, not just the first ────────────
-- chunks_hnsw_anatomiya sat at idx_scan = 0 for an hour because "the index exists"
-- was mistaken for "the index is used". indisvalid alone does not prove use.
select c.relname                                   as index_name,
       i.indisvalid,
       i.indisready,
       pg_size_pretty(pg_relation_size(c.oid))     as size,
       s.idx_scan,
       s.idx_tup_read
from pg_class c
join pg_index i on i.indexrelid = c.oid
left join pg_stat_user_indexes s on s.indexrelid = c.oid
where c.relname like 'chunks_hnsw%'
order by c.relname;

-- Any INVALID index is a failed CONCURRENTLY build: it occupies space, is never used,
-- and must be dropped before retrying.
--   drop index concurrently <name>;

-- After each build, re-run the app-side check so "used" is proven from the query path:
--   node scripts/bench-retrieval.mjs --all --label pass4 --runs 15
--   node scripts/bench-retrieval.mjs --compare pass3 pass4
-- Expect that subject's ms/1k to fall from ~16-22 to ~3, and its p95 to drop below 600ms.
-- If p95 does not move, the index is present but unused — check that match_chunks still
-- inlines the taxonomy literals, then re-read 0016's notes before changing anything else.
-- ============================================================================
