# Phase 87: the CRM, deploy steps

Do these in order. The server needs the new tables before it starts, and the pages need the new server.

## 1. Run the SQL (Supabase → SQL editor)

Run `sql/schema-phase87.sql` once. It is safe to run again.

It creates `crm_leads`, `crm_activities`, `crm_tasks`, `crm_influencers` and `crm_influencer_posts`, and adds `lat`, `lng`, `city` and `country` to `clients`. It sets `tools_enabled` to `{}`, so **every social media tool starts switched off**. It copies the agency's own Lead Finder business leads into `crm_leads`, tagged "Lead Finder", along with their notes. It copies every influencer into `crm_influencers`. The old tables are left as they are.

Check that it worked:

```sql
select (select count(*) from crm_leads) leads, (select count(*) from crm_influencers) creators,
       (select value from system_settings where key = 'tools_enabled') tools;
```

## 2. Deploy the server (Render)

Merge to the branch Render deploys. On start the log shows the tools switch it loaded. With everything off, it shows `xp_off` and no scheduler.

To keep a tool on during the move without touching the database, set `TOOLS_ENABLED` on Render, e.g. `reports,metaai`, or `all`. The environment variable wins over the stored switch. Remove it afterwards and use Settings instead.

## 3. Deploy the pages (Netlify)

After a sign-in, `index.html` now opens `crm.html`, and the CRM entry replaces Home in the old shell's navigation.

## What changed for people

| Before | Now |
| --- | --- |
| Home | **CRM**: Overview by department, Leads, Pipeline, Influencers map, Clients, Settings |
| Tools always running | Off until an admin turns them on (CRM → Settings, or Admin → Tools) |
| Lead Finder pipeline | Its business leads live in CRM → Leads, source *Social*, tag *Lead Finder* |

A lead only becomes **Won** through *Convert to client*. That creates the client and keeps the lead's history.

## Next phases

1. **Email automation:** connect a Google Workspace mailbox on edgelead.online, then sequences, reply detection, tracking and unsubscribe.
2. **Twilio dialer:** call from the lead record, with every call logged on its timeline.
