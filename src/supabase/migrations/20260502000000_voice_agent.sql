-- Voice agent MVP: тройка таблиц для задач звонков, escalation-сообщений и событий.

create table if not exists call_tasks (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  user_id           text not null,
  original_request  text not null,
  parsed_intent     jsonb not null default '{}'::jsonb,
  status            text not null default 'draft'
                      check (status in ('draft','confirmed','calling','escalated','completed','failed','cancelled')),
  vapi_call_id      text,
  result_summary    text,
  transcript_url    text,
  recording_url     text,
  outcome           text check (outcome in ('success','partial','failed')),
  metadata          jsonb not null default '{}'::jsonb
);

create index if not exists call_tasks_user_status_idx
  on call_tasks (user_id, status, created_at desc);

create index if not exists call_tasks_vapi_idx
  on call_tasks (vapi_call_id) where vapi_call_id is not null;

create table if not exists call_messages (
  id            uuid primary key default gen_random_uuid(),
  call_task_id  uuid not null references call_tasks(id) on delete cascade,
  created_at    timestamptz not null default now(),
  direction     text not null check (direction in ('agent_to_user','user_to_agent')),
  content       text not null,
  responded     boolean not null default false,
  metadata      jsonb not null default '{}'::jsonb
);

create index if not exists call_messages_task_idx
  on call_messages (call_task_id, created_at desc);

create index if not exists call_messages_unresponded_idx
  on call_messages (call_task_id, responded)
  where direction = 'agent_to_user' and responded = false;

create table if not exists call_events (
  id            uuid primary key default gen_random_uuid(),
  call_task_id  uuid not null references call_tasks(id) on delete cascade,
  created_at    timestamptz not null default now(),
  event_type    text not null,
  payload       jsonb not null default '{}'::jsonb
);

create index if not exists call_events_task_idx
  on call_events (call_task_id, created_at desc);

create or replace function touch_call_tasks_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists call_tasks_touch_updated_at on call_tasks;
create trigger call_tasks_touch_updated_at
  before update on call_tasks
  for each row execute function touch_call_tasks_updated_at();

-- Функции ходят с service role; RLS без политик закрывает таблицы для anon-ключа.
alter table public.call_tasks    enable row level security;
alter table public.call_messages enable row level security;
alter table public.call_events   enable row level security;
