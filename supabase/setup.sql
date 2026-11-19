-- =====================================================================
-- Merkentool / Outil de Marques – base de données des prix par magasin
-- À coller dans Supabase : SQL Editor > New query > Run.
-- Le script peut être relancé sans risque (il ne supprime aucune donnée).
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------- Tables ----------
create table if not exists public.shops (
  id          serial primary key,
  name        text not null unique,
  code_hash   text not null,                 -- code du magasin, chiffré
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);

create table if not exists public.prefs (
  shop_id     int  not null references public.shops(id) on delete cascade,
  brand       text not null,                 -- marque, telle que dans la liste
  item        text not null,                 -- clé article, ex. "women:Jeans"
  item_label  text,                          -- libellé lisible, ex. "Femmes – Jeans"
  stars       int,
  price       numeric(6,2) not null,
  ref         text not null,                 -- référence Onlinefact
  updated_at  timestamptz not null default now(),
  primary key (shop_id, brand, item)
);

-- Aucun accès direct aux tables depuis le site : tout passe par les fonctions.
alter table public.shops enable row level security;
alter table public.prefs enable row level security;
revoke all on public.shops, public.prefs from anon, authenticated;
revoke all on sequence public.shops_id_seq from anon, authenticated;

-- ---------- Contrôle du code magasin (interne) ----------
create or replace function public._shop_ok(p_shop int, p_code text)
returns boolean language sql stable security definer
set search_path = public, extensions as $$
  select exists (select 1 from public.shops
                 where id = p_shop and active
                   and code_hash = extensions.crypt(coalesce(p_code, ''), code_hash));
$$;

-- ---------- Fonctions utilisées par le site ----------
create or replace function public.list_shops()
returns table (id int, name text) language sql stable security definer
set search_path = public as $$
  select id, name from public.shops where active order by name;
$$;

create or replace function public.shop_login(p_shop int, p_code text)
returns boolean language sql stable security definer
set search_path = public as $$
  select public._shop_ok(p_shop, p_code);
$$;

create or replace function public.get_prefs(p_shop int, p_code text)
returns table (brand text, item text, stars int, price numeric, ref text, updated_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public._shop_ok(p_shop, p_code) then
    raise exception 'bad shop code' using errcode = '28000';
  end if;
  return query select p.brand, p.item, p.stars, p.price, p.ref, p.updated_at
               from public.prefs p where p.shop_id = p_shop;
end $$;

create or replace function public.set_pref(p_shop int, p_code text, p_brand text, p_item text,
                                           p_label text, p_stars int, p_price numeric, p_ref text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_ok(p_shop, p_code) then
    raise exception 'bad shop code' using errcode = '28000';
  end if;
  if length(coalesce(p_brand, '')) = 0 or length(p_brand) > 200 or length(coalesce(p_item, '')) = 0
     or length(p_item) > 200 or length(coalesce(p_ref, '')) = 0 or length(p_ref) > 50
     or p_price is null or p_price < 0 or p_price > 10000 then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  insert into public.prefs (shop_id, brand, item, item_label, stars, price, ref, updated_at)
  values (p_shop, p_brand, p_item, left(p_label, 200), p_stars, p_price, p_ref, now())
  on conflict (shop_id, brand, item) do update
    set item_label = excluded.item_label, stars = excluded.stars, price = excluded.price,
        ref = excluded.ref, updated_at = now();
end $$;

create or replace function public.del_pref(p_shop int, p_code text, p_brand text, p_item text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_ok(p_shop, p_code) then
    raise exception 'bad shop code' using errcode = '28000';
  end if;
  delete from public.prefs where shop_id = p_shop and brand = p_brand and item = p_item;
end $$;

-- ---------- Fonctions d'administration (SQL Editor uniquement) ----------
-- Ajouter un magasin ou changer son code :   select add_shop('Namur', '4821');
create or replace function public.add_shop(p_name text, p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  insert into public.shops (name, code_hash) values (p_name, extensions.crypt(p_code, extensions.gen_salt('bf')))
  on conflict (name) do update set code_hash = excluded.code_hash, active = true;
  return 'OK: ' || p_name;
end $$;

-- Désactiver un magasin (ses prix sont conservés) :   select disable_shop('Namur');
create or replace function public.disable_shop(p_name text)
returns text language sql security definer set search_path = public as $$
  update public.shops set active = false where name = p_name returning 'OK: ' || name;
$$;

-- Vue de contrôle : tous les prix mémorisés, par magasin (Table Editor > pref_report)
create or replace view public.pref_report with (security_invoker = true) as
  select s.name as magasin, case when p.brand = '*' then '(toutes marques)' else p.brand end as marque, p.item_label as article,
         repeat('*', coalesce(p.stars, 0)) as etoiles, p.price as prix, p.ref as ref_onlinefact,
         p.updated_at as modifie_le
  from public.prefs p join public.shops s on s.id = p.shop_id
  order by s.name, p.brand, p.item_label;

-- ---------- Droits ----------
revoke all on function public._shop_ok(int, text)           from public, anon, authenticated;
revoke all on function public.add_shop(text, text)           from public, anon, authenticated;
revoke all on function public.disable_shop(text)             from public, anon, authenticated;
revoke all on public.pref_report                             from anon, authenticated;

revoke all on function public.list_shops()                   from public;
revoke all on function public.shop_login(int, text)          from public;
revoke all on function public.get_prefs(int, text)           from public;
revoke all on function public.set_pref(int, text, text, text, text, int, numeric, text) from public;
revoke all on function public.del_pref(int, text, text, text) from public;
grant execute on function public.list_shops()                to anon;
grant execute on function public.shop_login(int, text)       to anon;
grant execute on function public.get_prefs(int, text)        to anon;
grant execute on function public.set_pref(int, text, text, text, text, int, numeric, text) to anon;
grant execute on function public.del_pref(int, text, text, text) to anon;

-- ---------- Vos magasins ----------
-- Remplacez par vos magasins et choisissez un code par magasin, puis exécutez ces lignes.
-- select add_shop('Magasin exemple', '1234');
