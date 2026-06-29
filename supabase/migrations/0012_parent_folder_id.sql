-- Migration 0012: add parent_folder_id to slides
-- Direct OlyVia parent container ID — used for bulk subject assignment by folder group.
-- Apply via: Supabase SQL Editor → New query → paste → Run

alter table slides add column if not exists parent_folder_id integer;

comment on column slides.parent_folder_id is
  'Direct OlyVia parent container ID — key for grouping slides and bulk subject assignment.';
