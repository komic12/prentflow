-- Run this once in the Supabase SQL editor.
-- Application records are kept in JSONB so the existing PrintFlow data API
-- can move from local JSON/Firebase without changing every route at once.
create table if not exists public.printflow_records (
    collection text not null,
    id text not null,
    data jsonb not null,
    created_at timestamptz not null default now(),
    primary key (collection, id)
);

create index if not exists printflow_records_collection_idx
    on public.printflow_records (collection);

alter table public.printflow_records enable row level security;

-- The backend uses the service-role key, so browser clients cannot read this table directly.