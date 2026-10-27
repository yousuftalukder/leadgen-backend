/**
 * The client's workbook (phase 69): the content plan, the ad ledger, products
 * and stock, and message templates — what the team types in by hand.
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    UUID_RE, app, auth, clientAccess, crypto, express, logger, missingTable, oneLine, sendErr, sniffImage,
    staffOnly, supabase
} = S;
Object.assign(S, { wbClean, wbIdeas });

// ===========================================================================
// PHASE 69 :: THE CLIENT'S WORKBOOK
//
// The tools read what is public and what Meta hands over. A good deal of the
// work is neither: the plan the team writes for next week, the ads they ran
// and what each cost, how many of each product are left, the replies they
// paste to customers. That lived in Google Sheets and in a one-page ledger
// saved on someone's laptop. It lives under the client now, for everyone on it.
//
// Every row here is typed by a person. The content plan the tool builds from
// scraped posts is shown beside the typed plan as ideas (GET …/workbook-ideas)
// and never written into it: copying an idea across is a person's choice, and
// the row is theirs from then on.
//
// Anyone who can open the client reads its workbook; editors change it. Owner
// logins have no route here (staffOnly), as with the task board.
// ===========================================================================
const WB_ROW_CAP = 5000;            // rows of one kind per client
const WB_IMPORT_MAX = 500;          // rows in one paste
const WB_MONEY_MAX = 1e12;
const WB_INT_MAX = 2147483647;      // an integer column
const WB_BIG_MAX = 1e12;            // a bigint column, kept well inside a double
const WB_MEDIA_BUCKET = process.env.WB_MEDIA_BUCKET || 'client-library';
const WB_MEDIA_MAX_BYTES = 5 * 1024 * 1024;
const WB_MEDIA_TTL_SECS = 3600;
const WB_MEDIA_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const WB_ORPHAN_HOURS = 24;         // a picture uploaded and never saved on a template goes after a day

const f = {
    line: max => ({ t: 'line', max }),
    text: max => ({ t: 'text', max }),
    int: (max = WB_INT_MAX) => ({ t: 'int', max }),
    money: () => ({ t: 'money' }),
    date: () => ({ t: 'date' }),
    url: () => ({ t: 'url' }),
    oneOf: list => ({ t: 'enum', list }),
    id: ref => ({ t: 'id', ref }),
    ids: (max, ref) => ({ t: 'ids', max, ref })
};

/**
 * What each kind of row holds. The keys are the columns; the page sends and
 * receives them as they are. `need` is a set of which at least one must be
 * filled, so an empty row is never saved.
 */
const WB_KINDS = {
    content: {
        table: 'client_content_entries', label: 'post',
        order: [['planned_on', { ascending: true, nullsFirst: false }], ['created_at', { ascending: true }]],
        fields: {
            planned_on: { ...f.date(), label: 'Date' },
            platform: { ...f.line(60), label: 'Platform' },
            post_type: { ...f.line(60), label: 'Type of post' },
            idea: { ...f.text(4000), label: 'Description' },
            caption: { ...f.text(4000), label: 'Caption' },
            status: { ...f.oneOf(['planned', 'made', 'posted', 'skipped']), label: 'Status', dflt: 'planned' },
            posted_url: { ...f.url(), label: 'Post link' },
            notes: { ...f.text(2000), label: 'Notes' }
        },
        need: [['planned_on', 'idea', 'caption'], 'Give the post a date or a description.']
    },
    products: {
        table: 'client_products', label: 'product',
        order: [['created_at', { ascending: true }]],
        fields: {
            name: { ...f.line(200), label: 'Product name', req: true },
            category: { ...f.line(80), label: 'Category' },
            sku: { ...f.line(60), label: 'Code' },
            stock: { ...f.int(), label: 'Quantity in hand' },
            in_order: { ...f.int(), label: 'In order' },
            cost: { ...f.money(), label: 'Buying price' },
            price: { ...f.money(), label: 'Customer price' },
            combo_price: { ...f.money(), label: 'Combo price' },
            notes: { ...f.text(2000), label: 'Notes' }
        }
    },
    creatives: {
        table: 'client_ad_creatives', label: 'creative',
        order: [['created_at', { ascending: false }]],
        fields: {
            title: { ...f.line(200), label: 'Creative name', req: true },
            format: { ...f.line(40), label: 'Format' },
            angle: { ...f.line(60), label: 'Angle' },
            posted_on: { ...f.date(), label: 'Date posted' },
            influencer: { ...f.line(120), label: 'Influencer' },
            language: { ...f.line(20), label: 'Language' },
            product_ids: { ...f.ids(30, 'products'), label: 'Products shown' },
            hook: { ...f.text(1000), label: 'Hook' },
            link: { ...f.url(), label: 'Post link' },
            notes: { ...f.text(2000), label: 'Notes' }
        }
    },
    ads: {
        table: 'client_ad_runs', label: 'ad',
        order: [['created_at', { ascending: false }]],
        fields: {
            creative_id: { ...f.id('creatives'), label: 'Creative' },
            status: { ...f.oneOf(['planned', 'running', 'done']), label: 'Status', dflt: 'done' },
            campaign: { ...f.line(200), label: 'Campaign' },
            run_via: { ...f.line(40), label: 'Run via' },
            objective: { ...f.line(40), label: 'Objective' },
            start_on: { ...f.date(), label: 'Start date' },
            end_on: { ...f.date(), label: 'End date' },
            audience: { ...f.line(500), label: 'Audience' },
            budget: { ...f.money(), label: 'Budget' },
            spend: { ...f.money(), label: 'Amount spent' },
            reach: { ...f.int(WB_BIG_MAX), label: 'Reach' },
            impressions: { ...f.int(WB_BIG_MAX), label: 'Impressions' },
            clicks: { ...f.int(WB_BIG_MAX), label: 'Link clicks' },
            messages: { ...f.int(WB_BIG_MAX), label: 'Messages' },
            orders: { ...f.int(WB_BIG_MAX), label: 'Orders' },
            revenue: { ...f.money(), label: 'Sales value' },
            verdict: { ...f.oneOf(['Winner', 'OK', 'Loser', 'Too early']), label: 'Verdict' },
            learned: { ...f.text(2000), label: 'What we learned' }
        },
        need: [['creative_id', 'campaign'], 'Pick the creative, or name the campaign.']
    },
    templates: {
        table: 'client_message_templates', label: 'template',
        order: [['created_at', { ascending: true }]],
        fields: {
            title: { ...f.line(120), label: 'Title', req: true },
            category: { ...f.line(60), label: 'Group' },
            body: { ...f.text(4000), label: 'Message' },
            media_ids: { ...f.ids(6, 'media'), label: 'Pictures' }
        },
        need: [['body', 'media_ids'], 'Write the message, or add a picture.'],
        cap: 500
    }
};
S.WB_KINDS = WB_KINDS;
// What a reference points at: products and creatives of the same client, its template pictures.
const WB_REF_TABLE = { products: 'client_products', creatives: 'client_ad_creatives', media: 'client_template_media' };

function wbFail(message, statusCode = 400) { const e = new Error(message); e.statusCode = statusCode; return e; }

/** A number as a person types it: "1,490", " 392 ", "৳1250". Null when there is none. */
function wbNumber(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
    const s = String(v).replace(/[৳$,\s]/g, '').replace(/^tk\.?/i, '');
    if (!s) return null;
    return /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : NaN;
}

function wbValue(spec, v) {
    const blank = v === null || v === undefined || (typeof v === 'string' && !v.trim());
    if (spec.t === 'ids') {
        if (blank) return [];
        if (!Array.isArray(v)) throw wbFail(`${spec.label}: send a list.`);
        const ids = [...new Set(v.map(x => String(x).toLowerCase()))];
        if (ids.some(x => !UUID_RE.test(x))) throw wbFail(`${spec.label}: one of them is not a valid id.`);
        if (ids.length > spec.max) throw wbFail(`${spec.label}: ${spec.max} at most.`);
        return ids;
    }
    if (blank) return null;
    switch (spec.t) {
        case 'line': {
            const s = oneLine(v, spec.max + 1);
            if (s.length > spec.max) throw wbFail(`${spec.label}: ${spec.max} characters at most.`);
            return s || null;
        }
        case 'text': {
            const s = String(v).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
            if (s.length > spec.max) throw wbFail(`${spec.label}: ${spec.max} characters at most.`);
            return s || null;
        }
        case 'int': {
            const n = wbNumber(v);
            if (!Number.isInteger(n) || n < 0 || n > spec.max) throw wbFail(`${spec.label}: a whole number, 0 or more.`);
            return n;
        }
        case 'money': {
            const n = wbNumber(v);
            if (!Number.isFinite(n) || n < 0 || n > WB_MONEY_MAX) throw wbFail(`${spec.label}: an amount, 0 or more.`);
            return Math.round(n * 100) / 100;
        }
        case 'date': {
            const s = String(v).trim();
            const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
            const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
            if (!d || d.toISOString().slice(0, 10) !== s || +m[1] < 2000 || +m[1] > 2100) throw wbFail(`${spec.label}: a date like 2026-10-27.`);
            return s;
        }
        case 'url': {
            const s = String(v).trim();
            let u = null;
            try { u = new URL(s); } catch { u = null; }
            if (!u || !/^https?:$/.test(u.protocol) || s.length > 500) throw wbFail(`${spec.label}: a link starting with https://`);
            return s;
        }
        case 'enum':
            if (!spec.list.includes(v)) throw wbFail(`${spec.label}: one of ${spec.list.join(', ')}.`);
            return v;
        case 'id': {
            const s = String(v).toLowerCase();
            if (!UUID_RE.test(s)) throw wbFail(`${spec.label}: not a valid id.`);
            return s;
        }
        default: throw wbFail('Unknown field.');
    }
}

/**
 * Validate one row from the page. A new row gets every field (blank ones as
 * null); an edit gets only the fields sent. Unknown keys are ignored, so a page
 * cannot write client_id, created_by or the dates.
 */
function wbClean(kind, body = {}, { create = false } = {}) {
    const k = WB_KINDS[kind];
    if (!k) throw wbFail('Unknown kind.', 404);
    const out = {};
    for (const [col, spec] of Object.entries(k.fields)) {
        if (!create && body[col] === undefined) continue;
        let v = wbValue(spec, body[col]);
        if (v === null && spec.dflt !== undefined && create) v = spec.dflt;
        if (v === null && spec.dflt !== undefined && !create) throw wbFail(`${spec.label}: choose one.`);
        if (spec.req && (v === null || v === '')) throw wbFail(`${spec.label} is needed.`);
        out[col] = v;
    }
    if (k.need && create) {
        const filled = k.need[0].some(c => Array.isArray(out[c]) ? out[c].length : out[c] !== null && out[c] !== undefined);
        if (!filled) throw wbFail(k.need[1]);
    }
    if (out.start_on && out.end_on && out.end_on < out.start_on) throw wbFail('The end date is before the start date.');
    return out;
}

/** Every product, creative or picture a set of rows points at must be this client's. */
async function wbCheckRefs(kind, clientId, rows) {
    for (const [col, spec] of Object.entries(WB_KINDS[kind].fields)) {
        if (!spec.ref) continue;
        const ids = [...new Set(rows.flatMap(r => (r[col] === undefined || r[col] === null) ? [] : [].concat(r[col])))];
        if (!ids.length) continue;
        const { data, error } = await supabase.from(WB_REF_TABLE[spec.ref]).select('id').eq('client_id', clientId).in('id', ids);
        if (error) throw error;
        const have = new Set((data || []).map(r => r.id));
        if (ids.some(id => !have.has(id))) throw wbFail(`${spec.label}: one of them is not on this client any more. Reload the page.`);
    }
}

function wbMigration(res) {
    return res.status(503).json({
        error: 'The content plan, ad ledger and templates need the phase-69 database update. Run sql/schema-phase69.sql in the Supabase SQL editor.',
        code: 'migration_required'
    });
}

/** The client, for a staff login with the access asked for; otherwise the response is sent and null comes back. */
async function wbClient(req, res, need) {
    const ctx = await auth(req, res); if (!ctx) return null;
    if (!staffOnly(ctx, res)) return null;
    const c = await clientAccess(ctx.user.id, req.params.id, need);
    if (!c) { res.status(404).json({ error: need === 'editor' ? 'Client not found, or you cannot edit it.' : 'Client not found.' }); return null; }
    return { ctx, c };
}
function wbKind(req, res) {
    const k = WB_KINDS[req.params.kind];
    if (!k) { res.status(404).json({ error: 'No such part of the workbook.' }); return null; }
    return k;
}

// ---- template pictures --------------------------------------------------------
let _wbBucket = null;
async function ensureWbBucket() {
    if (!supabase.storage) return false;
    if (!_wbBucket) {
        _wbBucket = (async () => {
            try {
                const { data } = await supabase.storage.getBucket(WB_MEDIA_BUCKET);
                if (data) return true;
                const { error } = await supabase.storage.createBucket(WB_MEDIA_BUCKET, {
                    public: false, fileSizeLimit: WB_MEDIA_MAX_BYTES, allowedMimeTypes: Object.keys(WB_MEDIA_TYPES)
                });
                if (error && !/exist/i.test(error.message || '')) throw error;
                return true;
            } catch (err) {
                logger.warn('wb_bucket_unavailable', { message: err.message });
                _wbBucket = null;
                return false;
            }
        })();
    }
    return _wbBucket;
}

/** Signed links for these pictures, this client's only. { id: url } */
async function wbMediaUrls(clientId, ids) {
    ids = [...new Set(ids)].filter(Boolean);
    if (!ids.length || !supabase.storage) return {};
    const { data, error } = await supabase.from('client_template_media').select('id, path').eq('client_id', clientId).in('id', ids);
    if (error || !(data || []).length) return {};
    const { data: signed, error: se } = await supabase.storage.from(WB_MEDIA_BUCKET).createSignedUrls(data.map(r => r.path), WB_MEDIA_TTL_SECS);
    if (se || !signed) return {};
    const byPath = Object.fromEntries(signed.filter(x => x && x.signedUrl).map(x => [x.path, x.signedUrl]));
    return Object.fromEntries(data.filter(r => byPath[r.path]).map(r => [r.id, byPath[r.path]]));
}

/** Remove pictures, files and rows. Never throws: a stray file is not worth failing a save over. */
async function wbRemoveMedia(clientId, ids) {
    if (!ids.length) return;
    try {
        const { data } = await supabase.from('client_template_media').select('id, path').eq('client_id', clientId).in('id', ids);
        if (!(data || []).length) return;
        if (supabase.storage) {
            const { error: re } = await supabase.storage.from(WB_MEDIA_BUCKET).remove(data.map(r => r.path));
            if (re) logger.warn('wb_media_remove_failed', { message: re.message });
        }
        await supabase.from('client_template_media').delete().eq('client_id', clientId).in('id', data.map(r => r.id));
    } catch (err) { logger.warn('wb_media_remove_failed', { message: err.message }); }
}

/** Of these pictures, the ones no template of the client holds any more. */
async function wbUnheld(clientId, ids) {
    if (!ids.length) return [];
    const { data, error } = await supabase.from('client_message_templates').select('media_ids').eq('client_id', clientId).overlaps('media_ids', ids);
    if (error) return [];                         // unsure: keep the files
    const held = new Set((data || []).flatMap(t => t.media_ids || []));
    return ids.filter(id => !held.has(id));
}

/** Pictures uploaded over a day ago that no template holds: the editor was closed without saving. */
async function wbSweepOrphans(clientId) {
    const before = new Date(Date.now() - WB_ORPHAN_HOURS * 3600000).toISOString();
    const { data: old } = await supabase.from('client_template_media').select('id').eq('client_id', clientId).lt('created_at', before).limit(200);
    if (!(old || []).length) return;
    const { data: held } = await supabase.from('client_message_templates').select('media_ids').eq('client_id', clientId);
    const used = new Set((held || []).flatMap(t => t.media_ids || []));
    await wbRemoveMedia(clientId, old.map(r => r.id).filter(id => !used.has(id)));
}

async function wbTemplateViews(clientId, rows) {
    const urls = await wbMediaUrls(clientId, rows.flatMap(t => t.media_ids || []));
    return rows.map(t => ({ ...t, media: (t.media_ids || []).filter(id => urls[id]).map(id => ({ id, url: urls[id] })) }));
}

// ---- the routes ----------------------------------------------------------------

/** One or more parts of a client's workbook: ?parts=content,products,creatives,ads,templates */
app.get('/api/clients/:id/workbook', async (req, res) => {
    try {
        const got = await wbClient(req, res, 'viewer'); if (!got) return;
        const { c } = got;
        const parts = [...new Set(String(req.query.parts || '').split(',').map(s => s.trim()).filter(Boolean))];
        if (!parts.length || parts.some(p => !WB_KINDS[p])) return res.status(400).json({ error: `Ask for parts: ${Object.keys(WB_KINDS).join(', ')}.` });
        const out = { canEdit: ['owner', 'admin', 'editor'].includes(c.access) };
        for (const p of parts) {
            const k = WB_KINDS[p];
            let q = supabase.from(k.table).select('*').eq('client_id', c.id);
            for (const [col, opt] of k.order) q = q.order(col, opt);
            const { data, error } = await q.limit(k.cap || WB_ROW_CAP);
            if (error) { if (missingTable(error)) return wbMigration(res); throw error; }
            out[p] = p === 'templates' ? await wbTemplateViews(c.id, data || []) : (data || []);
        }
        res.json(out);
    } catch (err) { sendErr(res, err); }
});

/** Add one row ({...}) or a pasted sheet ({ rows: [...] }). */
app.post('/api/clients/:id/workbook/:kind', async (req, res) => {
    try {
        const k = wbKind(req, res); if (!k) return;
        const got = await wbClient(req, res, 'editor'); if (!got) return;
        const { ctx, c } = got;
        const many = Array.isArray(req.body?.rows);
        const input = many ? req.body.rows : [req.body || {}];
        if (!input.length) return res.status(400).json({ error: 'There are no rows to add.' });
        if (input.length > WB_IMPORT_MAX) return res.status(400).json({ error: `${WB_IMPORT_MAX} rows at a time at most. Paste the rest after.` });

        const rows = [], problems = [];
        input.forEach((r, i) => {
            try { rows.push(wbClean(req.params.kind, r && typeof r === 'object' ? r : {}, { create: true })); }
            catch (e) { if (e.statusCode !== 400) throw e; problems.push(many ? `Row ${i + 1}: ${e.message}` : e.message); }
        });
        if (problems.length) return res.status(400).json({ error: problems[0], problems: problems.slice(0, 20) });
        await wbCheckRefs(req.params.kind, c.id, rows);

        const { count, error: ce } = await supabase.from(k.table).select('id', { count: 'exact', head: true }).eq('client_id', c.id);
        if (ce) { if (missingTable(ce)) return wbMigration(res); throw ce; }
        const cap = k.cap || WB_ROW_CAP;
        if ((count || 0) + rows.length > cap) return res.status(400).json({ error: `A client holds ${cap} ${k.label}s at most. Delete old ones first.` });

        const now = new Date().toISOString();
        const { data, error } = await supabase.from(k.table)
            .insert(rows.map(r => ({ ...r, client_id: c.id, created_by: ctx.user.id, created_at: now, updated_at: now }))).select();
        if (error) { if (missingTable(error)) return wbMigration(res); throw error; }
        const saved = req.params.kind === 'templates' ? await wbTemplateViews(c.id, data || []) : (data || []);
        res.status(201).json(many ? { added: saved.length, rows: saved } : { row: saved[0] || null });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/clients/:id/workbook/:kind/:rowId', async (req, res) => {
    try {
        const k = wbKind(req, res); if (!k) return;
        const got = await wbClient(req, res, 'editor'); if (!got) return;
        const { c } = got;
        if (!UUID_RE.test(String(req.params.rowId))) return res.status(404).json({ error: `That ${k.label} is not on this client.` });
        const patch = wbClean(req.params.kind, req.body || {});
        const { data: cur, error: re } = await supabase.from(k.table).select('*').eq('id', req.params.rowId).eq('client_id', c.id).maybeSingle();
        if (re) { if (missingTable(re)) return wbMigration(res); throw re; }
        if (!cur) return res.status(404).json({ error: `That ${k.label} is not on this client.` });
        // The row as it would stand: an edit cannot empty what a new row must have.
        const after = { ...cur, ...patch };
        if (k.need && !k.need[0].some(col => Array.isArray(after[col]) ? after[col].length : after[col] !== null && after[col] !== undefined)) return res.status(400).json({ error: k.need[1] });
        if (after.start_on && after.end_on && after.end_on < after.start_on) return res.status(400).json({ error: 'The end date is before the start date.' });
        await wbCheckRefs(req.params.kind, c.id, [patch]);
        const { data, error } = await supabase.from(k.table).update({ ...patch, updated_at: new Date().toISOString() })
            .eq('id', cur.id).eq('client_id', c.id).select().maybeSingle();
        if (error) throw error;
        if (!data) return res.status(404).json({ error: `That ${k.label} is not on this client any more.` });
        if (req.params.kind === 'templates') {
            const gone = (cur.media_ids || []).filter(id => !(data.media_ids || []).includes(id));
            await wbRemoveMedia(c.id, await wbUnheld(c.id, gone));
            return res.json({ row: (await wbTemplateViews(c.id, [data]))[0] });
        }
        res.json({ row: data });
    } catch (err) { sendErr(res, err); }
});

app.delete('/api/clients/:id/workbook/:kind/:rowId', async (req, res) => {
    try {
        const k = wbKind(req, res); if (!k) return;
        const got = await wbClient(req, res, 'editor'); if (!got) return;
        const { c } = got;
        if (!UUID_RE.test(String(req.params.rowId))) return res.status(404).json({ error: `That ${k.label} is not on this client.` });
        const { data, error } = await supabase.from(k.table).delete().eq('id', req.params.rowId).eq('client_id', c.id).select().maybeSingle();
        if (error) { if (missingTable(error)) return wbMigration(res); throw error; }
        if (!data) return res.status(404).json({ error: `That ${k.label} is not on this client.` });
        if (req.params.kind === 'templates') await wbRemoveMedia(c.id, await wbUnheld(c.id, data.media_ids || []));
        // A deleted product leaves the creatives that showed it.
        if (req.params.kind === 'products') {
            const { data: held } = await supabase.from('client_ad_creatives').select('id, product_ids').eq('client_id', c.id).contains('product_ids', [data.id]);
            for (const cr of (held || [])) {
                await supabase.from('client_ad_creatives').update({ product_ids: (cr.product_ids || []).filter(x => x !== data.id) }).eq('id', cr.id);
            }
        }
        res.json({ success: true });
    } catch (err) { sendErr(res, err); }
});

/** Upload one picture for a message template. The body is the image itself, not JSON. */
app.post('/api/clients/:id/template-media',
    express.raw({ type: Object.keys(WB_MEDIA_TYPES), limit: WB_MEDIA_MAX_BYTES }),
    async (req, res) => {
        try {
            const got = await wbClient(req, res, 'editor'); if (!got) return;
            const { ctx, c } = got;
            const buf = Buffer.isBuffer(req.body) ? req.body : null;
            if (!buf || !buf.length) return res.status(400).json({ error: 'Send a picture: PNG, JPEG, WebP or GIF.' });
            const type = sniffImage(buf);
            if (!type) return res.status(400).json({ error: 'That is not a PNG, JPEG, WebP or GIF picture.' });
            if (!(await ensureWbBucket())) return res.status(503).json({ error: 'Picture storage is not available right now. Try again in a minute.' });
            const id = crypto.randomUUID();
            const path = `${c.id}/${id}.${WB_MEDIA_TYPES[type]}`;
            const { error: ue } = await supabase.storage.from(WB_MEDIA_BUCKET).upload(path, buf, { contentType: type, upsert: false, cacheControl: '3600' });
            if (ue) throw ue;
            const { error } = await supabase.from('client_template_media').insert([{ id, client_id: c.id, path, content_type: type, bytes: buf.length, uploaded_by: ctx.user.id, created_at: new Date().toISOString() }]);
            if (error) {
                await supabase.storage.from(WB_MEDIA_BUCKET).remove([path]).catch(() => {});
                if (missingTable(error)) return wbMigration(res);
                throw error;
            }
            const urls = await wbMediaUrls(c.id, [id]);
            res.status(201).json({ id, url: urls[id] || null });
            setImmediate(() => wbSweepOrphans(c.id).catch(e => logger.warn('wb_sweep_failed', { message: e.message })));
        } catch (err) {
            if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'That picture is over 5 MB. Use a smaller one.' });
            sendErr(res, err);
        }
    });

// ---- ideas from the data ---------------------------------------------------------

/**
 * One content plan the tool built, as a list of ideas a person can borrow from:
 * each brief's format, hook, concept, caption and why, plus what to stop doing
 * and the caption rules. Pure, so it can be tested.
 */
function wbIdeas(report) {
    const b = (report && (report.briefs || report.ai_json)) || {};
    const spec = Array.isArray(report && report.format_spec) && report.format_spec.length ? report.format_spec
        : [{ key: 'Reel', plural: 'reels', label: 'Reels' }, { key: 'Carousel', plural: 'carousels', label: 'Carousels' }, { key: 'Still', plural: 'stills', label: 'Stills' }];
    const line = x => (typeof x === 'string' ? x : x && (x.line || x.text || x.say || '')) || '';
    const briefs = spec.flatMap(fm => (Array.isArray(b[fm.plural]) ? b[fm.plural] : []).map(x => ({
        format: fm.key || fm.label || '',
        hook: oneLine(x.hook, 300) || null,
        concept: x.concept ? String(x.concept).slice(0, 1200) : null,
        caption: x.caption ? String(x.caption).slice(0, 2000) : null,
        script: Array.isArray(x.script) ? x.script.map(line).map(s => oneLine(s, 300)).filter(Boolean).slice(0, 8) : [],
        why: x.why ? String(x.why).slice(0, 600) : null,
        slot: x.slot ? oneLine(x.slot, 60) : null
    })));
    return {
        id: report.id, createdAt: report.created_at, platform: report.platform || null, target: report.target_handle || null,
        summary: b.summary || report.ai_summary || null, briefs,
        stopDoing: (Array.isArray(b.stopDoing) ? b.stopDoing : []).map(x => oneLine(line(x), 300)).filter(Boolean).slice(0, 10),
        captionRules: (Array.isArray(b.captionRules) ? b.captionRules : []).map(x => oneLine(line(x), 300)).filter(Boolean).slice(0, 10)
    };
}

/** The content plans the tool built for this client, newest first, as ideas. Read only. */
app.get('/api/clients/:id/workbook-ideas', async (req, res) => {
    try {
        const got = await wbClient(req, res, 'viewer'); if (!got) return;
        const { c } = got;
        const { data, error } = await supabase.from('reports')
            .select('id, created_at, platform, target_handle, ai_summary, ai_json, briefs:report_json->briefs, format_spec:report_json->formatSpec')
            .eq('client_id', c.id).eq('report_type', 'content_plan').order('created_at', { ascending: false }).limit(3);
        if (error) throw error;
        res.json({ plans: (data || []).map(wbIdeas).filter(p => p.briefs.length || p.stopDoing.length || p.captionRules.length) });
    } catch (err) { sendErr(res, err); }
});
