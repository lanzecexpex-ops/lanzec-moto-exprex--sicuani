-- Un cliente solo puede tener UNA solicitud en espera (requested/countered).
-- Cuando un transportista la acepta o el cliente la cancela, puede pedir otra.
-- Ejecutar en Supabase > SQL Editor.
create or replace function public.open_services_count(p_uid uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.services
  where client_id = p_uid and status in ('requested','countered');
$$;

drop policy if exists services_insert on public.services;
create policy services_insert on public.services for insert to authenticated
  with check (
    client_id = auth.uid() and status = 'requested'
    and transporter_id is null and final_price is null
    and exists (select 1 from public.profiles p
                where p.id = auth.uid() and p.role = 'client' and p.account_status = 'active')
    and public.has_active_sub(auth.uid())
    and public.open_services_count(auth.uid()) < 1
  );
