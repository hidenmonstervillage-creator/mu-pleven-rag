-- Migration 0010: slides catalog table
-- Stores the admin-curated list of OlyVia microscope slides and their
-- mapping to the canonical faculty/specialty/subject hierarchy.
-- Apply via: Supabase SQL Editor → New query → paste → Run

create table if not exists slides (
  id               uuid        primary key default gen_random_uuid(),
  record_id        integer     not null unique,
  slide_name       text        not null,
  organ            text,
  konspekt_number  text,
  stain            text,
  faculty_id       text        not null,
  specialty_id     text        not null,
  subject          text        not null,
  olyvia_folder    text,
  created_at       timestamptz not null default now()
);

-- No RLS — consistent with documents/chunks tables in this project.
-- The admin routes use the service-role key; the student-facing route
-- (task 3) will also use the service-role key server-side.

comment on table slides is
  'OlyVia microscope slide catalog — one row per slide registered by an admin.';
comment on column slides.record_id is
  'OlyVia Net Image Server recordId (integer), e.g. 21236.';
comment on column slides.konspekt_number is
  'Syllabus number from the slide name (text, e.g. "18a"), for student search.';
comment on column slides.olyvia_folder is
  'Source folder path on the OlyVia server for reference, e.g. "Anatomy/Practice 1".';
