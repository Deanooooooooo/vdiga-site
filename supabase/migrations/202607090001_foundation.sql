create extension if not exists pgcrypto;

create type public.tenant_status as enum (
  'created',
  'paid',
  'provisioning',
  'forwarding_pending',
  'testing',
  'active',
  'failed',
  'suspended'
);

create type public.member_role as enum ('owner', 'admin', 'member');
create type public.provisioning_job_status as enum ('queued', 'running', 'waiting_for_customer', 'succeeded', 'failed', 'canceled');
create type public.phone_number_status as enum ('available', 'reserved', 'provisioning', 'forwarding_pending', 'testing', 'active', 'failed', 'suspended');
create type public.call_status as enum ('started', 'ended', 'analyzed', 'failed');

create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text unique,
  status public.tenant_status not null default 'created',
  stripe_customer_id text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id)
);

create table public.business_profiles (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null unique references public.tenants(id) on delete cascade,
  business_name text not null,
  niche text,
  city text,
  address text,
  main_phone text,
  contact_email text,
  transfer_phone text,
  timezone text not null default 'Europe/Sofia',
  working_hours jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  stripe_subscription_id text unique,
  plan_key text not null,
  status text not null default 'incomplete',
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index subscriptions_tenant_id_unique_idx on public.subscriptions(tenant_id);

create table public.phone_numbers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  original_business_number text,
  didww_number text unique,
  didww_did_id text unique,
  didww_trunk_id text,
  didww_trunk_group_id text,
  retell_phone_number text,
  retell_phone_number_id text,
  retell_agent_id text,
  status public.phone_number_status not null default 'available',
  last_test_call_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.retell_agents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retell_agent_id text not null unique,
  template_key text not null,
  nickname text,
  language text not null default 'bg-BG',
  webhook_url text,
  status text not null default 'draft',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calls (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  retell_call_id text unique,
  phone_number_id uuid references public.phone_numbers(id) on delete set null,
  from_number text,
  to_number text,
  status public.call_status not null default 'started',
  started_at timestamptz,
  ended_at timestamptz,
  duration_seconds integer,
  transcript text,
  summary text,
  recording_url text,
  analysis jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.call_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete cascade,
  provider text not null default 'retell',
  event_type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create table public.leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete set null,
  name text,
  phone text,
  email text,
  intent text,
  notes text,
  status text not null default 'new',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.calendar_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider text not null default 'cal.com',
  provider_account_id text,
  connected_email text,
  status text not null default 'pending',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.booking_event_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  calendar_connection_id uuid references public.calendar_connections(id) on delete set null,
  provider_event_type_id text,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  buffer_before_minutes integer not null default 0,
  buffer_after_minutes integer not null default 0,
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  call_id uuid references public.calls(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  booking_event_type_id uuid references public.booking_event_types(id) on delete set null,
  provider text not null default 'cal.com',
  provider_booking_id text,
  customer_name text,
  customer_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status text not null default 'confirmed',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.provisioning_jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  status public.provisioning_job_status not null default 'queued',
  step text not null default 'created',
  attempts integer not null default 0,
  last_error text,
  payload jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid references public.tenants(id) on delete set null,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  target_table text,
  target_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger tenants_set_updated_at before update on public.tenants for each row execute function public.set_updated_at();
create trigger business_profiles_set_updated_at before update on public.business_profiles for each row execute function public.set_updated_at();
create trigger subscriptions_set_updated_at before update on public.subscriptions for each row execute function public.set_updated_at();
create trigger phone_numbers_set_updated_at before update on public.phone_numbers for each row execute function public.set_updated_at();
create trigger retell_agents_set_updated_at before update on public.retell_agents for each row execute function public.set_updated_at();
create trigger calls_set_updated_at before update on public.calls for each row execute function public.set_updated_at();
create trigger leads_set_updated_at before update on public.leads for each row execute function public.set_updated_at();
create trigger calendar_connections_set_updated_at before update on public.calendar_connections for each row execute function public.set_updated_at();
create trigger booking_event_types_set_updated_at before update on public.booking_event_types for each row execute function public.set_updated_at();
create trigger bookings_set_updated_at before update on public.bookings for each row execute function public.set_updated_at();
create trigger provisioning_jobs_set_updated_at before update on public.provisioning_jobs for each row execute function public.set_updated_at();

create or replace function public.is_tenant_member(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_members
    where tenant_id = target_tenant_id and user_id = auth.uid()
  );
$$;

create or replace function public.is_tenant_admin(target_tenant_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.tenant_members
    where tenant_id = target_tenant_id
      and user_id = auth.uid()
      and role in ('owner', 'admin')
  );
$$;

alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.business_profiles enable row level security;
alter table public.subscriptions enable row level security;
alter table public.phone_numbers enable row level security;
alter table public.retell_agents enable row level security;
alter table public.calls enable row level security;
alter table public.call_events enable row level security;
alter table public.leads enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.booking_event_types enable row level security;
alter table public.bookings enable row level security;
alter table public.provisioning_jobs enable row level security;
alter table public.audit_logs enable row level security;

create policy "Members can read their tenants" on public.tenants for select to authenticated using (public.is_tenant_member(id));
create policy "Admins can update their tenants" on public.tenants for update to authenticated using (public.is_tenant_admin(id)) with check (public.is_tenant_admin(id));
create policy "Users can read their memberships" on public.tenant_members for select to authenticated using (user_id = auth.uid() or public.is_tenant_admin(tenant_id));
create policy "Tenant members can read business profiles" on public.business_profiles for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant admins can update business profiles" on public.business_profiles for update to authenticated using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy "Tenant members can read subscriptions" on public.subscriptions for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read phone numbers" on public.phone_numbers for select to authenticated using (tenant_id is not null and public.is_tenant_member(tenant_id));
create policy "Tenant members can read retell agents" on public.retell_agents for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read calls" on public.calls for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read call events" on public.call_events for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read leads" on public.leads for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant admins can update leads" on public.leads for update to authenticated using (public.is_tenant_admin(tenant_id)) with check (public.is_tenant_admin(tenant_id));
create policy "Tenant members can read calendar connections" on public.calendar_connections for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read booking event types" on public.booking_event_types for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read bookings" on public.bookings for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read provisioning jobs" on public.provisioning_jobs for select to authenticated using (public.is_tenant_member(tenant_id));
create policy "Tenant members can read audit logs" on public.audit_logs for select to authenticated using (tenant_id is not null and public.is_tenant_member(tenant_id));

create index tenant_members_user_id_idx on public.tenant_members(user_id);
create index subscriptions_tenant_id_idx on public.subscriptions(tenant_id);
create index phone_numbers_tenant_id_idx on public.phone_numbers(tenant_id);
create index phone_numbers_didww_number_idx on public.phone_numbers(didww_number);
create index retell_agents_tenant_id_idx on public.retell_agents(tenant_id);
create index calls_tenant_id_created_at_idx on public.calls(tenant_id, created_at desc);
create index calls_retell_call_id_idx on public.calls(retell_call_id);
create index call_events_tenant_id_created_at_idx on public.call_events(tenant_id, created_at desc);
create index leads_tenant_id_created_at_idx on public.leads(tenant_id, created_at desc);
create index bookings_tenant_id_starts_at_idx on public.bookings(tenant_id, starts_at desc);
create index provisioning_jobs_tenant_id_created_at_idx on public.provisioning_jobs(tenant_id, created_at desc);
