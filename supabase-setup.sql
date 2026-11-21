-- Exkursionskarte Aachen: Datenbank einrichten
-- In Supabase unter "SQL Editor" komplett einfügen und auf "Run" klicken.
-- Das Skript kann gefahrlos mehrfach ausgeführt werden.

create extension if not exists pgcrypto;

-- Tabellen ---------------------------------------------------------------

create table if not exists public.zugang (
  rolle text primary key check (rolle in ('schueler', 'lehrer')),
  code  text not null
);

create table if not exists public.kategorien (
  id      uuid primary key default gen_random_uuid(),
  name    text not null check (char_length(name) between 1 and 40),
  farbe   text not null check (farbe ~ '^#[0-9a-fA-F]{6}$'),
  erstellt timestamptz not null default now()
);
create unique index if not exists kategorien_name_eindeutig on public.kategorien (lower(name));

create table if not exists public.orte (
  id           uuid primary key default gen_random_uuid(),
  name         text not null check (char_length(name) between 1 and 80),
  notiz        text not null default '' check (char_length(notiz) <= 1500),
  kategorie_id uuid references public.kategorien(id) on delete set null,
  lat          double precision not null check (lat between -90 and 90),
  lng          double precision not null check (lng between -180 and 180),
  gruppe       text not null default '' check (char_length(gruppe) <= 40),
  fotos        text[] not null default '{}' check (cardinality(fotos) <= 12),
  geraet       text not null default '',
  erstellt     timestamptz not null default now(),
  geaendert    timestamptz not null default now()
);

create table if not exists public.einstellungen (
  schluessel text primary key,
  wert       text not null default ''
);

-- Direkter Zugriff ist gesperrt; alles läuft über die Funktionen unten,
-- die den Klassencode prüfen.
alter table public.zugang        enable row level security;
alter table public.kategorien    enable row level security;
alter table public.orte          enable row level security;
alter table public.einstellungen enable row level security;

-- Codes (hier bei Bedarf ändern und das Skript erneut ausführen) ---------

insert into public.zugang (rolle, code) values
  ('schueler', 'KLASSENCODE_HIER'),
  ('lehrer',   'LEHRERCODE_HIER')
on conflict (rolle) do update set code = excluded.code;

-- Funktionen -------------------------------------------------------------

create or replace function public.rolle_fuer(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select rolle from zugang where code = trim(p_code)
  order by case rolle when 'lehrer' then 0 else 1 end limit 1
$$;
revoke all on function public.rolle_fuer(text) from public, anon, authenticated;

create or replace function public.pruefe_code(p_code text)
returns text language sql stable security definer set search_path = public as $$
  select public.rolle_fuer(p_code)
$$;

create or replace function public.daten_laden(p_code text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare r text := rolle_fuer(p_code);
begin
  if r is null then raise exception 'Falscher Klassencode' using errcode = '28000'; end if;
  return jsonb_build_object(
    'rolle', r,
    'kategorien', coalesce((select jsonb_agg(to_jsonb(k) order by k.erstellt) from kategorien k), '[]'::jsonb),
    'orte',       coalesce((select jsonb_agg(to_jsonb(o) order by o.erstellt) from orte o), '[]'::jsonb),
    'aufgabe',    coalesce((select wert from einstellungen where schluessel = 'aufgabe'), '')
  );
end $$;

create or replace function public.ort_speichern(p_code text, p_ort jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  r text := rolle_fuer(p_code);
  v_id uuid := nullif(p_ort->>'id', '')::uuid;
  v_fotos text[] := coalesce(array(select jsonb_array_elements_text(p_ort->'fotos')), '{}');
begin
  if r is null then raise exception 'Falscher Klassencode' using errcode = '28000'; end if;
  if v_id is null then
    insert into orte (name, notiz, kategorie_id, lat, lng, gruppe, fotos, geraet)
    values (trim(p_ort->>'name'), coalesce(p_ort->>'notiz', ''), nullif(p_ort->>'kategorie_id', '')::uuid,
            (p_ort->>'lat')::float8, (p_ort->>'lng')::float8, coalesce(p_ort->>'gruppe', ''), v_fotos,
            coalesce(p_ort->>'geraet', ''))
    returning id into v_id;
  else
    update orte set
      name = trim(p_ort->>'name'),
      notiz = coalesce(p_ort->>'notiz', ''),
      kategorie_id = nullif(p_ort->>'kategorie_id', '')::uuid,
      lat = (p_ort->>'lat')::float8,
      lng = (p_ort->>'lng')::float8,
      fotos = v_fotos,
      geaendert = now()
    where id = v_id and (r = 'lehrer' or geraet = coalesce(p_ort->>'geraet', ''));
    if not found then
      raise exception 'Nur die eigene Gruppe oder die Lehrkraft kann diesen Ort ändern' using errcode = '42501';
    end if;
  end if;
  return v_id;
end $$;

create or replace function public.ort_loeschen(p_code text, p_id uuid, p_geraet text)
returns void language plpgsql security definer set search_path = public as $$
declare r text := rolle_fuer(p_code);
begin
  if r is null then raise exception 'Falscher Klassencode' using errcode = '28000'; end if;
  delete from orte where id = p_id and (r = 'lehrer' or geraet = coalesce(p_geraet, ''));
  if not found then
    raise exception 'Nur die eigene Gruppe oder die Lehrkraft kann diesen Ort löschen' using errcode = '42501';
  end if;
end $$;

create or replace function public.kategorie_speichern(p_code text, p_id uuid, p_name text, p_farbe text)
returns uuid language plpgsql security definer set search_path = public as $$
declare r text := rolle_fuer(p_code); v_id uuid := p_id;
begin
  if r is null then raise exception 'Falscher Klassencode' using errcode = '28000'; end if;
  if v_id is null then
    insert into kategorien (name, farbe) values (trim(p_name), p_farbe) returning id into v_id;
  else
    if r <> 'lehrer' then raise exception 'Nur die Lehrkraft kann Kategorien ändern' using errcode = '42501'; end if;
    update kategorien set name = trim(p_name), farbe = p_farbe where id = v_id;
  end if;
  return v_id;
end $$;

create or replace function public.kategorie_loeschen(p_code text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if rolle_fuer(p_code) is distinct from 'lehrer' then
    raise exception 'Nur die Lehrkraft kann Kategorien löschen' using errcode = '42501';
  end if;
  delete from kategorien where id = p_id;
end $$;

create or replace function public.aufgabe_setzen(p_code text, p_text text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if rolle_fuer(p_code) is distinct from 'lehrer' then
    raise exception 'Nur die Lehrkraft kann die Aufgabe ändern' using errcode = '42501';
  end if;
  insert into einstellungen (schluessel, wert) values ('aufgabe', left(coalesce(p_text, ''), 2000))
  on conflict (schluessel) do update set wert = excluded.wert;
end $$;

grant execute on function
  public.pruefe_code(text), public.daten_laden(text), public.ort_speichern(text, jsonb),
  public.ort_loeschen(text, uuid, text), public.kategorie_speichern(text, uuid, text, text),
  public.kategorie_loeschen(text, uuid), public.aufgabe_setzen(text, text)
to anon, authenticated;

-- Fotospeicher -----------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', true, 5242880, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set public = true, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Exkursion: Fotos hochladen" on storage.objects;
create policy "Exkursion: Fotos hochladen" on storage.objects
  for insert to anon, authenticated with check (bucket_id = 'fotos');
