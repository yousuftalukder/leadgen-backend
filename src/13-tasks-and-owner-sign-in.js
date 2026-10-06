/**
 * The client's task board, and owners signing in to Edge Meta AI.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    EMAIL_RE, ENC_KEY, TRIAL_ENGINES, UUID_RE, _roleCache, absorbEmptyOwnRecord, app, appUrl, auth,
    clientAccess, clientsAccessible, crypto, express, findOwnClient, invalidateEngineAccess, logger,
    mailSettings, markAgencyOwner, ownClientFor, rateLimit, sendErr, sendMail, supabase, trialDaysSetting,
    userRole
} = S;
Object.assign(S, { missingTable, oneLine, peopleById, staffOnly, endOfColumn });

// ===========================================================================
// PHASE 32 :: THE CLIENT'S TASK BOARD
//
// Reports said what to do; nothing said who was doing it, so the work that is
// not a report (film the Reels, fix the link in bio, answer the birthday
// requests) lived in people's heads. Every client now has a board: To do,
// In progress, Waiting on the client, Done. The rules are the client's rules:
// anyone who can open the client can read its board, editors change it.
//
// A task can be the client's own (assigned_to_client) and any task can be
// shown to the client (visible_to_client). Those are the only rows the owner's
// portal selects, through its own endpoints under /api/client (rule 11); the
// staff routes refuse client accounts rather than filter for them.
// ===========================================================================
const TASK_STATUSES = ['todo', 'doing', 'waiting', 'done'];
const TASK_PRIORITIES = ['lowest', 'low', 'medium', 'high', 'highest'];   // phase 48
const TASK_TITLE_MAX = 300;
const TASK_NOTES_MAX = 20000;           // phase 48: a description, pictures referenced in it
const TASK_LABELS_MAX = 8;
const TASK_CHECKLIST_MAX = 30;
const TASK_COMMENT_MAX = 4000;
const TASK_DONE_SHOWN_DAYS = 14;          // "My tasks" keeps a fortnight of finished work in view
const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The phase-32 tables are missing: the server was deployed before the SQL.
 * Deploy order is SQL → server → pages; when that slips, the board says what
 * to run instead of failing as a 500 nobody can act on.
 */
function missingTable(err) {
    return !!err && (err.code === '42P01' || err.code === 'PGRST205'
        || /does not exist|could not find the table/i.test(String(err.message || '')));
}
/** Phase 48's columns (priority, task_number) or its media table are missing: the server is ahead of the SQL. */
function missing48(err) {
    return !!err && (err.code === 'PGRST204' || err.code === '42703' || err.code === 'PGRST205' || err.code === '42P01')
        && /priority|task_number|client_task_media/i.test(String(err.message || ''));
}
function migration48(res) {
    return res.status(503).json({
        error: 'Task priority, keys and pictures need the phase-48 database update. Run sql/schema-phase48.sql in the Supabase SQL editor.',
        code: 'migration_required'
    });
}
function migrationNeeded(res) {
    return res.status(503).json({
        error: 'The task board needs the phase-32 database update. Run sql/schema-phase32.sql in the Supabase SQL editor.',
        code: 'migration_required'
    });
}
function taskFail(message, statusCode = 400) {
    const e = new Error(message); e.statusCode = statusCode; return e;
}

/** One line of plain text: control characters out, runs of space collapsed. */
function oneLine(v, max) {
    return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Validate a task body from the page. Only the fields present come back, so
 * create (everything) and patch (some things) share one set of rules.
 */
function cleanTaskBody(b = {}, { create = false } = {}) {
    const out = {};
    if (create || b.title !== undefined) {
        const t = oneLine(b.title, TASK_TITLE_MAX);
        if (!t) throw taskFail('Give the task a name.');
        out.title = t;
    }
    if (b.notes !== undefined) {
        const n = String(b.notes ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, TASK_NOTES_MAX);
        out.notes = n || null;
    }
    if (b.status !== undefined) {
        if (!TASK_STATUSES.includes(b.status)) throw taskFail(`Status must be one of: ${TASK_STATUSES.join(', ')}.`);
        out.status = b.status;
    }
    if (b.priority !== undefined) {
        if (!TASK_PRIORITIES.includes(b.priority)) throw taskFail(`Priority must be one of: ${TASK_PRIORITIES.join(', ')}.`);
        out.priority = b.priority;
    }
    if (b.dueDate !== undefined) {
        if (b.dueDate === null || b.dueDate === '') out.due_date = null;
        else {
            const d = String(b.dueDate);
            if (!ISO_DAY_RE.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw taskFail('A due date looks like 2026-10-01.');
            out.due_date = d;
        }
    }
    if (b.labels !== undefined) {
        if (!Array.isArray(b.labels)) throw taskFail('Labels must be a list.');
        const seen = new Set(); const labels = [];
        for (const raw of b.labels) {
            const l = oneLine(raw, 24);
            if (!l || seen.has(l.toLowerCase())) continue;
            seen.add(l.toLowerCase()); labels.push(l);
        }
        out.labels = labels.slice(0, TASK_LABELS_MAX);
    }
    if (b.checklist !== undefined) {
        if (!Array.isArray(b.checklist)) throw taskFail('The checklist must be a list.');
        out.checklist = b.checklist.slice(0, TASK_CHECKLIST_MAX)
            .map(i => ({ text: oneLine(i && i.text, 200), done: !!(i && i.done) }))
            .filter(i => i.text);
    }
    if (b.visibleToClient !== undefined) out.visible_to_client = b.visibleToClient === true;
    if (b.position !== undefined) {
        const p = Number(b.position);
        if (!Number.isFinite(p)) throw taskFail('Position must be a number.');
        out.position = p;
    }
    return out;
}

/**
 * Who a task may belong to: nobody, the client, or a person who can open this
 * client. A client-role login is never a team assignee — "the client" is.
 */
async function resolveAssignee(raw, client) {
    if (raw === undefined) return {};
    if (raw === null || raw === '') return { assignee_user_id: null, assigned_to_client: false };
    if (raw === 'client') return { assignee_user_id: null, assigned_to_client: true, visible_to_client: true };
    if (!UUID_RE.test(String(raw)) || await userRole(raw) === 'client' || !(await clientAccess(raw, client.id, 'viewer'))) {
        throw taskFail('That person cannot open this client. Add them to the client first.');
    }
    return { assignee_user_id: raw, assigned_to_client: false };
}

/**
 * Where a task came from. A report or job it points at must be filed under
 * the same client, or a board could link to another client's work.
 */
async function cleanTaskSource(s, client) {
    if (!s || typeof s !== 'object') return {};
    const type = ['report', 'recommendation', 'job', 'schedule'].includes(s.type) ? s.type : null;
    if (!type) return {};
    const out = { source_type: type, source_id: null, source_label: oneLine(s.label, 120) || null, source_key: oneLine(s.key, 80) || null };
    if (s.id && type !== 'schedule') {
        if (!UUID_RE.test(String(s.id))) throw taskFail('That source is not a report or job id.');
        const { data } = await supabase.from(type === 'job' ? 'jobs' : 'reports').select('id, client_id').eq('id', s.id).maybeSingle();
        if (!data || data.client_id !== client.id) throw taskFail('That work is not filed under this client.');
        out.source_id = data.id;
    }
    return out;
}

/** Everyone who can be given a task on this client: owner, members, admins. Never a client login. */
async function clientPeople(client) {
    const { data: members } = await supabase.from('client_members').select('user_id, role').eq('client_id', client.id);
    const { data: admins } = await supabase.from('app_users').select('id').eq('role', 'admin');
    const ids = [...new Set([client.owner_user_id, ...(members || []).map(m => m.user_id), ...(admins || []).map(a => a.id)].filter(Boolean))];
    if (!ids.length) return [];
    const { data: users } = await supabase.from('app_users').select('id, email, full_name, role, is_active').in('id', ids);
    const memberRole = Object.fromEntries((members || []).map(m => [m.user_id, m.role]));
    return (users || [])
        .filter(u => u.role !== 'client' && u.is_active !== false)
        .map(u => ({
            id: u.id, email: u.email, name: u.full_name || null, role: u.role,
            access: u.id === client.owner_user_id ? 'owner' : (memberRole[u.id] || (u.role === 'admin' ? 'admin' : 'viewer'))
        }))
        .sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email)));
}

async function peopleById(ids) {
    const want = [...new Set(ids.filter(Boolean))];
    if (!want.length) return {};
    const { data } = await supabase.from('app_users').select('id, email, full_name').in('id', want);
    return Object.fromEntries((data || []).map(u => [u.id, { id: u.id, email: u.email, name: u.full_name || null }]));
}

async function taskCommentCounts(taskIds) {
    if (!taskIds.length) return {};
    const { data, error } = await supabase.from('client_task_comments').select('task_id').in('task_id', taskIds);
    if (error) return {};
    const out = {};
    for (const r of (data || [])) out[r.task_id] = (out[r.task_id] || 0) + 1;
    return out;
}

/**
 * A task's key, as on a Jira board: the client's initials and the task's number (HC-12).
 * The number runs across every client, so a key never repeats, even between businesses.
 */
function taskKeyPrefix(name) {
    const words = String(name || '').replace(/[^A-Za-z0-9 ]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return 'T';
    const p = words.length === 1 ? words[0].slice(0, 2) : words.slice(0, 3).map(w => w[0]).join('');
    return p.toUpperCase();
}
const taskKey = (t, clientName) => (t && t.task_number ? `${taskKeyPrefix(clientName)}-${t.task_number}` : null);

/** The staff view of a task. */
function taskView(t, people = {}, comments = {}, clientName = '') {
    const p = t.assignee_user_id ? people[t.assignee_user_id] : null;
    return {
        id: t.id, clientId: t.client_id, title: t.title, notes: t.notes || '',
        key: taskKey(t, clientName), number: t.task_number || null,
        priority: t.priority || 'medium',
        status: t.status, dueDate: t.due_date || null,
        labels: t.labels || [], checklist: t.checklist || [],
        assignee: t.assigned_to_client ? { kind: 'client' }
            : (t.assignee_user_id ? { kind: 'person', id: t.assignee_user_id, email: p?.email || null, name: p?.name || null } : null),
        visibleToClient: !!t.visible_to_client,
        source: t.source_type ? { type: t.source_type, id: t.source_id || null, label: t.source_label || null, key: t.source_key || null } : null,
        position: Number(t.position) || 0,
        createdBy: t.created_by || null, completedAt: t.completed_at || null,
        createdAt: t.created_at, updatedAt: t.updated_at || t.created_at,
        comments: comments[t.id] || 0
    };
}

/** The owner's view of a task: what it is and whether it is theirs. No ids of people, no internal notes on who made it. */
function clientTaskView(t) {
    return {
        id: t.id, title: t.title, notes: t.notes || '', status: t.status, dueDate: t.due_date || null, priority: t.priority || 'medium',
        yours: !!t.assigned_to_client, from: t.source_label || null,
        checklist: t.checklist || [], completedAt: t.completed_at || null, updatedAt: t.updated_at || t.created_at
    };
}

/** The staff routes are the agency's; a client account has its own under /api/client. */
function staffOnly(ctx, res) {
    if (ctx.profile?.role !== 'client') return true;
    res.status(403).json({ error: 'Your to-dos are on your portal home.', code: 'client_surface' });
    return false;
}

const TASK_MISSING = Symbol('migration_required');
async function loadTask(id) {
    if (!UUID_RE.test(String(id || ''))) return null;
    const { data, error } = await supabase.from('client_tasks').select('*').eq('id', id).maybeSingle();
    if (error) { if (missingTable(error)) return TASK_MISSING; throw error; }
    return data || null;
}

/** The next position at the bottom of a column. */
async function endOfColumn(clientId, status) {
    const { data } = await supabase.from('client_tasks').select('position')
        .eq('client_id', clientId).eq('status', status).order('position', { ascending: false }).limit(1);
    return ((data && data[0]) ? Number(data[0].position) || 0 : 0) + 1;
}

/**
 * May this caller read (and comment on) this task? Staff: anyone who can open
 * the client. A client account: only a task shown to it, on its own business.
 */
async function taskForReader(ctx, taskId) {
    const t = await loadTask(taskId);
    if (!t || t === TASK_MISSING) return t;
    if (ctx.profile?.role === 'client') {
        const own = await ownClientFor(ctx);
        return (own && own.id === t.client_id && t.visible_to_client) ? t : null;
    }
    return (await clientAccess(ctx.user.id, t.client_id, 'viewer')) ? t : null;
}

app.get('/api/clients/:id/tasks', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const { data, error } = await supabase.from('client_tasks').select('*').eq('client_id', c.id)
            .order('position', { ascending: true }).order('created_at', { ascending: true });
        if (error) { if (missingTable(error)) return migrationNeeded(res); throw error; }
        const tasks = data || [];
        const people = await clientPeople(c);
        const byId = Object.fromEntries(people.map(p => [p.id, p]));
        // Someone taken off the client keeps their name on the tasks they had.
        Object.assign(byId, await peopleById(tasks.map(t => t.assignee_user_id).filter(id => id && !byId[id])));
        const counts = await taskCommentCounts(tasks.map(t => t.id));
        res.json({
            client: { id: c.id, name: c.name, access: c.access },
            canEdit: ['owner', 'admin', 'editor'].includes(c.access),
            statuses: TASK_STATUSES,
            people,
            tasks: tasks.map(t => taskView(t, byId, counts, c.name))
        });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients/:id/tasks', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const body = cleanTaskBody(req.body || {}, { create: true });
        const who = await resolveAssignee(req.body?.assignee, c);
        const src = await cleanTaskSource(req.body?.source, c);

        // A recommendation is added to the board once, however many times the
        // button is pressed or by whom.
        if (src.source_id && src.source_key) {
            const { data: dup, error: de } = await supabase.from('client_tasks').select('*')
                .eq('client_id', c.id).eq('source_id', src.source_id).eq('source_key', src.source_key).maybeSingle();
            if (de) { if (missingTable(de)) return migrationNeeded(res); throw de; }
            if (dup) return res.json({ task: taskView(dup, await peopleById([dup.assignee_user_id]), {}, c.name), existing: true });
        }

        const status = body.status || 'todo';
        let position = body.position;
        if (position === undefined) {
            const { error: pe } = await supabase.from('client_tasks').select('id').eq('client_id', c.id).limit(1);
            if (pe) { if (missingTable(pe)) return migrationNeeded(res); throw pe; }
            position = await endOfColumn(c.id, status);
        }
        const now = new Date().toISOString();
        const row = {
            client_id: c.id, status, notes: null, due_date: null, labels: [], checklist: [],
            assignee_user_id: null, assigned_to_client: false, visible_to_client: false,
            ...body, ...who, ...src,
            position, created_by: ctx.user.id, created_at: now, updated_at: now,
            completed_at: status === 'done' ? now : null
        };
        if (row.assigned_to_client) row.visible_to_client = true;
        const { data, error } = await supabase.from('client_tasks').insert([row]).select().maybeSingle();
        if (error) { if (missing48(error)) return migration48(res); if (missingTable(error)) return migrationNeeded(res); throw error; }
        await linkTaskMedia(data, [data.notes]);
        res.status(201).json({ task: taskView(data, await peopleById([data.assignee_user_id]), {}, c.name) });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/tasks/:taskId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const t = await loadTask(req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        const c = t ? await clientAccess(ctx.user.id, t.client_id, 'editor') : null;
        if (!t || !c) return res.status(404).json({ error: 'Task not found, or you cannot edit it.' });

        // Phase 53: two people editing one task. The editor sends the version it opened (baseUpdatedAt);
        // if someone saved since, nothing is written and the page is handed the newer task to choose from,
        // instead of the later save silently wiping out the earlier one.
        const base = req.body?.baseUpdatedAt ? String(req.body.baseUpdatedAt) : null;
        const current = t.updated_at || t.created_at;
        const stale = async () => {
            const fresh = (await loadTask(t.id)) || t;
            res.status(409).json({ error: 'Someone else saved this task while you had it open.', code: 'task_conflict',
                task: taskView(fresh, await peopleById([fresh.assignee_user_id]), await taskCommentCounts([fresh.id]), c.name) });
        };
        if (base && current && Date.parse(base) !== Date.parse(current)) return stale();

        const now = new Date().toISOString();
        const patch = { ...cleanTaskBody(req.body || {}), ...(await resolveAssignee(req.body?.assignee, c)), updated_at: now };
        if (patch.status && patch.status !== t.status) {
            patch.completed_at = patch.status === 'done' ? now : null;
            if (patch.position === undefined) patch.position = await endOfColumn(t.client_id, patch.status);
        }
        // The client's own to-do is always one the client can see.
        const forClient = patch.assigned_to_client !== undefined ? patch.assigned_to_client : t.assigned_to_client;
        if (forClient) patch.visible_to_client = true;

        // Compare-and-set: the row is written only if nobody saved it since it was read here.
        let upd = supabase.from('client_tasks').update(patch).eq('id', t.id);
        if (base && t.updated_at) upd = upd.eq('updated_at', t.updated_at);
        const { data, error } = await upd.select().maybeSingle();
        if (error) { if (missing48(error)) return migration48(res); throw error; }
        if (!data) return stale();
        if (patch.notes !== undefined) await linkTaskMedia(data, [data.notes]);
        await S.syncPostFromTask(data, t.status).catch(e => logger.warn('post_sync_failed', { taskId: t.id, message: e.message }));
        res.json({ task: taskView(data, await peopleById([data.assignee_user_id]), await taskCommentCounts([data.id]), c.name) });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/tasks/:taskId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const t = await loadTask(req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        const c = t ? await clientAccess(ctx.user.id, t.client_id, 'editor') : null;
        if (!t || !c) return res.status(404).json({ error: 'Task not found, or you cannot edit it.' });
        await removeTaskMedia(t.id);                      // the pictures go with it, files and all
        const { error } = await supabase.from('client_tasks').delete().eq('id', t.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/tasks/:taskId/comments', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const t = await taskForReader(ctx, req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        if (!t) return res.status(404).json({ error: 'Task not found.' });
        const { data, error } = await supabase.from('client_task_comments').select('id, author_user_id, body, created_at')
            .eq('task_id', t.id).order('created_at', { ascending: true }).limit(500);
        if (error) { if (missingTable(error)) return migrationNeeded(res); throw error; }
        const rows = data || [];
        const people = await peopleById(rows.map(r => r.author_user_id));
        const roles = {};
        for (const id of Object.keys(people)) roles[id] = await userRole(id);
        const forClient = ctx.profile?.role === 'client';
        res.json({
            media: await taskMediaUrls(t.client_id, rows.map(r => r.body)),
            comments: rows.map(r => {
                const p = people[r.author_user_id] || {};
                const fromClient = roles[r.author_user_id] === 'client';
                // The owner reads who said it, never the team's addresses.
                const author = fromClient
                    ? { kind: 'client', name: p.name || 'Client', ...(forClient ? {} : { id: r.author_user_id, email: p.email || null }) }
                    : { kind: 'team', name: p.name || (forClient ? 'Your agency team' : (p.email || 'Team')), ...(forClient ? {} : { id: r.author_user_id, email: p.email || null }) };
                return { id: r.id, author, mine: r.author_user_id === ctx.user.id, body: r.body, createdAt: r.created_at };
            })
        });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/tasks/:taskId/comments', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const t = await taskForReader(ctx, req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        if (!t) return res.status(404).json({ error: 'Task not found.' });
        const body = String(req.body?.body ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
        if (!body) return res.status(400).json({ error: 'Write something first.' });
        if (body.length > TASK_COMMENT_MAX) return res.status(400).json({ error: `Keep a comment under ${TASK_COMMENT_MAX.toLocaleString('en-US')} characters.` });
        const { data, error } = await supabase.from('client_task_comments')
            .insert([{ task_id: t.id, client_id: t.client_id, author_user_id: ctx.user.id, body, created_at: new Date().toISOString() }])
            .select().maybeSingle();
        if (error) { if (missingTable(error)) return migrationNeeded(res); throw error; }
        await linkTaskMedia(t, [body]);
        await supabase.from('client_tasks').update({ updated_at: new Date().toISOString() }).eq('id', t.id);
        res.status(201).json({ comment: { id: data.id, mine: true, body: data.body, createdAt: data.created_at } });
    } catch (err) { sendErr(res, err); }
});

// ---- phase 48: one task, opened; pictures in its description and comments ----
//
// A picture is uploaded the moment it is pasted (the task may not exist yet),
// filed under the client, and referenced from the text as ![image](media:<id>).
// Saving the task or the comment ties the referenced pictures to the task. The
// bucket is private: the pages get signed links that last an hour, and only
// from routes that already decided the caller may read the task.
const TASK_MEDIA_BUCKET = process.env.TASK_MEDIA_BUCKET || 'task-media';
const TASK_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const TASK_MEDIA_TTL_SECS = 3600;
const TASK_MEDIA_RE = /!\[[^\]]{0,80}\]\(media:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;
const TASK_MEDIA_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
let _taskBucket = null;

async function ensureTaskBucket() {
    if (!supabase.storage) return false;
    if (!_taskBucket) {
        _taskBucket = (async () => {
            try {
                const { data } = await supabase.storage.getBucket(TASK_MEDIA_BUCKET);
                if (data) return true;
                const { error } = await supabase.storage.createBucket(TASK_MEDIA_BUCKET, {
                    public: false, fileSizeLimit: TASK_MEDIA_MAX_BYTES, allowedMimeTypes: Object.keys(TASK_MEDIA_TYPES)
                });
                if (error && !/exist/i.test(error.message || '')) throw error;
                return true;
            } catch (err) {
                logger.warn('task_bucket_unavailable', { message: err.message });
                _taskBucket = null;
                return false;
            }
        })();
    }
    return _taskBucket;
}

/** What the bytes are, from the bytes: the header a browser sends is only a claim. */
function sniffImage(buf) {
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
    if (buf.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    return null;
}

const mediaIdsIn = texts => [...new Set(texts.filter(Boolean).flatMap(x => [...String(x).matchAll(TASK_MEDIA_RE)].map(m => m[1].toLowerCase())))];

/** Signed links for the pictures these texts reference, this client's only. { id: url } */
async function taskMediaUrls(clientId, texts) {
    const ids = mediaIdsIn(texts);
    if (!ids.length || !supabase.storage) return {};
    const { data, error } = await supabase.from('client_task_media').select('id, path').eq('client_id', clientId).in('id', ids);
    if (error || !(data || []).length) return {};
    const { data: signed, error: se } = await supabase.storage.from(TASK_MEDIA_BUCKET).createSignedUrls(data.map(r => r.path), TASK_MEDIA_TTL_SECS);
    if (se || !signed) return {};
    const byPath = Object.fromEntries(signed.filter(x => x && x.signedUrl).map(x => [x.path, x.signedUrl]));
    return Object.fromEntries(data.filter(r => byPath[r.path]).map(r => [r.id, byPath[r.path]]));
}

/** Tie the pictures a saved text references to its task. Pictures of another client are never adopted. */
async function linkTaskMedia(task, texts) {
    const ids = mediaIdsIn(texts);
    if (!ids.length || !task) return;
    const { error } = await supabase.from('client_task_media').update({ task_id: task.id })
        .eq('client_id', task.client_id).is('task_id', null).in('id', ids);
    if (error && !missing48(error)) logger.warn('task_media_link_failed', { message: error.message });
}

async function removeTaskMedia(taskId) {
    const { data, error } = await supabase.from('client_task_media').select('path').eq('task_id', taskId);
    if (error || !(data || []).length || !supabase.storage) return;
    const { error: re } = await supabase.storage.from(TASK_MEDIA_BUCKET).remove(data.map(r => r.path));
    if (re) logger.warn('task_media_remove_failed', { message: re.message });
}

/** Upload one picture for a client's tasks. The body is the image itself, not JSON. */
app.post('/api/clients/:id/task-media',
    express.raw({ type: Object.keys(TASK_MEDIA_TYPES), limit: TASK_MEDIA_MAX_BYTES }),
    async (req, res) => {
        try {
            const ctx = await auth(req, res); if (!ctx) return;
            if (!staffOnly(ctx, res)) return;
            const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
            if (!c) return res.status(404).json({ error: 'Client not found.' });
            const buf = Buffer.isBuffer(req.body) ? req.body : null;
            if (!buf || !buf.length) return res.status(400).json({ error: 'Send a picture: PNG, JPEG, WebP or GIF.' });
            const type = sniffImage(buf);
            if (!type) return res.status(400).json({ error: 'That is not a PNG, JPEG, WebP or GIF picture.' });
            if (!(await ensureTaskBucket())) return res.status(503).json({ error: 'Picture storage is not available right now. Try again in a minute.' });
            const id = crypto.randomUUID();
            const path = `${c.id}/${id}.${TASK_MEDIA_TYPES[type]}`;
            const { error: ue } = await supabase.storage.from(TASK_MEDIA_BUCKET).upload(path, buf, { contentType: type, upsert: false, cacheControl: '3600' });
            if (ue) throw ue;
            const { error } = await supabase.from('client_task_media').insert([{ id, client_id: c.id, path, content_type: type, bytes: buf.length, uploaded_by: ctx.user.id, created_at: new Date().toISOString() }]);
            if (error) {
                await supabase.storage.from(TASK_MEDIA_BUCKET).remove([path]).catch(() => {});
                if (missing48(error)) return migration48(res);
                throw error;
            }
            const urls = await taskMediaUrls(c.id, [`![image](media:${id})`]);
            res.status(201).json({ id, token: `![image](media:${id})`, url: urls[id] || null });
        } catch (err) {
            if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That picture is over 5 MB. Use a smaller one.' });
            sendErr(res, err);
        }
    });

/** One task, opened: everything the board card has, plus who made it and signed links for its pictures. */
app.get('/api/tasks/:taskId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const t = await loadTask(req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        const c = t ? await clientAccess(ctx.user.id, t.client_id, 'viewer') : null;
        if (!t || !c) return res.status(404).json({ error: 'Task not found.' });
        const people = await peopleById([t.assignee_user_id, t.created_by]);
        const view = taskView(t, people, await taskCommentCounts([t.id]), c.name);
        view.reporter = t.created_by && people[t.created_by] ? { id: t.created_by, name: people[t.created_by].name, email: people[t.created_by].email } : null;
        res.json({ task: view, media: await taskMediaUrls(t.client_id, [t.notes]), canEdit: ['owner', 'admin', 'editor'].includes(c.access) });
    } catch (err) { sendErr(res, err); }
});

/** Everything assigned to the caller, on every client they can still open. */
app.get('/api/my-tasks', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const { data, error } = await supabase.from('client_tasks').select('*').eq('assignee_user_id', ctx.user.id).limit(1000);
        if (error) { if (missingTable(error)) return migrationNeeded(res); throw error; }
        const cutoff = new Date(Date.now() - TASK_DONE_SHOWN_DAYS * 86400000).toISOString();
        const rows = (data || []).filter(t => t.status !== 'done' || (t.completed_at && t.completed_at >= cutoff));
        const clients = new Map();
        for (const c of await clientsAccessible(ctx, [...new Set(rows.map(t => t.client_id))])) if (!c.archived) clients.set(c.id, c);
        const me = await peopleById([ctx.user.id]);
        const counts = await taskCommentCounts(rows.map(t => t.id));
        const tasks = rows.filter(t => clients.has(t.client_id))
            // Soonest first; no due date last; then oldest.
            .sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999') || String(a.created_at).localeCompare(String(b.created_at)))
            .map(t => ({ ...taskView(t, me, counts, clients.get(t.client_id).name), client: { id: t.client_id, name: clients.get(t.client_id).name } }));
        res.json({ tasks });
    } catch (err) { sendErr(res, err); }
});

// ---- the owner's side (rule 11: its own endpoints, its own columns) --------

app.get('/api/client/tasks', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (ctx.profile?.role !== 'client') return res.status(400).json({ error: 'This is the owner portal’s list. Staff use the client’s task board.' });
        const own = await ownClientFor(ctx);
        if (!own) return res.json({ business: null, tasks: [] });
        const { data, error } = await supabase.from('client_tasks')
            .select('*')
            .eq('client_id', own.id).eq('visible_to_client', true).limit(500);
        if (error) { if (missingTable(error)) return res.json({ business: { id: own.id, name: own.name }, tasks: [] }); throw error; }
        const rows = (data || []).sort((a, b) =>
            (a.status === 'done') - (b.status === 'done')
            || (a.due_date || '9999').localeCompare(b.due_date || '9999')
            || String(a.created_at).localeCompare(String(b.created_at)));
        res.json({ business: { id: own.id, name: own.name }, tasks: rows.map(clientTaskView), media: await taskMediaUrls(own.id, rows.map(r => r.notes)) });
    } catch (err) { sendErr(res, err); }
});

/** The owner ticks off their own to-do, or un-ticks it. Nothing else about a task is theirs to change. */
app.patch('/api/client/tasks/:taskId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (ctx.profile?.role !== 'client') return res.status(400).json({ error: 'Staff change tasks on the client’s task board.' });
        const t = await taskForReader(ctx, req.params.taskId);
        if (t === TASK_MISSING) return migrationNeeded(res);
        if (!t || !t.assigned_to_client) return res.status(404).json({ error: 'Task not found.' });
        const status = req.body?.status;
        if (!['todo', 'doing', 'done'].includes(status)) return res.status(400).json({ error: 'Mark it done, or not done.' });
        const now = new Date().toISOString();
        const patch = { status, updated_at: now, completed_at: status === 'done' ? (t.completed_at || now) : null };
        if (status !== t.status) patch.position = await endOfColumn(t.client_id, status);
        const { data, error } = await supabase.from('client_tasks').update(patch).eq('id', t.id).select().maybeSingle();
        if (error) throw error;
        res.json({ task: clientTaskView(data) });
    } catch (err) { sendErr(res, err); }
});

// ---- the owner's login, made by the agency ----------------------------------
//
// Until now an owner had one way in: sign up themselves, then be absorbed into
// the agency's record by an owner who knew their email. That is backwards for
// the agency that already has the client. So the agency invites the owner
// from the client's page: the login is made, filed under THIS client, and a
// one-time link lets the owner choose a password. The link is sent from the
// agency's Gmail when mail is set up; otherwise the person who invited gets
// it to pass on, because an invite that silently goes nowhere is worse.
// ===========================================================================
// PHASE 49 :: OWNERS SIGN IN TO EDGE META AI WITH AN EMAILED CODE
//
// No password: the owner types their email, a 6-digit code arrives, they type
// it, and the app keeps them signed in. Invite-only: a code goes only to an
// owner login the agency made (role client, active). Whether an address has a
// login is never said — the answer is the same either way.
//
// The code proves the email; the session itself is Supabase's. The server
// makes a one-time magic-link token for that login (admin API) and hands its
// hash to the page, which exchanges it for a session with verifyOtp. Only a
// hash of the code is kept; one use, ten minutes, five tries.
// ===========================================================================
const OWNER_CODE_TTL_MS = 10 * 60000;
const OWNER_CODE_TRIES = 5;
const OWNER_CODE_GAP_MS = 45000;          // one code per address per 45 s
const OWNER_CODE_PER_HOUR = 6;
const ownerCodeLimit = rateLimit({ windowMs: 60000, max: 10 });

function ownerCodeHash(code, userId) {
    const key = ENC_KEY || Buffer.from(String(process.env.SUPABASE_SERVICE_ROLE_KEY || 'edgelead'));
    return crypto.createHmac('sha256', key).update(`${userId}:${code}`).digest('hex');
}
function ownerCodesMissing(err) {
    return !!err && (err.code === '42P01' || err.code === 'PGRST205' || /owner_login_codes/i.test(String(err.message || '')));
}

app.post('/api/public/owner-code', ownerCodeLimit, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter the email your agency invited.' });
        const generic = { sent: true, note: 'If that email has a login, a 6-digit code is on its way. It works for 10 minutes.' };
        if (!(await mailSettings()).configured) {
            return res.status(503).json({ error: 'Sign-in codes are not switched on yet. Ask your agency for a sign-in link.', code: 'mail_off' });
        }
        const { data: u } = await supabase.from('app_users').select('id, role, is_active').eq('email', email).maybeSingle();
        if (!u || u.role !== 'client' || u.is_active === false) return res.json(generic);
        // Phase 52: a login whose business the agency has closed gets no code (same answer as anyone).
        if (!(await findOwnClient(u.id))) return res.json(generic);

        const since = new Date(Date.now() - 3600000).toISOString();
        const { data: recent, error: re } = await supabase.from('owner_login_codes').select('created_at').eq('email', email).gte('created_at', since).order('created_at', { ascending: false }).limit(20);
        if (re) { if (ownerCodesMissing(re)) return res.status(503).json({ error: 'Sign-in codes need the phase-49 database update.', code: 'migration_required' }); throw re; }
        if ((recent || []).length && Date.now() - Date.parse(recent[0].created_at) < OWNER_CODE_GAP_MS) return res.json(generic);
        // Phase 51: the same answer as any other address, so the limit cannot tell anyone which emails have logins.
        if ((recent || []).length >= OWNER_CODE_PER_HOUR) return res.json(generic);

        const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
        const now = Date.now();
        const { error } = await supabase.from('owner_login_codes').insert([{
            email, user_id: u.id, code_hash: ownerCodeHash(code, u.id), attempts: 0,
            expires_at: new Date(now + OWNER_CODE_TTL_MS).toISOString(), created_at: new Date(now).toISOString()
        }]);
        if (error) throw error;
        const sent = await sendMail({
            to: email,
            subject: `${code} is your Edge Meta AI code`,
            text: [`Your sign-in code for Edge Meta AI: ${code}`, '', 'It works once, for 10 minutes. If you did not ask for it, you can ignore this email.', '— EdgeLead'].join('\n')
        });
        if (!sent.ok) {
            logger.warn('owner_code_mail_failed', { message: sent.error });
            return res.status(502).json({ error: 'The code could not be emailed just now. Try again in a minute.' });
        }
        logger.info('owner_code_sent', { userId: u.id });
        res.json(generic);
    } catch (err) { sendErr(res, err); }
});

app.post('/api/public/owner-verify', ownerCodeLimit, async (req, res) => {
    try {
        const email = String(req.body?.email || '').trim().toLowerCase();
        const code = String(req.body?.code || '').replace(/\D/g, '');
        const wrong = () => res.status(400).json({ error: 'That code is not right, or it has expired. Ask for a new one.' });
        if (!EMAIL_RE.test(email) || code.length !== 6) return wrong();
        const { data: rows, error } = await supabase.from('owner_login_codes').select('*').eq('email', email).is('used_at', null)
            .gte('expires_at', new Date().toISOString()).order('created_at', { ascending: false }).limit(1);
        if (error) { if (ownerCodesMissing(error)) return res.status(503).json({ error: 'Sign-in codes need the phase-49 database update.', code: 'migration_required' }); throw error; }
        const row = (rows || [])[0];
        if (!row || row.attempts >= OWNER_CODE_TRIES) return wrong();
        // Phase 51: every try is counted BEFORE the code is compared, and only if the count is still the
        // one just read (compare-and-set). Guesses sent at the same moment can no longer share one count
        // and slip past the five-try limit: all but one of them find the count moved and are refused.
        const { data: claimed } = await supabase.from('owner_login_codes').update({ attempts: (row.attempts || 0) + 1 })
            .eq('id', row.id).eq('attempts', row.attempts || 0).is('used_at', null).select('id');
        if (!(claimed || []).length) return wrong();
        const want = Buffer.from(row.code_hash, 'hex'), got = Buffer.from(ownerCodeHash(code, row.user_id), 'hex');
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return wrong();
        // One use: only the request that marks it used goes on.
        const { data: used } = await supabase.from('owner_login_codes').update({ used_at: new Date().toISOString() })
            .eq('id', row.id).is('used_at', null).select('id');
        if (!(used || []).length) return wrong();
        const { data: u } = await supabase.from('app_users').select('id, role, is_active').eq('id', row.user_id).maybeSingle();
        if (!u || u.role !== 'client' || u.is_active === false) return wrong();
        const { data: gl, error: ge } = await supabase.auth.admin.generateLink({ type: 'magiclink', email });
        if (ge) throw ge;
        const tokenHash = gl?.properties?.hashed_token || null;
        if (!tokenHash) throw new Error('No sign-in token came back.');
        logger.info('owner_code_verified', { userId: u.id });
        res.json({ tokenHash, type: 'magiclink' });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients/:id/portal-invite', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        // Phase 53: anyone on the team who can edit the client invites its business owner, not only the
        // account lead — the person running the client day to day is usually the one who has the email.
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const email = String(req.body?.email || '').trim().toLowerCase();
        if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter the owner’s email address.' });
        const name = oneLine(req.body?.name, 80) || null;

        // Every refusal happens before anything is written: a login made and
        // then refused would sit in Supabase with no account behind it.
        let paidUntil = null;
        if (req.body?.paidUntil) {
            // A portal can be part of what the agency already sells. Plans are
            // an admin's to give, exactly as on the admin page.
            if (ctx.profile.role !== 'admin') return res.status(403).json({ error: 'Only an admin can open a paid portal.' });
            paidUntil = String(req.body.paidUntil);
            if (!ISO_DAY_RE.test(paidUntil) || Number.isNaN(Date.parse(paidUntil + 'T23:59:59Z'))) return res.status(400).json({ error: 'Paid until looks like 2026-12-31.' });
        }

        let { data: u } = await supabase.from('app_users').select('id, email, role').eq('email', email).maybeSingle();
        if (u && u.role !== 'client') return res.status(400).json({ error: 'That email belongs to someone on your team, not a business owner.' });
        let created = false;
        if (!u) {
            // A password nobody knows: the owner sets their own through the link.
            const { data: cu, error: ce } = await supabase.auth.admin.createUser({
                email, password: crypto.randomBytes(24).toString('base64url'), email_confirm: true,
                ...(name ? { user_metadata: { full_name: name } } : {})
            });
            if (ce && /already|registered|exists/i.test(ce.message || '')) {
                return res.status(409).json({ error: 'That email already has a login that has never been used here. Ask them to sign in once, then invite them again.' });
            }
            if (ce) throw ce;
            const days = await trialDaysSetting();
            const start = new Date();
            const row = {
                id: cu.user.id, email, full_name: name, role: 'client', is_active: true, byo_key_only: false,
                trial_started_at: start.toISOString(), trial_ends_at: new Date(start.getTime() + days * 86400000).toISOString()
            };
            if (paidUntil) Object.assign(row, { paid_until: paidUntil + 'T23:59:59Z', plan_label: oneLine(req.body.planLabel, 60) || null, activated_by: ctx.user.id, activated_at: start.toISOString() });
            const { error: ue } = await supabase.from('app_users').upsert(row);
            if (ue) throw ue;
            for (const e of TRIAL_ENGINES) {
                await supabase.from('user_engine_access')
                    .upsert({ user_id: row.id, engine: e, granted_by: ctx.user.id }, { onConflict: 'user_id,engine' });
            }
            invalidateEngineAccess(row.id);
            _roleCache.delete(row.id);
            u = { id: row.id, email, role: 'client' };
            created = true;
        }

        // One login is one business: the portal shows the business the login
        // resolves to, and a second one would make that a coin toss. The other
        // business is not named — that would tell the inviter who else it is.
        if (!created) {
            const { data: mem } = await supabase.from('client_members').select('client_id').eq('user_id', u.id).eq('role', 'editor');
            const elsewhere = (mem || []).map(m => m.client_id).filter(id => id !== c.id);
            const { data: others } = elsewhere.length ? await supabase.from('clients').select('id, archived').in('id', elsewhere) : { data: [] };
            const { data: owns } = await supabase.from('clients').select('id').eq('owner_user_id', u.id).eq('archived', false);
            let ownsWork = false;
            for (const o of (owns || [])) {
                const [{ count: r }, { count: j }, { count: m }] = await Promise.all([
                    supabase.from('reports').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
                    supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
                    supabase.from('meta_connections').select('id', { count: 'exact', head: true }).eq('client_id', o.id)
                ]);
                if ((r || 0) + (j || 0) + (m || 0)) ownsWork = true;
            }
            if ((others || []).some(x => !x.archived) || ownsWork) {
                return res.status(409).json({ error: 'That login already belongs to another business. One login is one business; an admin can merge the two records if they are the same business.' });
            }
        }

        const { error: me } = await supabase.from('client_members')
            .upsert([{ client_id: c.id, user_id: u.id, role: 'editor', added_by: ctx.user.id }], { onConflict: 'client_id,user_id' });
        if (me) throw me;
        const absorbed = await absorbEmptyOwnRecord(u.id, c.id);
        await markAgencyOwner(u.id);

        // The way in. 'recovery' works for a login that exists and lands on
        // the page that asks for a password. For a login made just now the
        // inviter may carry the link themselves; for a login that already
        // existed it goes only to that person's inbox — handing someone
        // else's password link to whoever typed their address would let any
        // client's owner take over any business owner's account.
        const base = appUrl();
        const mailReady = (await mailSettings()).configured;
        let link = null;
        if (created || mailReady) {
            try {
                // Phase 49: owners live in Edge Meta AI, signed in by email code. The
                // invite is a one-tap sign-in straight into the app; no password is ever set.
                const { data: gl, error: ge } = await supabase.auth.admin.generateLink({
                    type: 'magiclink', email, ...(base ? { options: { redirectTo: `${base}/ai/` } } : {})
                });
                if (ge) throw ge;
                link = gl?.properties?.action_link || gl?.action_link || null;
            } catch (e) {
                logger.warn('portal_invite_link_failed', { clientId: c.id, message: e.message });
            }
        }

        let emailed = false, mailError = null;
        if (link) {
            const sent = await sendMail({
                to: email,
                subject: `Edge Meta AI for ${c.name}`,
                text: [
                    `${name ? 'Hi ' + name.split(' ')[0] + ',' : 'Hello,'}`,
                    '',
                    `Your agency has set up Edge Meta AI for ${c.name}: ask about your Instagram and Facebook, see what your agency is working on, approve your planned posts and read your reports, all in one chat.`,
                    '',
                    `Open it here (one tap signs you in): ${link}`,
                    '',
                    'On your phone, add it to your home screen from there and it opens like an app.',
                    `Next time, open ${base ? base + '/ai/' : 'Edge Meta AI'} and sign in with a code we email you. There is no password.`,
                    '— EdgeLead'
                ].join('\n')
            });
            emailed = !!sent.ok;
            if (!sent.ok) mailError = sent.error || null;
        }
        logger.info('portal_invite', { clientId: c.id, by: ctx.user.id, created, emailed });
        const handBack = created && !emailed && link;
        res.status(created ? 201 : 200).json({
            success: true, created, absorbed, emailed,
            owner: { id: u.id, email },
            // Only for a login made just now, and only when it could not be sent.
            link: handBack ? link : null,
            note: emailed ? `Invite sent to ${email}.`
                : handBack ? `Email is not set up${mailError ? ' (' + mailError + ')' : ''}, so send this link to the owner yourself. One tap signs them in to Edge Meta AI; it works once and expires.`
                : !created ? `${email} already has a login. Edge Meta AI now shows ${c.name}; they sign in with a code emailed to them.${mailReady ? ' The email could not be sent' + (mailError ? ' (' + mailError + ')' : '') + '.' : ''}`
                : 'The login is ready, but a sign-in link could not be made. Try again in a minute.'
        });
    } catch (err) { sendErr(res, err); }
});

/**
 * A fresh one-tap sign-in link for an owner who is already on this business
 * (phase 52). The invite link works once and expires; until the agency's Gmail
 * is set up there is no code either, so without this an owner who lost the
 * first link had no way back in. Only for a login whose business is this one:
 * the person asking already sees everything that login can.
 */
app.post('/api/clients/:id/owner-link', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const userId = String(req.body?.userId || '');
        if (!UUID_RE.test(userId)) return res.status(400).json({ error: 'Choose the owner login.' });
        const { data: u } = await supabase.from('app_users').select('id, email, role, is_active').eq('id', userId).maybeSingle();
        const own = u && u.role === 'client' ? await findOwnClient(u.id) : null;
        if (!u || u.role !== 'client' || !own || own.id !== c.id) return res.status(404).json({ error: 'That login is not this business’s owner login.' });
        if (u.is_active === false) return res.status(400).json({ error: 'That login is switched off. An admin can switch it back on first.' });

        const base = appUrl();
        const { data: gl, error: ge } = await supabase.auth.admin.generateLink({
            type: 'magiclink', email: u.email, ...(base ? { options: { redirectTo: `${base}/ai/` } } : {})
        });
        if (ge) throw ge;
        const link = gl?.properties?.action_link || gl?.action_link || null;
        if (!link) return res.status(502).json({ error: 'A sign-in link could not be made. Try again in a minute.' });

        let emailed = false;
        if ((await mailSettings()).configured) {
            const sent = await sendMail({
                to: u.email,
                subject: `Your Edge Meta AI sign-in link for ${c.name}`,
                text: [
                    'Hello,', '',
                    `Here is a new link into Edge Meta AI for ${c.name}. One tap signs you in: ${link}`, '',
                    'It works once and expires within the hour. Next time you can also sign in with a code we email you.',
                    '— EdgeLead'
                ].join('\n')
            });
            emailed = !!sent.ok;
        }
        logger.info('owner_link', { clientId: c.id, ownerId: u.id, by: ctx.user.id, emailed });
        res.json({
            success: true, emailed,
            link: emailed ? null : link,
            note: emailed ? `A new sign-in link was emailed to ${u.email}.`
                : `Send this link to ${u.email} yourself. One tap signs them in to Edge Meta AI; it works once and expires within the hour.`
        });
    } catch (err) { sendErr(res, err); }
});
