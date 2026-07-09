alter table public.calendar_connections
  add column if not exists mode text not null default 'not_configured',
  add column if not exists token_vault_ref text,
  add column if not exists selected_calendar_id text,
  add column if not exists selected_calendar_name text,
  add column if not exists last_connected_at timestamptz;

alter table public.booking_event_types
  add column if not exists service_key text,
  add column if not exists allowed_resource_ids uuid[] not null default '{}'::uuid[];

alter table public.bookings
  add column if not exists calendar_resource_id uuid,
  add column if not exists external_calendar_event_id text,
  add column if not exists requested_resource_name text,
  add column if not exists assigned_resource_name text,
  add column if not exists source text not null default 'retell';

create table if not exists public.calendar_resources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  calendar_connection_id uuid references public.calendar_connections(id) on delete cascade,
  name text not null,
  role text,
  provider_calendar_id text,
  provider_calendar_name text,
  provider_account_email text,
  services text[] not null default '{}'::text[],
  active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.calendar_integration_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  provider_requested text not null,
  software_name text,
  contact_email text,
  notes text,
  status text not null default 'new',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'bookings_calendar_resource_id_fkey'
  ) then
    alter table public.bookings
      add constraint bookings_calendar_resource_id_fkey
      foreign key (calendar_resource_id)
      references public.calendar_resources(id)
      on delete set null;
  end if;
end;
$$;

create trigger calendar_resources_set_updated_at
  before update on public.calendar_resources
  for each row execute function public.set_updated_at();

create trigger calendar_integration_requests_set_updated_at
  before update on public.calendar_integration_requests
  for each row execute function public.set_updated_at();

alter table public.calendar_resources enable row level security;
alter table public.calendar_integration_requests enable row level security;

create policy "Tenant admins can manage calendar connections"
  on public.calendar_connections
  for all to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create policy "Tenant members can read calendar resources"
  on public.calendar_resources
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Tenant admins can manage calendar resources"
  on public.calendar_resources
  for all to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create policy "Tenant members can read calendar integration requests"
  on public.calendar_integration_requests
  for select to authenticated
  using (public.is_tenant_member(tenant_id));

create policy "Tenant admins can manage calendar integration requests"
  on public.calendar_integration_requests
  for all to authenticated
  using (public.is_tenant_admin(tenant_id))
  with check (public.is_tenant_admin(tenant_id));

create index if not exists calendar_connections_tenant_id_status_idx
  on public.calendar_connections(tenant_id, status);

create index if not exists calendar_resources_tenant_id_idx
  on public.calendar_resources(tenant_id);

create index if not exists calendar_resources_connection_id_idx
  on public.calendar_resources(calendar_connection_id);

create index if not exists calendar_integration_requests_tenant_id_idx
  on public.calendar_integration_requests(tenant_id);
