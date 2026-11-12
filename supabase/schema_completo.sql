-- =====================================================================
-- LANZEC MOTO EXPRESS - Esquema Supabase (idempotente: se puede re-ejecutar)
-- Ejecutar completo en Supabase > SQL Editor > New query > Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- TABLAS
-- ---------------------------------------------------------------------
create table if not exists public.profiles (
  id             uuid primary key references auth.users(id) on delete cascade,
  role           text not null default 'client' check (role in ('client','transporter','admin')),
  account_status text not null default 'active' check (account_status in ('pending','active','suspended','rejected')),
  email          text not null,
  full_name      text not null check (char_length(full_name) between 2 and 120),
  age            int  check (age between 15 and 100),
  dni            text unique check (dni ~ '^[0-9]{8}$'),
  phone          text check (char_length(phone) between 6 and 20),
  created_at     timestamptz not null default now()
);

create table if not exists public.transporter_profiles (
  user_id          uuid primary key references public.profiles(id) on delete cascade,
  motorcycle       text not null check (char_length(motorcycle) between 2 and 100),
  plate            text not null check (char_length(plate) between 3 and 12),
  motorcycle_color text not null check (char_length(motorcycle_color) between 2 and 40),
  service_types    text[] not null check (
                     cardinality(service_types) > 0
                     and service_types <@ array['mototaxi','delivery']::text[]),
  photo_path       text,
  created_at       timestamptz not null default now()
);

create table if not exists public.subscriptions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  plan        text not null check (plan in ('weekly','monthly')),
  amount      numeric(8,2) not null,
  days        int not null,
  status      text not null default 'pending' check (status in ('pending','active','rejected')),
  starts_at   timestamptz,
  expires_at  timestamptz,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index if not exists one_pending_sub_per_user on public.subscriptions(user_id) where status = 'pending';
create index if not exists subs_user_status_idx on public.subscriptions(user_id, status);

create table if not exists public.services (
  id              uuid primary key default gen_random_uuid(),
  client_id       uuid not null references public.profiles(id) on delete cascade,
  transporter_id  uuid references public.profiles(id) on delete set null,
  service_type    text not null check (service_type in ('mototaxi','delivery')),
  origin          text not null check (char_length(origin) between 3 and 300),
  origin_reference text check (char_length(origin_reference) <= 200),
  destination     text not null check (char_length(destination) between 3 and 300),
  payment_method  text not null check (payment_method in ('Efectivo','Yape','Plin')),
  note            text check (char_length(note) <= 400),
  proposed_price  numeric(8,2) not null check (proposed_price between 0.5 and 500),
  final_price     numeric(8,2),
  client_name     text,
  status          text not null default 'requested'
                  check (status in ('requested','accepted','in_progress','completed','cancelled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists services_status_type_idx on public.services(status, service_type);
create index if not exists services_client_idx on public.services(client_id);
create index if not exists services_transporter_idx on public.services(transporter_id);

-- Migración (si ya habías ejecutado una versión anterior): quitar flujo de contraoferta única
drop policy if exists services_insert on public.services;
update public.services set status = 'requested', transporter_id = null where status = 'countered';
alter table public.services drop constraint if exists services_status_check;
alter table public.services add constraint services_status_check
  check (status in ('requested','accepted','in_progress','completed','cancelled'));
alter table public.services drop column if exists counter_price;
drop function if exists public.counter_service(uuid, numeric);
drop function if exists public.respond_counter(uuid, boolean);

create table if not exists public.offers (
  id             uuid primary key default gen_random_uuid(),
  service_id     uuid not null references public.services(id) on delete cascade,
  transporter_id uuid not null references public.profiles(id) on delete cascade,
  price          numeric(8,2) not null check (price between 0.5 and 500),
  status         text not null default 'pending' check (status in ('pending','accepted','rejected','withdrawn')),
  created_at     timestamptz not null default now(),
  unique (service_id, transporter_id)
);
create index if not exists offers_service_idx on public.offers(service_id, status);
create index if not exists offers_transporter_idx on public.offers(transporter_id);

create table if not exists public.complaints (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  service_id  uuid references public.services(id) on delete set null,
  reason      text not null check (reason in ('Servicio','Pago','Conducta','Cuenta','Otro')),
  description text not null check (char_length(description) between 5 and 3000),
  status      text not null default 'open' check (status in ('open','in_review','resolved')),
  created_at  timestamptz not null default now()
);
create index if not exists complaints_user_idx on public.complaints(user_id);

create table if not exists public.audit_log (
  id          uuid primary key default gen_random_uuid(),
  admin_id    uuid references public.profiles(id) on delete set null,
  action      text not null,
  target_type text not null,
  target_id   uuid,
  detail      jsonb,
  created_at  timestamptz not null default now()
);
create index if not exists audit_created_idx on public.audit_log(created_at desc);

-- ---------------------------------------------------------------------
-- FUNCIONES AUXILIARES (security definer, usadas por las políticas)
-- ---------------------------------------------------------------------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.profiles
                where id = auth.uid() and role = 'admin' and account_status = 'active');
$$;

create or replace function public.has_active_sub(p_uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from public.subscriptions
                where user_id = p_uid and status = 'active' and expires_at > now());
$$;

create or replace function public.can_serve(p_type text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(
           select 1 from public.profiles p
           join public.transporter_profiles t on t.user_id = p.id
           where p.id = auth.uid() and p.role = 'transporter'
             and p.account_status = 'active' and p_type = any(t.service_types))
         and public.has_active_sub(auth.uid());
$$;

create or replace function public.open_services_count(p_uid uuid) returns int
language sql stable security definer set search_path = public as $$
  select count(*)::int from public.services
  where client_id = p_uid and status in ('requested','countered');
$$;

-- ---------------------------------------------------------------------
-- TRIGGER: crear perfil al registrarse (el rol admin NUNCA se asigna aquí)
-- ---------------------------------------------------------------------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  m jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  r text := case when m->>'role' = 'transporter' then 'transporter' else 'client' end;
begin
  insert into public.profiles(id, role, account_status, email, full_name, age, dni, phone)
  values (new.id, r,
          case when r = 'transporter' then 'pending' else 'active' end,
          new.email,
          coalesce(nullif(left(m->>'full_name', 120), ''), 'Usuario'),
          nullif(m->>'age', '')::int,
          nullif(m->>'dni', ''),
          nullif(left(m->>'phone', 20), ''));

  if r = 'transporter' then
    insert into public.transporter_profiles(user_id, motorcycle, plate, motorcycle_color, service_types)
    values (new.id,
            left(coalesce(m->>'motorcycle', ''), 100),
            upper(left(coalesce(m->>'plate', ''), 12)),
            left(coalesce(m->>'motorcycle_color', ''), 40),
            array(select x from jsonb_array_elements_text(coalesce(m->'service_types', '[]'::jsonb)) x
                  where x in ('mototaxi','delivery')));
  end if;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.services_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.client_name := (select split_part(full_name, ' ', 1) from public.profiles where id = new.client_id);
  return new;
end $$;

drop trigger if exists services_before_insert on public.services;
create trigger services_before_insert before insert on public.services
  for each row execute function public.services_before_insert();

-- ---------------------------------------------------------------------
-- RPC: SUSCRIPCIONES
-- ---------------------------------------------------------------------
create or replace function public.request_subscription(p_plan text) returns uuid
language plpgsql security definer set search_path = public as $$
declare r text; a numeric; d int; new_id uuid;
begin
  select role into r from public.profiles where id = auth.uid() and account_status <> 'rejected';
  if r is null or r = 'admin' then raise exception 'Cuenta no válida para suscripción.'; end if;
  if p_plan not in ('weekly','monthly') then raise exception 'Plan inválido.'; end if;
  a := case when r = 'client' then (case p_plan when 'weekly' then 2 else 10 end)
                              else (case p_plan when 'weekly' then 8 else 25 end) end;
  d := case p_plan when 'weekly' then 7 else 30 end;
  insert into public.subscriptions(user_id, plan, amount, days)
  values (auth.uid(), p_plan, a, d) returning id into new_id;
  return new_id;
exception when unique_violation then
  raise exception 'Ya tienes una solicitud pendiente de revisión.';
end $$;

create or replace function public.admin_review_subscription(p_id uuid, p_approve boolean) returns void
language plpgsql security definer set search_path = public as $$
declare s public.subscriptions%rowtype; base timestamptz;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  select * into s from public.subscriptions where id = p_id and status = 'pending' for update;
  if not found then raise exception 'Solicitud no encontrada o ya revisada.'; end if;
  if p_approve then
    select coalesce(max(expires_at), now()) into base
      from public.subscriptions where user_id = s.user_id and status = 'active' and expires_at > now();
    update public.subscriptions
       set status = 'active', starts_at = base, expires_at = base + make_interval(days => s.days),
           reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_id;
  else
    update public.subscriptions
       set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
     where id = p_id;
  end if;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), case when p_approve then 'subscription_approved' else 'subscription_rejected' end,
          'subscription', p_id,
          jsonb_build_object('user_id', s.user_id, 'plan', s.plan, 'amount', s.amount));
end $$;

create or replace function public.admin_set_account_status(p_user uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare old_status text;
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if p_status not in ('pending','active','suspended','rejected') then raise exception 'Estado inválido.'; end if;
  if p_user = auth.uid() then raise exception 'No puedes cambiar el estado de tu propia cuenta.'; end if;
  select account_status into old_status from public.profiles where id = p_user;
  if not found then raise exception 'Usuario no encontrado.'; end if;
  update public.profiles set account_status = p_status where id = p_user;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'account_status', 'user', p_user, jsonb_build_object('from', old_status, 'to', p_status));
end $$;

create or replace function public.admin_set_complaint_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'No autorizado.'; end if;
  if p_status not in ('open','in_review','resolved') then raise exception 'Estado inválido.'; end if;
  update public.complaints set status = p_status where id = p_id;
  if not found then raise exception 'Reclamo no encontrado.'; end if;
  insert into public.audit_log(admin_id, action, target_type, target_id, detail)
  values (auth.uid(), 'complaint_status', 'complaint', p_id, jsonb_build_object('to', p_status));
end $$;

-- ---------------------------------------------------------------------
-- RPC: SERVICIOS (todas las transiciones se validan en el servidor)
-- ---------------------------------------------------------------------
create or replace function public.accept_service(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.services
     set transporter_id = auth.uid(), status = 'accepted', final_price = proposed_price, updated_at = now()
   where id = p_id and status = 'requested' and public.can_serve(service_type);
  if not found then
    raise exception 'La solicitud ya no está disponible o no puedes tomarla (revisa tu aprobación y suscripción).';
  end if;
  update public.offers
     set status = case when transporter_id = auth.uid() then 'accepted' else 'rejected' end
   where service_id = p_id and status = 'pending';
end $$;

-- El transportista envía (o actualiza) su oferta. Puede haber varias ofertas por solicitud.
create or replace function public.make_offer(p_service uuid, p_price numeric) returns void
language plpgsql security definer set search_path = public as $$
declare s public.services%rowtype;
begin
  if p_price is null or p_price < 0.5 or p_price > 500 then
    raise exception 'La oferta debe estar entre S/ 0.50 y S/ 500.';
  end if;
  select * into s from public.services where id = p_service;
  if not found or s.status <> 'requested' or not public.can_serve(s.service_type) then
    raise exception 'La solicitud ya no está disponible o no puedes ofertar (revisa tu aprobación y suscripción).';
  end if;
  insert into public.offers(service_id, transporter_id, price)
  values (p_service, auth.uid(), p_price)
  on conflict (service_id, transporter_id)
  do update set price = excluded.price, status = 'pending', created_at = now();
end $$;

create or replace function public.withdraw_offer(p_service uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  update public.offers set status = 'withdrawn'
   where service_id = p_service and transporter_id = auth.uid() and status = 'pending';
  if not found then raise exception 'No tienes una oferta pendiente en esta solicitud.'; end if;
end $$;

-- El cliente elige una oferta: se asigna el servicio y se rechazan las demás.
create or replace function public.accept_offer(p_offer uuid) returns void
language plpgsql security definer set search_path = public as $$
declare o public.offers%rowtype; s public.services%rowtype;
begin
  select * into o from public.offers where id = p_offer for update;
  if not found or o.status <> 'pending' then raise exception 'Esa oferta ya no está disponible.'; end if;
  select * into s from public.services where id = o.service_id for update;
  if s.client_id <> auth.uid() or s.status <> 'requested' then
    raise exception 'No puedes aceptar esta oferta.';
  end if;
  if not exists (select 1 from public.profiles where id = o.transporter_id and account_status = 'active') then
    raise exception 'El transportista ya no está disponible.';
  end if;
  update public.services
     set transporter_id = o.transporter_id, final_price = o.price, status = 'accepted', updated_at = now()
   where id = s.id;
  update public.offers
     set status = case when id = o.id then 'accepted' else 'rejected' end
   where service_id = s.id and status = 'pending';
end $$;

-- Ofertas recibidas por el cliente (sin datos de contacto hasta aceptar)
create or replace function public.client_offers()
returns table(offer_id uuid, service_id uuid, price numeric, offered_at timestamptz,
              transporter_name text, motorcycle text, color text, photo_path text)
language sql stable security definer set search_path = public as $$
  select o.id, o.service_id, o.price, o.created_at, p.full_name, t.motorcycle, t.motorcycle_color, t.photo_path
    from public.offers o
    join public.services s on s.id = o.service_id
    join public.profiles p on p.id = o.transporter_id
    left join public.transporter_profiles t on t.user_id = o.transporter_id
   where s.client_id = auth.uid() and s.status = 'requested'
     and o.status = 'pending' and p.account_status = 'active'
   order by o.price asc, o.created_at asc;
$$;

create or replace function public.update_service_status(p_id uuid, p_status text) returns void
language plpgsql security definer set search_path = public as $$
declare s public.services%rowtype; uid uuid := auth.uid();
begin
  select * into s from public.services where id = p_id for update;
  if not found then raise exception 'Servicio no encontrado.'; end if;

  if uid = s.client_id then
    if p_status = 'cancelled' and s.status in ('requested','accepted') then
      update public.services set status = 'cancelled', updated_at = now() where id = p_id;
      update public.offers set status = 'rejected' where service_id = p_id and status = 'pending';
    else
      raise exception 'Acción no permitida en el estado actual.';
    end if;

  elsif uid = s.transporter_id then
    if p_status = 'in_progress' and s.status = 'accepted' then
      update public.services set status = 'in_progress', updated_at = now() where id = p_id;
    elsif p_status = 'completed' and s.status = 'in_progress' then
      update public.services set status = 'completed', updated_at = now() where id = p_id;
    elsif p_status = 'cancelled' and s.status = 'accepted' then
      update public.services set status = 'cancelled', updated_at = now() where id = p_id;
    else
      raise exception 'Acción no permitida en el estado actual.';
    end if;
  else
    raise exception 'No autorizado.';
  end if;
end $$;

-- Datos de contacto de la otra parte: solo participantes y solo tras aceptar
create or replace function public.service_contact(p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare s public.services%rowtype; other uuid; r jsonb;
begin
  select * into s from public.services where id = p_id;
  if not found or s.status not in ('accepted','in_progress','completed') then return null; end if;
  if auth.uid() = s.client_id then other := s.transporter_id;
  elsif auth.uid() = s.transporter_id then other := s.client_id;
  else return null; end if;
  select jsonb_build_object('name', p.full_name, 'phone', p.phone,
                            'motorcycle', t.motorcycle, 'plate', t.plate, 'color', t.motorcycle_color)
    into r
    from public.profiles p left join public.transporter_profiles t on t.user_id = p.id
   where p.id = other;
  return r;
end $$;

create or replace function public.set_my_photo(p_path text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_path is null or split_part(p_path, '/', 1) <> auth.uid()::text then
    raise exception 'Ruta de foto inválida.';
  end if;
  update public.transporter_profiles set photo_path = p_path where user_id = auth.uid();
end $$;

-- ---------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------
alter table public.profiles             enable row level security;
alter table public.transporter_profiles enable row level security;
alter table public.subscriptions        enable row level security;
alter table public.services             enable row level security;
alter table public.complaints           enable row level security;
alter table public.audit_log            enable row level security;
alter table public.offers               enable row level security;

-- profiles: cada quien ve el suyo; admin ve y modifica todos. Nadie puede cambiar su propio rol.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
-- (las modificaciones del admin se hacen por RPC con registro de auditoría)
drop policy if exists profiles_admin_update on public.profiles;

drop policy if exists tprof_select on public.transporter_profiles;
create policy tprof_select on public.transporter_profiles for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- subscriptions: lectura propia/admin. Altas y revisiones solo por RPC.
drop policy if exists subs_select on public.subscriptions;
create policy subs_select on public.subscriptions for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

-- services
drop policy if exists services_select on public.services;
create policy services_select on public.services for select to authenticated
  using (client_id = auth.uid()
         or transporter_id = auth.uid()
         or public.is_admin()
         or (status = 'requested' and public.can_serve(service_type)));

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

-- complaints
drop policy if exists complaints_select on public.complaints;
create policy complaints_select on public.complaints for select to authenticated
  using (user_id = auth.uid() or public.is_admin());

drop policy if exists complaints_insert on public.complaints;
create policy complaints_insert on public.complaints for insert to authenticated
  with check (
    user_id = auth.uid() and status = 'open'
    and (service_id is null or exists (
          select 1 from public.services s
          where s.id = service_id and (s.client_id = auth.uid() or s.transporter_id = auth.uid())))
  );

drop policy if exists complaints_admin_update on public.complaints;

drop policy if exists offers_select on public.offers;
create policy offers_select on public.offers for select to authenticated
  using (transporter_id = auth.uid() or public.is_admin());

drop policy if exists audit_select on public.audit_log;
create policy audit_select on public.audit_log for select to authenticated using (public.is_admin());

-- ---------------------------------------------------------------------
-- PERMISOS
-- ---------------------------------------------------------------------
revoke all on all tables in schema public from anon;

revoke all on function public.is_admin()                      from public, anon;
revoke all on function public.has_active_sub(uuid)            from public, anon;
revoke all on function public.can_serve(text)                 from public, anon;
revoke all on function public.open_services_count(uuid)       from public, anon;
revoke all on function public.handle_new_user()               from public, anon, authenticated;
revoke all on function public.services_before_insert()        from public, anon, authenticated;
revoke all on function public.request_subscription(text)      from public, anon;
revoke all on function public.admin_review_subscription(uuid, boolean) from public, anon;
revoke all on function public.admin_set_account_status(uuid, text) from public, anon;
revoke all on function public.admin_set_complaint_status(uuid, text) from public, anon;
revoke all on function public.accept_service(uuid)            from public, anon;
revoke all on function public.make_offer(uuid, numeric)       from public, anon;
revoke all on function public.withdraw_offer(uuid)            from public, anon;
revoke all on function public.accept_offer(uuid)              from public, anon;
revoke all on function public.client_offers()                 from public, anon;
revoke all on function public.update_service_status(uuid, text) from public, anon;
revoke all on function public.service_contact(uuid)           from public, anon;
revoke all on function public.set_my_photo(text)              from public, anon;

grant execute on function public.is_admin()                      to authenticated;
grant execute on function public.has_active_sub(uuid)            to authenticated;
grant execute on function public.can_serve(text)                 to authenticated;
grant execute on function public.open_services_count(uuid)       to authenticated;
grant execute on function public.request_subscription(text)      to authenticated;
grant execute on function public.admin_review_subscription(uuid, boolean) to authenticated;
grant execute on function public.admin_set_account_status(uuid, text) to authenticated;
grant execute on function public.admin_set_complaint_status(uuid, text) to authenticated;
grant execute on function public.accept_service(uuid)            to authenticated;
grant execute on function public.make_offer(uuid, numeric)       to authenticated;
grant execute on function public.withdraw_offer(uuid)            to authenticated;
grant execute on function public.accept_offer(uuid)              to authenticated;
grant execute on function public.client_offers()                 to authenticated;
grant execute on function public.update_service_status(uuid, text) to authenticated;
grant execute on function public.service_contact(uuid)           to authenticated;
grant execute on function public.set_my_photo(text)              to authenticated;

-- ---------------------------------------------------------------------
-- STORAGE: fotos de perfil (máx 5 MB, solo imágenes, carpeta = id del usuario)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('profile-photos', 'profile-photos', true, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists profile_photos_insert on storage.objects;
create policy profile_photos_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'profile-photos' and (storage.foldername(name))[1] = auth.uid()::text);

-- =====================================================================
-- DESPUÉS de registrar tu cuenta de administrador, ejecuta (con tu correo):
--   update public.profiles set role='admin', account_status='active' where email='TU_CORREO_ADMIN';
-- =====================================================================

-- =====================================================================
-- PARCHE: edad mínima 15 años para clientes (transportistas siguen con 18)
-- Ejecutar en Supabase > SQL Editor. No borra datos. Se puede repetir.
-- =====================================================================
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
     where conrelid = 'public.profiles'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) ilike '%age%' and conname <> 'profiles_age_range'
  loop
    execute format('alter table public.profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.profiles drop constraint if exists profiles_age_range;
alter table public.profiles add constraint profiles_age_range
  check (age is null or (age between 15 and 100 and (role <> 'transporter' or age >= 18)));


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
