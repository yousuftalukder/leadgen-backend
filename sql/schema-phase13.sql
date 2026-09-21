-- =====================================================================
-- EDGELEAD — PHASE 13 MIGRATION
--
-- Run this in the Supabase SQL editor BEFORE deploying server.js.
-- Safe to run more than once.
--
-- Accounts, trial and quota. This is the foundation the client side
-- stands on: until an account has a lifecycle and a spend ceiling,
-- opening signup means opening the shared Apify pool to anyone.
--
-- What it does:
--   1. Account lifecycle on app_users — trial window, paid window, and
--      who activated it.
--   2. el_account_state(), one place that decides what an account is.
--   3. usage_counters + usage_limits, the quota ledger.
--   4. el_quota_consume() / el_quota_release(), atomic gate and refund.
--   5. Default caps seeded into system_settings.
--
-- Deliberately NOT here: no payment tables, no invoices, no webhook
-- state. Activation is manual — an admin sets paid_until from the admin
-- panel and money is collected out of band.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. ACCOUNT LIFECYCLE
--
--    app_users.role stays free text with no check constraint, exactly as
--    schema.sql left it. Phase 13 adds one value to the vocabulary:
--
--      'admin'  — everything, as today
--      'user'   — employee. Tools are gated by user_engine_access.
--      'viewer' — as today
--      'client' — NEW. Self-serve account. Sees the client surface only,
--                 and is the only role a trial or paid window applies to.
--
--    There is deliberately no account_state column. State is derived from
--    time, which means a trial expires on its own with nothing scheduled
--    to expire it — no cron, no sweep, no row that can be left stale.
--    is_active keeps its current meaning as the hard suspend switch.
--
--    An existing row gets nulls everywhere, so every employee and admin
--    already in the table is unaffected: el_account_state() answers on
--    role before it ever looks at a date.
-- ---------------------------------------------------------------------
alter table public.app_users add column if not exists trial_started_at timestamptz;
alter table public.app_users add column if not exists trial_ends_at    timestamptz;
alter table public.app_users add column if not exists paid_until       timestamptz;
alter table public.app_users add column if not exists activated_by     uuid;
alter table public.app_users add column if not exists activated_at     timestamptz;
alter table public.app_users add column if not exists plan_label       text;

comment on column public.app_users.trial_ends_at is
    'End of the free trial window. Null means this account never had one.';
comment on column public.app_users.paid_until is
    'End of paid access, set by an admin on manual activation. Null means never activated.';
comment on column public.app_users.plan_label is
    'Free text shown in the admin panel, e.g. "Starter — 3 months". Not a billing key.';

-- The admin panel needs "who lapses next" to be cheap, and it is the
-- query that gets run most often once there are clients.
create index if not exists idx_app_users_expiry
    on public.app_users (coalesce(paid_until, trial_ends_at))
    where role = 'client';


-- ---------------------------------------------------------------------
-- 2. ONE PLACE THAT DECIDES WHAT AN ACCOUNT IS
--
--    Both the server gate and the admin panel read this, so a client can
--    never be shown "active" on one screen while being refused by the
--    other. Order matters: suspension beats everything, role beats dates,
--    paid beats trial.
--
--    Returns: suspended | admin | employee | paid | trial | expired
-- ---------------------------------------------------------------------
create or replace function public.el_account_state(p_user uuid)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
    select case
        when u.is_active is not true                           then 'suspended'
        when u.role = 'admin'                                  then 'admin'
        when u.role <> 'client'                                then 'employee'
        when u.paid_until    is not null and u.paid_until    > now() then 'paid'
        when u.trial_ends_at is not null and u.trial_ends_at > now() then 'trial'
        else 'expired'
    end
    from public.app_users u
    where u.id = p_user;
$$;


-- ---------------------------------------------------------------------
-- 3. THE QUOTA LEDGER
--
--    usage_counters is append-in-place: one row per (account, period,
--    metric). The period key is 'trial' for the trial window and
--    'YYYY-MM' afterwards, so a trial cap and a monthly cap never share
--    a counter and nothing has to be reset on the boundary.
--
--    Metrics in use:
--      ig_report        one Instagram report run
--      fb_group_audit   one group audit run
--      leads            lead rows written
--      usd              estimated Apify spend, the backstop
--
--    usd is the one that actually protects the pool. Item counts assume
--    a run costs what it usually costs; a runaway actor breaks that
--    assumption without exceeding any item count.
-- ---------------------------------------------------------------------
create table if not exists public.usage_counters (
    user_id    uuid    not null references auth.users(id) on delete cascade,
    period     text    not null,
    metric     text    not null,
    used       numeric not null default 0,
    updated_at timestamptz not null default timezone('utc'::text, now()),
    primary key (user_id, period, metric)
);

alter table public.usage_counters enable row level security;

-- Per-account overrides. Absent means "use the default for this state",
-- which lives in system_settings. A null cap means unlimited, so an
-- employee or a negotiated client can be exempted from one metric
-- without being exempted from all of them.
create table if not exists public.usage_limits (
    user_id uuid    not null references auth.users(id) on delete cascade,
    metric  text    not null,
    cap     numeric,
    note    text,
    primary key (user_id, metric)
);

alter table public.usage_limits enable row level security;


-- ---------------------------------------------------------------------
-- 4. ATOMIC GATE AND REFUND
--
--    Same reasoning as the phase 3 budget reservation: two jobs starting
--    together must not both read the counter, both see room, and both
--    proceed. The row is locked for the check and the increment, so the
--    second waits and then fails honestly.
--
--    Consume raises quota_exceeded rather than returning false, so a
--    caller that forgets to check the result still cannot overspend.
--    A null cap means unlimited and always passes.
-- ---------------------------------------------------------------------
create or replace function public.el_quota_consume(
    p_user   uuid,
    p_period text,
    p_metric text,
    p_amount numeric,
    p_cap    numeric
)
returns numeric
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
    v_used numeric;
begin
    insert into public.usage_counters (user_id, period, metric, used)
    values (p_user, p_period, p_metric, 0)
    on conflict (user_id, period, metric) do nothing;

    select used into v_used
    from public.usage_counters
    where user_id = p_user and period = p_period and metric = p_metric
    for update;

    if p_cap is not null and v_used + p_amount > p_cap then
        raise exception 'quota_exceeded: % at % of %, requested %',
                        p_metric, v_used, p_cap, p_amount
              using errcode = 'check_violation';
    end if;

    update public.usage_counters
    set used = used + p_amount,
        updated_at = timezone('utc'::text, now())
    where user_id = p_user and period = p_period and metric = p_metric;

    return case when p_cap is null then null else p_cap - (v_used + p_amount) end;
end;
$$;

-- A job that reserved quota and then failed gives it back. Never drops
-- below zero: a double release must not hand out free credit.
create or replace function public.el_quota_release(
    p_user   uuid,
    p_period text,
    p_metric text,
    p_amount numeric
)
returns numeric
language plpgsql
volatile
set search_path = public, pg_temp
as $$
declare
    v_used numeric;
begin
    update public.usage_counters
    set used = greatest(0, used - p_amount),
        updated_at = timezone('utc'::text, now())
    where user_id = p_user and period = p_period and metric = p_metric
    returning used into v_used;

    return coalesce(v_used, 0);
end;
$$;

-- The service role calls these; nothing else should be able to.
revoke all on function public.el_account_state(uuid)                              from public, anon, authenticated;
revoke all on function public.el_quota_consume(uuid, text, text, numeric, numeric) from public, anon, authenticated;
revoke all on function public.el_quota_release(uuid, text, text, numeric)          from public, anon, authenticated;
grant execute on function public.el_account_state(uuid)                              to service_role;
grant execute on function public.el_quota_consume(uuid, text, text, numeric, numeric) to service_role;
grant execute on function public.el_quota_release(uuid, text, text, numeric)          to service_role;


-- ---------------------------------------------------------------------
-- 5. DEFAULT CAPS
--
--    system_settings.value is text, as schema.sql defined it, so these
--    are JSON strings the server parses — same as every other setting
--    already stored there.
--
--    trial_caps is the ceiling that matters. The usd figure is the one
--    to tune first: it is what a trial account can cost before it stops,
--    regardless of how it spent it.
--
--    on conflict do nothing, so re-running never overwrites a number an
--    admin has since tuned.
-- ---------------------------------------------------------------------
insert into public.system_settings (key, value) values
    ('trial_days',
     '7'),
    ('trial_caps',
     '{"ig_report":1,"fb_group_audit":1,"leads":50,"usd":2.00}'),
    ('client_monthly_caps',
     '{"ig_report":4,"fb_group_audit":4,"leads":500,"usd":25.00}')
on conflict (key) do nothing;


-- ---------------------------------------------------------------------
-- DONE
--
-- Every existing account should read as admin or employee, and none of
-- them should have a trial or paid window:
--
--     select email, role, public.el_account_state(id) as state,
--            trial_ends_at, paid_until
--     from public.app_users order by role, email;
--
-- The gate is exercised by consuming against a cap of zero, which must
-- raise quota_exceeded:
--
--     select public.el_quota_consume(
--       '00000000-0000-0000-0000-000000000000', 'trial', 'leads', 1, 0);
--
-- Deploy order from here: server.js reads el_account_state on every
-- authenticated request and calls el_quota_consume inside createJob,
-- before the Apify budget reservation. Pages last.
-- ---------------------------------------------------------------------
