-- Eleven 50 个单人账号：云端存档表 + 私有 bucket
-- 在 Supabase SQL Editor 里整段执行。

create table if not exists public.vault_meta (
  user_id uuid primary key references auth.users(id) on delete cascade,
  path text not null,
  rev bigint not null default 0,
  bytes bigint,
  updated_at timestamptz not null default now()
);

alter table public.vault_meta enable row level security;
drop policy if exists "own vault meta" on public.vault_meta;
create policy "own vault meta"
on public.vault_meta for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

insert into storage.buckets (id, name, public)
values ('vault', 'vault', false)
on conflict (id) do nothing;

drop policy if exists "vault read own" on storage.objects;
create policy "vault read own"
on storage.objects for select
using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault insert own" on storage.objects;
create policy "vault insert own"
on storage.objects for insert
with check (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault update own" on storage.objects;
create policy "vault update own"
on storage.objects for update
using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "vault delete own" on storage.objects;
create policy "vault delete own"
on storage.objects for delete
using (bucket_id = 'vault' and (storage.foldername(name))[1] = auth.uid()::text);

-- 可选：把账号数量硬限制在 50
-- 先建 profiles 表（如果你以后要显示昵称）
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  account text unique,
  nickname text,
  status text not null default 'active',
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;
drop policy if exists "own profile" on public.profiles;
drop policy if exists "own profile read" on public.profiles;
create policy "own profile read"
on public.profiles for select
using (auth.uid() = id);
