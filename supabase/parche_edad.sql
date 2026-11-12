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
