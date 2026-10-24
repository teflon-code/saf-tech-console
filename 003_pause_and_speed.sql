-- Subscription pause, speed-test history, and customer detail support.

alter table customers drop constraint if exists customers_status_check;
alter table customers add constraint customers_status_check check (status in ('active', 'paused', 'cancelled'));
alter table customers add column if not exists paused_at timestamptz;
alter table customers add column if not exists pause_reason text;

-- Speed-test history per customer (entered from the router or a speed test).
create table if not exists speed_tests (
  id bigint generated always as identity primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  download_mbps numeric not null,
  upload_mbps numeric not null,
  latency_ms numeric,
  tested_at timestamptz not null default now()
);
alter table speed_tests enable row level security;
create policy "owner_all_speed_tests" on speed_tests for all to authenticated
  using (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid)
  with check (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid);
create index if not exists speed_tests_customer_idx on speed_tests(customer_id, tested_at desc);
