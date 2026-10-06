/**
 * Boot-time handlers and the client workspace.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const { AUTH_CACHE_MS, app, auth, invalidateAuth, logger, sendErr, supabase } = S;
Object.assign(S, {
    trialOpen, endedTrialFor, clientStages,
    userRole, clientAccess, findOwnClient, ownClientFor, requireOwnClient, resolveClientId,
    applyReportScope, canReadReport, cleanClientBody, clientsAccessible, clientArchived, markAgencyOwner,
    absorbEmptyOwnRecord
});

// ===========================================================================
// BOOT
// ===========================================================================

/**
 * One-pass migration. Any token still sitting in the database as plaintext is
 * sealed, and token_hash is filled in for rows created before it existed.
 * Idempotent, so it is safe on every boot and a no-op once everything is done.
 */
/** Decrypt with the retiring key. Only used during rotation. */
// ===========================================================================
// TERMINAL HANDLERS
// Registered after every route, which is the only place they work.
// ===========================================================================

/**
 * A JSON 404 for the API surface.
 *
 * Without this a typo'd path fell through to Express's built-in handler, which
 * answers with an HTML page. EL.api() then failed inside JSON.parse and the
 * user saw "Unexpected token <" instead of "no such endpoint".
 */
// ===========================================================================
// PHASE 9 :: CLIENT WORKSPACE
//
// A client is the unit of work. Every report, job, set and suggestion carries
// a nullable client_id. Runs without a client keep the per-user rule that has
// always applied; runs with one land in that client's timeline and are
// visible to every member of that client.
// ===========================================================================

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
S.UUID_RE = UUID_RE;

/**
 * Return the client row when the user may act on it, else null.
 * need: 'viewer' (owner or any member) | 'editor' (owner or editor member) | 'owner'
 */
/**
 * The caller's account role, cached for the same window as auth itself.
 * clientAccess takes a user id rather than a ctx because half its callers are
 * workers with no request in hand, so the role has to be looked up here.
 */
const _roleCache = new Map();
S._roleCache = _roleCache;
/** Is this login the business owner of that client (its own record, or invited onto it)? */
async function isOwnerOf(userId, clientId) {
    const { data: c } = await supabase.from('clients').select('owner_user_id, archived').eq('id', clientId).maybeSingle();
    if (!c || c.archived) return false;
    if (c.owner_user_id === userId) return true;
    const { data: m } = await supabase.from('client_members').select('user_id').eq('client_id', clientId).eq('user_id', userId).maybeSingle();
    return !!m;
}

async function userRole(userId) {
    const hit = _roleCache.get(userId);
    if (hit && Date.now() - hit.t < AUTH_CACHE_MS) return hit.v;
    const { data } = await supabase.from('app_users').select('role').eq('id', userId).maybeSingle();
    const v = data?.role || null;
    _roleCache.set(userId, { v, t: Date.now() });
    return v;
}

async function clientAccess(userId, clientId, need = 'viewer') {
    if (!userId || !clientId || !UUID_RE.test(String(clientId))) return null;
    const { data: c } = await supabase.from('clients').select('*').eq('id', clientId).maybeSingle();
    if (!c) return null;
    // Phase 51: this is the agency's door. A business owner (role client) is a member of their client
    // record so the owner routes can find it, but never passes here: through the staff routes that
    // membership exposed the team's emails, job errors and costs, internal notes, and let an owner
    // rename or archive the record, run or delete schedules and revoke share links. Owners have their
    // own routes (/api/client/*, /api/xp/*), which resolve their business with ownClientFor.
    const role = await userRole(userId);
    if (role === 'client') return null;
    if (c.owner_user_id === userId) return { ...c, access: 'owner' };
    // An admin reaches every client. Without this, "admin creates the client
    // and assigns an employee" only worked when the admin happened to be the
    // one who created it — a client an employee made was untouchable by the
    // person whose job is to hand work out. requireEngine already lets admins
    // through every engine; this is the same rule applied to clients.
    if (role === 'admin') return { ...c, access: 'admin' };
    if (need === 'owner') return null;
    const { data: m } = await supabase.from('client_members')
        .select('role').eq('client_id', clientId).eq('user_id', userId).maybeSingle();
    if (!m) return null;
    if (need === 'editor' && m.role !== 'editor') return null;
    return { ...c, access: m.role };
}

/** Read clientId from a request body, validate it, or throw 403. */
/**
 * The live business a client-role login belongs to, or null: owned first,
 * failing that one the agency made them an editor of. Archived records do not
 * count — an owner whose business the agency has closed has no business here.
 */
async function findOwnClient(uid) {
    const { data: owned } = await supabase.from('clients').select('*')
        .eq('owner_user_id', uid).eq('archived', false)
        .order('created_at', { ascending: true }).limit(5);
    const ownLive = (owned || []).find(c => trialOpen(c));
    if (ownLive) return ownLive;

    const { data: mem } = await supabase.from('client_members').select('client_id')
        .eq('user_id', uid).eq('role', 'editor');
    const ids = (mem || []).map(m => m.client_id);
    if (!ids.length) return null;
    const { data: cs } = await supabase.from('clients').select('*').in('id', ids).eq('archived', false)
        .order('created_at', { ascending: true }).limit(20);
    return (cs || []).find(c => trialOpen(c)) || null;
}

/** A client on a trial that has run out is closed to its owner until the agency extends or converts it (phase 56). */
function trialOpen(c) {
    // One argument on purpose: passed straight to Array.find, a second parameter would be the index.
    return !(c && c.trial_ends_at && Date.parse(c.trial_ends_at) <= Date.now());
}
/** The business whose trial ended, for the owner's "your trial ended" screen. */
async function endedTrialFor(uid) {
    const { data: mem } = await supabase.from('client_members').select('client_id').eq('user_id', uid).eq('role', 'editor');
    const ids = (mem || []).map(m => m.client_id);
    if (!ids.length) return null;
    const { data: cs } = await supabase.from('clients').select('id, name, trial_ends_at, archived').in('id', ids).eq('archived', false);
    const c = (cs || []).filter(x => !trialOpen(x)).sort((a, b) => String(b.trial_ends_at).localeCompare(String(a.trial_ends_at)))[0];
    return c ? { name: c.name, endedAt: c.trial_ends_at } : null;
}

/**
 * The client record a client-role account IS. A self-serve signup with no
 * record yet gets one made — an account that signs up to see how its business
 * is doing is a business. An owner login the agency made never does (phase
 * 52): when the agency archives or removes their business, the login has no
 * business, and the app says their access has ended instead of quietly
 * opening an empty "My business" for them.
 */
async function ownClientFor(ctx) {
    const uid = ctx.user.id;
    const found = await findOwnClient(uid);
    if (found) return found;
    if (ctx.profile?.agency_owner === true) return null;

    const email = ctx.user.email || ctx.profile?.email || '';
    const name = String(ctx.profile?.full_name || '').trim() || email.split('@')[0] || 'My business';
    const { data: created } = await supabase.from('clients').insert([{
        owner_user_id: uid, name,
        // Explicit, not left to the column default: the lookup above filters
        // on archived = false, and a row that relies on the database to fill
        // that in is a row this function cannot find again anywhere the
        // default is absent. The use-case test caught exactly that.
        archived: false,
        notes: 'Created automatically when this account signed up. Rename it to the business name.'
    }]).select().maybeSingle();
    return created || null;
}

/** An owner's business, or a 403 the app shows as "your access has ended". Null means the response is sent. */
async function requireOwnClient(ctx, res) {
    const own = await ownClientFor(ctx);
    if (own) return own;
    res.status(403).json({ error: 'Your agency has not set up a business for this login, or it has been closed. Contact your agency.', code: 'no_business' });
    return null;
}

/**
 * Which business a piece of work is for. (phase 22: mandatory)
 *
 * This used to return null when the picker said "None (just me)", and the
 * numbers showed what that meant in practice: 15 of 16 reports and all 27
 * campaigns on the live database were filed under nothing. Work with no
 * client has no timeline, no history, no client who can ever see it, and no
 * way to be found again except by the person who ran it, from memory.
 *
 * So: every run is for a business. A client-role account IS its business and
 * needs to say nothing; everyone else must choose one, and the server refuses
 * rather than trusting the page to have asked.
 */
async function resolveClientId(req, ctx) {
    const raw = req.body?.clientId || req.body?.client_id || req.query?.client_id || null;
    // An owner's work is always filed under their own business, whatever id the browser sent along
    // (a client picked on this device by someone on the team, say).
    if (ctx.profile?.role === 'client') {
        const own = await ownClientFor(ctx);
        if (own) return own.id;
        const e = new Error('Your agency has not set up a business for this login, or it has been closed. Contact your agency.');
        e.statusCode = 403; e.code = 'no_business';
        throw e;
    }
    if (!raw) {
        const e = new Error('Choose a client first. Every run is filed under a business, and this one has nowhere to go.');
        e.statusCode = 400;
        e.code = 'client_required';
        throw e;
    }
    const c = await clientAccess(ctx.user.id, raw, 'editor');
    if (!c) { const e = new Error('You do not have edit access to that client.'); e.statusCode = 403; throw e; }
    return c.id;
}

/** Scope a reports query: by client (membership) when asked, else by user. */
/**
 * Resolves whose rows the caller may list and returns a function to apply to
 * a query builder — deliberately NOT the builder itself. PostgREST builders
 * are thenables, so returning one from an async function makes `await`
 * execute the query: the caller received `{ data, error }` instead of a
 * builder, and every vault list died with "q.order is not a function".
 */
async function applyReportScope(req, ctx) {
    const cid = req.query?.client_id;
    if (cid) {
        const c = await clientAccess(ctx.user.id, cid, 'viewer');
        if (!c) { const e = new Error('No access to that client.'); e.statusCode = 403; throw e; }
        return q => q.eq('client_id', c.id);
    }
    return q => q.eq('user_id', ctx.user.id);
}

/** May this user open this single report row? */
async function canReadReport(ctx, row) {
    if (!row) return false;
    if (row.user_id === ctx.user.id) return true;
    // Phase 51: an owner reads a report about their business only once the agency shares it
    // (visible_to_client). Competitor research, prospect lists and drafts stay with the team.
    if (ctx.profile?.role === 'client') return row.visible_to_client === true && !!row.client_id && await isOwnerOf(ctx.user.id, row.client_id);
    if (ctx.profile?.role === 'admin') return true;
    if (row.client_id && await clientAccess(ctx.user.id, row.client_id, 'viewer')) return true;
    return false;
}

function cleanClientBody(b = {}) {
    const s = v => (v === undefined || v === null) ? undefined : String(v).trim().slice(0, 300) || null;
    return {
        name: s(b.name), brand: s(b.brand),
        ig_handle: b.ig_handle !== undefined ? (s(b.ig_handle) || '').replace('@', '').toLowerCase() || null : undefined,
        fb_page: s(b.fb_page), fb_page_id: s(b.fb_page_id),
        niche: s(b.niche), location: s(b.location),
        notes: b.notes !== undefined ? String(b.notes || '').slice(0, 4000) || null : undefined,
        archived: typeof b.archived === 'boolean' ? b.archived : undefined
    };
}

/**
 * clientAccess for many clients in three queries instead of three per client
 * (phase 54: My tasks opened one by one every client a person had a task on).
 * Same rules: staff only; owner, admin, or a member at any level.
 */
async function clientsAccessible(ctx, ids) {
    ids = (ids || []).filter(id => id && UUID_RE.test(String(id)));
    if (!ids.length || ctx.profile?.role === 'client') return [];
    const uid = ctx.user.id;
    const [{ data: cs }, { data: mem }] = await Promise.all([
        supabase.from('clients').select('*').in('id', ids),
        ctx.profile?.role === 'admin' ? Promise.resolve({ data: [] }) : supabase.from('client_members').select('client_id, role').eq('user_id', uid).in('client_id', ids)
    ]);
    const role = Object.fromEntries((mem || []).map(m => [m.client_id, m.role]));
    return (cs || []).map(c => {
        if (c.owner_user_id === uid) return { ...c, access: 'owner' };
        if (ctx.profile?.role === 'admin') return { ...c, access: 'admin' };
        return role[c.id] ? { ...c, access: role[c.id] } : null;
    }).filter(Boolean);
}

/**
 * Reports per client and type, counted by the database (phase 54). The list
 * used to fetch every report row to count them, which grew with the agency's
 * history and stopped at PostgREST's 1,000-row cap — the counts were quietly
 * wrong past it. Without the phase-54 view it falls back to the old way.
 */
async function reportCounts(ids) {
    const counts = {};
    const add = (cid, type, n) => {
        const c = counts[cid] = counts[cid] || { total: 0, byType: {} };
        c.total += n; c.byType[type] = (c.byType[type] || 0) + n;
    };
    const { data, error } = await supabase.from('el_client_report_counts').select('client_id, report_type, n').in('client_id', ids);
    if (!error) { for (const r of (data || [])) add(r.client_id, r.report_type, Number(r.n) || 0); return counts; }
    const { data: reps } = await supabase.from('reports').select('client_id, report_type').in('client_id', ids);
    for (const r of (reps || [])) add(r.client_id, r.report_type, 1);
    return counts;
}

app.get('/api/clients', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;                  // phase 51: the agency's list; an owner lives in the app
        const includeArchived = String(req.query.archived || '') === '1';
        const { data: owned } = await supabase.from('clients').select('*')
            .eq('owner_user_id', ctx.user.id).order('created_at', { ascending: false });
        const { data: mem } = await supabase.from('client_members').select('client_id, role').eq('user_id', ctx.user.id);
        let shared = [];
        if (mem?.length) {
            const { data } = await supabase.from('clients').select('*').in('id', mem.map(m => m.client_id));
            shared = (data || []).map(c => ({ ...c, access: (mem.find(m => m.client_id === c.id) || {}).role || 'viewer' }));
        }
        let rows = [...(owned || []).map(c => ({ ...c, access: 'owner' })), ...shared];

        // An admin's list is every client, not just theirs: assigning work
        // means seeing the clients other people created. Ownership and
        // membership still label the rows they apply to.
        if (ctx.profile.role === 'admin') {
            const have = new Set(rows.map(r => r.id));
            const { data: all } = await supabase.from('clients').select('*').order('created_at', { ascending: false });
            for (const c of (all || [])) if (!have.has(c.id)) rows.push({ ...c, access: 'admin' });
        }
        if (!includeArchived) rows = rows.filter(c => !c.archived);
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

        // Counts per client so the list is a real overview rather than names.
        const ids = rows.map(r => r.id);
        const counts = ids.length ? await reportCounts(ids) : {};
        // Meta per client, so "is this one connected?" is answered on the row
        // rather than by opening each client and finding the tab.
        const meta = {};
        if (ids.length) {
            const { data: conns } = await supabase.from('meta_connections')
                .select('client_id, status, page_name, ig_username').in('client_id', ids);
            for (const k of (conns || [])) {
                const m = meta[k.client_id] = meta[k.client_id] || { connected: false, pages: 0, active: 0, names: [] };
                m.pages += 1;
                if (k.status === 'active') { m.active += 1; m.connected = true; }
                if (k.page_name && m.names.length < 3) m.names.push(k.page_name);
            }
        }
        const withMeta = rows.map(c => ({
            ...c,
            reports: counts[c.id] || { total: 0, byType: {} },
            meta: meta[c.id] || { connected: false, pages: 0, active: 0, names: [] }
        }));
        // Phase 56: the hub's view of each client — stage, next step, owner logins, trial, Meta reads.
        const stages = ids.length ? await clientStages(withMeta).catch(e => { logger.warn('client_stages_failed', { message: e.message }); return {}; }) : {};
        res.json({ clients: withMeta.map(c => ({ ...c, ...(stages[c.id] || {}) })) });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;                  // phase 51: the agency's list; an owner lives in the app
        const body = cleanClientBody(req.body);
        if (!body.name) return res.status(400).json({ error: 'Client name is required.' });
        const row = { owner_user_id: ctx.user.id };
        for (const [k, v] of Object.entries(body)) if (v !== undefined) row[k] = v;
        // Phase 56: a business can start as a trial of Edge Meta AI, for a set number of days.
        if (req.body?.trialDays !== undefined && req.body?.trialDays !== null) {
            const days = trialDaysOf(req.body.trialDays);
            if (!days) return res.status(400).json({ error: 'A trial runs 1 to 90 days.' });
            Object.assign(row, trialWindow(days));
        }
        const { data, error } = await supabase.from('clients').insert([row]).select().maybeSingle();
        if (error) throw error;
        res.status(201).json({ client: { ...data, access: 'owner' } });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const body = cleanClientBody(req.body);
        const patch = { updated_at: new Date().toISOString() };
        for (const [k, v] of Object.entries(body)) if (v !== undefined) patch[k] = v;
        if (patch.name === null) delete patch.name;
        const { data, error } = await supabase.from('clients').update(patch).eq('id', c.id).select().maybeSingle();
        if (error) throw error;
        if (patch.archived !== undefined && !!patch.archived !== !!c.archived) await clientArchived(c.id, !!patch.archived);
        res.json({ client: { ...data, access: c.access } });
    } catch (err) { sendErr(res, err); }
});

// ---- trials (phase 56) -------------------------------------------------------
// A trial is a business the agency lets try Edge Meta AI for a set time before
// it signs. The owner is invited the same way as any client's; when the trial
// ends the app tells them so and nothing else, until the team extends it or
// converts the business into a client.
const trialDaysOf = v => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= 1 && n <= 90 ? n : null; };
function trialWindow(days, from = Date.now()) {
    return { trial_started_at: new Date(from).toISOString(), trial_ends_at: new Date(from + days * 86400000).toISOString(), converted_at: null };
}

app.post('/api/clients/:id/trial', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!S.staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const action = String(req.body?.action || '');
        let patch;
        if (action === 'start' || action === 'extend') {
            const days = trialDaysOf(req.body?.days);
            if (!days) return res.status(400).json({ error: 'A trial runs 1 to 90 days.' });
            // Extending adds to whatever is left; an ended trial starts again from today.
            const base = action === 'extend' && c.trial_ends_at && Date.parse(c.trial_ends_at) > Date.now() ? Date.parse(c.trial_ends_at) : Date.now();
            patch = action === 'start' ? trialWindow(days)
                : { trial_ends_at: new Date(base + days * 86400000).toISOString(), trial_started_at: c.trial_started_at || new Date().toISOString() };
        } else if (action === 'convert') {
            if (!c.trial_ends_at) return res.status(400).json({ error: 'This business is not on a trial.' });
            patch = { trial_ends_at: null, converted_at: new Date().toISOString() };
        } else return res.status(400).json({ error: 'Start, extend or convert.' });
        patch.updated_at = new Date().toISOString();
        const { data, error } = await supabase.from('clients').update(patch).eq('id', c.id).select().maybeSingle();
        if (error) {
            if (/trial_ends_at|converted_at|trial_started_at/.test(error.message || '')) return res.status(503).json({ error: 'Trials need the phase-56 database update. Run sql/schema-phase56.sql in the Supabase SQL editor.', code: 'migration_required' });
            throw error;
        }
        logger.info('client_trial', { clientId: c.id, action, by: ctx.user.id, endsAt: data.trial_ends_at || null });
        res.json({ client: { ...data, access: c.access } });
    } catch (err) { sendErr(res, err); }
});

/**
 * Where each client stands, for the Clients hub (phase 56): its owner logins
 * and whether they ever signed in, its trial, how fresh Edge Meta AI's copy of
 * its Meta numbers is — and from those, one stage and the one next step.
 */
async function clientStages(clients) {
    const ids = clients.map(c => c.id);
    const out = {};
    if (!ids.length) return out;
    const [{ data: mem }, { data: xc }, { data: assets }] = await Promise.all([
        supabase.from('client_members').select('client_id, user_id, created_at').in('client_id', ids),
        supabase.from('xp_clients').select('id, last_synced_at, is_active').in('id', ids),
        supabase.from('xp_meta_assets').select('client_id, platform, last_full_backfill_at, last_synced_at, status').in('client_id', ids)
    ]);
    const userIds = [...new Set((mem || []).map(m => m.user_id))];
    const { data: users } = userIds.length
        ? await supabase.from('app_users').select('id, email, full_name, role, is_active, last_seen_at').in('id', userIds).eq('role', 'client')
        : { data: [] };
    const byUser = new Map((users || []).map(u => [u.id, u]));
    const running = new Set(typeof S.xp?.runningIds === 'function' ? S.xp.runningIds() : []);
    const now = Date.now();
    for (const c of clients) {
        const owners = (mem || []).filter(m => m.client_id === c.id && byUser.has(m.user_id)).map(m => {
            const u = byUser.get(m.user_id);
            return { id: u.id, email: u.email, name: u.full_name || null, invitedAt: m.created_at || null, lastSeenAt: u.last_seen_at || null, active: u.is_active !== false };
        });
        const x = (xc || []).find(r => r.id === c.id) || null;
        const as = (assets || []).filter(a => a.client_id === c.id);
        const xp = {
            assets: as.length,
            lastReadAt: x ? x.last_synced_at || null : null,
            historyRead: as.length ? as.every(a => a.last_full_backfill_at) : false,
            needsReconnect: as.length ? as.every(a => a.status === 'EXPIRED') : false,
            reading: running.has(c.id)
        };
        const trial = c.trial_ends_at ? { startedAt: c.trial_started_at || null, endsAt: c.trial_ends_at, ended: Date.parse(c.trial_ends_at) <= now,
            daysLeft: Math.max(0, Math.ceil((Date.parse(c.trial_ends_at) - now) / 86400000)) } : null;
        const signedIn = owners.some(o => o.lastSeenAt);
        const metaOn = !!(c.meta && c.meta.connected);
        const stage = c.archived ? 'archived' : trial ? 'trial' : (!owners.length ? 'onboarding' : !signedIn ? 'invited' : metaOn ? 'active' : 'onboarding');
        let next = null;
        if (c.archived) next = null;
        else if (trial && trial.ended) next = { key: 'extend', label: 'Extend trial' };
        else if (!owners.length) next = { key: 'invite', label: 'Invite owner' };
        else if (!signedIn) next = { key: 'resend', label: 'New sign-in link' };
        else if (!metaOn) next = { key: 'connect', label: 'Connect Meta' };
        else if (xp.needsReconnect) next = { key: 'connect', label: 'Reconnect Meta' };
        else if (xp.assets && !xp.historyRead && !xp.reading) next = { key: 'history', label: 'Read full history' };
        out[c.id] = { stage, next, owners, trial, xp };
    }
    return out;
}

/**
 * What archiving a client stops, and unarchiving starts again (phase 53).
 * Before, an archived client kept its scheduled reports running and spending,
 * and Edge Meta AI kept reading its Meta twice a day. Schedules paused here are
 * marked, so unarchiving resumes only those — never one the team paused itself.
 */
async function clientArchived(clientId, archived) {
    const now = new Date().toISOString();
    if (archived) {
        const { error } = await supabase.from('schedules').update({ paused: true, last_status: 'archived', updated_at: now })
            .eq('client_id', clientId).eq('paused', false);
        if (error) logger.warn('archive_schedules_failed', { clientId, message: error.message });
    } else {
        const { error } = await supabase.from('schedules').update({ paused: false, last_status: null, updated_at: now })
            .eq('client_id', clientId).eq('paused', true).eq('last_status', 'archived');
        if (error) logger.warn('unarchive_schedules_failed', { clientId, message: error.message });
    }
    const { error: xe } = await supabase.from('xp_clients').update({ is_active: !archived }).eq('id', clientId);
    if (xe && !S.missingTable(xe)) logger.warn('archive_xp_failed', { clientId, message: xe.message });
    logger.info(archived ? 'client_archived' : 'client_unarchived', { clientId });
}

app.delete('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        if (!c) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        // Reports are kept (client_id set null by the FK). Only the workspace goes.
        const { error } = await supabase.from('clients').delete().eq('id', c.id);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/clients/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const { data: members } = await supabase.from('client_members').select('user_id, role, created_at').eq('client_id', c.id);
        const ids = [c.owner_user_id, ...(members || []).map(m => m.user_id)];
        const { data: users } = await supabase.from('app_users').select('id, email, full_name, role').in('id', ids);
        const user = id => (users || []).find(u => u.id === id) || {};
        const email = id => user(id).email || id;
        const { data: conns } = await supabase.from('meta_connections')
            .select('id, page_id, page_name, ig_user_id, ig_username, status, last_sync_at, last_error, token_expires_at, scopes')
            .eq('client_id', c.id);
        res.json({
            client: c,
            owner: { id: c.owner_user_id, email: email(c.owner_user_id) },
            // accountRole 'client' is the business owner's portal login (phase 32);
            // everyone else is the agency's team.
            members: (members || []).map(m => ({ ...m, email: email(m.user_id), name: user(m.user_id).full_name || null, accountRole: user(m.user_id).role || null })),
            metaConnections: conns || []
        });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/clients/:id/timeline', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const { data: reports } = await supabase.from('reports')
            .select('id, user_id, platform, report_type, target_handle, competitor_handles, fb_group_names, fb_page_names, audit_mode, grade, score, engagement_rate, posts_analyzed, snapshot_date, created_at, ai_summary, credits_estimate, source_report_ids, visible_to_client')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(300);
        const { data: jobs } = await supabase.from('jobs')
            .select('id, type, engine, status, progress, credits_estimate, created_at, finished_at, error, result_report_id')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(50);
        const { data: sugg } = await supabase.from('fb_suggestions')
            .select('id, group_name, format, predicted_band, posted_at, verified_band, created_at')
            .eq('client_id', c.id).order('created_at', { ascending: false }).limit(50);
        res.json({ client: c, reports: reports || [], jobs: jobs || [], suggestions: sugg || [] });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/clients/:id/members', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        if (!c) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        const email = String(req.body.email || '').trim().toLowerCase();
        const role = req.body.role === 'viewer' ? 'viewer' : 'editor';
        if (!email) return res.status(400).json({ error: 'Email is required.' });
        const { data: u } = await supabase.from('app_users').select('id, email, role').eq('email', email).maybeSingle();
        if (!u) return res.status(404).json({ error: 'No EdgeLead account with that email. They need to sign up first.' });
        if (u.id === c.owner_user_id) return res.status(400).json({ error: 'That is the owner.' });
        const { error } = await supabase.from('client_members')
            .upsert([{ client_id: c.id, user_id: u.id, role, added_by: ctx.user.id }], { onConflict: 'client_id,user_id' });
        if (error) throw error;

        const absorbed = role === 'editor' ? await absorbEmptyOwnRecord(u.id, c.id) : null;
        if (role === 'editor' && u.role === 'client') await markAgencyOwner(u.id);
        res.json({ success: true, member: { user_id: u.id, email: u.email, role }, absorbed });
    } catch (err) { sendErr(res, err); }
});

/**
 * An owner login the agency has put on one of its businesses (phase 52): it
 * never expires, and it never gets a business made up for it. Before the
 * phase-52 SQL the column is missing; the login then keeps its trial dates,
 * which is what happened before, so that is only logged.
 */
async function markAgencyOwner(userId) {
    const { error } = await supabase.from('app_users').update({ agency_owner: true }).eq('id', userId).eq('role', 'client');
    if (error) logger.warn('agency_owner_mark_failed', { userId, message: error.message });
    invalidateAuth(userId);
}

/**
 * A client-role account already owns a business record of its own, made at
 * signup. If an agency now files them under the agency's record and their own
 * is still empty, keeping both means one business in two places. The empty
 * one is archived — never deleted — so their runs land where the agency is
 * already working. Returns the archived record's id, or null.
 */
async function absorbEmptyOwnRecord(userId, intoClientId) {
    if (await userRole(userId) !== 'client') return null;
    let absorbed = null;
    const { data: own } = await supabase.from('clients').select('id, name')
        .eq('owner_user_id', userId).eq('archived', false);
    for (const o of (own || [])) {
        if (o.id === intoClientId) continue;
        const [{ count: r }, { count: j }, { count: m }] = await Promise.all([
            supabase.from('reports').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
            supabase.from('jobs').select('id', { count: 'exact', head: true }).eq('client_id', o.id),
            supabase.from('meta_connections').select('id', { count: 'exact', head: true }).eq('client_id', o.id)
        ]);
        if (!(r || 0) && !(j || 0) && !(m || 0)) {
            await supabase.from('clients').update({ archived: true }).eq('id', o.id);
            absorbed = o.id;
            logger.info('client_own_record_absorbed', { userId, into: intoClientId, archived: o.id });
        }
    }
    return absorbed;
}

app.delete('/api/clients/:id/members/:userId', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'owner');
        const self = req.params.userId === ctx.user.id;
        if (!c && !self) return res.status(404).json({ error: 'Client not found, or you are not its owner.' });
        const { error } = await supabase.from('client_members').delete()
            .eq('client_id', req.params.id).eq('user_id', req.params.userId);
        if (error) throw error;
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});
