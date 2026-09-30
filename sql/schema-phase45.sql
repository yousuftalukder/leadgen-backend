-- ---------------------------------------------------------------------
-- PHASE 45 — disconnecting Meta really deletes what was read from it.
--
-- Until now "Disconnect" and Meta's data-deletion request removed
-- EdgeLead's own meta_connections rows (and what cascades from them) but
-- not the Owner Assistant's copy under xp_: its tokens, posts, numbers,
-- audience, comments, ads and chat stayed, and the twice-daily read kept
-- going. Settled rows in that warehouse are guarded against deletion, so
-- the server cannot remove them through the REST API. This adds the one
-- function that can, callable by the server only.
--
--   el_xp_purge(client, el_connection_ids)
--     el_connection_ids null  → everything the assistant holds for the
--                               business, and the business itself, so no
--                               read runs for it again
--     el_connection_ids given → only what came from those connections
--                               (one Page of several); everything, as
--                               above, when nothing else would remain
--
-- Also: final ad rows honour the same deliberate override as every other
-- guarded table, and chats that were only hidden are erased now that
-- deleting a chat erases it.
--
-- Run in the Supabase SQL editor before deploying the phase-45 server.
-- Idempotent.
-- ---------------------------------------------------------------------

-- A final ad row could not be removed at all, not even deliberately.
create or replace function fn_guard_final_ad_row() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_setting('app.allow_snapshot_rewrite', true) = 'on' then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.is_final then
      raise exception 'xp_ad_daily_snapshots: ad % on % is final and cannot be deleted', old.ad_id, old.metric_date;
    end if;
    return old;
  end if;
  if old.is_final then
    raise exception 'xp_ad_daily_snapshots: ad % on % is final and cannot change', old.ad_id, old.metric_date;
  end if;
  new.first_observed_at := old.first_observed_at;
  if new.is_final is not distinct from old.is_final then new.observed_at := now(); end if;
  return new;
end $$;

create or replace function public.el_xp_purge(p_client uuid, p_el_connections uuid[] default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conns  uuid[];
  v_users  text[];
  v_assets uuid[];
  v_full   boolean;
  v_n      int;
  v_out    jsonb := '{}'::jsonb;
begin
  -- Settled rows are immutable to everything else; this deletion is the deliberate exception.
  perform set_config('app.allow_snapshot_rewrite', 'on', true);

  select coalesce(array_agg(id), '{}'), coalesce(array_agg(meta_user_id) filter (where meta_user_id is not null), '{}')
    into v_conns, v_users
    from xp_meta_connections
   where client_id = p_client
     and (p_el_connections is null or el_connection_id = any(p_el_connections));

  v_full := p_el_connections is null
         or not exists (select 1 from xp_meta_connections where client_id = p_client and not (id = any(v_conns)));

  select coalesce(array_agg(id), '{}') into v_assets
    from xp_meta_assets
   where client_id = p_client
     and (v_full or connection_id = any(v_conns));

  -- Rows that point at an asset or a sync run without cascading.
  delete from xp_account_metric_observations where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('observations', v_n);
  update xp_data_conventions set asset_id = null where asset_id = any(v_assets);

  delete from xp_post_comments where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('comments', v_n);
  delete from xp_audience_snapshots where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('audience', v_n);
  delete from xp_post_metric_snapshots where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('postReadings', v_n);
  delete from xp_account_metric_snapshots where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('dailyReadings', v_n);
  delete from xp_meta_posts where asset_id = any(v_assets) or (v_full and client_id = p_client);
  get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('posts', v_n);
  delete from xp_sync_runs where asset_id = any(v_assets) or (v_full and client_id = p_client);

  if v_full then
    -- Ad accounts are found through the owner's Meta login; keep one only if another business's ads are in it.
    delete from xp_meta_ad_accounts a
     where a.client_id = p_client
        or (a.meta_user_id = any(v_users)
            and not exists (select 1 from xp_meta_ads d where d.ad_account_id = a.ad_account_id and d.client_id is distinct from p_client));
    get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('adAccounts', v_n);
    delete from xp_ad_daily_snapshots where client_id = p_client;
    delete from xp_ai_conversations where client_id = p_client;           -- messages cascade
    get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('chats', v_n);
    update xp_apify_runs set client_id = null where client_id = p_client;
    delete from xp_clients where id = p_client;                            -- tokens, assets and the rest cascade
    get diagnostics v_n = row_count; v_out := v_out || jsonb_build_object('business', v_n);
  else
    delete from xp_meta_assets where id = any(v_assets);
    delete from xp_meta_connections where id = any(v_conns);
  end if;

  return v_out || jsonb_build_object('full', v_full, 'assets', coalesce(array_length(v_assets, 1), 0), 'connections', coalesce(array_length(v_conns, 1), 0));
end $$;

revoke all on function public.el_xp_purge(uuid, uuid[]) from public, anon, authenticated;
grant execute on function public.el_xp_purge(uuid, uuid[]) to service_role;
comment on function public.el_xp_purge(uuid, uuid[]) is
  'Deletes what the Owner Assistant read from Meta for one business (or for some of its connections). Called by the server on Disconnect and on Meta''s data-deletion request.';

-- Chats that were only hidden are erased now, the way deleting a chat erases it from phase 45 on:
-- title, questions, answers and the data behind them. One bare row per message stays (when, and the
-- tokens it cost) so the daily question limit cannot be reset by deleting chats.
update xp_ai_conversations set title = null where deleted_at is not null;
update xp_ai_messages set content = null, tool_calls = null, tool_results = null
 where conversation_id in (select id from xp_ai_conversations where deleted_at is not null);
