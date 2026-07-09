create unique index if not exists subscriptions_tenant_id_unique_idx on public.subscriptions(tenant_id);

create or replace function public.select_subscription_plan(plan_key text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_tenant_id uuid;
  subscription_id uuid;
  normalized_plan_key text := nullif(trim(plan_key), '');
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if normalized_plan_key not in ('start', 'booking', 'multilingual') then
    raise exception 'Invalid plan';
  end if;

  select tm.tenant_id
    into target_tenant_id
  from public.tenant_members tm
  where tm.user_id = current_user_id
    and tm.role in ('owner', 'admin')
  order by tm.created_at asc
  limit 1;

  if target_tenant_id is null then
    raise exception 'Tenant not found';
  end if;

  insert into public.subscriptions (tenant_id, plan_key, status)
  values (target_tenant_id, normalized_plan_key, 'pending_payment')
  on conflict (tenant_id) do update
    set plan_key = excluded.plan_key,
        status = 'pending_payment',
        updated_at = now()
  returning id into subscription_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, metadata)
  values (
    target_tenant_id,
    current_user_id,
    'subscription.plan_selected',
    jsonb_build_object('plan_key', normalized_plan_key)
  );

  return subscription_id;
end;
$$;

grant execute on function public.select_subscription_plan(text) to authenticated;
