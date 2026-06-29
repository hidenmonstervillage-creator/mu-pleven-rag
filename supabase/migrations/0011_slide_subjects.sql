-- Migration 0011: slide_subjects junction table (many-to-many slides ↔ subjects)
--
-- Run order:
--   1. Run migration 0010 first (creates the slides table).
--      If 0010 was not applied yet, the CREATE TABLE IF NOT EXISTS below is safe.
--   2. Run this file.
--
-- The slides table keeps faculty_id / specialty_id / subject as nullable legacy
-- columns so the existing row (if any) is preserved, but the junction table is
-- now the authoritative source of truth for subject mappings.

-- ── Safety: ensure slides exists ─────────────────────────────────────────────
create table if not exists slides (
  id               uuid        primary key default gen_random_uuid(),
  record_id        integer     not null unique,
  slide_name       text        not null,
  organ            text,
  konspekt_number  text,
  stain            text,
  faculty_id       text,
  specialty_id     text,
  subject          text,
  olyvia_folder    text,
  created_at       timestamptz not null default now()
);

-- Drop NOT NULL from legacy subject-hierarchy columns (no-op if already nullable)
alter table slides
  alter column faculty_id   drop not null,
  alter column specialty_id drop not null,
  alter column subject      drop not null;

-- ── Junction table ───────────────────────────────────────────────────────────
create table if not exists slide_subjects (
  id           uuid        primary key default gen_random_uuid(),
  slide_id     uuid        not null references slides(id) on delete cascade,
  faculty_id   text        not null,
  specialty_id text        not null,
  subject      text        not null,
  created_at   timestamptz not null default now(),
  unique (slide_id, faculty_id, specialty_id, subject)
);

comment on table slide_subjects is
  'Many-to-many mapping between OlyVia slides and curriculum subjects.';

-- ── Migrate existing single-subject rows ─────────────────────────────────────
-- Safe to run even when slides is empty or when faculty_id is already null.
insert into slide_subjects (slide_id, faculty_id, specialty_id, subject)
select id, faculty_id, specialty_id, subject
from slides
where faculty_id   is not null
  and specialty_id is not null
  and subject      is not null
on conflict do nothing;
