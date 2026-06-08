create extension if not exists pgcrypto;

create table if not exists public.stores (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  admin_key_hash text,
  created_at timestamptz not null default now()
);

create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  sort_order integer not null default 0,
  discountable_default boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.items (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  category_id uuid not null references public.categories(id) on delete restrict,
  name text not null,
  price integer not null default 0 check (price >= 0),
  discountable boolean not null default true,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.customers (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  name text not null,
  discount_rate numeric(5, 2) not null default 0 check (discount_rate >= 0 and discount_rate <= 100),
  vat_enabled boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  store_id uuid not null references public.stores(id) on delete cascade,
  customer_id uuid references public.customers(id) on delete set null,
  customer_name text not null,
  discount_rate numeric(5, 2) not null default 0,
  vat_enabled boolean not null default false,
  subtotal integer not null default 0,
  discount integer not null default 0,
  supply integer not null default 0,
  vat integer not null default 0,
  total integer not null default 0,
  printed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references public.sales(id) on delete cascade,
  item_id uuid references public.items(id) on delete set null,
  item_name text not null,
  quantity integer not null check (quantity > 0),
  price integer not null default 0 check (price >= 0),
  discountable boolean not null default true,
  line_total integer generated always as (quantity * price) stored
);

create index if not exists categories_store_sort_idx on public.categories(store_id, sort_order);
create index if not exists items_store_category_idx on public.items(store_id, category_id) where active = true;
create index if not exists customers_store_active_idx on public.customers(store_id) where active = true;
create index if not exists sales_store_created_idx on public.sales(store_id, created_at desc);
create index if not exists sale_lines_sale_idx on public.sale_lines(sale_id);

alter table public.stores enable row level security;
alter table public.categories enable row level security;
alter table public.items enable row level security;
alter table public.customers enable row level security;
alter table public.sales enable row level security;
alter table public.sale_lines enable row level security;

-- Safe default: do not grant anonymous table access.
-- The app can run locally without Supabase. Before cloud operation, add a
-- store-scoped admin-key RPC/session design and create narrow policies that
-- filter every table by the verified store_id.
drop policy if exists "anon can read stores" on public.stores;
drop policy if exists "anon can manage categories" on public.categories;
drop policy if exists "anon can manage items" on public.items;
drop policy if exists "anon can manage customers" on public.customers;
drop policy if exists "anon can manage sales" on public.sales;
drop policy if exists "anon can manage sale lines" on public.sale_lines;
