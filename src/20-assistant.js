/**
 * The owner assistant.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    GEMINI_KEY_COOLDOWN_MS, GEMINI_TIMEOUT_MS, METRICS, SHARE_DEFAULT_DAYS, SHARE_MAX_DAYS, UUID_RE,
    _geminiCoolLocal, _geminiDeadModels, app, auth, canReadReport, clientAccess, clientReportView,
    dedupeLeads, geminiCandidates, geminiIsThinkingLevelModel, geminiMarkKey, geminiModelChain,
    growthForConnections, logger, missingTable, monthlyContext, ownClientFor, peopleById, publicLimit,
    rateLimit, sendErr, shareToken, shareUrlFor, staffOnly, supabase, timeHeatmap
} = S;
Object.assign(S, {
    assistantDeclarations, assistantSystemPrompt, assistantScope, assistantAnswer, clientDemandView
});

// ===========================================================================
// OWNER ASSISTANT  (phase 15)
//
// A business owner asks a question in their own words and gets an answer
// built from their own data. Two tiers, and the difference between them is
// the whole upsell:
//
//   not connected — everything we could work out from the outside. Real, but
//                   it is what anyone looking at the account could see.
//   Meta connected — reach, saves, demographics, the numbers only the owner
//                   can see. Costs no Apify, which is why it is the thing
//                   worth putting in front of a trial.
//
// The model never writes SQL. It picks from bounded tools, each of which is
// an ordinary scoped query, so the blast radius of a bad model turn is a
// wrong sentence rather than a wrong read.
// ===========================================================================

const ASSISTANT_MAX_ROUNDS = parseInt(process.env.ASSISTANT_MAX_ROUNDS || '6', 10);
const ASSISTANT_HISTORY    = parseInt(process.env.ASSISTANT_HISTORY || '20', 10);
// Staff ask quick questions about one client between other work (phase 35).
// Three rounds covers "tasks + leads + the latest report"; a question that
// needs more is too broad, and the last round answers with what it has.
const ASSISTANT_STAFF_ROUNDS  = parseInt(process.env.ASSISTANT_STAFF_ROUNDS || '3', 10);
const ASSISTANT_STAFF_HISTORY = parseInt(process.env.ASSISTANT_STAFF_HISTORY || '8', 10);

/**
 * One model turn with function calling.
 *
 * Deliberately a sibling of geminiCallDetailed rather than a refactor of it.
 * That one carries a JSON-repair path every report narrative depends on, and
 * the risk of breaking it is not worth the saved lines. This shares everything
 * that matters — the key pool, the cooldowns, the model chain, the dead-model
 * map — and only the loop body differs.
 */
async function geminiToolTurn(contents, functionDeclarations, { systemInstruction, userId, tag = 'assistant', noCalls = false } = {}) {
    const candidates = await geminiCandidates(userId);
    if (!candidates.length) return { ok: false, reason: 'no_key' };

    METRICS.gemini.calls += 1;

    const models = await geminiModelChain(candidates[0].key);
    let keyIdx = 0, modelIdx = 0, withThinking = true;
    const maxAttempts = 3 + candidates.length + models.length;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (keyIdx >= candidates.length) {
            keyIdx = 0;
            await new Promise(r => setTimeout(r, Math.min(2000 * Math.pow(2, attempt), 15000)));
        }
        if (modelIdx >= models.length) break;

        const cand = candidates[keyIdx];
        const model = models[modelIdx];

        const generationConfig = { temperature: 0.2, maxOutputTokens: 2048 };
        if (withThinking) {
            generationConfig.thinkingConfig = geminiIsThinkingLevelModel(model)
                ? { thinkingLevel: 'low' } : { thinkingBudget: 512 };
        }

        const body = {
            contents,
            generationConfig,
            ...(systemInstruction ? { systemInstruction: { parts: [{ text: systemInstruction }] } } : {}),
            ...(functionDeclarations?.length ? { tools: [{ functionDeclarations }] } : {}),
            // Tools stay declared (earlier turns called them) but none may be called now.
            ...(noCalls && functionDeclarations?.length ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {})
        };

        try {
            const r = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
                { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cand.key },
                  body: JSON.stringify(body), signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });

            if (r.status === 429) {
                METRICS.gemini.retries += 1;
                if (cand.id) _geminiCoolLocal.set(cand.id, Date.now() + GEMINI_KEY_COOLDOWN_MS);
                await geminiMarkKey(cand.id, {
                    status: 'cooldown',
                    cooldown_until: new Date(Date.now() + GEMINI_KEY_COOLDOWN_MS).toISOString(),
                    last_error: '429'
                });
                keyIdx += 1; continue;
            }

            if (!r.ok) {
                const text = (await r.text()).slice(0, 400);
                if (r.status === 400 && /thinking/i.test(text) && withThinking) { withThinking = false; continue; }
                if ((r.status === 400 || r.status === 403) && /api key|API_KEY|permission|not valid/i.test(text)) {
                    await geminiMarkKey(cand.id, { status: 'invalid', last_error: text.slice(0, 200), fail_count: 99 });
                    keyIdx += 1; continue;
                }
                if (r.status === 404 || /model|not found|not supported/i.test(text)) {
                    _geminiDeadModels.set(model, Date.now());
                    modelIdx += 1; continue;
                }
                if (r.status >= 500) {
                    METRICS.gemini.retries += 1;
                    await new Promise(res => setTimeout(res, Math.min(2000 * Math.pow(2, attempt), 15000)));
                    continue;
                }
                METRICS.gemini.failed += 1;
                logger.error('assistant_gemini_failed', { tag, status: r.status, body: text });
                return { ok: false, reason: 'http_' + r.status };
            }

            await geminiMarkKey(cand.id, { last_used_at: new Date().toISOString(), status: 'active', cooldown_until: null });

            const json  = await r.json();
            const parts = json?.candidates?.[0]?.content?.parts || [];
            return {
                ok: true,
                parts,
                calls: parts.filter(p => p.functionCall).map(p => p.functionCall),
                text: parts.filter(p => p.text && !p.thought).map(p => p.text).join('').trim(),
                finishReason: json?.candidates?.[0]?.finishReason || null
            };
        } catch (e) {
            logger.warn('assistant_gemini_error', { tag, message: e.message, attempt });
            await new Promise(res => setTimeout(res, Math.min(1500 * Math.pow(2, attempt), 10000)));
        }
    }

    METRICS.gemini.failed += 1;
    return { ok: false, reason: 'exhausted' };
}

/**
 * What the assistant may read. Every tool is scoped to the asking account —
 * the scope is applied here, not passed in by the model, so no argument it
 * invents can widen it.
 */
const ASSISTANT_TOOLS = {
    get_monthly_report: {
        decl: {
            name: 'get_monthly_report',
            description: 'A finished monthly report built from owner-side Meta Insights: this month against last month across reach, engagement, profile visits and followers, plus the posts that performed and who the audience is. Use this for any question about a named month, "last month", "how did we do in September", or when asked to write up or summarise a month. It is the only source with month-over-month numbers — do not assemble a month by hand from other reports.',
            parameters: {
                type: 'OBJECT',
                properties: {
                    month: { type: 'STRING', description: 'The month as YYYY-MM, for example 2026-08. Leave it out for the most recent month available.' }
                }
            }
        },
        run: async (s, a) => {
            let q = supabase.from('reports')
                .select('id, snapshot_date, target_handle, report_json, ai_json')
                .eq('report_type', 'meta_monthly').or(s.reportScope);
            const m = String(a.month || '');
            if (/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) q = q.eq('snapshot_date', `${m}-01`);
            const { data } = await q.order('snapshot_date', { ascending: false }).limit(1);
            const row = (data || [])[0];
            if (!row) {
                return {
                    available: false,
                    note: m ? `No monthly report exists for ${m}.` : 'No monthly report has been produced for this account yet.',
                    how: 'A monthly report needs Meta connected for this account, then one run for the month.'
                };
            }
            const r = row.report_json || {};
            // The whole payload is far more than a turn needs and would crowd
            // out the conversation. What comes back is what a person writing
            // the month up would actually cite.
            return {
                available: true,
                month: r.month, monthLabel: r.monthLabel,
                comparedWith: r.comparable ? r.prevMonthLabel : null,
                account: r.account,
                movements: (r.deltas || []).map(d => ({
                    metric: d.label, value: d.now, previous: d.before,
                    changePct: d.pct, direction: d.kind
                })),
                postsPublished: r.posting?.count ?? null,
                byFormat: r.posting?.formats || null,
                bestPosts: (r.posting?.topByReach || []).map(p => ({
                    kind: p.kind, reach: p.reach, saved: p.saved, shares: p.shares,
                    caption: p.caption, link: p.permalink
                })),
                audience: r.demographics || null,
                narrative: row.ai_json || null,
                missing: r.gaps || [],
                source: 'owner Meta Insights'
            };
        }
    },

    get_my_reports: {
        decl: {
            name: 'get_my_reports',
            description: 'The list of reports that exist for this business, newest first, with their date, type and overall band. Call this first when the user asks anything about how they are doing, so you know what you actually have.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('reports')
                .select('id, report_type, target_handle, snapshot_date, created_at, grade, score')
                .or(s.reportScope).order('created_at', { ascending: false }).limit(20);
            return (data || []).map(r => ({
                id: r.id, type: r.report_type, handle: r.target_handle,
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade,
                band: r.score >= 80 ? 'strong' : r.score >= 65 ? 'healthy'
                    : r.score >= 50 ? 'mixed' : r.score >= 35 ? 'weak' : 'poor'
            }));
        }
    },

    get_report_detail: {
        decl: {
            name: 'get_report_detail',
            description: 'One report in full: the headline finding, how the business compares to similar businesses, what is working, what to change, and any gaps in their profile. Use the id from get_my_reports. This is the richest source you have — prefer it over guessing.',
            parameters: { type: 'OBJECT', properties: { report_id: { type: 'STRING' } }, required: ['report_id'] }
        },
        run: async (s, a) => {
            if (!UUID_RE.test(String(a.report_id || ''))) return { error: 'bad report id' };
            const { data } = await supabase.from('reports').select('*').eq('id', a.report_id).maybeSingle();
            if (!data) return { error: 'not found' };
            if (data.user_id !== s.userId && !(data.client_id && s.clientIds.includes(data.client_id))) {
                return { error: 'not found' };
            }
            // The monthly document is for reading; get_monthly_report already
            // gives the model the month's numbers, so it is not sent twice.
            const { month, doc, ...view } = clientReportView(data);
            if (s.audience !== 'operator') return view;
            // Staff get the gist (phase 35): the finding, where they stand, the
            // top three each way and the summary. The page has the rest.
            const titles = a => (a || []).slice(0, 3).map(x => x.title);
            return {
                type: view.title, date: view.date, handle: view.handle, headline: view.headline,
                standing: view.standing && view.standing.verdict ? { verdict: view.standing.verdict, gap: view.standing.gap } : null,
                working: titles(view.working), fix: titles(view.fix),
                ideas: (view.ideas || []).slice(0, 3).map(i => ({ idea: i.concept || i.hook, format: i.format })),
                rooms: (view.rooms || []).slice(0, 3).map(r => r.name),
                profileMissing: (view.profile && view.profile.missing) || [],
                summary: view.summary ? String(view.summary).slice(0, 600) : null,
                provisional: !!view.provisional
            };
        }
    },

    get_progress_over_time: {
        decl: {
            name: 'get_progress_over_time',
            description: 'How the overall score and engagement rate have moved across every Instagram report for this business, oldest first. Use for "are we improving", "is it working", "compared to last month".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('reports')
                .select('snapshot_date, created_at, score, grade, engagement_rate, followers_snapshot, posts_per_week, cohort_avg_er')
                .or(s.reportScope).in('report_type', ['ig_report', 'deep_audit'])
                .order('created_at', { ascending: true }).limit(24);
            return (data || []).map(r => ({
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade,
                engagement_rate: r.engagement_rate,
                peer_average_engagement: r.cohort_avg_er,
                followers: r.followers_snapshot,
                posts_per_week: r.posts_per_week
            }));
        }
    },

    get_best_posts: {
        decl: {
            name: 'get_best_posts',
            description: 'This account\'s own posts from the most recent analysis, ranked by engagement, with format, caption, when it went out and how it did. Use for "what worked", "what should I post more of", "why did that one do well".',
            parameters: { type: 'OBJECT', properties: { limit: { type: 'INTEGER', description: 'default 8, max 20' } } }
        },
        run: async (s, a) => {
            const { data } = await supabase.from('posts')
                .select('caption, post_type, likes, comments, views, posted_at, engagement_raw, hashtags, post_url')
                .eq('user_id', s.userId)
                .order('engagement_raw', { ascending: false })
                .limit(Math.min(parseInt(a.limit, 10) || 8, 20));
            return (data || []).map(p => ({
                format: p.post_type,
                posted_at: p.posted_at,
                caption: String(p.caption || '').slice(0, 220),
                likes: p.likes, comments: p.comments, views: p.views,
                hashtags: (p.hashtags || []).slice(0, 8)
            }));
        }
    },

    get_best_times: {
        decl: {
            name: 'get_best_times',
            description: 'When this account\'s posts do best, by day of week and hour, from its own history. Use for "when should I post".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            const { data } = await supabase.from('posts')
                .select('hour_local, dow_local, engagement_raw')
                .eq('user_id', s.userId).limit(500);
            if (!data || data.length < 8) return { error: 'not enough posts analysed yet to say anything useful about timing' };
            return timeHeatmap(data);
        }
    },

    get_community_demand: {
        decl: {
            name: 'get_community_demand',
            description: 'Real posts from local Facebook groups where somebody is asking for what this business sells — the request, how urgent it reads, and when it was posted. Authors are anonymous by design. Use for "who needs me right now", "what are people asking for".',
            parameters: { type: 'OBJECT', properties: { limit: { type: 'INTEGER', description: 'default 10, max 25' } } }
        },
        run: async (s, a) => {
            const { data } = await supabase.from('fb_demand_signals')
                .select('snippet, intent, urgency, category, group_name, posted_at, lead_score')
                .eq('user_id', s.userId)
                .order('posted_at', { ascending: false })
                .limit(Math.min(parseInt(a.limit, 10) || 10, 25));
            return (data || []).map(d => ({
                asking_for: String(d.snippet || '').slice(0, 240),
                kind: d.intent, urgency: d.urgency, category: d.category,
                group: d.group_name, posted_at: d.posted_at
            }));
        }
    },

    get_owner_insights: {
        decl: {
            name: 'get_owner_insights',
            description: 'The numbers only the account owner can see, from a connected Meta account: reach, impressions, profile visits, saves and audience demographics. Only available when the business has connected Meta. If it returns not_connected, say plainly that connecting Meta would let you answer that properly — do not guess at these figures from anything else.',
            parameters: { type: 'OBJECT', properties: { days: { type: 'INTEGER', description: 'how far back, default 30' } } }
        },
        run: async (s, a) => {
            if (!s.metaConnected) {
                return { not_connected: true,
                         note: 'This business has not connected Meta, so owner-only numbers are unavailable.' };
            }
            const days  = Math.min(Math.max(parseInt(a.days, 10) || 30, 1), 90);
            const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
            const { data } = await supabase.from('meta_snapshots')
                .select('snapshot_date, level, metrics')
                .in('connection_id', s.connectionIds || []).gte('snapshot_date', since)
                .order('snapshot_date', { ascending: true }).limit(120);
            if (!data || !data.length) {
                return { connected_but_empty: true,
                         note: 'Meta is connected but no insights have synced yet.' };
            }
            return { days, snapshots: data };
        }
    },

    get_daily_growth: {
        decl: {
            name: 'get_daily_growth',
            description: 'How followers, reach, profile visits and interactions have moved day by day, from the numbers synced from Meta every day. Use for "am I growing", "how many followers did I gain this week", "what changed since yesterday", "is this week better than last". Only available when the business has connected Meta; if it returns not_connected, say plainly that connecting Meta would let you answer that.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            if (!s.metaConnected) {
                return { not_connected: true, note: 'This business has not connected Meta, so there are no daily numbers.' };
            }
            const { level, growth } = await growthForConnections(s.connectionIds || []);
            if (growth.empty) {
                return { connected_but_empty: true, note: 'Meta is connected but the first daily numbers have not arrived yet; they sync within the hour.' };
            }
            return {
                level, ...growth,
                how_to_read: 'followers.now is the count today; followers.day/week/month are the change since yesterday, 7 and 30 days ago (null = not enough days yet); reach, views, profile_views and interactions compare the last 7 ended days with the 7 before.'
            };
        }
    },

    // ---- phase 35: the rest of the client, in counts and short lists ----------
    // These three only exist when the conversation is about one client, and
    // each returns a summary of a kilobyte or two, never raw rows: the model
    // needs the shape of the account, and the pages have the detail.

    get_tasks: {
        when: s => !!s.clientId,
        decl: {
            name: 'get_tasks',
            description: 'The client\'s task board: how many tasks are in each column, the open ones (title, status, due date, who it is for, overdue or not; overdue first, at most 10) and what was finished this month. Use for "what is overdue", "what is waiting on the client", "what did we do this month", or to prepare a call.',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            if (!s.clientId) return { error: 'no client chosen' };
            let q = supabase.from('client_tasks').select('title, status, due_date, assignee_user_id, assigned_to_client, visible_to_client, completed_at')
                .eq('client_id', s.clientId);
            // The owner reads only what is shown to them, exactly as on their portal.
            if (s.audience !== 'operator') q = q.eq('visible_to_client', true);
            const { data, error } = await q.limit(500);
            if (error) return missingTable(error) ? { available: false, note: 'The task board is not switched on yet.' } : { error: 'could not read tasks' };
            const rows = data || [];
            const today = new Date().toISOString().slice(0, 10);
            const monthStart = today.slice(0, 7) + '-01';
            const people = s.audience === 'operator' ? await peopleById(rows.map(t => t.assignee_user_id)) : {};
            const who = t => t.assigned_to_client ? 'the client'
                : (t.assignee_user_id ? ((people[t.assignee_user_id] || {}).name || String((people[t.assignee_user_id] || {}).email || 'a team member').split('@')[0]) : 'unassigned');
            const open = rows.filter(t => t.status !== 'done')
                .map(t => ({ title: t.title, status: t.status, due: t.due_date || null, for: who(t), overdue: !!(t.due_date && t.due_date < today) }))
                .sort((a, b) => (b.overdue - a.overdue) || String(a.due || '9999').localeCompare(String(b.due || '9999')));
            const counts = {};
            for (const t of rows) counts[t.status] = (counts[t.status] || 0) + 1;
            return {
                counts, overdue: open.filter(t => t.overdue).length, openShown: open.slice(0, 10), openTotal: open.length,
                doneThisMonth: rows.filter(t => t.status === 'done' && t.completed_at && t.completed_at.slice(0, 10) >= monthStart).map(t => t.title).slice(0, 10),
                statuses: 'todo = to do, doing = in progress, waiting = waiting on the client, done'
            };
        }
    },

    get_leads_summary: {
        when: s => !!s.clientId,
        decl: {
            name: 'get_leads_summary',
            description: 'The leads found for this client, as totals: how many, how many have an email or a phone, how many were found this month, by platform and by how they were found, and the five newest names. No contact details. Use for "how many leads do we have", "how many can we reach", "what did the last search find".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            if (!s.clientId) return { error: 'no client chosen' };
            const { data: links } = await supabase.from('client_leads').select('lead_id, source, created_at')
                .eq('client_id', s.clientId).order('created_at', { ascending: false }).limit(1000);
            const L = links || [];
            if (!L.length) return { total: 0, note: 'No leads have been found for this client yet.' };
            const ids = [...new Set(L.map(l => l.lead_id))];
            const leads = [];
            for (let i = 0; i < ids.length; i += 200) {
                const { data } = await supabase.from('leads').select('id, username, full_name, platform, email, phone, whatsapp').in('id', ids.slice(i, i + 200));
                leads.push(...(data || []));
            }
            const monthStart = new Date().toISOString().slice(0, 7) + '-01';
            const tally = f => L.reduce((o, l) => { const k = f(l) || 'other'; o[k] = (o[k] || 0) + 1; return o; }, {});
            const byId = Object.fromEntries(leads.map(l => [l.id, l]));
            return {
                total: ids.length, capped: L.length >= 1000,
                withEmail: leads.filter(l => l.email).length,
                withPhone: leads.filter(l => l.phone || l.whatsapp).length,
                foundThisMonth: new Set(L.filter(l => String(l.created_at) >= monthStart).map(l => l.lead_id)).size,
                byPlatform: leads.reduce((o, l) => { const k = l.platform || 'instagram'; o[k] = (o[k] || 0) + 1; return o; }, {}),
                bySource: tally(l => l.source),
                newest: L.slice(0, 5).map(l => byId[l.lead_id]).filter(Boolean).map(l => ({ name: l.full_name || l.username, platform: l.platform || 'instagram' })),
                note: 'Contact details are on the Leads page, not here.'
            };
        }
    },

    get_work_log: {
        // What the agency ran and has scheduled is the team's view, not the owner's.
        when: s => !!s.clientId && s.audience === 'operator',
        decl: {
            name: 'get_work_log',
            description: 'What the team has done and has lined up for this client: reports delivered in the last 30 days, work running now, runs that failed or paused in the last 30 days, and the next scheduled runs. Use for "what did we do this month", "is anything running", "what is scheduled next".',
            parameters: { type: 'OBJECT', properties: {} }
        },
        run: async (s) => {
            if (!s.clientId || s.audience !== 'operator') return { error: 'not available' };
            const since = new Date(Date.now() - 30 * 86400000).toISOString();
            const [{ data: reps }, { data: jobs }, { data: scheds }] = await Promise.all([
                supabase.from('reports').select('report_type, target_handle, created_at').eq('client_id', s.clientId)
                    .gte('created_at', since).order('created_at', { ascending: false }).limit(10),
                supabase.from('jobs').select('type, status, progress, created_at').eq('client_id', s.clientId)
                    .gte('created_at', since).order('created_at', { ascending: false }).limit(40),
                supabase.from('schedules').select('label, job_type, cadence, next_run_at, paused').eq('client_id', s.clientId)
                    .order('next_run_at', { ascending: true }).limit(10)
            ]);
            const J = jobs || [];
            return {
                delivered: (reps || []).map(r => ({ report: CLIENT_REPORT_TITLES[r.report_type] || r.report_type, about: r.target_handle || null, date: String(r.created_at).slice(0, 10) })),
                runningNow: J.filter(j => ['queued', 'running'].includes(j.status)).map(j => ({ work: j.type, status: j.status, progress: j.progress || 0 })),
                stuck: J.filter(j => ['failed', 'paused_no_credit', 'interrupted'].includes(j.status)).map(j => ({ work: j.type, status: j.status, date: String(j.created_at).slice(0, 10) })).slice(0, 5),
                finishedRuns: J.filter(j => j.status === 'done').length,
                scheduled: (scheds || []).filter(x => !x.paused).slice(0, 3).map(x => ({ what: x.label || x.job_type, cadence: x.cadence, next: String(x.next_run_at).slice(0, 10) })),
                pausedSchedules: (scheds || []).filter(x => x.paused).length
            };
        }
    }
};
S.ASSISTANT_TOOLS = ASSISTANT_TOOLS;

/** The tools this conversation may use. With no scope, every declaration (for the contract tests). */
function assistantDeclarations(scope = null) {
    return Object.values(ASSISTANT_TOOLS).filter(t => !scope || !t.when || t.when(scope)).map(t => t.decl);
}

/**
 * The voice. Most of this is about what NOT to do: a business owner asking
 * how their Instagram is doing will believe a confident number, so the cost
 * of inventing one is higher than the cost of saying there is no data.
 */
function assistantSystemPrompt(scope) {
    // Two readers, one set of numbers. An owner wants to know what to do on
    // Monday; an operator is building a deliverable and needs the mechanics,
    // the caveats and the wording they can hand on. Writing one prompt for
    // both produces an answer that patronises the operator and overwhelms the
    // owner, so the register splits here and the access rules do not.
    const operator = scope.audience === 'operator';
    const who = scope.client?.name ? `the account "${scope.client.name}"` : 'this business';

    const common = [
        '- Lead with the answer. Put the reasoning after it, only if it helps.',
        '- Numbers are for support, not decoration. One or two that matter beat ten that do not.',
        '- Never invent a figure. If a tool did not return it, say you do not have it and say what would get it.',
        '- Scraped numbers and owner-only Meta numbers are different things and are never averaged, added or compared as if they were the same measurement. If you use both, say which is which.'
    ];

    return [
        operator
            ? `You are EdgeLead's analyst. You work alongside an agency operator who is managing ${who} on behalf of a client. They are a professional: they know the platforms, they are building something they will put their name on.`
            : 'You are EdgeLead\'s assistant. You help the owner of a small business understand their own social media.',
        '',
        'How to answer:',
        operator
            ? '- Talk like a sharp colleague. Be direct, skip the encouragement, do not explain what engagement rate is.'
            : '- Talk like a knowledgeable friend, not a dashboard. Short paragraphs, no bullet-point dumps unless asked for a list.',
        ...common,
        operator
            ? '- When something in the data is weak, ambiguous or too small a sample to act on, say so plainly. They would rather hear it from you than from their client.'
            : '- Never mention tools, reports ids, databases, scraping, Apify, or how any of this is built.',
        operator
            ? '- If they ask for something they can send to a client, write it in the client\'s language: no internal metric names, no tool names, no hedging they would have to strip out.'
            : '',
        '',
        'What you can see:',
        scope.metaConnected
            ? `- ${operator ? 'This account has' : 'This business has'} connected Meta, so you can also see owner-only numbers: reach, saves, profile visits and demographics.`
            : (operator
                ? '- Meta is NOT connected for this account, so there are no owner-only numbers: no reach, saves, impressions, profile visits or demographics. Everything you have is observable from outside. Say which is missing when it matters; do not pitch connecting, they already know.'
                : '- This business has NOT connected Meta. You can only see what is visible from outside the account. If they ask about reach, saves, impressions, profile visits or who their audience is, say plainly that those are owner-only numbers and connecting Meta would let you answer properly. Say it once, naturally, not as a sales pitch every time.'),
        scope.metaConnected
            ? '- Their numbers are synced from Meta every day. For "am I growing", "followers this week" or "this week against last", use get_daily_growth and say which days it covers.'
            : '',
        scope.handle ? `- ${operator ? 'The' : 'Their'} Instagram is @${scope.handle}.` : '',
        operator && scope.client?.niche ? `- Niche: ${scope.client.niche}${scope.client.location ? `, in ${scope.client.location}` : ''}.` : '',
        operator && scope.clientId
            ? '- You are scoped to this one client. You cannot see the operator\'s other clients from here, so do not compare against them or refer to them.'
            : '',
        operator && scope.clientId
            ? '- Your job here is the account at a glance, for someone about to talk to the client: what we did for them (get_work_log, finished tasks), what is planned (open tasks, scheduled runs, the latest content plan or monthly recommendations), and their numbers in a sentence. Keep answers short enough to read out on a call.'
            : '',
        operator && scope.clientId
            ? '- Fetch only what the question needs: the client card below already has the headline numbers and counts, and one or two lookups is usually enough. Tasks: get_tasks. Leads: get_leads_summary. Work done and scheduled: get_work_log.'
            : '',
        scope.card ? `- Client card: ${scope.card}` : '',
        `- Today is ${new Date().toISOString().slice(0, 10)}.`,
        '',
        'If you have no data at all for what they asked, say so in one sentence and suggest the one thing that would fix it.'
    ].filter(Boolean).join('\n');
}

/** Everything a tool needs to stay inside one account, resolved once. */
/**
 * What one assistant conversation is allowed to see.
 *
 * `clientId` narrows the whole thing to a single client. An employee running
 * eight accounts asking "how did last month go" must not get an answer blended
 * across all eight — and the model cannot be trusted to keep them apart on its
 * own, so the narrowing happens here and the tools never receive an account
 * argument at all (tested in phase15).
 *
 * `audience` is who is reading, not what they may read: an owner and an
 * operator get the same numbers and a different register. Access is still
 * decided by scope; this only changes how the answer is written.
 */
async function assistantScope(userId, clientId = null, role = null) {
    const wanted = clientId && UUID_RE.test(String(clientId)) ? String(clientId) : null;

    const [{ data: memberships }, { data: owned }, { data: prof }] = await Promise.all([
        supabase.from('client_members').select('client_id').eq('user_id', userId),
        supabase.from('clients').select('id, name, ig_handle, fb_page, niche, location, competitors').eq('owner_user_id', userId),
        supabase.from('reports').select('target_handle').eq('user_id', userId)
            .order('created_at', { ascending: false }).limit(1)
    ]);

    const clientIds = [...new Set([
        ...(memberships || []).map(m => m.client_id),
        ...(owned || []).map(c => c.id)
    ])].filter(Boolean);

    // A client id the caller has no access to is dropped rather than refused:
    // the request still answers, just over their own data. Refusing would let
    // a stale picker selection break an otherwise valid question.
    // Access is clientAccess's, admins included (phase 33): an admin asking
    // about a client they neither own nor were added to used to get their own
    // data back under that client's name.
    const scoped = wanted && (clientIds.includes(wanted) || await clientAccess(userId, wanted, 'viewer')) ? wanted : null;
    let client = (owned || []).find(c => c.id === scoped) || null;
    if (scoped && !client) {
        const { data } = await supabase.from('clients')
            .select('id, name, ig_handle, fb_page, niche, location, competitors').eq('id', scoped).maybeSingle();
        client = data || null;
    }

    // Meta is checked against the same narrowing. A connection filed under a
    // different client must not make THIS client look connected, or the
    // assistant will confidently offer owner numbers it cannot read.
    let cq = supabase.from('meta_connections').select('id, status');
    cq = scoped ? cq.eq('client_id', scoped) : cq.eq('user_id', userId);
    const { data: conns } = await cq.limit(10);
    const connectionIds = (conns || []).filter(c => c.status === 'active').map(c => c.id);

    const ors = scoped
        ? [`client_id.eq.${scoped}`]
        : [`user_id.eq.${userId}`, ...(clientIds.length ? [`client_id.in.(${clientIds.join(',')})`] : [])];

    // One line that answers the simple questions without a lookup (phase 35):
    // counts only, read in parallel, and a missing table is just left out.
    let card = null;
    if (scoped && client) {
        const head = q => q.then(r => (r.error ? null : r.count), () => null);
        let tq = supabase.from('client_tasks').select('id', { count: 'exact', head: true }).eq('client_id', scoped).neq('status', 'done');
        if (role === 'client') tq = tq.eq('visible_to_client', true);
        const quiet = p => p.then(r => r, () => null);
        const [reps, openTasks, leadsN, audit, grow] = await Promise.all([
            head(supabase.from('reports').select('id', { count: 'exact', head: true }).eq('client_id', scoped)),
            head(tq),
            head(supabase.from('client_leads').select('lead_id', { count: 'exact', head: true }).eq('client_id', scoped)),
            quiet(supabase.from('reports').select('grade, engagement_rate, created_at').eq('client_id', scoped)
                .eq('report_type', 'ig_report').order('created_at', { ascending: false }).limit(1)),
            connectionIds.length ? quiet(growthForConnections(connectionIds)) : Promise.resolve(null)
        ]);
        // The numbers a client asks about on the phone, so the answer needs no
        // lookup: their followers and last week from Meta, the last audit's
        // grade and engagement from public data, each labelled with its source.
        const nums = [];
        const g = grow && grow.growth && !grow.growth.empty ? grow.growth : null;
        const sg = v => (v > 0 ? '+' : '') + Number(v).toLocaleString('en-US');
        if (g && g.followers && g.followers.now != null) nums.push(`${Number(g.followers.now).toLocaleString('en-US')} followers${g.followers.week != null ? ` (${sg(g.followers.week)} this week)` : ''}`);
        if (g && g.reach && g.reach.now != null) nums.push(`reach ${Number(g.reach.now).toLocaleString('en-US')} last 7 days${g.reach.pct != null ? ` (${sg(g.reach.pct)}% on the week before)` : ''}`);
        if (nums.length) nums[nums.length - 1] += ' [owner Meta numbers]';
        const a = audit && audit.data && audit.data[0];
        if (a && (a.grade || a.engagement_rate != null)) {
            const er = a.engagement_rate == null ? null : Number(a.engagement_rate) * (Number(a.engagement_rate) < 1 ? 100 : 1);
            nums.push(`last Instagram audit ${String(a.created_at).slice(0, 10)}: ${[a.grade ? 'grade ' + a.grade : null, er != null ? er.toFixed(1) + '% engagement' : null].filter(Boolean).join(', ')} [public data]`);
        }
        card = [
            client.name,
            [client.niche, client.location].filter(Boolean).join(', ') || null,
            connectionIds.length ? 'Meta connected' : 'Meta not connected',
            reps === null ? null : `${reps} report${reps === 1 ? '' : 's'}`,
            openTasks === null ? null : `${openTasks} open task${openTasks === 1 ? '' : 's'}`,
            leadsN === null ? null : `${leadsN} lead${leadsN === 1 ? '' : 's'} found`,
            nums.length ? 'numbers: ' + nums.join('; ') : null
        ].filter(Boolean).join(' · ');
    }

    return {
        userId,
        role,
        card,
        audience: role === 'client' ? 'owner' : 'operator',
        clientIds,
        clientId: scoped,
        client,
        reportScope: ors.join(','),
        metaConnected: connectionIds.length > 0,
        connectionIds,
        handle: client?.ig_handle
            || (scoped ? null : (owned || []).find(c => c.ig_handle)?.ig_handle || prof?.[0]?.target_handle)
            || null
    };
}

/**
 * Run one question to an answer.
 *
 * onEvent receives status updates as tools run. Token-level streaming is
 * deliberately not done: it would mean streaming every model turn including
 * the ones that turn out to be tool calls, and the win over "I'm reading your
 * September report" is small.
 */
async function assistantAnswer({ userId, message, conversationId, clientId = null, role = null, onEvent }) {
    const emit = ev => { try { if (onEvent) onEvent(ev); } catch (e) { logger.warn('assistant_emit', { message: e.message }); } };

    const scope = await assistantScope(userId, clientId, role);

    // Thread: reuse if it belongs to this user, otherwise start one.
    let conv = null;
    if (conversationId && UUID_RE.test(String(conversationId))) {
        const { data } = await supabase.from('ai_conversations')
            .select('*').eq('id', conversationId).eq('user_id', userId).maybeSingle();
        conv = data || null;
        // A thread belongs to the client it was started under. Carrying it to
        // a different client would silently re-answer eight turns of history
        // about account A as if they had been about account B.
        if (conv && (conv.client_id || null) !== (scope.clientId || null)) conv = null;
    }
    if (!conv) {
        const { data } = await supabase.from('ai_conversations').insert([{
            user_id: userId,
            client_id: scope.clientId,
            title: String(message || '').slice(0, 80) || 'New conversation'
        }]).select().single();
        conv = data;
    }

    const staff = scope.audience === 'operator';
    // The most recent turns, oldest first. .limit() on an ascending read kept
    // the OLDEST ones, so a long thread lost its latest context first.
    const { data: recent } = await supabase.from('ai_messages')
        .select('role, content, created_at').eq('conversation_id', conv.id)
        .order('created_at', { ascending: false }).limit(staff ? ASSISTANT_STAFF_HISTORY : ASSISTANT_HISTORY);
    const history = (recent || []).slice().reverse();

    await supabase.from('ai_messages').insert([{ conversation_id: conv.id, role: 'user', content: message }]);

    const contents = [
        ...(history || []).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
        { role: 'user', parts: [{ text: message }] }
    ];

    const STATUS = {
        get_monthly_report:    'Pulling the monthly numbers',
        get_my_reports:        'Looking at your reports',
        get_report_detail:     'Reading your report',
        get_progress_over_time:'Checking how things have moved',
        get_best_posts:        'Going through your posts',
        get_best_times:        'Working out your best times',
        get_community_demand:  'Checking what people are asking for',
        get_owner_insights:    'Reading your Meta numbers',
        get_daily_growth:      'Checking your growth day by day',
        get_tasks:             'Checking the task board',
        get_leads_summary:     'Counting the leads',
        get_work_log:          'Looking at the work done'
    };
    const declarations = assistantDeclarations(scope);
    const maxRounds = staff ? ASSISTANT_STAFF_ROUNDS : ASSISTANT_MAX_ROUNDS;

    const used = [];
    let answer = '';

    for (let round = 0; round < maxRounds; round++) {
        // The last round offers no tools, so it answers from what it has read
        // instead of spending the turn on one more lookup it cannot use.
        const last = round === maxRounds - 1 && round > 0;
        const turn = await geminiToolTurn(contents, declarations, {
            systemInstruction: assistantSystemPrompt(scope), userId, tag: 'assistant', noCalls: last
        });

        if (!turn.ok) {
            answer = turn.reason === 'no_key'
                ? 'The assistant is not switched on for this account yet.'
                : 'I could not get an answer together just then. Try asking again in a moment.';
            break;
        }

        if (!turn.calls.length) {
            answer = turn.text || 'I could not put an answer together for that one. Try asking it a different way.';
            break;
        }

        contents.push({ role: 'model', parts: turn.parts });
        emit({ type: 'status', label: [...new Set(turn.calls.map(c => STATUS[c.name] || 'Reading your data'))].join(' · ') });

        // Independent reads, so they go together rather than one after another.
        const settled = await Promise.all(turn.calls.map(async fc => {
            const tool = ASSISTANT_TOOLS[fc.name];
            if (tool && tool.when && !tool.when(scope)) return { fc, result: { error: 'not available here' } };
            let result;
            try { result = tool ? await tool.run(scope, fc.args || {}) : { error: 'unknown tool' }; }
            catch (e) { logger.warn('assistant_tool_failed', { tool: fc.name, message: e.message }); result = { error: e.message }; }
            return { fc, result };
        }));

        contents.push({
            role: 'user',
            parts: settled.map(({ fc, result }) => {
                used.push(fc.name);
                return { functionResponse: { name: fc.name, response: { result } } };
            })
        });
    }

    if (!answer) answer = 'That turned into more digging than I could finish. Try narrowing the question.';

    await supabase.from('ai_messages').insert([{
        conversation_id: conv.id, role: 'assistant', content: answer,
        tools: used.length ? used : null
    }]);
    await supabase.from('ai_conversations')
        .update({ updated_at: new Date().toISOString() }).eq('id', conv.id);

    return {
        answer, conversationId: conv.id, used: [...new Set(used)],
        metaConnected: scope.metaConnected,
        clientId: scope.clientId, clientName: scope.client?.name || null
    };
}

/**
 * The client's own reports.
 *
 * Deliberately a separate endpoint rather than a flag on the employee vault.
 * That one selects credits_estimate, set_id, source_report_ids and competitor
 * handles, and the reliable way to keep those off the client surface is for
 * the client surface to have an endpoint that never selects them in the first
 * place — rather than a filter somebody has to remember to apply.
 */
// Keyed by reports.report_type — the value the row actually carries. Two of
// these were job-type names (fb_page_report, fb_community_audit) that no row
// has ever carried, so a client's Facebook report showed as "Report". The
// wiring audit checks this map against every report_type the server writes.
// Module level since phase 34: the monthly report names the work it lists.
const CLIENT_REPORT_TITLES = {
    ig_report:    'Instagram check-up',
    deep_audit:   'Instagram deep dive',
    fb_page:      'Facebook page check-up',
    fb_community: 'Community report',
    fb_group:     'Community report',
    content_plan: 'Content plan',
    meta_owned:   'Owner report',
    meta_monthly: 'Monthly report',
    public_monthly: 'Monthly report',
    review_scan: 'Who is reviewing local businesses'
};
S.CLIENT_REPORT_TITLES = CLIENT_REPORT_TITLES;

app.get('/api/client/reports', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const [{ data: memberships }, { data: owned }] = await Promise.all([
            supabase.from('client_members').select('client_id').eq('user_id', ctx.user.id),
            supabase.from('clients').select('id').eq('owner_user_id', ctx.user.id)
        ]);
        const clientIds = [...new Set([
            ...(memberships || []).map(m => m.client_id),
            ...(owned || []).map(c => c.id)
        ])].filter(Boolean);

        // Phase 51: their own check-ups, and what the agency shared with them — nothing else.
        const cols = 'id, report_type, platform, target_handle, snapshot_date, created_at, grade, score';
        const [mine, shared] = await Promise.all([
            supabase.from('reports').select(cols).eq('user_id', ctx.user.id).order('created_at', { ascending: false }).limit(60),
            clientIds.length
                ? supabase.from('reports').select(cols).in('client_id', clientIds).eq('visible_to_client', true).order('created_at', { ascending: false }).limit(60)
                : Promise.resolve({ data: [] })
        ]);
        if (mine.error) throw mine.error;
        const seen = new Set();
        const data = [...(mine.data || []), ...(shared.data || [])]
            .filter(r => !seen.has(r.id) && seen.add(r.id))
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
            .slice(0, 60);

        const TITLES = CLIENT_REPORT_TITLES;

        res.json({
            reports: (data || []).map(r => ({
                id: r.id,
                title: TITLES[r.report_type] || 'Report',
                handle: r.target_handle,
                platform: r.platform,
                date: r.snapshot_date || (r.created_at || '').slice(0, 10),
                grade: r.grade || null,
                // A band, never the raw score. A number out of 100 invites an
                // argument about the number instead of the finding.
                band: r.score === null || r.score === undefined ? null
                    : r.score >= 80 ? 'strong'
                    : r.score >= 65 ? 'healthy'
                    : r.score >= 50 ? 'mixed'
                    : r.score >= 35 ? 'weak' : 'poor'
            }))
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * Ask the assistant.
 *
 * Streams when asked to, because a tool round can take fifteen seconds and a
 * chat that sits silent that long reads as broken. The stream carries status,
 * not tokens — see assistantAnswer.
 *
 * Rate limited by address rather than metered like a job: this spends Gemini,
 * not Apify, and the key pool has its own cooldowns underneath.
 */
app.post('/api/assistant/ask', rateLimit({ windowMs: 60000, max: 12 }), async (req, res) => {
    const ctx = await auth(req, res); if (!ctx) return;

    const message = String(req.body?.message || '').trim().slice(0, 2000);
    if (!message) return res.status(400).json({ error: 'Ask a question first.' });
    const conversationId = req.body?.conversationId || null;
    // EL.api puts the selected client on every body automatically, so an
    // employee's question is scoped by the header picker without the page
    // having to think about it.
    // A client account is its own business: its questions are scoped to that
    // record, which is where a connection made FOR it by its agency lives.
    // Before phase 30 a client was scoped to its user id, so the Meta its
    // agency connected was invisible and the assistant kept asking for it.
    let clientId = req.body?.clientId || null;
    const role = ctx.profile?.role || null;
    if (role === 'client') clientId = (await ownClientFor(ctx).catch(() => null))?.id || null;

    if (String(req.query.stream || '') !== '1') {
        try {
            res.json(await assistantAnswer({ userId: ctx.user.id, message, conversationId, clientId, role }));
        } catch (err) { sendErr(res, err); }
        return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Render sits behind a proxy that will otherwise buffer the whole response
    // and deliver it at the end, which defeats the point entirely.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };
    const beat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { /* client gone */ } }, 15000);

    try {
        const out = await assistantAnswer({
            userId: ctx.user.id, message, conversationId, clientId, role,
            onEvent: ev => send('status', ev)
        });
        send('done', out);
    } catch (err) {
        logger.error('assistant_failed', { message: err.message, stack: (err.stack || '').slice(0, 400) });
        send('error', { error: 'Something went wrong answering that. Try again in a moment.' });
    } finally {
        clearInterval(beat);
        res.end();
    }
});

/** This account's threads, newest first. */
app.get('/api/assistant/conversations', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        // Threads follow the selected client. `.is('client_id', null)` rather
        // than leaving the filter off: with no client selected you want your
        // own threads, not a list mixing in every client you manage.
        const cid = String(req.query.client_id || '');
        let q = supabase.from('ai_conversations')
            .select('id, title, client_id, created_at, updated_at')
            .eq('user_id', ctx.user.id);
        q = UUID_RE.test(cid) ? q.eq('client_id', cid) : q.is('client_id', null);
        const { data, error } = await q.order('updated_at', { ascending: false }).limit(40);
        if (error) throw error;
        res.json({ conversations: data || [] });
    } catch (err) { sendErr(res, err); }
});

/** One thread's turns. Ownership is checked on the thread, not the messages. */
app.get('/api/assistant/conversation/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad conversation id.' });

        const { data: conv } = await supabase.from('ai_conversations')
            .select('id, title').eq('id', req.params.id).eq('user_id', ctx.user.id).maybeSingle();
        if (!conv) return res.status(404).json({ error: 'Conversation not found.' });

        const { data: messages } = await supabase.from('ai_messages')
            .select('role, content, created_at').eq('conversation_id', conv.id)
            .order('created_at', { ascending: true }).limit(200);

        res.json({ conversation: conv, messages: messages || [] });
    } catch (err) { sendErr(res, err); }
});

/**
 * The client's own leads. /api/search-leads needs a search term and returns
 * the full row including campaign bookkeeping; a client browsing what they
 * found wants neither.
 */
app.get('/api/client/leads', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        // Their own draws, plus everything an agency found FOR them under
        // their business record. Before phase 24 this was the first half
        // only, so a client whose agency had just found forty leads for them
        // saw none of them here.
        const own = ctx.profile?.role === 'client' ? await ownClientFor(ctx).catch(() => null) : null;
        const { data: links } = own
            ? await supabase.from('client_leads').select('lead_id').eq('client_id', own.id)
            : { data: [] };
        const linkedIds = (links || []).map(l => l.lead_id);

        const cols = 'id, owner_user_id, username, full_name, email, phone, whatsapp, website, category, city, followers_count, profile_url, is_enriched, platform, created_at';
        const [{ data: mine, error }, { data: forYou }] = await Promise.all([
            supabase.from('leads').select(cols).eq('owner_user_id', ctx.user.id).order('created_at', { ascending: false }).limit(200),
            linkedIds.length
                ? supabase.from('leads').select(cols).in('id', linkedIds).order('created_at', { ascending: false }).limit(400)
                : Promise.resolve({ data: [] })
        ]);
        if (error) throw error;

        const data = dedupeLeads([...(mine || []), ...(forYou || [])])
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        const foundForYou = data.filter(l => l.owner_user_id !== ctx.user.id).length;

        res.json({
            yours: data.length - foundForYou,
            foundForYou,
            leads: (data || []).map(l => ({
                foundForYou: l.owner_user_id !== ctx.user.id,
                username: l.username,
                platform: l.platform || 'instagram',
                name: l.full_name || null,
                category: l.category || null,
                city: l.city || null,
                followers: l.followers_count ?? null,
                email: l.email || null,
                phone: l.phone || null,
                whatsapp: l.whatsapp || null,
                website: l.website || null,
                url: l.profile_url || ('https://instagram.com/' + l.username),
                // An un-enriched row is a username and nothing else yet, which
                // is worth saying rather than rendering as a contact with every
                // field blank.
                enriched: !!l.is_enriched
            }))
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * A demand signal, said in owner language.
 *
 * The employee feed shows intent, urgency, lead_score and a matched phrase,
 * which is the right shape for someone deciding where to spend an afternoon.
 * An owner is asking one question — is this worth replying to, and how soon —
 * so the scores collapse into a stance and the jargon goes.
 *
 * The author is not here and cannot be: the group pipeline hashes identity on
 * the way in, one-way. That is deliberate, and the copy says so rather than
 * leaving a blank where a name should be.
 */
const DEMAND_INTENT = {
    recommendation_request: 'Asking for a recommendation',
    question:               'Asking a question',
    buy_sell:               'Looking to buy',
    hiring:                 'Looking to hire',
    event:                  'Planning something',
    offer:                  'Offering something',
    complaint:              'Unhappy with someone else',
    story:                  'Sharing an experience'
};
S.DEMAND_INTENT = DEMAND_INTENT;

function clientDemandView(row) {
    if (!row) return null;

    const urgency = String(row.urgency || 'low').toLowerCase();
    return {
        asking_for: String(row.snippet || '').slice(0, 320),
        kind: DEMAND_INTENT[row.intent] || 'Mentioned you might help',
        // Three bands become two words an owner can act on. "Medium" tells
        // nobody anything; "worth a reply today" does.
        stance: urgency === 'high' ? 'Reply today'
              : urgency === 'medium' ? 'Worth a reply'
              : 'Keep an eye on it',
        urgent: urgency === 'high',
        group: row.group_name || null,
        posted_at: row.posted_at || null,
        // Present so the page can say why no name is shown, rather than
        // rendering an empty author line.
        author_shown: false
    };
}

/** What people near this business are asking for. */
app.get('/api/client/demand', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;

        const { data, error } = await supabase.from('fb_demand_signals')
            .select('snippet, intent, urgency, group_name, posted_at, lead_score')
            .eq('user_id', ctx.user.id)
            .order('posted_at', { ascending: false })
            .limit(100);
        if (error) throw error;

        res.json({ demand: (data || []).map(clientDemandView) });
    } catch (err) { sendErr(res, err); }
});

/** One report, said in owner language. Same authorisation rule as the vault. */
/**
 * Phase 51: share a report with the business owner, or take it back. Reports start private to the
 * team — competitor research, prospect lists and drafts must not reach the owner just because they
 * are filed under the business. The owner's own check-ups are always theirs.
 */
/** Whether the owner sees this report — for the toggle beside Share link on every report page. */
app.get('/api/reports/:id/visibility', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad report id.' });
        const { data: row, error } = await supabase.from('reports').select('id, client_id, visible_to_client').eq('id', req.params.id).maybeSingle();
        if (error) return res.json({ id: req.params.id, clientId: null, visibleToClient: false, unavailable: true });
        if (!row) return res.status(404).json({ error: 'Report not found.' });
        const c = row.client_id ? await clientAccess(ctx.user.id, row.client_id, 'viewer') : null;
        if (row.client_id && !c) return res.status(404).json({ error: 'Report not found.' });
        res.json({ id: row.id, clientId: row.client_id || null, visibleToClient: row.visible_to_client === true, canEdit: !!(c && ['owner', 'admin', 'editor'].includes(c.access)) });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/reports/:id/visibility', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad report id.' });
        const { data: row } = await supabase.from('reports').select('id, client_id, user_id, report_type').eq('id', req.params.id).maybeSingle();
        if (!row) return res.status(404).json({ error: 'Report not found.' });
        if (!row.client_id) return res.status(400).json({ error: 'File this report under a client first; then it can be shared with the owner.' });
        const c = await clientAccess(ctx.user.id, row.client_id, 'editor');
        if (!c) return res.status(404).json({ error: 'Report not found, or you cannot edit its client.' });
        const visible = req.body?.visible === true;
        const { error } = await supabase.from('reports').update({ visible_to_client: visible }).eq('id', row.id);
        if (error) {
            if (/visible_to_client/.test(error.message || '')) return res.status(503).json({ error: 'Sharing reports needs the phase-51 database update. Run sql/schema-phase51.sql.', code: 'migration_required' });
            throw error;
        }
        logger.info('report_visibility', { reportId: row.id, clientId: row.client_id, by: ctx.user.id, visible });
        res.json({ id: row.id, visibleToClient: visible });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/client/report/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!UUID_RE.test(String(req.params.id))) return res.status(400).json({ error: 'Bad report id.' });

        const { data: row } = await supabase.from('reports')
            .select('*').eq('id', req.params.id).maybeSingle();
        if (!row || !(await canReadReport(ctx, row))) {
            return res.status(404).json({ error: 'Report not found.' });
        }
        const view = clientReportView(row);
        if (view.month) view.month.context = await monthlyContext(row);
        res.json({ report: view });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/share', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { reportId, expiresDays, label } = req.body || {};
        if (!reportId || !UUID_RE.test(String(reportId))) return res.status(400).json({ error: 'reportId required.' });
        const { data: rep } = await supabase.from('reports').select('id, user_id, client_id, report_type, target_handle').eq('id', reportId).maybeSingle();
        if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Report not found.' });

        const days = Math.min(SHARE_MAX_DAYS, Math.max(1, parseInt(expiresDays || SHARE_DEFAULT_DAYS, 10) || SHARE_DEFAULT_DAYS));
        const token = shareToken();
        const { data, error } = await supabase.from('report_shares').insert([{
            token, report_id: rep.id, user_id: ctx.user.id, client_id: rep.client_id || null,
            label: String(label || '').trim().slice(0, 120) || null,
            expires_at: new Date(Date.now() + days * 86400000).toISOString()
        }]).select().single();
        if (error) throw error;
        res.status(201).json({ success: true, share: data, url: shareUrlFor(rep, token) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/shares', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        let q = supabase.from('report_shares').select('*, reports!inner(id, report_type, target_handle, created_at, client_id)');
        const cid = req.query?.client_id;
        const rid = req.query?.report_id;
        if (rid && UUID_RE.test(String(rid))) {
            const { data: rep } = await supabase.from('reports').select('id, user_id, client_id').eq('id', rid).maybeSingle();
            if (!rep || !(await canReadReport(ctx, rep))) return res.status(404).json({ error: 'Report not found.' });
            q = q.eq('report_id', rep.id);
        } else if (cid) {
            const c = await clientAccess(ctx.user.id, cid, 'viewer');
            if (!c) return res.status(403).json({ error: 'No access to that client.' });
            q = q.eq('client_id', c.id);
        } else {
            q = q.eq('user_id', ctx.user.id);
        }
        const { data, error } = await q.order('created_at', { ascending: false }).limit(200);
        if (error) throw error;
        const now = Date.now();
        res.json({ shares: (data || []).map(s => ({
            ...s, mine: s.user_id === ctx.user.id,
            active: !s.revoked_at && new Date(s.expires_at).getTime() > now,
            url: shareUrlFor(s.reports || {}, s.token)
        })) });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/share/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const { data: s } = await supabase.from('report_shares').select('id, user_id, client_id').eq('id', req.params.id).maybeSingle();
        const may = s && (s.user_id === ctx.user.id || (s.client_id && await clientAccess(ctx.user.id, s.client_id, 'editor')));
        if (!may) return res.status(404).json({ error: 'Share not found.' });
        await supabase.from('report_shares').update({ revoked_at: new Date().toISOString() }).eq('id', s.id);
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/** PUBLIC. No auth. The token is the credential. */
app.get('/api/public/share/:token', publicLimit, async (req, res) => {
    try {
        const token = String(req.params.token || '');
        if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return res.status(404).json({ error: 'Link not found.' });
        const { data: s } = await supabase.from('report_shares').select('*').eq('token', token).maybeSingle();
        if (!s || s.revoked_at) return res.status(404).json({ error: 'This link has been turned off.' });
        if (new Date(s.expires_at).getTime() < Date.now()) return res.status(410).json({ error: 'This link has expired. Ask for a new one.' });
        const { data: rep } = await supabase.from('reports').select('*').eq('id', s.report_id).maybeSingle();
        if (!rep) return res.status(404).json({ error: 'The report behind this link was deleted.' });
        let client = null;
        if (rep.client_id) {
            const { data: c } = await supabase.from('clients').select('name, brand').eq('id', rep.client_id).maybeSingle();
            client = c || null;
        }
        supabase.from('report_shares').update({ views: (s.views || 0) + 1, last_viewed_at: new Date().toISOString() })
            .eq('id', s.id).then(() => {}, () => {});
        res.set('Cache-Control', 'no-store');
        // The client view, not the employee one.
        //
        // publicReportView only stripped ownership columns — everything else
        // went out: every pillar score, every competitor handle, the whole
        // agency-language report. A share link is the thing an employee hands
        // a client, so it now carries what a client should read, and the
        // internals simply are not in the payload to leak.
        //
        // Types clientReportView cannot translate yet (content plans, community
        // audits) degrade to headline, date and summary rather than falling
        // back to the raw report.
        const view = clientReportView(rep);
        if (view.month) view.month.context = await monthlyContext(rep);
        res.json({
            report: view,
            client,
            shared: { expiresAt: s.expires_at, label: s.label, page: 'share.html' }
        });
    } catch (err) { sendErr(res, err); }
});
