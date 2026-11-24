/**
 * Email campaigns (phase 90): #campaigns, #campaigns/new, #campaigns/<id>[/<panel>], #campaigns/templates.
 * Loaded the first time the page opens. The server sends (src/25-campaigns.js); this page builds and watches.
 *
 *   The list       every campaign with its results, the mailbox's state and today's sending
 *   The builder    the flow: a lead enrolls, then each step (email, call, task) a number of days after the one
 *                  before, wired top to bottom; drag a step to reorder it, click the wait to change it, + to add.
 *                  Beside it: the selected step, the audience (category, industry, stage, pipeline, owner, with a
 *                  live count), the rules (stop on reply or a stage move, open tracking), and the people on it.
 *   Templates      saved emails, for a category or industry, that a step can start from
 */
(function () {
'use strict';
const C = window.CRM;
const { api, esc, ic, toast, st, $, num, ago, modal, v } = C;
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const P = { list: null, c: null, sel: null, panel: 'step', aud: null, templates: null, saving: 0, dirty: false, enrollments: [] };
const STEP = { email: ['mail', 'Email', '--s-email'], call: ['phone', 'Call', '--gold'], task: ['task', 'Task', '--s-meta'] };
const VARS = [['first_name', 'First name'], ['company', 'Business'], ['city', 'City'], ['industry', 'Industry'], ['website', 'Website'], ['sender_name', 'Your name']];
const STATUS_TXT = { draft: 'Draft', active: 'Sending', paused: 'Paused', archived: 'Archived' };
const rid = () => Math.random().toString(36).slice(2, 10);

// ------------------------------------------------------------------ presets: a sensible start for 7, 14 and 30 days
const E = (delay, subject, body, thread) => ({ id: rid(), type: 'email', delay, subject, body, thread: !!thread });
const K = (delay, title) => ({ id: rid(), type: 'call', delay, title });
const INTRO = E(0, '{{company}}: more calls from {{city}}', `Hi {{first_name|there}},\n\nI was looking for a {{industry|local business}} in {{city|your area}} on Google and noticed {{company}} is hard to find, even though the reviews are good.\n\nWe help local businesses like yours get found first and turn those searches into calls. Would a short 10-minute look at what is holding {{company}} back be useful?\n\n{{sender_name}}`);
const PRESETS = {
    7: { name: '7-day quick follow-up', steps: [INTRO, E(2, '', `Hi {{first_name|there}}, just bringing this back to the top of your inbox. Happy to send over a quick audit of {{company}}'s Google listing, free. Worth a look?`, true),
        K(2, 'Call {{first_name}} at {{company}} about the audit'), E(3, 'Should I close your file?', `Hi {{first_name|there}},\n\nI have not heard back, so I will assume now is not the right time. If more calls from {{city}} become a priority, just reply to this email.\n\n{{sender_name}}`)] },
    14: { name: '14-day outreach', steps: [INTRO, E(3, '', `Hi {{first_name|there}}, following up on my note. I put together three quick ideas for {{company}}: your Google Business profile, the website's booking path, and reviews. Want me to send them?`, true),
        K(2, 'Call {{first_name}} at {{company}}'), E(3, 'What we did for another {{industry}} business', `Hi {{first_name|there}},\n\nA {{industry|local}} business near {{city|you}} went from page two to the top three on Google Maps in about eight weeks, and calls went up with it. The work was simple: profile, reviews, and a faster site.\n\nWould the same approach make sense for {{company}}?\n\n{{sender_name}}`),
        K(3, 'Second call to {{company}}'), E(3, 'Last note from me', `Hi {{first_name|there}}, I will leave it here. If you want the free audit for {{company}} later, reply any time and I will send it the same day.\n\n{{sender_name}}`)] },
    30: { name: '30-day nurture', steps: [INTRO, E(3, '', `Hi {{first_name|there}}, bringing this back up. Would a free audit of {{company}}'s Google listing be useful?`, true), K(3, 'Call {{first_name}} at {{company}}'),
        E(4, 'Three quick wins for {{company}}', `Hi {{first_name|there}},\n\nThree things most {{industry|local}} businesses can fix in a week:\n1. Answer every Google review, good or bad.\n2. Put the phone number and a Book button at the top of the website.\n3. Post on the Google profile once a week.\n\nHappy to do these for {{company}}, or just send the checklist.\n\n{{sender_name}}`),
        E(5, 'A question about {{company}}', `Hi {{first_name|there}}, quick one: where do most of {{company}}'s new customers come from today? Google, word of mouth, or ads?`), K(5, 'Check in with {{company}}'),
        E(5, 'Busy season in {{city}}', `Hi {{first_name|there}},\n\nThe next season is when {{industry|local}} searches in {{city|the area}} pick up. If {{company}} wants to be the first name people see, now is the time to set it up.\n\n{{sender_name}}`),
        E(5, 'Should I close your file?', `Hi {{first_name|there}}, I will stop here. If more calls become a priority for {{company}}, reply to this email and I will pick it up.\n\n{{sender_name}}`)] }
};

// ------------------------------------------------------------------ the same fill-in the server uses
function render(text, lead = {}, sender = {}) {
    const first = String(lead.full_name || '').trim().split(/\s+/)[0] || '';
    const vars = { first_name: /^[-–—.]?$/.test(first) ? '' : first, name: lead.full_name || '', company: lead.company || '', city: lead.city || '', industry: lead.industry || '', website: lead.website || '', title: lead.title || '', sender_name: sender.name || '', sender_email: sender.email || '' };
    return String(text || '').replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (m, k, d) => { const x = vars[k.toLowerCase()]; return x ? x : d !== undefined ? d.trim() : k.toLowerCase() in vars ? '' : m; });
}
const unknownVars = text => [...String(text || '').matchAll(/\{\{\s*([a-z_]+)/gi)].map(m => m[1].toLowerCase()).filter(k => !['first_name', 'name', 'company', 'city', 'industry', 'website', 'title', 'sender_name', 'sender_email'].includes(k));
const dayOf = (steps, i) => steps.slice(0, i + 1).reduce((a, s) => a + (s.delay || 0), 0);
function summary(c) {
    const n = t => c.steps.filter(s => s.type === t).length, days = dayOf(c.steps, c.steps.length - 1);
    return [n('email') && `${n('email')} email${n('email') > 1 ? 's' : ''}`, n('call') && `${n('call')} call${n('call') > 1 ? 's' : ''}`, n('task') && `${n('task')} task${n('task') > 1 ? 's' : ''}`].filter(Boolean).join(' · ') + (c.steps.length ? ` · ${days} day${days === 1 ? '' : 's'}` : '');
}
function audienceText(a) {
    const src = (a.sources || []).map(k => C.srcOf(k).label), parts = [];
    if (src.length) parts.push(src.join(', ')); if ((a.industries || []).length) parts.push(a.industries.join(', '));
    if ((a.stages || []).length) parts.push(a.stages.map(s => (st.meta.stages.find(x => x.key === s) || {}).label).join(', '));
    if (a.pipeline === 'in') parts.push('in the pipeline'); if (a.pipeline === 'out') parts.push('cold leads');
    return parts.join(' · ') || 'Every lead with an email';
}

// ------------------------------------------------------------------ the list
C.views.campaigns = async arg => {
    const [first, panel] = String(arg || '').split('/');
    if (first === 'new') { setTimeout(newCampaign, 0); location.replace('#campaigns'); }
    if (first === 'templates') return vTemplates();
    if (first && first !== 'new') return vBuilder(first, panel);
    if (!C.p90()) return `<div class="head"><div><h1>Email campaigns</h1></div></div><div class="card"><div class="empty">${ic('seq')}<b>One step first.</b> Email campaigns need <span class="mono">sql/schema-phase90.sql</span>. The owner runs it once in Supabase; then this page fills in.</div></div>`;
    if (P.dirty && P.c) await save();
    P.c = null;   // coming back to a campaign reads it fresh, with its latest numbers
    const d = await api('/api/crm/campaigns'); P.list = d;
    const mb = d.mailbox || {};
    const pctOf = (a, b) => b ? Math.round(a / b * 100) : 0;
    const all = d.campaigns.reduce((a, c) => ({ sent: a.sent + c.stats.sent, opened: a.opened + c.stats.opened, active: a.active + c.stats.active, replied: a.replied + c.stats.replied }), { sent: 0, opened: 0, active: 0, replied: 0 });
    return `<div class="head"><div><h1>Email campaigns</h1><p class="sub">Automated cold email and call follow-ups for the leads you choose. A lead leaves a campaign when it replies or moves on.</p></div><div class="sp"></div>
        <a class="btn" href="#campaigns/templates">${ic('note')}Templates</a><button class="btn pri" type="button" data-camp="new">${ic('plus')}New campaign</button></div>
      <div class="mbox ${mb.connected ? (mb.paused ? 'warn' : 'ok') : 'off'}">${ic('mail')}<div><b>${mb.connected ? (mb.paused ? 'Sending is paused' : 'Mailbox connected') : 'No mailbox connected yet'}</b>
        <span>${mb.connected ? `${esc(mb.fromName ? mb.fromName + ' · ' : '')}${esc(mb.fromEmail || '')} · ${num(d.sentToday)} of ${num(mb.dailyCap)} sent today · ${String(mb.window.from).padStart(2, '0')}:00–${String(mb.window.to).padStart(2, '0')}:00` : 'Campaigns can be built now; emails send once the owner connects a mailbox (a Google Workspace address on edgelead.online is best). Call and task steps work without one.'}</span></div>
        ${C.isAdmin() ? `<a class="btn sm" href="#admin/email">${mb.connected ? 'Sending settings' : 'Connect a mailbox'}</a>` : ''}</div>
      ${d.campaigns.length ? `<div class="cstats card">${[['On a campaign now', num(all.active), ''], ['Emails sent', num(all.sent), ''], ['Opened', pctOf(all.opened, all.sent) + '%', ''], ['Replied', num(all.replied), 'ok']].map(([l, n, c]) => `<div><small>${l}</small><b class="${c}">${n}</b></div>`).join('')}</div>
        <div class="camps">${d.campaigns.map(c => `<a class="card camp" href="#campaigns/${c.id}"><div class="cph"><span class="cstat s-${c.status}"><i></i>${STATUS_TXT[c.status] || c.status}</span><b>${esc(c.name)}</b><span class="dim small">${ago(c.updated_at)}</span></div>
          <div class="cpflow">${c.steps.slice(0, 10).map(s => `<span class="fdot" style="--c:var(${STEP[s.type][2]})" title="${STEP[s.type][1]}${s.delay ? ' after ' + s.delay + ' days' : ''}">${ic(STEP[s.type][0])}</span>`).join('<i></i>')}${c.steps.length > 10 ? '<em>+' + (c.steps.length - 10) + '</em>' : ''}${c.steps.length ? '' : '<span class="dim small">No steps yet</span>'}</div>
          <div class="cpmeta"><span>${esc(summary(c) || 'Empty')}</span><span>${esc(audienceText(c.audience))}</span></div>
          <div class="cpnums">${[['Enrolled', c.stats.enrolled], ['Active', c.stats.active], ['Sent', c.stats.sent], ['Opened', pctOf(c.stats.opened, c.stats.sent) + '%'], ['Replied', c.stats.replied]].map(([l, n]) => `<div><b>${typeof n === 'number' ? num(n) : n}</b><small>${l}</small></div>`).join('')}</div></a>`).join('')}</div>`
        : `<div class="card"><div class="empty camp-empty">${ic('seq')}<b>No campaigns yet.</b><p>Start from a 7, 14 or 30-day flow and change what you like. Choose who it is for by category, industry and stage.</p><button class="btn pri" type="button" data-camp="new">${ic('plus')}New campaign</button></div></div>`}`;
};
function newCampaign() {
    modal('New campaign', `<div class="field"><label for="nc-n">Name</label><input id="nc-n" placeholder="Houston appliance repair, December" autocomplete="off"></div>
      <div class="field"><label>Start from</label><div class="presets">${[[7, '7 days', '3 emails and a call. For warm or small lists.'], [14, '14 days', '4 emails and 2 calls. The standard cold outreach.'], [30, '30 days', '6 emails and 2 calls. Slower, more value.'], [0, 'Blank', 'Build the flow yourself.']].map(([k, l, d], i) => `<label class="preset"><input type="radio" name="nc-p" value="${k}" ${i === 1 ? 'checked' : ''}><span><b>${l}</b><small>${d}</small></span></label>`).join('')}</div></div>`, 'Create', async () => {
        const k = +($('input[name=nc-p]:checked') || {}).value || 0;
        const pr = PRESETS[k];
        const name = v('nc-n').trim() || (pr ? pr.name : 'New campaign');
        const { campaign } = await api('/api/crm/campaigns', { method: 'POST', body: { name, steps: pr ? pr.steps.map(s => ({ ...s, id: rid() })) : [], audience: { pipeline: 'any' } } });
        C.closeLayer(); location.hash = 'campaigns/' + campaign.id;
    });
}

// ------------------------------------------------------------------ the builder
async function vBuilder(id, panel) {
    if (!P.c || P.c.id !== id) { const d = await api('/api/crm/campaigns/' + id); P.c = d.campaign; P.enrollments = d.enrollments; P.sel = P.c.steps[0] ? P.c.steps[0].id : null; P.aud = null; }
    if (panel && ['step', 'audience', 'rules', 'people', 'preview'].includes(panel)) P.panel = panel;
    if (!P.templates) P.templates = (await api('/api/crm/templates').catch(() => ({ templates: [] }))).templates;
    const c = P.c, s = c.stats || {};
    return `<div class="bhead"><a class="btn sm ghost" href="#campaigns">${ic('stage').replace('<path', '<path transform="rotate(180 12 12)"')}Campaigns</a>
        <div class="bt"><input id="cname" value="${esc(c.name)}" aria-label="Campaign name" maxlength="120"><span class="cstat s-${c.status}"><i></i>${STATUS_TXT[c.status]}</span><span class="saved" id="saved">${P.dirty ? 'Unsaved changes' : 'Saved'}</span></div>
        <div class="bacts"><button class="btn" type="button" data-camp="test">${ic('mail')}Send me a test</button>
          ${c.status === 'active' ? `<button class="btn" type="button" data-camp="pause">Pause</button>` : `<button class="btn pri" type="button" data-camp="start">${ic('play' in C.ICONS ? 'play' : 'arrow')}${c.status === 'paused' ? 'Resume' : 'Start'}</button>`}
          <button class="btn ghost" type="button" data-camp="delete" title="${s.sent ? 'Archive' : 'Delete'}">${ic('trash')}</button></div></div>
      <div class="cstats card slim">${[['Enrolled', s.enrolled], ['On it now', s.active], ['Finished', s.done], ['Sent', s.sent], ['Opened', s.sent ? Math.round(s.opened / s.sent * 100) + '%' : '—'], ['Replied', s.replied], ['Stopped', (s.stopped || 0) + (s.unsubscribed || 0) + (s.failed || 0)]].map(([l, n]) => `<div><small>${l}</small><b>${typeof n === 'number' ? num(n) : (n || 0)}</b></div>`).join('')}</div>
      <div class="builder"><section class="flow" id="flow" aria-label="The flow">${flowHtml()}</section>
        <aside class="card insp"><nav class="itabs" role="tablist">${[['step', 'Step'], ['audience', 'Audience'], ['rules', 'Rules'], ['people', 'People'], ['preview', 'Preview']].map(([k, l]) => `<button type="button" role="tab" data-ptab="${k}" class="${P.panel === k ? 'on' : ''}">${l}${k === 'people' && s.enrolled ? `<span>${num(s.enrolled)}</span>` : ''}</button>`).join('')}</nav>
          <div class="ibody" id="ibody">${await panelHtml()}</div></aside></div>`;
}
function flowHtml() {
    const c = P.c;
    const add = i => `<div class="addstep"><button type="button" class="plus" data-addat="${i}" aria-label="Add a step here">${ic('plus')}</button><div class="addmenu" hidden>${Object.entries(STEP).map(([k, [i2, l]]) => `<button type="button" data-addtype="${k}" data-at="${i}">${ic(i2)}${l}</button>`).join('')}</div></div>`;
    return `<div class="node start"><span class="ni">${ic('leads')}</span><div><b>A lead joins</b><span>${esc(audienceText(c.audience))}</span></div><button type="button" class="btn sm ghost" data-ptab="audience">Audience</button></div>
      ${c.steps.map((s, i) => { const [ico, label, col] = STEP[s.type];
        return `<div class="wire">${add(i)}<button type="button" class="wait" data-wait="${s.id}" title="Change the wait">${s.delay ? `Wait ${s.delay} day${s.delay > 1 ? 's' : ''}` : i ? 'Same day' : 'Right away'}</button></div>
          <div class="node step ${P.sel === s.id ? 'on' : ''}" draggable="true" data-step="${s.id}" style="--c:var(${col})"><span class="grip" title="Drag to move">${ic('grip')}</span><span class="ni">${ic(ico)}</span>
            <div class="nt"><span class="nk">${label} · day ${dayOf(c.steps, i)}</span><b>${esc(s.type === 'email' ? (s.thread && i ? 'Re: ' + (prevSubject(i) || '(previous subject)') : s.subject || 'No subject yet') : s.title || 'No title yet')}</b><span class="np">${esc(String(s.type === 'email' ? s.body : '').replace(/\s+/g, ' ').slice(0, 110))}</span></div>
            <button type="button" class="btn ghost sm" data-delstep="${s.id}" aria-label="Remove this step">${ic('x')}</button></div>`; }).join('')}
      <div class="wire">${add(c.steps.length)}</div>
      <div class="node end"><span class="ni">${ic('task')}</span><div><b>The lead leaves</b><span>After the last step, or at once when it replies${(c.settings || {}).stopOnStage !== false ? ', moves on in the pipeline' : ''} or unsubscribes</span></div></div>`;
}
const prevSubject = i => { const p = P.c.steps.slice(0, i).reverse().find(s => s.type === 'email' && !s.thread) || P.c.steps.slice(0, i).reverse().find(s => s.type === 'email'); return p ? p.subject : ''; };
async function panelHtml() {
    const c = P.c, s = c.steps.find(x => x.id === P.sel);
    if (P.panel === 'step') {
        if (!s) return `<div class="empty sm">${ic('seq')}Pick a step in the flow, or add one with <b>+</b>.</div>`;
        const i = c.steps.indexOf(s);
        const head = `<div class="ihead" style="--c:var(${STEP[s.type][2]})"><span class="ni">${ic(STEP[s.type][0])}</span><div><b>${STEP[s.type][1]} · step ${i + 1}</b><span>Day ${dayOf(c.steps, i)}</span></div>
          <select data-sf="type" aria-label="Kind of step">${Object.entries(STEP).map(([k, [, l]]) => `<option value="${k}" ${s.type === k ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div class="field"><label for="sf-delay">Wait before this step</label><div class="inline"><input id="sf-delay" data-sf="delay" type="number" min="0" max="90" value="${s.delay || 0}"><span class="dim">days after ${i ? 'the step before' : 'the lead joins'}</span></div></div>`;
        if (s.type !== 'email') return head + `<div class="field"><label for="sf-title">${s.type === 'call' ? 'Call task' : 'Task'}</label><input id="sf-title" data-sf="title" value="${esc(s.title || '')}" placeholder="${s.type === 'call' ? 'Call {{first_name}} at {{company}}' : 'What to do'}"></div>
          <p class="note">On that day the lead's owner gets a ${s.type === 'call' ? 'call' : ''} task: it shows on the Overview under Calls and follow-ups, and as the lead's next step.</p>`;
        const tpls = P.templates || [];
        const bad = unknownVars(s.subject + ' ' + s.body);
        return head + `${i ? `<label class="check"><input type="checkbox" data-sf="thread" ${s.thread ? 'checked' : ''}> Send as a reply to the email before (same subject, same thread)</label>` : ''}
          ${s.thread && i ? '' : `<div class="field"><label for="sf-subject">Subject</label><input id="sf-subject" data-sf="subject" value="${esc(s.subject || '')}" placeholder="{{company}}: a quick idea"></div>`}
          <div class="field"><div class="lhead"><label for="sf-body">Email</label>${tpls.length ? `<select id="sf-tpl" aria-label="Start from a template"><option value="">Use a template…</option>${tpls.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select>` : ''}</div>
            <textarea id="sf-body" data-sf="body" rows="12" placeholder="Hi {{first_name|there}},">${esc(s.body || '')}</textarea>
            <div class="vars"><span class="dim small">Insert</span>${VARS.map(([k, l]) => `<button type="button" data-var="${k}">${l}</button>`).join('')}</div>
            <small>Write <b>{{first_name|there}}</b> to say "there" when a lead has no first name. Your signature and an unsubscribe link are added at the end.</small></div>
          ${bad.length ? `<p class="note bad">Unknown: ${bad.map(x => '{{' + esc(x) + '}}').join(', ')}. They would be sent as written.</p>` : ''}
          <div class="tbar"><button class="btn sm ghost" type="button" data-camp="savetpl">${ic('note')}Save as a template</button><span class="sp"></span><button class="btn sm" type="button" data-ptab="preview">Preview</button></div>`;
    }
    if (P.panel === 'audience') {
        const a = c.audience || {};
        if (!P.aud) P.aud = await api('/api/crm/campaigns/audience', { method: 'POST', body: { audience: a } }).catch(e => ({ error: e.message }));
        const L = st.leads || await C.leads();
        const inds = [...new Set([...(st.meta.industries || []), ...L.map(l => l.industry).filter(Boolean)])];
        const chips = (key, list, label) => `<div class="field"><label>${label}</label><div class="chipsel">${list.map(([k, l]) => `<button type="button" data-aud="${key}" data-val="${esc(k)}" class="${(a[key] || []).includes(k) ? 'on' : ''}">${esc(l)}</button>`).join('')}</div></div>`;
        return `<div class="audcount ${P.aud.error ? 'bad' : ''}">${P.aud.error ? esc(P.aud.error) : `<b>${num(P.aud.count)}</b><span>lead${P.aud.count === 1 ? '' : 's'} match${P.aud.noEmail ? ` · ${num(P.aud.noEmail)} more have no email` : ''}${P.aud.unsubscribed ? ` · ${num(P.aud.unsubscribed)} unsubscribed` : ''}</span>`}</div>
          <p class="dim small" style="margin:0">Empty means any. Won and lost leads are left out unless you pick those stages.</p>
          ${chips('sources', st.meta.sources.map(s => [s.key, s.label]), 'Category')}
          ${chips('industries', inds.map(i => [i, i]), 'Industry')}
          ${chips('stages', st.meta.stages.map(s => [s.key, s.label]), 'Stage')}
          <div class="field"><label>Pipeline</label><div class="seg">${[['any', 'Any'], ['out', 'Cold leads'], ['in', 'In the pipeline']].map(([k, l]) => `<button type="button" data-audpipe="${k}" class="${(a.pipeline || 'any') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
          ${chips('owners', st.meta.team.map(m => [m.id, m.name]), 'Owner')}
          ${!P.aud.error && P.aud.sample && P.aud.sample.length ? `<div class="field"><label>Some of them</label><div class="asample">${P.aud.sample.slice(0, 6).map(l => `<span><b>${esc(l.company || l.full_name)}</b>${esc(l.industry || '')}${l.city ? ' · ' + esc(l.city) : ''}</span>`).join('')}</div></div>` : ''}
          <div class="tbar"><span class="dim small">Adding is safe: a lead already on this campaign is left as it is.</span><span class="sp"></span><button class="btn pri" type="button" data-camp="enroll" ${P.aud.count ? '' : 'disabled'}>${ic('plus')}Add ${num(P.aud.count || 0)} lead${P.aud.count === 1 ? '' : 's'}</button></div>`;
    }
    if (P.panel === 'rules') {
        const r = c.settings || {}, mb = (st.meta.mailbox) || {};
        const sw = (k, on, l, d) => `<div class="opt"><div class="t"><b>${l}</b><span>${d}</span></div><label class="sw"><input type="checkbox" data-rule="${k}" ${on ? 'checked' : ''} aria-label="${l}"><i></i></label></div>`;
        return `${sw('stopOnReply', r.stopOnReply !== false, 'Stop when they reply', 'A reply logged on the lead (or moving it to Replied) takes it off this campaign.')}
          ${sw('stopOnStage', r.stopOnStage !== false, 'Stop when they move on', 'Meeting, Proposal, Won or Lost in the pipeline takes it off.')}
          ${sw('track', r.track !== false, 'Count opens', 'A tiny picture in each email shows when it is opened. Some mail apps block it.')}
          <div class="opt"><div class="t"><b>When emails go</b><span>${mb.connected ? `${String(mb.window.from).padStart(2, '0')}:00 to ${String(mb.window.to).padStart(2, '0')}:00, ${(mb.window.days || []).map(d => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d]).join(', ')} (${esc(st.meta.timezone || '')}), at most ${num(mb.dailyCap)} a day, spread out.` : 'Set with the mailbox in Admin → Email.'}</span></div>${C.isAdmin() ? '<a class="btn sm" href="#admin/email">Change</a>' : ''}</div>`;
    }
    if (P.panel === 'people') {
        const E2 = P.enrollments;
        const label = { active: 'On it', done: 'Finished', stopped: 'Stopped', replied: 'Replied', unsubscribed: 'Unsubscribed', bounced: 'Bounced', failed: 'Failed' };
        return E2.length ? `<div class="people">${E2.map(e => `<div class="prow"><div class="t"><b data-open="${e.lead_id}">${esc(e.lead ? e.lead.company || e.lead.full_name : 'A deleted lead')}</b><span>${esc(e.lead ? e.lead.email || '' : '')}</span></div>
            <span class="wstat w-${e.status === 'active' ? 'running' : e.status === 'replied' || e.status === 'done' ? 'done' : e.status === 'stopped' ? 'draft' : 'rejected'}">${label[e.status] || e.status}</span>
            <span class="dim small">${e.status === 'active' ? `Step ${e.step + 1}${e.next_at ? ' · ' + new Date(e.next_at).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}` : esc(e.stop_reason || '')}</span>
            ${e.status === 'active' ? `<button class="btn ghost sm" type="button" data-unenroll="${e.id}" title="Take off this campaign">${ic('x')}</button>` : ''}</div>`).join('')}</div>`
            : `<div class="empty sm">${ic('leads')}Nobody yet. Choose who it is for in <b>Audience</b> and add them, or add leads from the Leads page.</div>`;
    }
    const sample = (st.leads || []).find(l => l.email && C.leadState(l) !== 'client') || { full_name: 'Alex Rivera', company: 'Rivera Roofing', city: 'Houston', industry: 'Roofing' };
    const me = { name: C.teamName(st.meta.me.id) };
    return `<p class="dim small" style="margin:0">As ${esc(sample.company || sample.full_name)} would see it.</p>${c.steps.map((x, i) => x.type === 'email' ? `<div class="pmail"><div class="pm-h"><span class="nk">Day ${dayOf(c.steps, i)}</span><b>${esc(x.thread && i ? 'Re: ' + render(prevSubject(i), sample, me) : render(x.subject, sample, me))}</b></div><div class="pm-b">${esc(render(x.body, sample, me))}</div></div>`
        : `<div class="pmail task"><span class="nk">Day ${dayOf(c.steps, i)} · ${STEP[x.type][1]}</span><b>${esc(render(x.title, sample, {}))}</b></div>`).join('') || '<div class="empty sm">No steps yet.</div>'}`;
}

// ------------------------------------------------------------------ saving
let saveT = 0;
function changed(redrawFlow = true) {
    P.dirty = true; const sv = $('#saved'); if (sv) sv.textContent = 'Saving…';
    if (redrawFlow) { const f = $('#flow'); if (f) f.innerHTML = flowHtml(); }
    clearTimeout(saveT); saveT = setTimeout(save, 700);
}
async function save() {
    const c = P.c;
    try { const r = await api('/api/crm/campaigns/' + c.id, { method: 'PATCH', body: { name: c.name, steps: c.steps, audience: c.audience, settings: c.settings } }); P.c = { ...r.campaign, stats: c.stats }; P.dirty = false; const sv = $('#saved'); if (sv) sv.textContent = 'Saved'; }
    catch (e) { const sv = $('#saved'); if (sv) sv.textContent = 'Not saved'; toast(e.message, true); }
}
async function redrawPanel() { const b = $('#ibody'); if (b) b.innerHTML = await panelHtml(); $$('[data-ptab]').forEach(x => x.classList.toggle('on', x.dataset.ptab === P.panel)); }

// ------------------------------------------------------------------ templates
async function vTemplates() {
    P.templates = (await api('/api/crm/templates')).templates;
    return `<div class="head"><div><a class="btn sm ghost" href="#campaigns" style="margin:-6px 0 6px -8px">${ic('stage').replace('<path', '<path transform="rotate(180 12 12)"')}Campaigns</a><h1>Email templates</h1><p class="sub">Saved emails a campaign step can start from. Give one a category or industry to keep them sorted.</p></div><div class="sp"></div><button class="btn pri" type="button" data-camp="newtpl">${ic('plus')}New template</button></div>
      ${P.templates.length ? `<div class="cgrid">${P.templates.map(t => `<button type="button" class="card tpl" data-tpl="${t.id}"><b>${esc(t.name)}</b><span class="tsub">${esc(t.subject || '(no subject)')}</span><p>${esc(String(t.body).slice(0, 220))}</p><div class="chips">${t.source ? C.srcChip(t.source) : ''}${t.industry ? C.indChip(t.industry) : ''}<span class="dim small">${ago(t.updated_at)}</span></div></button>`).join('')}</div>`
        : `<div class="card"><div class="empty">${ic('note')}No templates yet. Save one from a campaign step, or make one here.</div></div>`}`;
}
function tplForm(t = {}) {
    modal(t.id ? 'Edit template' : 'New template', `<div class="field"><label for="tp-n">Name</label><input id="tp-n" value="${esc(t.name || '')}" placeholder="First touch, roofing"></div>
      <div class="grid2"><div class="field"><label for="tp-s">Category</label><select id="tp-s"><option value="">Any</option>${st.meta.sources.map(s => `<option value="${s.key}" ${t.source === s.key ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
        <div class="field"><label for="tp-i">Industry</label><input id="tp-i" list="tp-il" value="${esc(t.industry || '')}" placeholder="Any"><datalist id="tp-il">${C.industries().map(i => `<option value="${esc(i)}">`).join('')}</datalist></div></div>
      <div class="field"><label for="tp-sub">Subject</label><input id="tp-sub" value="${esc(t.subject || '')}"></div>
      <div class="field"><label for="tp-b">Email</label><textarea id="tp-b" rows="10">${esc(t.body || '')}</textarea><small>Use {{first_name}}, {{company}}, {{city}}, {{industry}}, {{website}}, {{sender_name}}.</small></div>
      ${t.id ? `<button type="button" class="btn sm ghost danger" data-tpldel="${t.id}">${ic('trash')}Delete template</button>` : ''}`, t.id ? 'Save' : 'Create', async () => {
        const body = { name: v('tp-n'), source: v('tp-s') || null, industry: v('tp-i') || null, subject: v('tp-sub'), body: $('#tp-b').value };
        if (t.id) await api('/api/crm/templates/' + t.id, { method: 'PATCH', body }); else await api('/api/crm/templates', { method: 'POST', body });
        P.templates = null; C.closeLayer(); toast('Template saved'); C.render();
    }, true);
}

// ------------------------------------------------------------------ events (only while campaigns are open)
const here = () => C.route === 'campaigns';
const curStep = () => P.c && P.c.steps.find(x => x.id === P.sel);
document.addEventListener('click', async e => {
    if (!here()) return;
    const t = e.target;
    const tp = t.closest('[data-tpl]'); if (tp) return tplForm(P.templates.find(x => x.id === tp.dataset.tpl));
    const td = t.closest('[data-tpldel]'); if (td) { if (!confirm('Delete this template?')) return; await api('/api/crm/templates/' + td.dataset.tpldel, { method: 'DELETE' }); C.closeLayer(); toast('Deleted'); return C.render(); }
    const pt = t.closest('[data-ptab]'); if (pt && P.c) { P.panel = pt.dataset.ptab; return redrawPanel(); }
    const plus = t.closest('[data-addat]'); if (plus) { const m = plus.nextElementSibling; const open = m.hidden; $$('.addmenu').forEach(x => x.hidden = true); m.hidden = !open; return; }
    const at = t.closest('[data-addtype]'); if (at) { const type = at.dataset.addtype, i = +at.dataset.at;
        const s = type === 'email' ? { id: rid(), type, delay: i ? 2 : 0, subject: '', body: 'Hi {{first_name|there}},\n\n', thread: i > 0 } : { id: rid(), type, delay: i ? 2 : 0, title: type === 'call' ? 'Call {{first_name}} at {{company}}' : '' };
        P.c.steps.splice(i, 0, s); P.sel = s.id; P.panel = 'step'; changed(); return redrawPanel(); }
    if (!t.closest('.addstep')) $$('.addmenu').forEach(x => x.hidden = true);
    const ds = t.closest('[data-delstep]'); if (ds) { e.stopPropagation(); P.c.steps = P.c.steps.filter(x => x.id !== ds.dataset.delstep); if (P.sel === ds.dataset.delstep) P.sel = P.c.steps[0] ? P.c.steps[0].id : null; changed(); return redrawPanel(); }
    const wt = t.closest('[data-wait]'); if (wt) { P.sel = wt.dataset.wait; P.panel = 'step'; changed(false); $$('.node.step').forEach(n => n.classList.toggle('on', n.dataset.step === P.sel)); await redrawPanel(); const d = $('#sf-delay'); if (d) { d.focus(); d.select(); } return; }
    const nd = t.closest('[data-step]'); if (nd) { P.sel = nd.dataset.step; P.panel = 'step'; $$('.node.step').forEach(n => n.classList.toggle('on', n.dataset.step === P.sel)); return redrawPanel(); }
    const vr = t.closest('[data-var]'); if (vr) { const ta = $('#sf-body'); const tok = `{{${vr.dataset.var}${vr.dataset.var === 'first_name' ? '|there' : ''}}}`; const p0 = ta.selectionStart, p1 = ta.selectionEnd; ta.value = ta.value.slice(0, p0) + tok + ta.value.slice(p1); ta.focus(); ta.setSelectionRange(p0 + tok.length, p0 + tok.length); curStep().body = ta.value; return changed(); }
    const au = t.closest('[data-aud]'); if (au) { const a = P.c.audience, k = au.dataset.aud, x = au.dataset.val; a[k] = (a[k] || []).includes(x) ? a[k].filter(y => y !== x) : [...(a[k] || []), x]; P.aud = null; changed(); return redrawPanel(); }
    const ap = t.closest('[data-audpipe]'); if (ap) { P.c.audience.pipeline = ap.dataset.audpipe; P.aud = null; changed(); return redrawPanel(); }
    const un = t.closest('[data-unenroll]'); if (un) { await api(`/api/crm/campaigns/${P.c.id}/enrollments/${un.dataset.unenroll}/stop`, { method: 'POST' }); toast('Taken off the campaign'); P.c = null; return C.render(); }
    const a = t.closest('[data-camp]'); if (!a) return;
    const k = a.dataset.camp;
    try {
        if (k === 'new') return newCampaign();
        if (k === 'newtpl') return tplForm({});
        if (k === 'savetpl') { const s = curStep(); if (!s) return; const { template } = await api('/api/crm/templates', { method: 'POST', body: { name: (s.subject || P.c.name).slice(0, 120), subject: s.subject, body: s.body } }); P.templates = [template, ...(P.templates || [])]; toast('Saved as a template'); return redrawPanel(); }
        if (k === 'test') { if (P.dirty) await save(); const s = curStep(); const r = await api(`/api/crm/campaigns/${P.c.id}/test`, { method: 'POST', body: { stepId: s && s.type === 'email' ? s.id : undefined } }); return toast('Test sent to ' + r.to); }
        if (k === 'start' || k === 'pause') { if (P.dirty) await save(); await api(`/api/crm/campaigns/${P.c.id}/status`, { method: 'POST', body: { status: k === 'start' ? 'active' : 'paused' } }); toast(k === 'start' ? 'Started. Steps go out as they fall due.' : 'Paused. Nothing goes out until you resume.'); P.c = null; return C.render(); }
        if (k === 'delete') { if (!confirm(P.c.stats && P.c.stats.sent ? 'Archive this campaign? It stops, and its history stays on the leads.' : 'Delete this campaign?')) return; await api('/api/crm/campaigns/' + P.c.id, { method: 'DELETE' }); toast('Done'); P.c = null; location.hash = 'campaigns'; return; }
        if (k === 'enroll') { if (P.dirty) await save(); const r = await api(`/api/crm/campaigns/${P.c.id}/enroll`, { method: 'POST', body: {} }); toast(`${num(r.added)} added${r.already ? ` · ${num(r.already)} already on it` : ''}${P.c.status !== 'active' ? '. Press Start to begin sending.' : ''}`); P.c = null; P.panel = 'people'; return C.render(); }
    } catch (err) { toast(err.message, true); }
});
document.addEventListener('input', e => {
    if (!here() || !P.c) return;
    const t = e.target;
    if (t.id === 'cname') { P.c.name = t.value; return changed(false); }
    const s = curStep(); if (!s || !t.dataset.sf) return;
    const f = t.dataset.sf;
    if (f === 'delay') s.delay = Math.max(0, Math.min(90, Math.round(+t.value || 0)));
    else if (f === 'thread') return;
    else s[f] = t.value;
    changed();
});
document.addEventListener('change', async e => {
    if (!here() || !P.c) return;
    const t = e.target, s = curStep();
    if (t.dataset.sf === 'thread' && s) { s.thread = t.checked; changed(); return redrawPanel(); }
    if (t.dataset.sf === 'type' && s) { s.type = t.value; if (s.type === 'email') { s.subject = s.subject || ''; s.body = s.body || 'Hi {{first_name|there}},\n\n'; } else s.title = s.title || (s.type === 'call' ? 'Call {{first_name}} at {{company}}' : ''); changed(); return redrawPanel(); }
    if (t.id === 'sf-tpl' && t.value && s) { const tp = (P.templates || []).find(x => x.id === t.value); if (tp) { s.subject = tp.subject || s.subject; s.body = tp.body; s.thread = false; changed(); toast('Template loaded into this step'); return redrawPanel(); } }
    if (t.dataset.rule) { P.c.settings = { ...(P.c.settings || {}), [t.dataset.rule]: t.checked }; changed(); }
});
// drag a step to reorder it
document.addEventListener('dragstart', e => { if (!here()) return; const n = e.target.closest && e.target.closest('.node.step'); if (n) { e.dataTransfer.setData('text/step', n.dataset.step); n.classList.add('dragging'); } });
document.addEventListener('dragend', e => { if (!here()) return; $$('.node.dragging').forEach(n => n.classList.remove('dragging')); $$('.node.dropabove').forEach(n => n.classList.remove('dropabove')); });
document.addEventListener('dragover', e => { if (!here()) return; const n = e.target.closest && e.target.closest('.node.step,.node.end'); if (!n || !e.dataTransfer.types.includes('text/step')) return; e.preventDefault(); $$('.node.dropabove').forEach(x => x !== n && x.classList.remove('dropabove')); n.classList.add('dropabove'); });
document.addEventListener('drop', e => {
    if (!here() || !P.c) return; const n = e.target.closest && e.target.closest('.node.step,.node.end'); const id = e.dataTransfer.getData('text/step'); if (!n || !id) return; e.preventDefault();
    const steps = P.c.steps, from = steps.findIndex(s => s.id === id); if (from < 0) return;
    const [m] = steps.splice(from, 1);
    const to = n.classList.contains('end') ? steps.length : steps.findIndex(s => s.id === n.dataset.step);
    steps.splice(to < 0 ? steps.length : to, 0, m); P.sel = m.id; changed(); redrawPanel();
});
addEventListener('beforeunload', e => { if (here() && P.dirty) { save(); e.preventDefault(); } });
addEventListener('hashchange', () => { if (P.dirty && P.c) save(); });
})();
