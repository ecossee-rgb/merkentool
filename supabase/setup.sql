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
-- Le verrou pg_advisory_xact_lock fait attendre leur tour aux essais simultanés pour le même
-- magasin (jusqu'à la fin de l'essai en cours) : chaque échec est donc vu par l'essai suivant.
create or replace function public._guard(p_who text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform pg_advisory_xact_lock(hashtext('merkentool:' || p_who));
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

-- ---------- Catalogue : recherche d'un choix (interne) ----------
-- Renvoie le niveau d'étoiles et le libellé si [prix, référence] existe pour cet article
-- dans le catalogue actuel ; sinon renvoie des valeurs nulles.
create or replace function public._match_choice(p_item text, p_price numeric, p_ref text,
                                                out o_level int, out o_label text)
language sql stable security definer set search_path = public as $$
  select l.ord::int, (c->>'fr') || ' – ' || (it->>'fr')
  from public.app_data d,
       jsonb_array_elements(d.data->'categories') c,
       jsonb_array_elements(c->'sections') s,
       jsonb_array_elements(s->'items') it,
       jsonb_array_elements(it->'r') with ordinality l(arr, ord),
       jsonb_array_elements(l.arr) e
  where d.key = 'prices'
    and (c->>'id') || ':' || (it->>'nl') = p_item
    and e->>1 = p_ref
    and (case when jsonb_typeof(e->0) = 'number' then (e->>0)::numeric end) = p_price
  limit 1;
$$;

create or replace function public._brand_exists(p_brand text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.app_data d, jsonb_array_elements(d.data) b
                 where d.key = 'brands' and b->>0 = p_brand);
$$;

-- ---------- Catalogue : validation avant chargement (interne) ----------
create or replace function public._v_text(p jsonb, p_where text, p_max int)
returns text language plpgsql immutable as $$
declare v text;
begin
  if p is null or jsonb_typeof(p) <> 'string' then
    raise exception 'Donnée refusée (%) : texte attendu', p_where using errcode = '22023';
  end if;
  v := p #>> '{}';
  if length(btrim(v)) = 0 or length(v) > p_max then
    raise exception 'Donnée refusée (%) : texte vide ou trop long (max % caractères)', p_where, p_max using errcode = '22023';
  end if;
  if v ~ '[[:cntrl:]<>]' then
    raise exception 'Donnée refusée (%) : caractères interdits (<, > ou caractères de contrôle) dans « % »', p_where, left(v, 60) using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function public._v_money(p jsonb, p_where text)
returns numeric language plpgsql immutable as $$
declare v numeric;
begin
  if p is null or jsonb_typeof(p) <> 'number' then
    raise exception 'Donnée refusée (%) : nombre attendu, reçu %', p_where, coalesce(left(p::text, 40), 'rien') using errcode = '22023';
  end if;
  v := (p #>> '{}')::numeric;
  if v < 0 or v > 10000 or v * 100 <> trunc(v * 100) then
    raise exception 'Donnée refusée (%) : prix % hors limites (0 à 10 000 €, 2 décimales max)', p_where, v using errcode = '22023';
  end if;
  return v;
end $$;

create or replace function public._v_keys(p jsonb, p_where text, p_required text[], p_optional text[])
returns void language plpgsql immutable as $$
declare k text;
begin
  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'Donnée refusée (%) : objet attendu', p_where using errcode = '22023';
  end if;
  foreach k in array p_required loop
    if not p ? k then raise exception 'Donnée refusée (%) : champ « % » manquant', p_where, k using errcode = '22023'; end if;
  end loop;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (p_required) or k = any (p_optional)) then
      raise exception 'Donnée refusée (%) : champ inconnu « % »', p_where, left(k, 40) using errcode = '22023';
    end if;
  end loop;
end $$;

create or replace function public._validate_brands(p jsonb)
returns int language plpgsql immutable as $$
declare e jsonb; i bigint; v_dup text; v_stars numeric;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) = 0 or jsonb_array_length(p) > 100000 then
    raise exception 'Donnée refusée (marques) : liste de 1 à 100 000 marques attendue' using errcode = '22023';
  end if;
  for e, i in select value, ordinality from jsonb_array_elements(p) with ordinality loop
    if jsonb_typeof(e) <> 'array' or jsonb_array_length(e) not between 2 and 3 then
      raise exception 'Donnée refusée (marque n°%) : format [nom, étoiles, remarque] attendu', i using errcode = '22023';
    end if;
    perform public._v_text(e->0, format('marque n°%s', i), 200);
    if jsonb_typeof(e->1) <> 'number' then
      raise exception 'Donnée refusée (marque « % ») : étoiles = nombre de 0 à 4', left(e->>0, 60) using errcode = '22023';
    end if;
    v_stars := (e->>1)::numeric;
    if v_stars not in (0, 1, 2, 3, 4) then
      raise exception 'Donnée refusée (marque « % ») : étoiles = nombre de 0 à 4', left(e->>0, 60) using errcode = '22023';
    end if;
    if jsonb_array_length(e) = 3 and jsonb_typeof(e->2) <> 'null' then
      perform public._v_text(e->2, format('remarque de la marque « %s »', left(e->>0, 60)), 500);
    end if;
  end loop;
  select lower(value->>0) into v_dup from jsonb_array_elements(p) group by 1 having count(*) > 1 limit 1;
  if v_dup is not null then
    raise exception 'Donnée refusée (marques) : « % » apparaît plusieurs fois', v_dup using errcode = '22023';
  end if;
  return jsonb_array_length(p);
end $$;

create or replace function public._validate_prices(p jsonb)
returns int language plpgsql immutable as $$
declare
  c jsonb; s jsonb; it jsonb; rng jsonb; lst jsonb; e jsonb; img jsonb;
  v_levels int; v_lv int; v_where text; v_cat text; v_lo numeric; v_hi numeric; v_price numeric;
  v_ref text; v_dup text; v_count int := 0;
begin
  perform public._v_keys(p, 'liste de prix', array['categories'], array['built']);
  if p ? 'built' then perform public._v_text(p->'built', 'date de génération', 40); end if;
  if jsonb_typeof(p->'categories') <> 'array' or jsonb_array_length(p->'categories') not between 1 and 20 then
    raise exception 'Donnée refusée (liste de prix) : 1 à 20 catégories attendues' using errcode = '22023';
  end if;

  for c in select value from jsonb_array_elements(p->'categories') loop
    perform public._v_keys(c, 'catégorie', array['id', 'fr', 'nl', 'levels', 'sections'], array[]::text[]);
    if jsonb_typeof(c->'id') <> 'string' or (c->>'id') !~ '^[a-z][a-z0-9_-]{0,39}$' then
      raise exception 'Donnée refusée (catégorie) : identifiant invalide « % »', left(c->>'id', 40) using errcode = '22023';
    end if;
    v_cat := c->>'id';
    perform public._v_text(c->'fr', v_cat || ' (nom FR)', 100);
    perform public._v_text(c->'nl', v_cat || ' (nom NL)', 100);
    if jsonb_typeof(c->'levels') <> 'number' or (c->>'levels')::numeric not in (1, 2, 3, 4, 5, 6) then
      raise exception 'Donnée refusée (%) : nombre de niveaux d''étoiles invalide', v_cat using errcode = '22023';
    end if;
    v_levels := (c->>'levels')::int;
    if jsonb_typeof(c->'sections') <> 'array' or jsonb_array_length(c->'sections') not between 1 and 100 then
      raise exception 'Donnée refusée (%) : 1 à 100 sections attendues', v_cat using errcode = '22023';
    end if;

    for s in select value from jsonb_array_elements(c->'sections') loop
      perform public._v_keys(s, v_cat || ' / section', array['fr', 'nl', 'items'], array[]::text[]);
      perform public._v_text(s->'fr', v_cat || ' / section (FR)', 100);
      perform public._v_text(s->'nl', v_cat || ' / section (NL)', 100);
      if jsonb_typeof(s->'items') <> 'array' or jsonb_array_length(s->'items') > 500 then
        raise exception 'Donnée refusée (% / %) : liste d''articles invalide', v_cat, s->>'fr' using errcode = '22023';
      end if;

      for it in select value from jsonb_array_elements(s->'items') loop
        perform public._v_keys(it, v_cat || ' / article', array['fr', 'nl', 'p', 'r'], array['img']);
        v_where := v_cat || ' / ' || public._v_text(it->'fr', v_cat || ' / article (FR)', 200);
        perform public._v_text(it->'nl', v_where || ' (NL)', 200);
        if jsonb_typeof(it->'p') <> 'array' or jsonb_array_length(it->'p') <> v_levels
           or jsonb_typeof(it->'r') <> 'array' or jsonb_array_length(it->'r') <> v_levels then
          raise exception 'Donnée refusée (%) : il faut % fourchettes et % listes de références', v_where, v_levels, v_levels using errcode = '22023';
        end if;
        for v_lv in 1 .. v_levels loop
          rng := it->'p'->(v_lv - 1);
          lst := it->'r'->(v_lv - 1);
          if jsonb_typeof(rng) = 'null' then
            v_lo := null; v_hi := null;
          elsif jsonb_typeof(rng) = 'array' and jsonb_array_length(rng) = 2 then
            v_lo := public._v_money(rng->0, v_where || ' ' || repeat('*', v_lv) || ' (min)');
            v_hi := public._v_money(rng->1, v_where || ' ' || repeat('*', v_lv) || ' (max)');
            if v_lo > v_hi then
              raise exception 'Donnée refusée (% %) : minimum % € plus grand que maximum % €', v_where, repeat('*', v_lv), v_lo, v_hi using errcode = '22023';
            end if;
          else
            raise exception 'Donnée refusée (% %) : fourchette [min, max] attendue', v_where, repeat('*', v_lv) using errcode = '22023';
          end if;
          if jsonb_typeof(lst) <> 'array' or jsonb_array_length(lst) > 500 then
            raise exception 'Donnée refusée (% %) : liste de références invalide', v_where, repeat('*', v_lv) using errcode = '22023';
          end if;
          for e in select value from jsonb_array_elements(lst) loop
            if jsonb_typeof(e) <> 'array' or jsonb_array_length(e) <> 2 then
              raise exception 'Donnée refusée (% %) : [prix, référence] attendu', v_where, repeat('*', v_lv) using errcode = '22023';
            end if;
            v_price := public._v_money(e->0, v_where || ' ' || repeat('*', v_lv));
            if jsonb_typeof(e->1) <> 'string' or (e->>1) !~ '^[A-Za-z0-9][A-Za-z0-9_./-]{0,49}$' then
              raise exception 'Donnée refusée (% %) : référence Onlinefact invalide « % »', v_where, repeat('*', v_lv), left(e->>1, 60) using errcode = '22023';
            end if;
            if v_lo is null or v_price < v_lo or v_price > v_hi then
              raise exception 'Donnée refusée (% %) : la référence % (% €) est hors de la fourchette', v_where, repeat('*', v_lv), e->>1, v_price using errcode = '22023';
            end if;
            v_count := v_count + 1;
          end loop;
        end loop;
        if it ? 'img' then
          if jsonb_typeof(it->'img') <> 'array' or jsonb_array_length(it->'img') > 10 then
            raise exception 'Donnée refusée (%) : liste de photos invalide', v_where using errcode = '22023';
          end if;
          for img in select value from jsonb_array_elements(it->'img') loop
            if jsonb_typeof(img) <> 'string' or (img #>> '{}') !~ '^[0-9a-f]{12}\.jpg$' then
              raise exception 'Donnée refusée (%) : nom de photo invalide « % »', v_where, left(img #>> '{}', 60) using errcode = '22023';
            end if;
          end loop;
        end if;
      end loop;
    end loop;
  end loop;

  -- unicité : catégories, articles (clé des prix mémorisés), références Onlinefact
  select xc->>'id' into v_dup from jsonb_array_elements(p->'categories') xc group by 1 having count(*) > 1 limit 1;
  if v_dup is not null then raise exception 'Donnée refusée : catégorie « % » en double', v_dup using errcode = '22023'; end if;
  select (xc->>'id') || ' / ' || (xi->>'nl') into v_dup
    from jsonb_array_elements(p->'categories') xc, jsonb_array_elements(xc->'sections') xs, jsonb_array_elements(xs->'items') xi
    group by 1 having count(*) > 1 limit 1;
  if v_dup is not null then raise exception 'Donnée refusée : article « % » en double', v_dup using errcode = '22023'; end if;
  select xe->>1 into v_dup
    from jsonb_array_elements(p->'categories') xc, jsonb_array_elements(xc->'sections') xs, jsonb_array_elements(xs->'items') xi,
         jsonb_array_elements(xi->'r') xl(arr), jsonb_array_elements(xl.arr) xe
    group by 1 having count(*) > 1 limit 1;
  if v_dup is not null then raise exception 'Donnée refusée : référence Onlinefact « % » utilisée plusieurs fois', v_dup using errcode = '22023'; end if;
  return v_count;
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

-- Prix mémorisés du magasin. "valid" = le couple prix/référence existe encore pour cet
-- article dans le catalogue actuel. Les anciens choix sont conservés, jamais effacés.
drop function if exists public.get_prefs(int, text);
create function public.get_prefs(p_shop int, p_code text)
returns table (brand text, item text, stars int, price numeric, ref text, updated_at timestamptz, valid boolean)
language plpgsql security definer set search_path = public as $$
begin
  if not public._shop_check(p_shop, p_code) then return; end if;
  return query select p.brand, p.item, p.stars, p.price, p.ref, p.updated_at,
                      (public._match_choice(p.item, p.price, p.ref)).o_level is not null
               from public.prefs p where p.shop_id = p_shop;
end $$;

-- Mémoriser un choix. Le serveur vérifie que [prix, référence] existe pour cet article
-- dans le catalogue actuel et que la marque existe ; il déduit lui-même les étoiles et le
-- libellé (p_label et p_stars sont gardés pour compatibilité mais ignorés).
drop function if exists public.set_pref(int, text, text, text, text, int, numeric, text);
create function public.set_pref(p_shop int, p_code text, p_brand text, p_item text,
                                p_label text, p_stars int, p_price numeric, p_ref text)
returns boolean language plpgsql security definer set search_path = public as $$
declare m record;
begin
  if not public._shop_check(p_shop, p_code) then return false; end if;
  if length(coalesce(p_brand, '')) = 0 or length(p_brand) > 200 or length(coalesce(p_item, '')) = 0
     or length(p_item) > 200 or length(coalesce(p_ref, '')) = 0 or length(p_ref) > 50
     or p_price is null or p_price < 0 or p_price > 10000 then
    raise exception 'invalid value' using errcode = '22023';
  end if;
  select * into m from public._match_choice(p_item, p_price, p_ref);
  if m.o_level is null then
    raise exception 'invalid choice: price/reference not in catalogue' using errcode = '22023';
  end if;
  if p_brand <> '*' and not public._brand_exists(p_brand) then
    raise exception 'invalid choice: unknown brand' using errcode = '22023';
  end if;
  insert into public.prefs (shop_id, brand, item, item_label, stars, price, ref, updated_at)
  values (p_shop, p_brand, p_item, m.o_label, m.o_level, p_price, p_ref, now())
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

-- Charger les marques ou les listes de prix : chaque entrée est vérifiée avant d'être acceptée.
-- Si une seule entrée est refusée, rien n'est remplacé et le message dit laquelle.
create or replace function public.upload_app_data(p_admin text, p_key text, p_data jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if not public._admin_check(p_admin) then return false; end if;
  if p_key not in ('brands', 'prices') then
    raise exception 'invalid key' using errcode = '22023';
  end if;
  if p_data is null or length(p_data::text) > 8000000 then
    raise exception 'Donnée refusée : fichier vide ou trop gros' using errcode = '22023';
  end if;
  if p_key = 'brands' then perform public._validate_brands(p_data);
  else perform public._validate_prices(p_data);
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

-- Vérifier les données déjà en base avec les règles de chargement :   select check_app_data();
create or replace function public.check_app_data()
returns text language plpgsql security definer set search_path = public as $$
declare v_b int; v_r int;
begin
  v_b := public._validate_brands((select data from public.app_data where key = 'brands'));
  v_r := public._validate_prices((select data from public.app_data where key = 'prices'));
  return format('OK: %s marques, %s références Onlinefact valides', v_b, v_r);
end $$;

-- Vue de contrôle : tous les prix mémorisés, par magasin (Table Editor > pref_report)
-- "statut" signale les choix qui n'existent plus dans le catalogue actuel.
create or replace view public.pref_report with (security_invoker = true) as
  select s.name as magasin, case when p.brand = '*' then '(toutes marques)' else p.brand end as marque,
         p.item_label as article,
         repeat('*', coalesce(p.stars, 0)) as etoiles, p.price as prix, p.ref as ref_onlinefact,
         p.updated_at as modifie_le,
         case when (public._match_choice(p.item, p.price, p.ref)).o_level is null
              then 'plus dans le catalogue' else 'OK' end as statut
  from public.prefs p join public.shops s on s.id = p.shop_id
  order by s.name, p.brand, p.item_label;

-- ---------- Droits ----------
-- Tout est d'abord fermé, puis seules les fonctions du site sont ouvertes.
revoke all on function public._guard(text)                   from public, anon, authenticated;
revoke all on function public._fail(text)                    from public, anon, authenticated;
revoke all on function public._shop_ok(int, text)            from public, anon, authenticated;
revoke all on function public._shop_check(int, text)         from public, anon, authenticated;
revoke all on function public._admin_check(text)             from public, anon, authenticated;
revoke all on function public._match_choice(text, numeric, text) from public, anon, authenticated;
revoke all on function public._brand_exists(text)            from public, anon, authenticated;
revoke all on function public._v_text(jsonb, text, int)      from public, anon, authenticated;
revoke all on function public._v_money(jsonb, text)          from public, anon, authenticated;
revoke all on function public._v_keys(jsonb, text, text[], text[]) from public, anon, authenticated;
revoke all on function public._validate_brands(jsonb)        from public, anon, authenticated;
revoke all on function public._validate_prices(jsonb)        from public, anon, authenticated;
revoke all on function public.add_shop(text, text)           from public, anon, authenticated;
revoke all on function public.disable_shop(text)             from public, anon, authenticated;
revoke all on function public.set_admin_code(text)           from public, anon, authenticated;
revoke all on function public.unblock_shop(text)             from public, anon, authenticated;
revoke all on function public.check_app_data()               from public, anon, authenticated;
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
