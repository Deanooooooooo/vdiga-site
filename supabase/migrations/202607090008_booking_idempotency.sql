create unique index if not exists bookings_retell_call_id_unique_idx
  on public.bookings(call_id)
  where call_id is not null and source = 'retell';
