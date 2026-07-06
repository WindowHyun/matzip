-- ============================================================
-- 맛집 데이터 백업/복구 (append-only 감사 이력)
-- 목적: "누구나 추가·삭제 가능"은 유지하되, 삭제/변경 사고를 복구
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣고 실행 (1회)
-- ============================================================

-- 1) 이력 테이블 — places의 모든 변경을 append-only로 보관 (절대 삭제되지 않음)
create table if not exists places_audit (
  audit_id    bigint generated always as identity primary key,
  op          text        not null check (op in ('INSERT','UPDATE','DELETE')),
  place_id    text,
  data        jsonb       not null,          -- 변경 시점의 행 전체(DELETE는 삭제 직전 값)
  actor       text,                          -- 변경 시도한 auth uid (있으면)
  changed_at  timestamptz not null default now()
);
create index if not exists idx_places_audit_place on places_audit(place_id, changed_at desc);

-- 2) 트리거 함수 — RLS와 무관하게 무조건 기록 (security definer)
create or replace function log_places_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'DELETE') then
    insert into places_audit(op, place_id, data, actor)
      values ('DELETE', old.id, to_jsonb(old), auth.uid()::text);
    return old;
  else
    insert into places_audit(op, place_id, data, actor)
      values (tg_op, new.id, to_jsonb(new), auth.uid()::text);
    return new;
  end if;
end;
$$;

-- 3) 트리거 연결
drop trigger if exists trg_places_audit on places;
create trigger trg_places_audit
after insert or update or delete on places
for each row execute function log_places_change();

-- 4) 이력 테이블 보호 — 클라이언트(anon/authenticated)는 접근 불가.
--    RLS를 켜고 정책을 만들지 않으면 아무도 못 읽고/못 씀 → 트리거(정의자 권한)만 기록.
alter table places_audit enable row level security;

-- 5) (선택) 최초 1회: 현재 places 전체를 기준선으로 스냅샷
insert into places_audit(op, place_id, data, actor)
  select 'INSERT', p.id, to_jsonb(p), 'baseline' from places p;

-- ============================================================
-- 복구용 도구 (Dashboard SQL Editor 에서 사용)
-- ============================================================

-- (A) 지금 삭제된 상태인 맛집 목록 = 이력엔 있는데 places엔 없는 것
create or replace view deleted_places as
select distinct on (a.place_id)
       a.place_id, a.data, a.changed_at
from places_audit a
where not exists (select 1 from places p where p.id = a.place_id)
order by a.place_id, a.changed_at desc;

-- (B) 특정 맛집을 마지막 상태로 되살리기:  select restore_place('d5');
create or replace function restore_place(target text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare last_row jsonb;
begin
  select data into last_row
    from places_audit
   where place_id = target and op <> 'DELETE'
   order by changed_at desc limit 1;
  if last_row is null then return '이력 없음: ' || target; end if;

  insert into places (id, name, cat, lat, lng, menu, comment, tags, added_by, created_at)
  select last_row->>'id', last_row->>'name', last_row->>'cat',
         (last_row->>'lat')::float8, (last_row->>'lng')::float8,
         coalesce(last_row->>'menu',''), coalesce(last_row->>'comment',''),
         coalesce((select array_agg(value) from jsonb_array_elements_text(last_row->'tags')), '{}'),
         coalesce(last_row->>'added_by','복구'),
         coalesce((last_row->>'created_at')::timestamptz, now())
  on conflict (id) do update
    set name=excluded.name, cat=excluded.cat, lat=excluded.lat, lng=excluded.lng,
        menu=excluded.menu, comment=excluded.comment, tags=excluded.tags;
  return '복구 완료: ' || target;
end;
$$;

-- (C) 삭제된 것 전부 한 번에 복구:
--     select restore_place(place_id) from deleted_places;

-- ============================================================
-- 참고: ratings 도 동일 패턴으로 감사하려면 위 1~4를 ratings 기준으로 복제하면 됩니다.
--       (별점은 rating_summary 뷰로 집계되므로 보통 places 이력만으로 충분)
-- ============================================================
