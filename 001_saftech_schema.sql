-- SAF-TECH Operations Console schema
-- Mirrors the data shape used in SAF-TECH_Operations_Console.html

create table if not exists packages (
  name text primary key,
  monthly_price integer not null
);

insert into packages (name, monthly_price) values
  ('Bronze', 2000), ('Silver', 2500), ('Gold', 3000), ('Premium', 4500)
on conflict (name) do nothing;

create table if not exists customers (
  id bigint generated always as identity primary key,
  name text not null,
  phone text,
  email text,
  package text references packages(name),
  service text not null default 'PPPoE' check (service in ('PPPoE', 'Hotspot')),
  stage text not null default 'Onboarding' check (stage in ('Onboarding', 'Active', 'Upsell', 'At risk')),
  last_contact date,
  pppoe_username text,
  pppoe_password text,
  location text,
  national_id text,
  alternate_contact text,
  installed_on date,
  equipment_serial text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists leads (
  id bigint generated always as identity primary key,
  name text not null,
  source text,
  package text references packages(name),
  stage integer not null default 0 check (stage between 0 and 4),
  customer_id bigint references customers(id),
  created_at timestamptz not null default now()
);

create table if not exists invoices (
  id bigint generated always as identity primary key,
  customer_id bigint not null references customers(id) on delete cascade,
  billing_month text not null,
  status text not null default 'Due' check (status in ('Due', 'Overdue')),
  created_at timestamptz not null default now(),
  unique (customer_id, billing_month)
);

create table if not exists payments (
  id bigint generated always as identity primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  amount integer not null check (amount > 0),
  method text not null check (method in ('Mobile money', 'Cash', 'Bank transfer')),
  paid_on date not null,
  created_at timestamptz not null default now()
);

create table if not exists messages (
  id bigint generated always as identity primary key,
  channel text not null check (channel in ('SMS', 'WhatsApp')),
  audience text not null,
  recipient_count integer not null,
  body text not null,
  sent_at timestamptz not null default now()
);

create table if not exists goals (
  id bigint generated always as identity primary key,
  title text not null,
  current_value numeric not null,
  target_value numeric not null,
  unit text default '',
  lower_is_better boolean not null default false,
  minimum_value numeric
);

create table if not exists marketing_channels (
  id bigint generated always as identity primary key,
  name text not null,
  description text,
  spend integer not null,
  leads integer not null,
  customers integer not null
);

-- AI layer
-- The AI never writes business data directly. It proposes an action,
-- which sits in ai_actions until a staff member approves or rejects it.
create table if not exists ai_summaries (
  id bigint generated always as identity primary key,
  scope text not null,
  content text not null,
  created_at timestamptz not null default now()
);

create table if not exists ai_actions (
  id bigint generated always as identity primary key,
  action_type text not null check (action_type in ('send_message', 'set_stage', 'mark_paid', 'create_invoices')),
  payload jsonb not null,
  rationale text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
  requested_by text,
  decided_by uuid references auth.users(id),
  decided_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigint generated always as identity primary key,
  actor text not null,
  event text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Row level security: only signed-in staff can read or write.
alter table packages enable row level security;
alter table customers enable row level security;
alter table leads enable row level security;
alter table invoices enable row level security;
alter table payments enable row level security;
alter table messages enable row level security;
alter table goals enable row level security;
alter table marketing_channels enable row level security;
alter table ai_summaries enable row level security;
alter table ai_actions enable row level security;
alter table audit_log enable row level security;

do $$
declare t text;
begin
  foreach t in array array['packages','customers','leads','invoices','payments','messages','goals','marketing_channels','ai_summaries','ai_actions','audit_log']
  loop
    execute format('create policy "staff_all_%s" on %I for all to authenticated using (true) with check (true);', t, t);
  end loop;
end $$;

-- Customers' Wi-Fi and PPPoE passwords should not be readable through the
-- public API by ordinary staff. Restrict them to the admin role if you add roles later.
