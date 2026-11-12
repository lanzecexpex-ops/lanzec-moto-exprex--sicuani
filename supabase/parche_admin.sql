-- =====================================================================
-- PARCHE: PODERES DE ADMINISTRADOR
-- Ejecutar completo en Supabase > SQL Editor. No borra datos. Se puede repetir.
-- Todas las funciones verifican is_admin() y quedan en el registro de auditoría.
-- =====================================================================

-- Activar un plan a un usuario (si tiene un pago pendiente, lo aprueba con el plan elegido)
create or replace function public.admin_activate_subscription(p_user uuid, p_plan text) returns void
language plpgsql security definer set search_path = public as $$
declare r text; a numeric; d int; base timestamptz; pend uuid;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if p_plan not in ('weekly','monthly') then raise exception 'Plan inválido.'; end if;
  select role into r from public.profiles where id = p_user;
  if r is null or r = 'admin' then raise exception 'Usuario no válido para suscripción.'; end if;
  a := case when r = 'client' then (case p_plan when 'weekly' then 2 else 10 end)
                              else (case p_plan when 'weekly' then 8 else 25 end) end;
  d := case p_plan when 'weekly' then 7 else 30 end;
  select coalesce(max(expires_at), now()) into base
    from public.subscriptions where user_id = p_user and status = 'active' and expires_at > now();
  select id into pend from public.subscriptions where user_id = p_user and status = 'pending' for update;
  if pend is not null then
    update public.subscriptions
       set plan = p_plan, amount = a, days = d, status = 'active', starts_at = base,
           expires_at = base + make_interval(days => d), reviewed_by = auth.uid(), reviewed_at = now()
     where id = pend;
  else
    insert into public.subscriptions(user_id, plan, amount, days, status, starts_at, expires_at, reviewed_by, reviewed_at)
    values (p_user, p_plan, a, d, 'active', base, base + make_interval(days => d), auth.uid(), now());
  end if;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'subscription_granted', 'user', p_user, jsonb_build_object('plan', p_plan, 'amount', a));
end $$;

-- Sumar o restar días a la suscripción vigente
create or replace function public.admin_adjust_subscription(p_user uuid, p_days int) returns void
language plpgsql security definer set search_path = public as $$
declare sid uuid;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if p_days is null or p_days = 0 or abs(p_days) > 365 then raise exception 'Días inválidos (entre -365 y 365).'; end if;
  select id into sid from public.subscriptions
   where user_id = p_user and status = 'active' order by expires_at desc limit 1 for update;
  if sid is null then raise exception 'No hay suscripción activa para ajustar.'; end if;
  update public.subscriptions set expires_at = expires_at + make_interval(days => p_days) where id = sid;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'subscription_adjusted', 'user', p_user, jsonb_build_object('days', p_days));
end $$;

-- Quitar la suscripción vigente (vence ahora)
create or replace function public.admin_revoke_subscription(p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  update public.subscriptions set expires_at = now()
   where user_id = p_user and status = 'active' and expires_at > now();
  if not found then raise exception 'No hay suscripción vigente.'; end if;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'subscription_revoked', 'user', p_user, null);
end $$;

-- Cambiar el estado de un servicio
create or replace function public.admin_set_service_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.services%rowtype;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if p_status not in ('accepted','in_progress','completed','cancelled') then raise exception 'Estado inválido.'; end if;
  select * into s from public.services where id = p_id for update;
  if not found then raise exception 'Servicio no encontrado.'; end if;
  if p_status <> 'cancelled' and s.transporter_id is null then
    raise exception 'Asigna un transportista antes de cambiar el estado.';
  end if;
  update public.services
     set status = p_status,
         final_price = case when p_status = 'cancelled' then final_price else coalesce(final_price, proposed_price) end,
         updated_at = now()
   where id = p_id;
  update public.offers set status = 'rejected' where service_id = p_id and status = 'pending';
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'service_status', 'service', p_id, jsonb_build_object('from', s.status, 'to', p_status));
end $$;

-- Asignar (o reasignar) un transportista a un servicio
create or replace function public.admin_assign_service(p_id uuid, p_transporter uuid) returns void
language plpgsql security definer set search_path = public as $$
declare s public.services%rowtype; offer_price numeric;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  select * into s from public.services where id = p_id for update;
  if not found then raise exception 'Servicio no encontrado.'; end if;
  if s.status not in ('requested','accepted') then raise exception 'Solo se puede asignar si está solicitado o aceptado.'; end if;
  if not exists (select 1 from public.profiles p
                   join public.transporter_profiles t on t.user_id = p.id
                  where p.id = p_transporter and p.role = 'transporter' and p.account_status = 'active'
                    and s.service_type = any(t.service_types)) then
    raise exception 'Ese transportista no está activo o no ofrece este tipo de servicio.';
  end if;
  select price into offer_price from public.offers
   where service_id = p_id and transporter_id = p_transporter and status = 'pending';
  update public.services
     set transporter_id = p_transporter, status = 'accepted',
         final_price = coalesce(offer_price, final_price, proposed_price), updated_at = now()
   where id = p_id;
  update public.offers
     set status = case when transporter_id = p_transporter then 'accepted' else 'rejected' end
   where service_id = p_id and status = 'pending';
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'service_assigned', 'service', p_id, jsonb_build_object('transporter_id', p_transporter));
end $$;

-- Editar nombre y celular de un usuario
create or replace function public.admin_update_profile(p_user uuid, p_full_name text, p_phone text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if char_length(trim(coalesce(p_full_name, ''))) not between 2 and 120 then raise exception 'Nombre inválido (2 a 120 letras).'; end if;
  if char_length(trim(coalesce(p_phone, ''))) not between 6 and 20 then raise exception 'Celular inválido (6 a 20 dígitos).'; end if;
  update public.profiles set full_name = trim(p_full_name), phone = trim(p_phone) where id = p_user;
  if not found then raise exception 'Usuario no encontrado.'; end if;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'profile_edited', 'user', p_user, null);
end $$;

revoke all on function public.admin_activate_subscription(uuid, text) from public, anon;
revoke all on function public.admin_adjust_subscription(uuid, int)    from public, anon;
revoke all on function public.admin_revoke_subscription(uuid)         from public, anon;
revoke all on function public.admin_set_service_status(uuid, text)    from public, anon;
revoke all on function public.admin_assign_service(uuid, uuid)        from public, anon;
revoke all on function public.admin_update_profile(uuid, text, text)  from public, anon;
grant execute on function public.admin_activate_subscription(uuid, text) to authenticated;
grant execute on function public.admin_adjust_subscription(uuid, int)    to authenticated;
grant execute on function public.admin_revoke_subscription(uuid)         to authenticated;
grant execute on function public.admin_set_service_status(uuid, text)    to authenticated;
grant execute on function public.admin_assign_service(uuid, uuid)        to authenticated;
grant execute on function public.admin_update_profile(uuid, text, text)  to authenticated;
