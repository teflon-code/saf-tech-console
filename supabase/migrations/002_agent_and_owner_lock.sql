-- Account numbers, cancellations, complaints, AI chat log,
-- and owner-only access.

-- Account numbers that the AI and staff use to identify a customer.
alter table customers add column if not exists account_no text unique;
alter table customers add column if not exists status text not null default 'active'
  check (status in ('active', 'cancelled'));
alter table customers add column if not exists cancelled_at timestamptz;
alter table customers add column if not exists cancel_reason text;

-- Give existing customers account numbers, e.g. SAF-0001.
update customers
set account_no = 'SAF-' || lpad(id::text, 4, '0')
where account_no is null;

create table if not exists complaints (
  id bigint generated always as identity primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  summary text not null,
  status text not null default 'open' check (status in ('open', 'responded', 'resolved')),
  response text,
  created_at timestamptz not null default now(),
  responded_at timestamptz
);

-- Full chat history with the AI assistant. Every turn is kept.
create table if not exists ai_chats (
  id bigint generated always as identity primary key,
  session_id uuid not null,
  role text not null check (role in ('user', 'assistant', 'tool')),
  content text not null,
  tool_name text,
  tool_input jsonb,
  tool_result jsonb,
  created_at timestamptz not null default now()
);
create index if not exists ai_chats_session_idx on ai_chats(session_id, created_at);

alter table complaints enable row level security;
alter table ai_chats enable row level security;

-- Only the owner account may use the console. Everyone else is locked out.
do $$
declare t text;
begin
  foreach t in array array['packages','customers','leads','invoices','payments','messages','goals','marketing_channels','ai_summaries','ai_actions','audit_log']
  loop
    execute format('drop policy if exists "staff_all_%s" on %I;', t, t);
    execute format('create policy "owner_all_%s" on %I for all to authenticated using (auth.uid() = %L::uuid) with check (auth.uid() = %L::uuid);', t, t, 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2', 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2');
  end loop;
end $$;

create policy "owner_all_complaints" on complaints for all to authenticated
  using (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid)
  with check (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid);

create policy "owner_all_ai_chats" on ai_chats for all to authenticated
  using (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid)
  with check (auth.uid() = 'd3e8ee83-ab03-4b4a-a97e-8fc2112864c2'::uuid);
