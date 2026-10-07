/**
 * Packages, agreements and invoices (phase 60).
 *
 * Part of the EdgeLead server, split out of server.js (phase 55). The parts load in
 * order from server.js and share one namespace, S: what this part needs from an earlier
 * part is unpacked below; anything else from another part is read as S.name when it runs.
 */
'use strict';
const S = require('./shared');
const {
    app, auth, clientAccess, contactSettings, crypto, logger, missingTable, oneLine, ownClientFor, requireAdmin,
    sendErr, staffOnly, supabase
} = S;
Object.assign(S, { agreementMailLines, billingProfile, billingPackages });

// ===========================================================================
// PHASE 60 :: WHAT THE CLIENT PAYS FOR, AND THE INVOICES
//
// The agency keeps a catalog of packages (Team & settings → Packages & billing):
// a name, a price in BDT, monthly or one-off, and what it delivers. A client's
// agreement is picked from the catalog and can be changed for that client. The
// owner reads it in their app and signs it — a typed name and a ticked "I agree",
// kept with the time and address — before using the app. Changing a signed
// agreement raises its version, and the owner signs again.
//
// Invoices are made by hand, numbered across every client, shown to the owner,
// and marked paid by the agency when the money arrives (bKash, bank: the ways to
// pay are the payment options already set under Email & sign-ups).
// ===========================================================================
const CURRENCY = 'BDT';
const BILLING = ['monthly', 'one_off'];
const PACKAGES_MAX = 40, ITEMS_MAX = 20, DELIVERABLES_MAX = 30, INVOICE_ITEMS_MAX = 40;
const MONEY_MAX = 100000000;            // ৳10 crore: anything above is a typo
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAFF_EDIT = ['owner', 'admin', 'editor'];

function billingFail(message) { const e = new Error(message); e.statusCode = 400; return e; }
function migration60(res) {
    return res.status(503).json({
        error: 'Agreements and invoices need the phase-60 database update. Run sql/schema-phase60.sql in the Supabase SQL editor.',
        code: 'migration_required'
    });
}
const money = v => {
    const n = Math.round(Number(v) * 100) / 100;
    if (!Number.isFinite(n) || n < 0 || n > MONEY_MAX) throw billingFail('A price is a number of taka, 0 or more.');
    return n;
};
const day = (v, what) => {
    if (v === null || v === undefined || v === '') return null;
    const d = String(v);
    if (!ISO_DAY.test(d) || Number.isNaN(Date.parse(d + 'T00:00:00Z'))) throw billingFail(`${what} looks like 2026-10-01.`);
    return d;
};
const lines = (list, max) => (Array.isArray(list) ? list : String(list || '').split('\n'))
    .map(s => oneLine(s, 200)).filter(Boolean).slice(0, max);

/** A package or an agreement line, cleaned. */
function cleanItem(o, i) {
    if (!o || typeof o !== 'object') throw billingFail(`Line ${i + 1} is not a package.`);
    const name = oneLine(o.name, 120);
    if (!name) throw billingFail(`Line ${i + 1} needs a name.`);
    const billing = BILLING.includes(o.billing) ? o.billing : 'monthly';
    return {
        ...(o.id ? { id: oneLine(o.id, 40) } : {}),
        name, billing, price: money(o.price),
        description: oneLine(o.description, 500),
        deliverables: lines(o.deliverables, DELIVERABLES_MAX)
    };
}
const totals = items => ({
    monthly: items.filter(i => i.billing === 'monthly').reduce((a, i) => a + Number(i.price || 0), 0),
    oneOff: items.filter(i => i.billing === 'one_off').reduce((a, i) => a + Number(i.price || 0), 0)
});
const taka = n => '৳' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

// ---- settings: the catalog and the agency's details ---------------------------

async function readSetting(key, fallback) {
    const { data } = await supabase.from('system_settings').select('value').eq('key', key).maybeSingle();
    try { const v = data && data.value ? JSON.parse(data.value) : null; return v ?? fallback; } catch { return fallback; }
}
async function billingPackages() {
    const v = await readSetting('billing_packages', []);
    return Array.isArray(v) ? v : [];
}
async function billingProfile() {
    const v = await readSetting('billing_profile', {});
    const p = v && typeof v === 'object' ? v : {};
    return {
        name: String(p.name || ''), address: String(p.address || ''), phone: String(p.phone || ''),
        email: String(p.email || ''), terms: String(p.terms || ''), invoiceNote: String(p.invoiceNote || '')
    };
}

app.get('/api/admin/billing', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        res.json({ packages: await billingPackages(), profile: await billingProfile(), currency: CURRENCY });
    } catch (err) { sendErr(res, err); }
});

app.put('/api/admin/billing', async (req, res) => {
    try {
        const ctx = await requireAdmin(req, res); if (!ctx) return;
        const now = new Date().toISOString();
        const out = {};
        if (req.body?.packages !== undefined) {
            if (!Array.isArray(req.body.packages)) throw billingFail('Packages must be a list.');
            if (req.body.packages.length > PACKAGES_MAX) throw billingFail(`Up to ${PACKAGES_MAX} packages.`);
            const packages = req.body.packages.map((p, i) => {
                const c = cleanItem(p, i);
                return { ...c, id: c.id || crypto.randomBytes(6).toString('hex') };
            });
            await supabase.from('system_settings').upsert({ key: 'billing_packages', value: JSON.stringify(packages), updated_at: now }, { onConflict: 'key' });
            out.packages = packages;
        }
        if (req.body?.profile !== undefined) {
            const p = req.body.profile || {};
            const profile = {
                name: oneLine(p.name, 120), address: String(p.address || '').slice(0, 400).trim(),
                phone: oneLine(p.phone, 40), email: oneLine(p.email, 120),
                terms: String(p.terms || '').slice(0, 8000).trim(), invoiceNote: String(p.invoiceNote || '').slice(0, 1000).trim()
            };
            await supabase.from('system_settings').upsert({ key: 'billing_profile', value: JSON.stringify(profile), updated_at: now }, { onConflict: 'key' });
            out.profile = profile;
        }
        logger.info('billing_settings', { by: ctx.user.id, parts: Object.keys(out) });
        res.json({ success: true, packages: out.packages || await billingPackages(), profile: out.profile || await billingProfile() });
    } catch (err) { sendErr(res, err); }
});

// ---- agreements ----------------------------------------------------------------

const needsSignature = a => !!a && (a.items || []).length > 0 && a.signed_version !== a.version;
function agreementView(a) {
    if (!a) return null;
    const items = a.items || [];
    return {
        id: a.id, clientId: a.client_id, items, terms: a.terms || '', startDate: a.start_date || null,
        version: a.version, currency: CURRENCY, totals: totals(items),
        status: !items.length ? 'empty' : needsSignature(a) ? 'awaiting' : 'signed',
        signed: a.signed_at ? { name: a.signed_name, at: a.signed_at, version: a.signed_version } : null,
        updatedAt: a.updated_at
    };
}
async function loadAgreement(clientId) {
    const { data, error } = await supabase.from('client_agreements').select('*').eq('client_id', clientId).maybeSingle();
    if (error) { if (missingTable(error)) return Symbol.for('migration60'); throw error; }
    return data || null;
}
const MISSING = Symbol.for('migration60');

/** For the invite and sign-in emails: what the owner will be asked to sign. Empty when there is nothing to sign. */
async function agreementMailLines(clientId) {
    try {
        const a = await loadAgreement(clientId);
        if (a === MISSING || !needsSignature(a)) return [];
        const t = totals(a.items || []);
        return [
            'Your agreement with us:',
            ...(a.items || []).map(i => `  • ${i.name}: ${taka(i.price)} ${i.billing === 'monthly' ? 'a month' : 'once'}`),
            ...(t.monthly ? [`  Monthly total: ${taka(t.monthly)}`] : []),
            ...(t.oneOff ? [`  One-off total: ${taka(t.oneOff)}`] : []),
            'You will read the whole agreement, with what we deliver for each, and accept it when you open the app.',
            ''
        ];
    } catch { return []; }
}

app.get('/api/clients/:id/agreement', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'viewer');
        if (!c) return res.status(404).json({ error: 'Client not found.' });
        const a = await loadAgreement(c.id);
        if (a === MISSING) return migration60(res);
        res.json({
            client: { id: c.id, name: c.name }, canEdit: STAFF_EDIT.includes(c.access),
            agreement: agreementView(a), packages: await billingPackages(), profile: await billingProfile(), currency: CURRENCY
        });
    } catch (err) { sendErr(res, err); }
});

app.put('/api/clients/:id/agreement', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const b = req.body || {};
        if (!Array.isArray(b.items)) throw billingFail('Pick at least one package, or send an empty list.');
        if (b.items.length > ITEMS_MAX) throw billingFail(`Up to ${ITEMS_MAX} lines.`);
        const items = b.items.map(cleanItem).map(({ id, ...rest }) => (id ? { packageId: id, ...rest } : rest));
        const terms = String(b.terms ?? '').slice(0, 8000).trim() || null;
        const start = day(b.startDate, 'The start date');

        const cur = await loadAgreement(c.id);
        if (cur === MISSING) return migration60(res);
        const now = new Date().toISOString();
        const same = cur && JSON.stringify(cur.items || []) === JSON.stringify(items)
            && (cur.terms || null) === terms && (cur.start_date || null) === start;
        let row;
        if (!cur) {
            const { data, error } = await supabase.from('client_agreements').insert([{
                client_id: c.id, items, terms, start_date: start, version: 1, updated_by: ctx.user.id, created_at: now, updated_at: now
            }]).select().maybeSingle();
            if (error) { if (missingTable(error)) return migration60(res); throw error; }
            row = data;
        } else if (same) {
            row = cur;
        } else {
            // Any change is a new version: an owner who signed the old one signs again.
            const { data, error } = await supabase.from('client_agreements').update({
                items, terms, start_date: start, version: (cur.version || 1) + 1, updated_by: ctx.user.id, updated_at: now
            }).eq('id', cur.id).select().maybeSingle();
            if (error) throw error;
            row = data;
        }
        logger.info('agreement_saved', { clientId: c.id, by: ctx.user.id, version: row.version, changed: !same });
        res.json({ agreement: agreementView(row), changed: !same });
    } catch (err) { sendErr(res, err); }
});

// ---- invoices --------------------------------------------------------------------

const invoiceNo = n => (n ? 'INV-' + String(n).padStart(4, '0') : null);
function invoiceView(r, clientName) {
    const late = r.status === 'unpaid' && r.due_date && r.due_date < new Date().toISOString().slice(0, 10);
    return {
        id: r.id, clientId: r.client_id, client: clientName ? { id: r.client_id, name: clientName } : undefined,
        number: invoiceNo(r.invoice_number), issueDate: r.issue_date, dueDate: r.due_date || null,
        items: r.items || [], total: Number(r.total) || 0, currency: CURRENCY,
        status: r.status, overdue: !!late, paidAt: r.paid_at || null, paidNote: r.paid_note || '',
        notes: r.notes || '', createdAt: r.created_at, updatedAt: r.updated_at
    };
}
function cleanInvoiceItems(list) {
    if (!Array.isArray(list) || !list.length) throw billingFail('An invoice needs at least one line.');
    if (list.length > INVOICE_ITEMS_MAX) throw billingFail(`Up to ${INVOICE_ITEMS_MAX} lines.`);
    return list.map((o, i) => {
        const text = oneLine(o && o.text, 200);
        if (!text) throw billingFail(`Line ${i + 1} needs a description.`);
        const qty = Math.round(Number(o.qty ?? 1) * 100) / 100;
        if (!(qty > 0) || qty > 10000) throw billingFail(`Line ${i + 1}: the quantity is a number above 0.`);
        return { text, qty, price: money(o.price) };
    });
}
const invoiceTotal = items => Math.round(items.reduce((a, i) => a + i.qty * i.price, 0) * 100) / 100;

async function loadInvoice(id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return null;
    const { data, error } = await supabase.from('invoices').select('*').eq('id', id).maybeSingle();
    if (error) { if (missingTable(error)) return MISSING; throw error; }
    return data || null;
}

app.post('/api/clients/:id/invoices', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const c = await clientAccess(ctx.user.id, req.params.id, 'editor');
        if (!c) return res.status(404).json({ error: 'Client not found, or you cannot edit it.' });
        const b = req.body || {};
        const items = cleanInvoiceItems(b.items);
        const now = new Date().toISOString();
        const row = {
            client_id: c.id, items, total: invoiceTotal(items), status: 'unpaid',
            issue_date: day(b.issueDate, 'The issue date') || now.slice(0, 10),
            due_date: day(b.dueDate, 'The due date'),
            notes: String(b.notes || '').slice(0, 2000).trim() || null,
            created_by: ctx.user.id, created_at: now, updated_at: now
        };
        if (row.due_date && row.due_date < row.issue_date) throw billingFail('The due date is before the issue date.');
        const { data, error } = await supabase.from('invoices').insert([row]).select().maybeSingle();
        if (error) { if (missingTable(error)) return migration60(res); throw error; }
        logger.info('invoice_created', { clientId: c.id, by: ctx.user.id, invoiceId: data.id, total: data.total });
        res.status(201).json({ invoice: invoiceView(data, c.name) });
    } catch (err) { sendErr(res, err); }
});

app.patch('/api/invoices/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const r = await loadInvoice(req.params.id);
        if (r === MISSING) return migration60(res);
        const c = r ? await clientAccess(ctx.user.id, r.client_id, 'editor') : null;
        if (!r || !c) return res.status(404).json({ error: 'Invoice not found, or you cannot edit it.' });
        const b = req.body || {};
        const now = new Date().toISOString();
        const patch = { updated_at: now };
        const editing = ['items', 'issueDate', 'dueDate', 'notes'].some(k => b[k] !== undefined);
        // What the client was billed is fixed once paid: void it and make a new one instead.
        if (editing && r.status === 'paid') throw billingFail('A paid invoice cannot be changed. Mark it unpaid first, or void it and make a new one.');
        if (b.items !== undefined) { patch.items = cleanInvoiceItems(b.items); patch.total = invoiceTotal(patch.items); }
        if (b.issueDate !== undefined) patch.issue_date = day(b.issueDate, 'The issue date') || r.issue_date;
        if (b.dueDate !== undefined) patch.due_date = day(b.dueDate, 'The due date');
        if (b.notes !== undefined) patch.notes = String(b.notes || '').slice(0, 2000).trim() || null;
        if (b.status !== undefined) {
            if (!['unpaid', 'paid', 'void'].includes(b.status)) throw billingFail('The status is unpaid, paid or void.');
            patch.status = b.status;
            patch.paid_at = b.status === 'paid' ? (r.paid_at && r.status === 'paid' ? r.paid_at : now) : null;
            if (b.status !== 'paid') patch.paid_note = null;
        }
        if (b.paidNote !== undefined && (patch.status || r.status) === 'paid') patch.paid_note = oneLine(b.paidNote, 300) || null;
        const issue = patch.issue_date || r.issue_date, due = patch.due_date !== undefined ? patch.due_date : r.due_date;
        if (due && issue && due < issue) throw billingFail('The due date is before the issue date.');
        const { data, error } = await supabase.from('invoices').update(patch).eq('id', r.id).select().maybeSingle();
        if (error) throw error;
        logger.info('invoice_updated', { invoiceId: r.id, by: ctx.user.id, fields: Object.keys(patch) });
        res.json({ invoice: invoiceView(data, c.name) });
    } catch (err) { sendErr(res, err); }
});

/** One invoice, for the printable page: the agency's details and the ways to pay come with it. */
app.get('/api/invoices/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const r = await loadInvoice(req.params.id);
        if (r === MISSING) return migration60(res);
        const c = r ? await clientAccess(ctx.user.id, r.client_id, 'viewer') : null;
        if (!r || !c) return res.status(404).json({ error: 'Invoice not found.' });
        res.json({ invoice: invoiceView(r, c.name), canEdit: STAFF_EDIT.includes(c.access), ...(await printExtras()) });
    } catch (err) { sendErr(res, err); }
});
async function printExtras() {
    const contact = await contactSettings().catch(() => ({ paymentOptions: [] }));
    return { profile: await billingProfile(), paymentOptions: contact.paymentOptions || [] };
}

/**
 * Billing across every client the caller can open: each client's agreement in
 * one line, and the invoices. The Billing page in the menu is this.
 */
app.get('/api/billing', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        if (!staffOnly(ctx, res)) return;
        const clients = await S.openClientsFor(ctx);
        const ids = clients.map(c => c.id);
        let agreements = [], invoices = [];
        if (ids.length) {
            const [a, i] = await Promise.all([
                supabase.from('client_agreements').select('*').in('client_id', ids),
                supabase.from('invoices').select('*').in('client_id', ids).order('issue_date', { ascending: false }).limit(2000)
            ]);
            if (a.error || i.error) {
                const e = a.error || i.error;
                if (missingTable(e)) return migration60(res);
                throw e;
            }
            agreements = a.data || []; invoices = i.data || [];
        }
        const byClient = Object.fromEntries(agreements.map(a => [a.client_id, a]));
        const names = Object.fromEntries(clients.map(c => [c.id, c.name]));
        res.json({
            currency: CURRENCY,
            clients: clients.map(c => ({
                id: c.id, name: c.name, canEdit: STAFF_EDIT.includes(c.access),
                agreement: agreementView(byClient[c.id] || null)
            })).sort((x, y) => String(x.name).localeCompare(String(y.name))),
            invoices: invoices.map(r => invoiceView(r, names[r.client_id]))
        });
    } catch (err) { sendErr(res, err); }
});

// ---- the owner's side (its own endpoints, its own columns) -----------------------

async function ownerBilling(ctx, res, list = false) {
    if (ctx.profile?.role !== 'client') { res.status(400).json({ error: 'This is the owner’s billing. Staff use Billing in the menu.' }); return null; }
    const own = await ownClientFor(ctx);
    if (!own) {
        if (list) res.json({ business: null, agreement: null, needsSignature: false, invoices: [] });
        else res.status(404).json({ error: 'There is no business on this login.', code: 'no_business' });
        return null;
    }
    return own;
}

app.get('/api/client/billing', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const own = await ownerBilling(ctx, res, true); if (!own) return;
        const a = await loadAgreement(own.id);
        if (a === MISSING) return res.json({ business: { id: own.id, name: own.name }, agreement: null, needsSignature: false, invoices: [] });
        const { data } = await supabase.from('invoices').select('*').eq('client_id', own.id).neq('status', 'void')
            .order('issue_date', { ascending: false }).limit(200);
        const view = agreementView(a);
        res.json({
            business: { id: own.id, name: own.name },
            agreement: view && view.status !== 'empty' ? view : null,
            needsSignature: needsSignature(a),
            invoices: (data || []).map(r => invoiceView(r)),
            ...(await printExtras())
        });
    } catch (err) { sendErr(res, err); }
});

app.post('/api/client/agreement/sign', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const own = await ownerBilling(ctx, res); if (!own) return;
        const name = oneLine(req.body?.name, 120);
        if (req.body?.agree !== true) throw billingFail('Tick “I agree” to accept the agreement.');
        if (name.length < 2) throw billingFail('Type your full name to sign.');
        const a = await loadAgreement(own.id);
        if (a === MISSING || !a || !(a.items || []).length) return res.status(404).json({ error: 'There is no agreement to sign yet.' });
        // Signed what was on the screen: a version changed meanwhile is shown again, not signed blind.
        if (req.body?.version !== undefined && Number(req.body.version) !== a.version) {
            return res.status(409).json({ error: 'Your agency changed the agreement while you were reading it. Read the new one.', code: 'agreement_changed', agreement: agreementView(a) });
        }
        if (!needsSignature(a)) return res.json({ agreement: agreementView(a), already: true });
        const now = new Date().toISOString();
        const { data, error } = await supabase.from('client_agreements').update({
            signed_version: a.version, signed_name: name, signed_at: now, signed_by: ctx.user.id,
            signed_ip: String(req.ip || '').slice(0, 60) || null
        }).eq('id', a.id).eq('version', a.version).select().maybeSingle();
        if (error) throw error;
        if (!data) return res.status(409).json({ error: 'Your agency changed the agreement while you were reading it. Read the new one.', code: 'agreement_changed' });
        logger.info('agreement_signed', { clientId: own.id, by: ctx.user.id, version: a.version });
        res.json({ agreement: agreementView(data) });
    } catch (err) { sendErr(res, err); }
});

app.get('/api/client/invoices/:id', async (req, res) => {
    try {
        const ctx = await auth(req, res); if (!ctx) return;
        const own = await ownerBilling(ctx, res); if (!own) return;
        const r = await loadInvoice(req.params.id);
        if (!r || r === MISSING || r.client_id !== own.id || r.status === 'void') return res.status(404).json({ error: 'Invoice not found.' });
        res.json({ invoice: invoiceView(r, own.name), ...(await printExtras()) });
    } catch (err) { sendErr(res, err); }
});
