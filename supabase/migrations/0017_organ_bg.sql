-- ============================================================================
-- Migration 0017 — Bulgarian organ names on slides
-- ============================================================================
--
-- Adds a nullable Bulgarian-name column to slides. Displayed in the student
-- slide panel and viewer as "Latin / Български" (e.g. "Oesophagus / Хранопровод").
-- Populated separately by scripts/update-organ-bg.mjs from a reviewed dictionary.
--
-- Safe/idempotent. HOW TO RUN: paste into Supabase SQL Editor and Run. Instant.
-- ============================================================================

alter table slides add column if not exists organ_bg text;

comment on column slides.organ_bg is
  'Bulgarian anatomical/pathology name for the slide''s organ. Shown as "Latin / Български"; null → Latin only.';
