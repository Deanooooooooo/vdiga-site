create table if not exists public.calendar_oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  calendar_connection_id uuid not null references public.calendar_connections(id) on delete cascade,
  provider text not null,
  access_token text,
  refresh_token text,
  token_type text,
  scope text,
  expires_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (calendar_connection_id, provider)
);

create trigger calendar_oauth_tokens_set_updated_at
  before update on public.calendar_oauth_tokens
  for each row execute function public.set_updated_at();

alter table public.calendar_oauth_tokens enable row level security;

create index if not exists calendar_oauth_tokens_tenant_id_idx
  on public.calendar_oauth_tokens(tenant_id);

create index if not exists calendar_oauth_tokens_connection_id_idx
  on public.calendar_oauth_tokens(calendar_connection_id);
