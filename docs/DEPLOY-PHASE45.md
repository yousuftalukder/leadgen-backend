# Phase 45 — disconnecting Meta deletes what was read from it

## Before you deploy

1. **Check Render → Environment has `APP_ENCRYPTION_KEY`.** From this phase on, production never stores a secret unencrypted. Without the key, connecting Meta and saving an Apify or AI key are refused with a message saying what to set, and the assistant no longer falls back to its built-in development key. If the key is missing, set it first (`openssl rand -hex 32`).
2. **If Render has a `META_SCOPES` variable, remove it,** or add `pages_read_user_content` and `instagram_manage_comments` to it. Otherwise the new default is overridden.

## Run, in this order

1. **SQL:** run `sql/schema-phase45.sql` in the Supabase SQL editor (project `sasbwgollyjpwegsbrty`). It is idempotent and adds three things:
   - The function `el_xp_purge(client, el_connection_ids)`. Only the server can call it.
   - Final ad rows now accept the same deliberate override as every other guarded table.
   - Chats that were previously only hidden are erased.
2. **Server:** merge (Render deploys it).
3. **Pages:** Netlify deploys the reworded `privacy.html` and `data-deletion.html`.

## What changed

- **Disconnect** and **Meta's data-deletion request** now run the same deletion:
  - the owner reports built from the connection
  - the connection itself, with its media, snapshots and daily numbers
  - the Owner Assistant's copy: tokens, posts, readings, audience, comments and ads

  When a business has no Meta account left connected, its assistant chats and warehouse row go too, and the twice-daily read stops for it. Disconnecting one Page of several removes only that Page's copy.
- **Orphaned copies are cleaned up.** A copy whose EdgeLead connection no longer exists (for example, its client was deleted, or it was disconnected before this phase) is removed on the next scheduled read.
- **Deleting a chat erases it:** the title, every question and answer, and the data behind each answer. One bare row per message stays (when it was asked, and the tokens it cost), so deleting chats cannot reset the daily question limit.
- **Chats unused for 12 months are deleted** by a daily job. Set `CHAT_RETENTION_DAYS` to change the period.
- **Comments are stored and now readable.** The Facebook login asks for `pages_read_user_content` and `instagram_manage_comments`. Owners connected before this phase must reconnect once to grant them. Both permissions need Meta App Review.
- **The privacy and data-deletion pages now state** comments and commenter usernames, what Edge Meta AI sends to Gemini, the 12-month chat limit, and exactly what Disconnect removes.

## Check after deploy

On a test client:
1. Connect Meta, press **Read my numbers now**, and ask the assistant a question.
2. Press **Disconnect**.
3. In the Supabase SQL editor, confirm nothing is left for that client:

```sql
select 'xp_clients', count(*) from xp_clients where id = '<client id>'
union all select 'xp_meta_assets', count(*) from xp_meta_assets where client_id = '<client id>'
union all select 'xp_post_comments', count(*) from xp_post_comments where client_id = '<client id>'
union all select 'xp_ai_conversations', count(*) from xp_ai_conversations where client_id = '<client id>';
```

All four counts should be 0.
