-- =====================================================================
-- 00_reset.sql  -  EJECUTAR SOLO UNA VEZ y SOLO SI NO TIENES DATOS REALES
-- BORRA las tablas de LANZEC (perfiles, servicios, suscripciones, ofertas,
-- reclamos, auditoría), los tipos enum y los triggers de auth.users
-- que quedaron de versiones anteriores. Luego ejecuta schema.sql.
-- =====================================================================

drop table if exists public.audit_log, public.offers, public.complaints, public.services,
                     public.subscriptions, public.transporter_profiles, public.profiles cascade;

-- tipos enum antiguos (p. ej. complaint_state)
do $$
declare r record;
begin
  for r in select t.typname from pg_type t join pg_namespace n on n.oid = t.typnamespace
           where n.nspname = 'public' and t.typtype = 'e' loop
    execute format('drop type if exists public.%I cascade', r.typname);
  end loop;
end $$;

-- triggers antiguos sobre auth.users (se recrea el correcto en schema.sql)
do $$
declare r record;
begin
  for r in select tgname from pg_trigger
           where tgrelid = 'auth.users'::regclass and not tgisinternal loop
    execute format('drop trigger if exists %I on auth.users', r.tgname);
  end loop;
end $$;

-- funciones antiguas con los mismos nombres
drop function if exists public.is_admin(), public.has_active_sub(uuid), public.can_serve(text),
  public.open_services_count(uuid), public.handle_new_user(), public.services_before_insert(),
  public.request_subscription(text), public.admin_review_subscription(uuid, boolean),
  public.admin_set_account_status(uuid, text), public.admin_set_complaint_status(uuid, text),
  public.accept_service(uuid), public.make_offer(uuid, numeric), public.withdraw_offer(uuid),
  public.accept_offer(uuid), public.client_offers(), public.update_service_status(uuid, text),
  public.service_contact(uuid), public.set_my_photo(text), public.counter_service(uuid, numeric),
  public.respond_counter(uuid, boolean) cascade;
