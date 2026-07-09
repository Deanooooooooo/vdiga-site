alter table public.call_events
  add column if not exists dedupe_key text;

create unique index if not exists call_events_dedupe_key_idx
  on public.call_events(dedupe_key);

create index if not exists retell_agents_retell_agent_id_idx
  on public.retell_agents(retell_agent_id);

create index if not exists phone_numbers_retell_phone_number_idx
  on public.phone_numbers(retell_phone_number);

create unique index if not exists leads_call_id_unique_idx
  on public.leads(call_id);
