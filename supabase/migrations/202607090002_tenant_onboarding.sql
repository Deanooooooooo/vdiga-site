create or replace function public.create_tenant_onboarding(
  business_name text,
  niche text default null,
  city text default null,
  main_phone text default null,
  contact_email text default null,
  wants_booking boolean default false
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  current_user_id uuid := auth.uid();
  new_tenant_id uuid;
  clean_business_name text := nullif(trim(business_name), '');
begin
  if current_user_id is null then
    raise exception 'Authentication required';
  end if;

  if clean_business_name is null then
    raise exception 'Business name is required';
  end if;

  insert into public.tenants (name, status)
  values (clean_business_name, 'created')
  returning id into new_tenant_id;

  insert into public.tenant_members (tenant_id, user_id, role)
  values (new_tenant_id, current_user_id, 'owner');

  insert into public.business_profiles (
    tenant_id,
    business_name,
    niche,
    city,
    main_phone,
    contact_email
  )
  values (
    new_tenant_id,
    clean_business_name,
    nullif(trim(niche), ''),
    nullif(trim(city), ''),
    nullif(trim(main_phone), ''),
    nullif(trim(contact_email), '')
  );

  insert into public.audit_logs (tenant_id, actor_user_id, action, metadata)
  values (
    new_tenant_id,
    current_user_id,
    'tenant.created',
    jsonb_build_object('source', 'onboarding', 'wants_booking', wants_booking)
  );

  if wants_booking then
    insert into public.calendar_connections (tenant_id, provider, status, metadata)
    values (
      new_tenant_id,
      'cal.com',
      'pending',
      jsonb_build_object('created_from', 'onboarding')
    );
  end if;

  return new_tenant_id;
end;
$$;

grant execute on function public.create_tenant_onboarding(text, text, text, text, text, boolean) to authenticated;

