create or replace function public.dev_activate_subscription()
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_tenant_id uuid;
  target_subscription_id uuid;
  new_job_id uuid;
begin
  if current_user_id is null then
    raise exception 'Authentication required';
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

  select s.id
    into target_subscription_id
  from public.subscriptions s
  where s.tenant_id = target_tenant_id
  order by s.created_at desc
  limit 1;

  if target_subscription_id is null then
    raise exception 'Subscription not found';
  end if;

  update public.subscriptions
  set status = 'active',
      updated_at = now()
  where id = target_subscription_id;

  update public.tenants
  set status = 'paid',
      updated_at = now()
  where id = target_tenant_id;

  insert into public.provisioning_jobs (
    tenant_id,
    status,
    step,
    payload,
    started_at
  )
  values (
    target_tenant_id,
    'queued',
    'queued',
    jsonb_build_object('source', 'dev_activation', 'subscription_id', target_subscription_id),
    now()
  )
  returning id into new_job_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, metadata)
  values (
    target_tenant_id,
    current_user_id,
    'subscription.dev_activated',
    jsonb_build_object('subscription_id', target_subscription_id, 'provisioning_job_id', new_job_id)
  );

  return new_job_id;
end;
$$;

grant execute on function public.dev_activate_subscription() to authenticated;

create or replace function public.dev_update_provisioning_step(next_step text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  target_tenant_id uuid;
  target_job_id uuid;
  normalized_step text := nullif(trim(next_step), '');
  next_status public.provisioning_job_status := 'running';
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if normalized_step not in (
    'queued',
    'running',
    'assigning_number',
    'configuring_didww',
    'creating_retell_agent',
    'importing_retell_number',
    'forwarding_pending',
    'testing',
    'active',
    'failed'
  ) then
    raise exception 'Invalid provisioning step';
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

  select pj.id
    into target_job_id
  from public.provisioning_jobs pj
  where pj.tenant_id = target_tenant_id
  order by pj.created_at desc
  limit 1;

  if target_job_id is null then
    raise exception 'Provisioning job not found';
  end if;

  if normalized_step = 'forwarding_pending' then
    next_status := 'waiting_for_customer';
  elsif normalized_step = 'active' then
    next_status := 'succeeded';
  elsif normalized_step = 'failed' then
    next_status := 'failed';
  elsif normalized_step = 'queued' then
    next_status := 'queued';
  else
    next_status := 'running';
  end if;

  update public.provisioning_jobs
  set step = normalized_step,
      status = next_status,
      finished_at = case when next_status in ('succeeded', 'failed', 'canceled') then now() else finished_at end,
      updated_at = now()
  where id = target_job_id;

  update public.tenants
  set status = case
      when normalized_step = 'forwarding_pending' then 'forwarding_pending'::public.tenant_status
      when normalized_step = 'testing' then 'testing'::public.tenant_status
      when normalized_step = 'active' then 'active'::public.tenant_status
      when normalized_step = 'failed' then 'failed'::public.tenant_status
      else status
    end,
    updated_at = now()
  where id = target_tenant_id;

  insert into public.audit_logs (tenant_id, actor_user_id, action, metadata)
  values (
    target_tenant_id,
    current_user_id,
    'provisioning.dev_step_updated',
    jsonb_build_object('provisioning_job_id', target_job_id, 'step', normalized_step, 'status', next_status)
  );

  return target_job_id;
end;
$$;

grant execute on function public.dev_update_provisioning_step(text) to authenticated;

