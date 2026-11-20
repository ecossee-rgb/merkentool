-- =====================================================================
-- Merkentool – RETOUR ARRIÈRE de la mise à jour de sécurité (base de données)
-- Remet les fonctions de la base exactement comme dans la version GitHub 0cfe1a5.
-- À coller en entier dans Supabase : SQL Editor > New query > Run.
--
-- Conservé : magasins et leurs codes, code admin, prix mémorisés, marques et
-- listes de prix, compteur d'essais. Rien n'est effacé.
-- Retiré : contrôle des prix mémorisés, contrôle des chargements, colonne
-- "statut" de pref_report, verrou anti-essais simultanés.
--
-- Les pages GitHub (nouvelles ou anciennes) fonctionnent avec les deux versions
-- de la base : l'ordre du retour arrière (GitHub d'abord ou base d'abord) n'a pas d'importance.
-- =====================================================================

-- 1. Retirer ce que la mise à jour a ajouté
drop view if exists public.pref_report;
drop function if exists public.check_app_data();
drop function if exists public._validate_prices(jsonb);
drop function if exists public._validate_brands(jsonb);
drop function if exists public._v_keys(jsonb, text, text[], text[]);
drop function if exists public._v_money(jsonb, text);
drop function if exists public._v_text(jsonb, text, int);
drop function if exists public._brand_exists(text);
drop function if exists public._match_choice(text, numeric, text);

-- 2. Réinstaller la version 0cfe1a5 (copie exacte de supabase/setup.sql de cette version)
-- =====================================================================
-- Merkentool / Outil de Marques – base de données
-- À coller dans Supabase : SQL Editor > New query > Run.
-- Le script peut être relancé sans risque : il ne supprime ni les magasins,
-- ni les prix mémorisés, ni les données (marques et listes de prix).
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
  brand       text not null,                 -- marque, ou '*' = toutes marques
  item        text not null,                 -- clé article, ex. "women:Jeans"
  item_label  text,                          -- libellé lisible, ex. "Femmes – Jeans"
  stars       int,
  price       numeric(6,2) not null,
  ref         text not null,                 -- référence Onlinefact
  updated_at  timestamptz not null default now(),
  primary key (shop_id, brand, item)
);

-- Données de l'outil (marques, listes de prix), lisibles seulement avec un code magasin
create table if not exists public.app_data (
  key         text primary key,              -- 'brands' ou 'prices'
  data        jsonb not null,
  updated_at  timestamptz not null default now()
);

-- Code administrateur (pour charger les données via admin.html)
create table if not exists public.app_admin (
  id          int primary key default 1 check (id = 1),
  code_hash   text not null
);

-- Essais de code ratés (limite anti-devinette)
create table if not exists public.login_failures (
  who         text not null,                 -- 'shop:12' ou 'admin'
  at          timestamptz not null default now()
);
create index if not exists login_failures_who_at on public.login_failures (who, at);

-- Aucun accès direct aux tables depuis le site : tout passe par les fonctions.
alter table public.shops          enable row level security;
alter table public.prefs          enable row level security;
alter table public.app_data       enable row level security;
alter table public.app_admin      enable row level security;
alter table public.login_failures enable row level security;
revoke all on public.shops, public.prefs, public.app_data, public.app_admin, public.login_failures from anon, authenticated;
revoke all on sequence public.shops_id_seq from anon, authenticated;

-- ---------- Contrôles internes ----------
-- Au-delà de 10 essais ratés en 15 minutes pour un même magasin (ou pour l'admin) : blocage 15 minutes.
create or replace function public._guard(p_who text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if (select count(*) from public.login_failures
      where who = p_who and at > now() - interval '15 minutes') >= 10 then
    raise exception 'too many attempts' using errcode = 'P0001';
  end if;
end $$;

create or replace function public._fail(p_who text)
returns void language plpgsql security definer set search_path = public as $$
begin
  delete from public.login_failures where at < now() - interval '1 day';
  insert into public.login_failures (who) values (p_who);
end $$;

create or replace function public._shop_ok(p_shop int, p_code text)
returns boolean language sql stable security definer
set search_path = public, extensions as $$
  select exists (select 1 from public.shops
                 where id = p_shop and active
                   and code_hash = extensions.crypt(coalesce(p_code, ''), code_hash));
$$;

-- Vérifie le code magasin, compte les échecs. Ne lève pas d'erreur sur un mauvais code
-- (sinon l'échec ne serait pas enregistré).
create or replace function public._shop_check(p_shop int, p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  perform public._guard('shop:' || coalesce(p_shop, 0));
  if public._shop_ok(p_shop, p_code) then return true; end if;
  perform public._fail('shop:' || coalesce(p_shop, 0));
  return false;
end $$;

create or replace function public._admin_check(p_code text)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
begin
  perform public._guard('admin');
  if exists (select 1 from public.app_admin
             where code_hash = extensions.crypt(coalesce(p_code, ''), code_hash)) then
    return true;
  end if;
  perform public._fail('admin');
  return false;
end $$;

-- ---------- Fonctions utilisées par le site ----------
create or replace function public.list_shops()
returns table (id int, name text) language sql stable security definer
set search_path = public as $$
  select id, name from public.shops where active order by name;
$$;

drop function if exists public.shop_login(int, text);
create function public.shop_login(p_shop int, p_code text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  return public._shop_check(p_shop, p_code);
end $$;

-- Marques + listes de prix (null si le code est faux)
create or replace function public.get_app_data(p_shop int, p_code text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_check(p_shop, p_code) then return null; end if;
  return jsonb_build_object(
    'brands', (select data from public.app_data where key = 'brands'),
    'prices', (select data from public.app_data where key = 'prices'));
end $$;

drop function if exists public.get_prefs(int, text);
create function public.get_prefs(p_shop int, p_code text)
returns table (brand text, item text, stars int, price numeric, ref text, updated_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_check(p_shop, p_code) then return; end if;
  return query select p.brand, p.item, p.stars, p.price, p.ref, p.updated_at
               from public.prefs p where p.shop_id = p_shop;
end $$;

drop function if exists public.set_pref(int, text, text, text, text, int, numeric, text);
create function public.set_pref(p_shop int, p_code text, p_brand text, p_item text,
                                p_label text, p_stars int, p_price numeric, p_ref text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_check(p_shop, p_code) then return false; end if;
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
  return true;
end $$;

drop function if exists public.del_pref(int, text, text, text);
create function public.del_pref(p_shop int, p_code text, p_brand text, p_item text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_check(p_shop, p_code) then return false; end if;
  delete from public.prefs where shop_id = p_shop and brand = p_brand and item = p_item;
  return true;
end $$;

-- ---------- Fonctions de la page admin.html ----------
create or replace function public.admin_login(p_admin text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  return public._admin_check(p_admin);
end $$;

create or replace function public.admin_status(p_admin text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_check(p_admin) then return null; end if;
  return (select coalesce(jsonb_object_agg(key, jsonb_build_object(
            'updated_at', updated_at,
            'count', case when jsonb_typeof(data) = 'array' then jsonb_array_length(data)
                          else jsonb_array_length(coalesce(data->'categories', '[]'::jsonb)) end)), '{}'::jsonb)
          from public.app_data);
end $$;

create or replace function public.upload_app_data(p_admin text, p_key text, p_data jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_check(p_admin) then return false; end if;
  if p_key not in ('brands', 'prices') then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  if (p_key = 'brands' and jsonb_typeof(p_data) <> 'array')
     or (p_key = 'prices' and jsonb_typeof(p_data->'categories') is distinct from 'array') then
    raise exception 'invalid data' using errcode = '22023';
  end if;
  insert into public.app_data (key, data, updated_at) values (p_key, p_data, now())
  on conflict (key) do update set data = excluded.data, updated_at = now();
  return true;
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

-- Définir ou changer le code administrateur :   select set_admin_code('un-long-mot-de-passe');
create or replace function public.set_admin_code(p_code text)
returns text language plpgsql security definer set search_path = public, extensions as $$
begin
  if length(coalesce(p_code, '')) < 10 then
    raise exception 'Le code admin doit faire au moins 10 caractères';
  end if;
  insert into public.app_admin (id, code_hash) values (1, extensions.crypt(p_code, extensions.gen_salt('bf')))
  on conflict (id) do update set code_hash = excluded.code_hash;
  delete from public.login_failures where who = 'admin';
  return 'OK: code admin enregistré';
end $$;

-- Débloquer un magasin après trop d'essais :   select unblock_shop('Shop Brugge');
create or replace function public.unblock_shop(p_name text)
returns text language sql security definer set search_path = public as $$
  delete from public.login_failures where who = 'shop:' || (select id from public.shops where name = p_name);
  select 'OK: ' || p_name;
$$;

-- Vue de contrôle : tous les prix mémorisés, par magasin (Table Editor > pref_report)
create or replace view public.pref_report with (security_invoker = true) as
  select s.name as magasin, case when p.brand = '*' then '(toutes marques)' else p.brand end as marque,
         p.item_label as article,
         repeat('*', coalesce(p.stars, 0)) as etoiles, p.price as prix, p.ref as ref_onlinefact,
         p.updated_at as modifie_le
  from public.prefs p join public.shops s on s.id = p.shop_id
  order by s.name, p.brand, p.item_label;

-- ---------- Droits ----------
-- Tout est d'abord fermé, puis seules les fonctions du site sont ouvertes.
revoke all on function public._guard(text)                   from public, anon, authenticated;
revoke all on function public._fail(text)                    from public, anon, authenticated;
revoke all on function public._shop_ok(int, text)            from public, anon, authenticated;
revoke all on function public._shop_check(int, text)         from public, anon, authenticated;
revoke all on function public._admin_check(text)             from public, anon, authenticated;
revoke all on function public.add_shop(text, text)           from public, anon, authenticated;
revoke all on function public.disable_shop(text)             from public, anon, authenticated;
revoke all on function public.set_admin_code(text)           from public, anon, authenticated;
revoke all on function public.unblock_shop(text)             from public, anon, authenticated;
revoke all on public.pref_report                             from anon, authenticated;

revoke all on function public.list_shops()                   from public;
revoke all on function public.shop_login(int, text)          from public;
revoke all on function public.get_app_data(int, text)        from public;
revoke all on function public.get_prefs(int, text)           from public;
revoke all on function public.set_pref(int, text, text, text, text, int, numeric, text) from public;
revoke all on function public.del_pref(int, text, text, text) from public;
revoke all on function public.admin_login(text)              from public;
revoke all on function public.admin_status(text)             from public;
revoke all on function public.upload_app_data(text, text, jsonb) from public;
grant execute on function public.list_shops()                to anon;
grant execute on function public.shop_login(int, text)       to anon;
grant execute on function public.get_app_data(int, text)     to anon;
grant execute on function public.get_prefs(int, text)        to anon;
grant execute on function public.set_pref(int, text, text, text, text, int, numeric, text) to anon;
grant execute on function public.del_pref(int, text, text, text) to anon;
grant execute on function public.admin_login(text)           to anon;
grant execute on function public.admin_status(text)          to anon;
grant execute on function public.upload_app_data(text, text, jsonb) to anon;

-- ---------- Magasins ----------
-- Les magasins sont créés à part (fichier magasins_supabase.sql, à ne jamais mettre sur GitHub) :
-- select add_shop('Magasin exemple', '123456');
