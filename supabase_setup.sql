-- Run this entire file in the Supabase SQL Editor (Project → SQL Editor → New query)

-- Step 1: Enable pgvector extension
create extension if not exists vector;

-- Step 2: Documents table (one row per uploaded file)
create table documents (
  id uuid primary key default gen_random_uuid(),
  filename text not null,
  clean_title text not null,
  file_type text not null check (file_type in ('textbook', 'lecture')),
  faculty_id text not null,
  specialty_id text not null,
  subject text not null,
  storage_url text,
  page_count integer,
  created_at timestamptz default now()
);

-- Step 3: Chunks table (one row per text chunk from a document)
create table chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  content text not null,
  page_number integer,
  chunk_index integer,
  embedding vector(1536),
  created_at timestamptz default now()
);

-- Step 4: IVFFlat index for fast cosine similarity search
create index on chunks using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- Step 5: RPC function for similarity search (called from /api/chat)
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
language sql stable
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
  join documents d on c.document_id = d.id
  where d.faculty_id = match_faculty
    and d.specialty_id = match_specialty
    and d.subject = match_subject
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- Step 6: Create a public Storage bucket named 'documents'
-- Do this in Supabase Dashboard → Storage → New bucket
-- Name: documents
-- Public: true (so storage_url links work without auth)
