(function () {
    'use strict';

    // ---- portal.js helpers, verbatim ---------------------------------------
    const $ = id => document.getElementById(id);
    const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const safeMarkdown = (md) => (window.DOMPurify && window.marked
        ? DOMPurify.sanitize(marked.parse(md))
        : `<p>${escHtml(md).replace(/\n/g, '<br>')}</p>`);
    const fmtN = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));
    const fmtMoney = (v, cur) => {
        try { return new Intl.NumberFormat('en-US', { style: 'currency', currency: cur || 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(v)); }
        catch { return `${Number(v).toFixed(2)} ${cur || ''}`.trim(); }
    };
    const fmtV = (v, format, cur) => (v === null || v === undefined ? '—'
        : format === 'money' ? fmtMoney(v, cur)
        : format === 'ratio' ? `${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`
        : fmtN(v));
    const fmtCompact = (v) => {
        const n = Number(v), a = Math.abs(n);
        if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, '')}M`;
        if (a >= 1e4) return `${Math.round(n / 1e3)}K`;
        if (a >= 1e3) return `${(n / 1e3).toFixed(1).replace(/\.0$/, '')}K`;
        return n.toLocaleString('en-US');
    };
    const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
    const isDesktop = () => window.matchMedia('(min-width: 941px)').matches;
    const ICON = {
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>',
        stop: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:14px;height:14px"><rect x="5" y="5" width="14" height="14" rx="2.5"/></svg>',
        more: '<svg viewBox="0 0 24 24" fill="currentColor" style="width:16px;height:16px" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>'
    };

    // ---- state (portal.js) ---------------------------------------------------
    let activeClient = null;        // { id, name }
    let conversationId = null;
    let chatBusy = false, chatEpoch = 0, abortCtl = null, lastQuestion = '', stick = true;
    let convMenuFor = null, convReloadPending = false;
    const liveCharts = [];
    let xpStatus = null;

    // EdgeLead's seam: the bearer session instead of XpulseAI's client token.
    async function authFetch(path, options = {}) {
        const token = await EL.token();
        return fetch(EL.backendUrl() + path, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
    }
    const scroller = () => $('chat-scroll');
    function scrollToBottom(force) {
        const s = scroller();
        if (force) stick = true;
        if (stick) s.scrollTop = s.scrollHeight;
        updateToBottom();
    }
    function updateToBottom() {
        const s = scroller(), btn = $('to-bottom');
        const far = !$('welcome') && s.scrollHeight - s.scrollTop - s.clientHeight > 160;
        btn.classList.toggle('hidden', !far);
    }

    // ---- boot ---------------------------------------------------------------------
    // The page boots EL (the session, the account) and hands over. `opts.app` is
    // the Edge Meta AI app (ai/): the same chat, with no EdgeLead around it.
    let isOwner = false, appMode = false, pollTimer = null;
    async function start(me, opts = {}) {
        appMode = !!opts.app;
        isOwner = me.role === 'client';
        if (me.role === 'client') {
            if (!me.business) { $('chat-box').innerHTML = '<p class="oa-note">This account has no business record yet. Sign out and back in.</p>'; return; }
            activeClient = { id: me.business.id, name: me.business.name || 'your business' };
        } else {
            // Staff arrive from a client's Ask AI tab (phase 33) with ?client= in
            // the address, which EL.init has made the chosen client. The Owner
            // Assistant's routes check the caller may read that client.
            const list = await EL.clients();
            const cl = list.find(x => x.id === EL.clientId());
            if (!cl) { $('chat-box').innerHTML = '<p class="oa-note">Open this from a client’s Assistant tab, so it knows whose numbers to read. <a href="clients.html">Choose a client</a>.</p>'; return; }
            activeClient = { id: cl.id, name: cl.name };
            document.title = `Edge Meta AI · ${cl.name} — EdgeLead`;
        }
        $('oa-for').textContent = appMode ? activeClient.name : ` for ${activeClient.name}`;
        // An owner inside EdgeLead can take the chat along as its own app. (phase 47)
        if (isOwner && !appMode && $('oa-state')) {
            const a = document.createElement('a');
            a.className = 'icon-btn oa-app-link'; a.href = 'ai/'; a.textContent = 'Open as an app';
            a.title = 'Edge Meta AI on its own, full screen. Add it to your home screen from there.';
            $('oa-state').after(a);
        }

        $('oa-new').addEventListener('click', newChat);
        $('oa-side-toggle').addEventListener('click', () => $('oa-side').classList.toggle('is-open'));
        $('chat-form').addEventListener('submit', handleChatSubmit);
        input.addEventListener('input', autoGrow);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !isTouch()) handleChatSubmit(e); });
        $('to-bottom').addEventListener('click', () => scrollToBottom(true));
        $('chat-box').addEventListener('click', (e) => {
            const q = e.target.closest('[data-q]');
            if (q) { ask(q.dataset.q); return; }
            if (e.target.closest('[data-retry]')) { e.target.closest('[data-retry-wrap]')?.remove(); ask(lastQuestion, { echo: false }); }
            if (e.target.closest('[data-connect]')) connectMeta(e.target.closest('[data-connect]'));
        });
        scroller().addEventListener('scroll', () => { const s = scroller(); stick = s.scrollHeight - s.scrollTop - s.clientHeight < 80; updateToBottom(); }, { passive: true });
        if ('ResizeObserver' in window) new ResizeObserver(() => { if (stick && !$('welcome')) scroller().scrollTop = scroller().scrollHeight; updateToBottom(); }).observe($('chat-box'));
        $('chat-history').addEventListener('click', (e) => {
            const more = e.target.closest('[data-conv-menu]');
            if (more) { toggleConvMenu(more, e.detail === 0); return; }
            const b = e.target.closest('[data-conv]');
            if (b && b.dataset.conv !== conversationId) openConversation(b.dataset.conv);
        });
        $('conv-menu').addEventListener('click', (e) => {
            const a = e.target.closest('[data-action]'); if (!a) return;
            const id = convMenuFor; closeConvMenu();
            if (a.dataset.action === 'conv-rename') renameConversation(id);
            if (a.dataset.action === 'conv-delete') deleteConversation(id);
        });
        document.addEventListener('click', (e) => { if (!e.target.closest('#conv-menu') && !e.target.closest('[data-conv-menu]')) closeConvMenu(); });
        window.addEventListener('resize', () => closeConvMenu());

        setComposerBusy(false);
        resetChat();
        loadStatus();
        loadConversations();
        // Back from Meta's login: say so once, then the status line takes over.
        const back = new URLSearchParams(location.search).get('meta');
        if (back === 'ok') EL.toast('Connected. Reading your numbers now: the last 90 days and every post.');
        else if (back === 'error') EL.toast(new URLSearchParams(location.search).get('message') || 'Meta did not connect. Try again.', 'bad');
        if (back) history.replaceState(null, '', location.pathname);
        // Coming back to the app after a while: pick up whatever changed.
        document.addEventListener('visibilitychange', () => { if (!document.hidden) loadStatus(); });
    }
    window.MetaAI = { start };

    // ---- what the warehouse holds: decides the welcome ----------------------------------
    // Phase 47: the server says where the business stands in one word (phase) and
    // starts the first read itself, so the owner is never handed a button to find.
    // While it reads, this page checks back on its own and opens up when it is done.
    async function loadStatus() {
        const before = xpStatus && xpStatus.phase;
        try { xpStatus = await EL.api('/api/xp/status?client_id=' + encodeURIComponent(activeClient.id)); } catch (err) { xpStatus = null; }
        renderState();
        if ($('welcome')) $('chat-box').innerHTML = welcomeHtml();
        setComposerOpen();
        if (before && before !== 'ready' && xpStatus && xpStatus.phase === 'ready') EL.toast('Your numbers are in. Ask away.');
        clearTimeout(pollTimer);
        if (xpStatus && (xpStatus.running || xpStatus.phase === 'reading')) pollTimer = setTimeout(loadStatus, 15000);
    }
    const hasData = (s) => !!(s && s.coverage && Array.isArray(s.coverage.assets) && s.coverage.assets.some(a => a.account_days > 0 || a.post_days > 0));
    const readyToAsk = () => !xpStatus || hasData(xpStatus);
    function setComposerOpen() {
        const open = readyToAsk();
        input.disabled = !open;
        // Short, so it fits one line on a phone.
        input.placeholder = open ? (appMode ? 'Ask about your numbers…' : 'Ask about your Instagram and Facebook…')
            : xpStatus && xpStatus.phase === 'reading' ? 'Ready in a few minutes…' : 'Connect Meta first…';
        updateSendState();
    }
    function whenNext(s) {
        const sc = s && s.schedule;
        const m = sc && sc.enabled && /^(\d+)\s+([\d,]+)\s/.exec(sc.cron || '');
        return m ? 'updates itself at ' + m[2].split(',').map(h => h.padStart(2, '0') + ':' + m[1].padStart(2, '0')).join(' and ') + ' ' + (sc.tz || 'UTC') : 'updates itself twice a day';
    }
    function ago(iso) {
        const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
        if (m < 2) return 'just now';
        if (m < 60) return `${m} min ago`;
        const h = Math.round(m / 60);
        return h < 36 ? `${h} h ago` : new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    function renderState() {
        const s = xpStatus;
        const el = $('oa-state');
        el.className = 'oa-state';
        if (!s) { el.textContent = ''; return; }
        const last = (s.assets || []).map(a => a.last_synced_at).filter(Boolean).sort().pop();
        const set = (text, tone) => { el.textContent = text; if (tone) el.classList.add('is-' + tone); };
        if (s.phase === 'not_connected') return set('Meta not connected', 'warn');
        if (s.phase === 'reconnect') return set('Reconnect Meta to keep your numbers current', 'bad');
        if (s.running) return set(hasData(s) ? 'Updating your numbers…' : 'Reading your numbers…', 'live');
        if (s.phase === 'reading') return set('Getting ready…', 'live');
        set(last ? `Updated ${ago(last)} · ${whenNext(s)}` : whenNext(s), 'ok');
    }
    const STARTERS = [
        ['What are you working on for us?', 'Your agency’s work, what is planned and what waits for you'],
        ['How are we doing this month so far?', 'Views, reach and followers, Instagram first, against the same days last month'],
        ['Which post did best last month?', 'Ranked by views, with the figures that back it'],
        ['When should we post?', 'By day and hour, from your own history'],
        ['How many followers did we gain this week?', 'Measured day by day, not estimated']
    ];
    const connectBtn = (label) => isOwner
        ? `<button class="btn-primary" type="button" data-connect>${escHtml(label)}</button>`
        : `<a class="btn-primary" style="display:inline-block;text-decoration:none" href="workspace.html?client=${encodeURIComponent(activeClient.id)}&tab=meta">Open this client’s Meta tab</a>`;
    function welcomeHtml() {
        const s = xpStatus;
        const phase = s && s.phase;
        if (phase === 'not_connected') {
            return `<div id="welcome" class="rise"><div class="oa-connect">
                <p><b>${isOwner ? 'Connect your Facebook Page and Instagram.' : 'This business has no Meta connected yet.'}</b> Edge Meta AI reads your own numbers
                   (every day, every post, every follower) and answers only from them. It takes one login with Facebook;
                   after that everything updates by itself.</p>
                ${connectBtn('Connect with Facebook')}
                <p class="oa-fine">Read only: nothing is posted and no messages are read. You can disconnect at any time, and what was read is then deleted.${appMode ? ' Your agency’s work, your to-dos, planned posts and reports are already in the row at the top.' : ''}</p>
            </div></div>`;
        }
        if (phase === 'reading' || (s && s.running && !hasData(s))) {
            const names = (s.assets || []).map(a => (a.platform === 'IG' ? 'Instagram ' : 'Facebook ') + (a.username ? '@' + a.username : a.name || '')).join(' and ');
            return `<div id="welcome" class="rise"><div class="oa-connect oa-reading">
                <div class="oa-pulse" aria-hidden="true"><i></i><i></i><i></i></div>
                <p><b>Reading your numbers${names ? ' from ' + escHtml(names) : ''}.</b> The first time, Edge Meta AI reads the last 90 days
                   and every post. It usually takes a few minutes; you can leave and come back. This page opens up by itself when it is done.</p>
            </div></div>`;
        }
        const banner = phase === 'reconnect'
            ? `<div class="oa-connect" style="margin-top:0"><p><b>Meta stopped letting us read your numbers.</b> This happens when a password changes or access runs out.
                 ${isOwner ? 'Reconnect once and everything carries on from where it stopped.' : 'Reconnect from the client’s Meta tab.'} Until then, answers use the numbers read before.</p>
                 ${connectBtn('Reconnect with Facebook')}</div>` : '';
        return `<div id="welcome" class="rise oa-welcome">
            <div class="mark"><img src="icons/logo-mark-lg.png?v=1" alt=""></div>
            <h2>What would you like to know?</h2>
            <p>Ask about your Instagram and Facebook: this month, last month, a single post or a single day. Every answer comes from your own numbers.</p>
            ${banner}
            <div class="starters">${STARTERS.map(([q, sub]) => `<button type="button" class="starter" data-q="${escHtml(q)}"><b>${escHtml(q)}</b><span>${escHtml(sub)}</span></button>`).join('')}</div>
        </div>`;
    }
    /**
     * The one thing an owner does: log in with Facebook. From the app, Meta sends
     * everyone back to EdgeLead's Home; the note left here brings them back to the app.
     */
    async function connectMeta(btn) {
        btn.disabled = true; btn.textContent = 'Opening Facebook…';
        try {
            const d = await EL.api('/api/meta/oauth/start');
            if (appMode) { try { localStorage.setItem('el-after-meta', JSON.stringify({ to: 'ai/', at: Date.now() })); } catch { /* private mode: they land on Home */ } }
            window.location.href = d.url;
        } catch (err) { btn.disabled = false; btn.textContent = 'Connect with Facebook'; if (!err.handled) EL.toast(err.message, 'bad'); }
    }

    // ---- composer (portal.js) -------------------------------------------------------
    const input = $('chat-input'), sendBtn = $('send-btn');
    function updateSendState() { sendBtn.disabled = chatBusy ? false : (input.disabled || !input.value.trim()); }
    function autoGrow() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 208)}px`; updateSendState(); }
    function setComposerBusy(busy) {
        sendBtn.innerHTML = busy ? ICON.stop : ICON.send;
        sendBtn.setAttribute('aria-label', busy ? 'Stop the answer' : 'Send');
        sendBtn.title = busy ? 'Stop' : 'Send';
        updateSendState();
    }
    function handleChatSubmit(e) {
        e.preventDefault();
        if (chatBusy) { if (abortCtl) abortCtl.abort(); return; }
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        autoGrow();
        ask(text);
    }
    const HINT_DEFAULT = 'Answers come from your own Instagram and Facebook data. The most recent days can still change.';
    function setQuestionsLeft(n) {
        const hint = $('composer-hint');
        if (typeof n !== 'number' || n > 10) { hint.textContent = HINT_DEFAULT; hint.classList.remove('warn'); return; }
        hint.textContent = n === 0 ? 'You have used today’s questions. The limit resets at midnight.' : `${n} question${n === 1 ? '' : 's'} left today.`;
        hint.classList.add('warn');
    }

    // ---- the turn templates ---------------------------------------------------------
    const userMsgHtml = (m) => `<div class="rise oa-user"><div class="user-bubble">${escHtml(m)}</div></div>`;
    const assistantShellHtml = (id) => `
        <div id="${id}" class="rise oa-turn">
            <div class="oa-avatar oa-thinking" data-avatar aria-hidden="true"><img src="icons/logo-mark-lg.png?v=1" alt=""></div>
            <div class="oa-body">
                <div data-status><span data-status-text class="shimmer-text">Thinking…</span></div>
                <div data-body class="answer"></div>
                <div data-panels></div>
                <div data-suggestions></div>
            </div>
        </div>`;
    const errorHtml = (msg, retry = true) => `
        <div class="rise oa-error" data-retry-wrap><div class="mark">!</div>
            <div>${escHtml(msg)}${retry ? '<button type="button" data-retry>Try again</button>' : ''}</div></div>`;
    function polishAnswer(el) {
        el.querySelectorAll('table').forEach((t) => {
            if (t.parentElement && t.parentElement.classList.contains('table-wrap')) return;
            const w = document.createElement('div'); w.className = 'table-wrap'; t.replaceWith(w); w.appendChild(t);
        });
        el.querySelectorAll('a[href]').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    }
    function renderSuggestions(host, suggestions) {
        const list = Array.isArray(suggestions) ? suggestions.filter((q) => typeof q === 'string' && q.trim()) : [];
        if (!list.length) return;
        host.innerHTML = `<div class="chips">${list.map((q) => `<button type="button" class="chip" data-q="${escHtml(q)}">${escHtml(q)}</button>`).join('')}</div>`;
    }

    // ---- ask: the streamed answer (portal.js, verbatim but for the endpoints) ------------
    async function ask(message, { echo = true } = {}) {
        message = String(message || '').trim();
        if (!message || !activeClient || chatBusy) return;
        const epoch = chatEpoch;
        chatBusy = true;
        lastQuestion = message;
        setComposerBusy(true);
        $('welcome')?.remove();

        const box = $('chat-box');
        box.querySelectorAll('[data-suggestions]').forEach((el) => { el.innerHTML = ''; });
        if (echo) box.insertAdjacentHTML('beforeend', userMsgHtml(message));
        const id = `a${Date.now()}`;
        box.insertAdjacentHTML('beforeend', assistantShellHtml(id));
        const root = $(id);
        const statusEl = root.querySelector('[data-status]');
        const statusText = root.querySelector('[data-status-text]');
        const bodyEl = root.querySelector('[data-body]');
        const panelsEl = root.querySelector('[data-panels]');
        const sugEl = root.querySelector('[data-suggestions]');
        scrollToBottom(true);

        let text = '', gotText = false, raf = 0;
        const render = () => { raf = 0; bodyEl.innerHTML = safeMarkdown(text); polishAnswer(bodyEl); scrollToBottom(); };
        const schedule = () => { if (!raf) raf = requestAnimationFrame(render); };
        const avatarEl = root.querySelector('[data-avatar]');
        const settle = () => avatarEl && avatarEl.classList.remove('oa-thinking');
        const firstText = () => { if (!gotText) { gotText = true; statusEl.remove(); settle(); } };
        const handleEvent = (type, data) => {
            if (epoch !== chatEpoch) return;
            if (type === 'status') { if (!gotText && statusText) statusText.textContent = `${data.label || 'Reading the data'}…`; }
            else if (type === 'delta') { if (data.text) { firstText(); text += data.text; schedule(); } }
            else if (type === 'done') {
                if (data.conversationId) conversationId = data.conversationId;
                if (data.reply && (!gotText || data.reply.length > text.length)) { firstText(); text = data.reply; }
                if (raf) { cancelAnimationFrame(raf); raf = 0; }
                render();
                renderPanels(panelsEl, data.charts);
                renderSuggestions(sugEl, data.suggestions);
                if ('remaining' in data) setQuestionsLeft(data.remaining);
                loadConversations();
                scrollToBottom();
            }
            else if (type === 'error') throw new Error(data.error || 'Something went wrong with that answer.');
        };

        abortCtl = new AbortController();
        const signal = abortCtl.signal;
        try {
            const body = JSON.stringify({ message, clientId: activeClient.id, conversationId });
            const res = await authFetch('/api/xp/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' }, body, signal });
            if (res.status >= 400 && res.status < 500) {
                const data = await res.json().catch(() => ({}));
                const refusal = new Error(data.error || `The question was refused (${res.status}).`);
                refusal.final = true;
                if (res.status === 429) setQuestionsLeft(0);
                throw refusal;
            }
            if (!res.ok || !res.body || !/text\/event-stream/.test(res.headers.get('content-type') || '')) {
                const r2 = await authFetch('/api/xp/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal });
                const data = await r2.json().catch(() => ({}));
                if (!r2.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : (data.error && data.error.message) || `Server error ${r2.status}`);
                if (!(data.reply || '').trim()) throw new Error('The answer came back empty. Please try again.');
                handleEvent('done', data);
            } else {
                const reader = res.body.getReader(), dec = new TextDecoder();
                let buf = '';
                while (true) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let idx;
                    while ((idx = buf.indexOf('\n\n')) >= 0) {
                        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
                        let type = 'message', dataLine = '';
                        for (const line of frame.split('\n')) {
                            if (line.startsWith('event:')) type = line.slice(6).trim();
                            else if (line.startsWith('data:')) dataLine += line.slice(5).trim();
                        }
                        if (!dataLine) continue;
                        let data = {};
                        try { data = JSON.parse(dataLine); } catch { continue; }
                        handleEvent(type, data);
                    }
                }
                if (!text.trim()) throw new Error('The answer came back empty. Please try again.');
            }
        } catch (err) {
            if (epoch !== chatEpoch) return;
            if (raf) { cancelAnimationFrame(raf); raf = 0; }
            if (err.name === 'AbortError') {
                if (text.trim()) { render(); bodyEl.insertAdjacentHTML('beforeend', '<p class="oa-stopped">Stopped.</p>'); }
                else root.remove();
            } else {
                if (!text.trim()) root.remove(); else statusEl.remove();
                if (activeClient) box.insertAdjacentHTML('beforeend', errorHtml(err.message || 'Something went wrong sending that message.', !err.final));
            }
            scrollToBottom();
        } finally {
            settle();
            if (epoch === chatEpoch) { chatBusy = false; abortCtl = null; setComposerBusy(false); }
        }
    }

    // ---- figure panels (portal.js) ----------------------------------------------------
    const PLAT = {
        IG: { color: '#f472b6', soft: 'rgba(244, 114, 182, 0.30)', fill: 'rgba(244, 114, 182, 0.16)' },
        FB: { color: '#60a5fa', soft: 'rgba(96, 165, 250, 0.30)', fill: 'rgba(96, 165, 250, 0.16)' },
        ADS: { color: '#fbbf24', soft: 'rgba(251, 191, 36, 0.30)', fill: 'rgba(251, 191, 36, 0.16)' }
    };
    const platColor = (pl) => PLAT[pl] || PLAT.IG;
    const chartPalette = () => ({ tipBg: '#0b1329', tipBorder: 'rgba(217,181,108,0.35)', tipTitle: '#f3efe4', tipBody: '#c3c9d6', tick: '#8a9a92', grid: 'rgba(255, 255, 255, 0.05)', fade: 'rgba(6, 20, 15, 0)', hole: '#06140f' });
    const platLabel = (sec) => `<div class="plat"><i style="background:${platColor(sec.platform).color}"></i><span>${escHtml(sec.name)}</span></div>`;
    const panelHead = (title, subtitle, right = '') => `
        <div class="panel-head"><div><div class="panel-title">${escHtml(title)}</div>${subtitle ? `<div class="panel-sub">${escHtml(subtitle)}</div>` : ''}</div>
        ${right ? `<div class="panel-right">${right}</div>` : ''}</div>`;
    const runningPill = '<span class="pill pill-live"><span class="live-dot"></span>Still running</span>';

    function chartLibReady() {
        if (window.Chart) return Promise.resolve(true);
        const tag = $('chartjs');
        return new Promise((resolve) => {
            const done = () => resolve(!!window.Chart);
            if (tag) { tag.addEventListener('load', done, { once: true }); tag.addEventListener('error', done, { once: true }); }
            setTimeout(done, 4000);
        });
    }
    async function renderPanels(host, panels) {
        if (!Array.isArray(panels) || !panels.length) return;
        if (panels.some((p) => p.kind === 'chart')) await chartLibReady();
        if (!host.isConnected) return;
        for (const p of panels) {
            try {
                const el = document.createElement('section');
                el.className = 'panel rise';
                if (p.kind === 'summary') el.innerHTML = summaryHtml(p);
                else if (p.kind === 'compare') el.innerHTML = compareHtml(p);
                else if (p.kind === 'ranking') el.innerHTML = rankingHtml(p);
                else if (p.kind === 'chart') el.innerHTML = chartShellHtml(p);
                else continue;
                host.appendChild(el);
                if (p.kind === 'chart') mountCharts(el, p);
            } catch (e) { console.warn('[panel]', e); }
        }
    }
    function summaryTile(t) {
        if (t.value === null || t.value === undefined) {
            return `<div class="tile"><div class="tile-label">${escHtml(t.label)}</div><div class="tile-value"><span class="dim">—</span></div><div class="tile-foot">${escHtml(t.empty || 'not tracked')}</div></div>`;
        }
        let value = fmtV(t.value, t.format, t.currency), foot = '';
        if (t.sub && t.sub.value !== null && t.sub.value !== undefined) foot = `${fmtV(t.sub.value, t.sub.format, t.sub.currency)} ${escHtml(t.sub.suffix || '')}`;
        if (t.key === 'followers') {
            if (t.estimated) value += '<span class="badge-est" title="Estimated from the days around it, not read from Meta">est</span>';
            if (t.net !== null && t.net !== undefined) {
                const cls = t.net > 0 ? 'up' : t.net < 0 ? 'down' : '';
                foot = `<span class="${cls}">${t.net > 0 ? '+' : ''}${fmtN(t.net)}</span> net${t.net_estimated ? ' · est' : ''}`;
            }
        } else if (t.days !== undefined && t.of && t.days < t.of) {
            foot = `<span class="warn">${fmtN(t.days)} of ${fmtN(t.of)} days</span>`;
        }
        return `<div class="tile"><div class="tile-label">${escHtml(t.label)}</div><div class="tile-value">${value}</div>${foot ? `<div class="tile-foot">${foot}</div>` : ''}</div>`;
    }
    function summaryHtml(p) {
        return panelHead(p.title, p.subtitle || 'Headline figures', p.running ? runningPill : '') + p.sections.map((sec) => `
            <div class="sec"><div class="sec-head">${platLabel(sec)}</div>
                <div class="tiles">${sec.tiles.map(summaryTile).join('')}</div>
                ${sec.note ? `<p class="sec-note ${sec.note_warn ? 'warn' : 'up'}">${escHtml(sec.note)}</p>` : ''}
            </div>`).join('');
    }
    function changePill(t) {
        if (!t.direction) return '';
        if (t.direction === 'flat') return '<span class="pill pill-flat">no change</span>';
        const arrow = t.direction === 'up' ? '▲' : '▼';
        const cls = t.neutral ? 'pill-flat' : t.direction === 'up' ? 'pill-up' : 'pill-down';
        if (t.change_pct !== null && t.change_pct !== undefined) return `<span class="pill ${cls}">${arrow} ${Math.abs(t.change_pct).toLocaleString('en-US', { maximumFractionDigits: 1 })}%</span>`;
        if (t.change !== null && t.change !== undefined) return `<span class="pill ${cls}">${arrow} ${fmtV(Math.abs(t.change), t.format, t.currency)}</span>`;
        return '';
    }
    function candles(t, curLabel, prevLabel) {
        const max = Math.max(t.current || 0, t.previous || 0);
        const height = (v) => (v <= 0 || max <= 0 ? '2px' : `${Math.max(6, Math.round((v / max) * 100))}%`);
        const curCls = t.neutral ? 'c-flat' : t.direction === 'up' ? 'c-up' : t.direction === 'down' ? 'c-down' : 'c-flat';
        const bar = (v, cls, label) => (v === null || v === undefined
            ? `<div class="candle c-none" title="${escHtml(label)}: not tracked"></div>`
            : `<div class="candle ${cls}" style="height:${height(v)}" title="${escHtml(label)}: ${escHtml(fmtV(v, t.format, t.currency))}"></div>`);
        return `<div class="candles" aria-hidden="true">${bar(t.previous, 'c-prev', prevLabel)}${bar(t.current, curCls, curLabel)}</div>`;
    }
    function compareTile(t, curLabel, prevLabel) {
        const gap = (d, of) => d !== null && d !== undefined && of && d < of;
        const partial = [];
        if (gap(t.current_days, t.current_of) && gap(t.previous_days, t.previous_of) && t.current_days === t.previous_days && t.current_of === t.previous_of) {
            partial.push(`${t.current_days} of ${t.current_of} days in each period`);
        } else {
            if (gap(t.current_days, t.current_of)) partial.push(`${curLabel}: ${t.current_days} of ${t.current_of} days`);
            if (gap(t.previous_days, t.previous_of)) partial.push(`${prevLabel}: ${t.previous_days} of ${t.previous_of} days`);
        }
        const was = t.previous === null || t.previous === undefined ? `${escHtml(prevLabel)}: not tracked` : `was ${fmtV(t.previous, t.format, t.currency)}`;
        return `<div class="tile">
            <div class="tile-top"><div class="tile-label">${escHtml(t.label)}</div>${changePill(t)}</div>
            <div class="tile-mid"><div style="min-width:0">
                <div class="tile-value">${t.current === null || t.current === undefined ? '<span class="dim">—</span>' : fmtV(t.current, t.format, t.currency)}</div>
                <div class="tile-foot">${t.current === null || t.current === undefined ? 'not tracked' : was}</div></div>
                ${candles(t, curLabel, prevLabel)}</div>
            ${partial.length ? `<div class="tile-foot warn">${escHtml(partial.join(' · '))}</div>` : ''}
        </div>`;
    }
    function compareHtml(p) {
        const curLabel = p.current.label, prevLabel = p.previous.label;
        const legend = `<span class="legend"><span class="swatch c-prev"></span>${escHtml(prevLabel)}</span>
            <span class="legend"><span class="swatch" style="background:linear-gradient(90deg,#34d399 50%,#fb7185 50%)"></span>${escHtml(curLabel)}</span>${p.current.running ? runningPill : ''}`;
        return panelHead(p.title, 'This period against the one before', legend) + p.sections.map((sec) => `
            <div class="sec"><div class="sec-head">${platLabel(sec)}</div>
                <div class="tiles compare">${sec.tiles.map((t) => compareTile(t, curLabel, prevLabel)).join('')}</div></div>`).join('')
            + (p.note ? `<p class="panel-note">${escHtml(p.note)}</p>` : '');
    }
    function rankingHtml(p) {
        const max = Math.max(1, ...p.items.map((i) => i.value || 0));
        return panelHead(p.title, p.subtitle) + `<ol class="rank-list">${p.items.map((it, i) => {
            const text = escHtml(it.text);
            const title = it.url ? `<a href="${escHtml(it.url)}" target="_blank" rel="noopener noreferrer">${text}</a>` : text;
            return `<li><span class="rank">${i + 1}</span><div class="rank-body">
                <div class="rank-line"><div class="rank-text">${title}</div><div class="rank-val">${escHtml(fmtV(it.value, p.value_format, p.currency))}</div></div>
                <div class="rank-bar"><i style="width:${Math.max(2, Math.round(((it.value || 0) / max) * 100))}%;background:${platColor(it.platform).color}"></i></div>
                <div class="rank-meta">${escHtml([it.name, it.format, it.date].filter(Boolean).join(' · '))}</div></div></li>`;
        }).join('')}</ol>`;
    }
    function chartShellHtml(p) {
        const faded = p.sections.some((s) => (s.faded || []).some(Boolean));
        const hollow = p.sections.some((s) => s.series.some((x) => (x.hollow || []).some(Boolean)));
        const notes = [faded ? p.faded_note : '', hollow ? p.hollow_note : '', p.note || ''].filter(Boolean);
        return panelHead(p.title, p.subtitle) + p.sections.map((sec, si) => `
            <div class="sec" data-sec="${si}"><div class="sec-head">${platLabel(sec)}
                ${sec.series.length > 1 ? `<div class="seg">${sec.series.map((s, i) => `<button type="button" data-series="${i}" class="${i === 0 ? 'on' : ''}">${escHtml(s.label)}</button>`).join('')}</div>` : ''}</div>
                <div class="chart-box"><canvas role="img" aria-label="${escHtml(`${sec.name}: ${sec.series[0].label}`)}"></canvas></div></div>`).join('')
            + (notes.length ? `<p class="panel-note">${escHtml(notes.join(' '))}</p>` : '');
    }
    function chartDataset(type, sec, s) {
        const col = platColor(sec.platform);
        if (type === 'line') {
            const hollow = s.hollow || [];
            return {
                data: s.values, borderColor: col.color, borderWidth: 2, tension: 0.32, spanGaps: false, fill: true,
                backgroundColor: (ctx) => {
                    const area = ctx.chart.chartArea;
                    if (!area) return col.fill;
                    const g = ctx.chart.ctx.createLinearGradient(0, area.top, 0, area.bottom);
                    g.addColorStop(0, col.fill); g.addColorStop(1, chartPalette().fade);
                    return g;
                },
                pointRadius: s.values.length > 45 ? 0 : 2.6, pointHoverRadius: 4.5, pointBorderWidth: 1.6,
                pointBackgroundColor: s.values.map((_, i) => (hollow[i] ? chartPalette().hole : col.color)), pointBorderColor: col.color,
                segment: { borderDash: (ctx) => (hollow[ctx.p0DataIndex] || hollow[ctx.p1DataIndex] ? [4, 4] : undefined) }
            };
        }
        const faded = sec.faded || [];
        return { data: s.values, backgroundColor: s.values.map((_, i) => (faded[i] ? col.soft : col.color)), hoverBackgroundColor: col.color,
            borderRadius: 5, borderSkipped: 'bottom', maxBarThickness: 34, categoryPercentage: 0.8, barPercentage: 0.9 };
    }
    function mountCharts(card, p) {
        p.sections.forEach((sec, si) => {
            const wrap = card.querySelector(`[data-sec="${si}"]`);
            const box = wrap.querySelector('.chart-box');
            const chips = [...wrap.querySelectorAll('[data-series]')];
            let current = sec.series[0];
            if (!window.Chart) {
                fallbackBars(box, sec, current);
                chips.forEach((b) => b.addEventListener('click', () => { current = sec.series[Number(b.dataset.series)]; fallbackBars(box, sec, current); chips.forEach((x) => x.classList.toggle('on', x === b)); }));
                return;
            }
            Chart.defaults.font.family = "'Anek Latin', system-ui, sans-serif";
            const pal = chartPalette();
            const chart = new Chart(box.querySelector('canvas'), {
                type: p.type === 'line' ? 'line' : 'bar',
                data: { labels: sec.labels, datasets: [chartDataset(p.type, sec, current)] },
                options: {
                    responsive: true, maintainAspectRatio: false,
                    animation: { duration: 450, easing: 'easeOutQuart' },
                    interaction: { mode: 'index', intersect: false },
                    layout: { padding: { top: 4 } },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: pal.tipBg, borderColor: pal.tipBorder, borderWidth: 1, padding: 10, cornerRadius: 10,
                            titleColor: pal.tipTitle, bodyColor: pal.tipBody, titleFont: { weight: '600', size: 12 }, bodyFont: { size: 12 }, displayColors: false,
                            callbacks: {
                                title: (items) => (sec.hints && sec.hints[items[0].dataIndex]) || items[0].label,
                                label: (item) => {
                                    const i = item.dataIndex, v = item.raw;
                                    const bits = [`${current.label}: ${v === null || v === undefined ? 'not tracked' : fmtN(v)}`];
                                    if (sec.faded && sec.faded[i]) bits.push('Meta is still counting this day');
                                    if (current.hollow && current.hollow[i]) bits.push('estimated');
                                    if (sec.notes && sec.notes[i]) bits.push(sec.notes[i]);
                                    return bits;
                                }
                            }
                        }
                    },
                    scales: {
                        x: { grid: { display: false }, border: { display: false }, ticks: { color: pal.tick, font: { size: 11 }, maxRotation: 0, autoSkip: true, autoSkipPadding: 14 } },
                        y: { beginAtZero: p.type !== 'line', grace: p.type === 'line' ? '6%' : 0, grid: { color: pal.grid, drawTicks: false }, border: { display: false },
                             ticks: { color: pal.tick, font: { size: 11 }, padding: 8, maxTicksLimit: 5, precision: 0, callback: (v) => fmtCompact(v) } }
                    }
                }
            });
            liveCharts.push(chart);
            chips.forEach((b) => b.addEventListener('click', () => {
                current = sec.series[Number(b.dataset.series)];
                chart.data.datasets = [chartDataset(p.type, sec, current)];
                chart.update();
                chips.forEach((x) => x.classList.toggle('on', x === b));
            }));
        });
    }
    function fallbackBars(box, sec, s) {
        const vals = s.values.filter((v) => v !== null && v !== undefined);
        const max = Math.max(1, ...vals);
        const col = platColor(sec.platform).color;
        box.innerHTML = `<div class="fallback-bars">${s.values.map((v) => `<i style="height:${v === null || v === undefined ? 0 : Math.max(1, Math.round((v / max) * 100))}%;background:${col}"></i>`).join('')}</div>`;
    }

    // ---- recent chats (portal.js) -------------------------------------------------------
    function resetChat() {
        chatEpoch++;
        if (abortCtl) { try { abortCtl.abort(); } catch { /* finished */ } }
        abortCtl = null; chatBusy = false; conversationId = null;
        while (liveCharts.length) { try { liveCharts.pop().destroy(); } catch { /* gone */ } }
        $('chat-box').innerHTML = welcomeHtml();
        setComposerBusy(false);
        stick = true;
        scroller().scrollTop = 0;
        updateToBottom();
    }
    function newChat() {
        resetChat();
        markActiveConversation();
        if (!isDesktop()) $('oa-side').classList.remove('is-open');
        if (!isTouch()) input.focus();
    }
    async function loadConversations() {
        const host = $('chat-history');
        if (!activeClient) return;
        const editing = () => { if (host.querySelector('.conv-edit')) { convReloadPending = true; return true; } return false; };
        if (editing()) return;
        try {
            const res = await authFetch('/api/xp/chat/' + encodeURIComponent(activeClient.id) + '/conversations');
            const data = await res.json();
            const list = (data.conversations || []).slice(0, 25);
            if (editing()) return;
            closeConvMenu();
            if (!list.length) { host.innerHTML = '<p class="oa-note" style="text-align:left;margin:0 4px">No chats yet.</p>'; return; }
            host.innerHTML = list.map((c) => {
                const when = new Date(c.updated_at || c.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
                return `<div class="conv-item">
                    <button type="button" class="conv-row${c.id === conversationId ? ' on' : ''}" data-conv="${escHtml(c.id)}" title="${escHtml(c.title || '')}">
                        <span data-name>${escHtml(c.title || 'Conversation')}</span><span class="conv-when">${escHtml(when)}</span></button>
                    <button type="button" class="conv-more" data-conv-menu="${escHtml(c.id)}" aria-haspopup="menu" aria-expanded="false" aria-controls="conv-menu" title="Rename or delete" aria-label="Rename or delete this chat">${ICON.more}</button>
                </div>`;
            }).join('');
        } catch { /* the chat works without the list */ }
    }
    function markActiveConversation() {
        document.querySelectorAll('#chat-history .conv-row').forEach((b) => b.classList.toggle('on', !!conversationId && b.dataset.conv === conversationId));
    }
    async function openConversation(id) {
        if (!activeClient || !id) return;
        resetChat();
        const epoch = chatEpoch;
        if (!isDesktop()) $('oa-side').classList.remove('is-open');
        const box = $('chat-box');
        box.innerHTML = '<p class="oa-note" style="padding-top:40px">Opening the chat…</p>';
        try {
            const res = await authFetch('/api/xp/chat/' + encodeURIComponent(activeClient.id) + '/conversations/' + encodeURIComponent(id));
            const data = await res.json().catch(() => ({}));
            if (epoch !== chatEpoch) return;
            if (!res.ok) throw new Error(data.error || 'Could not open that chat.');
            box.innerHTML = '';
            conversationId = data.id;
            for (const m of data.messages || []) {
                if (m.role === 'user') { box.insertAdjacentHTML('beforeend', userMsgHtml(m.content)); continue; }
                const aid = `h${Math.random().toString(36).slice(2)}`;
                box.insertAdjacentHTML('beforeend', assistantShellHtml(aid));
                const root = $(aid);
                root.querySelector('[data-status]').remove();
                root.querySelector('[data-avatar]')?.classList.remove('oa-thinking');
                const body = root.querySelector('[data-body]');
                body.innerHTML = safeMarkdown(m.content || '');
                polishAnswer(body);
                renderPanels(root.querySelector('[data-panels]'), m.charts);
                if (m.suggestions) renderSuggestions(root.querySelector('[data-suggestions]'), m.suggestions);
            }
            markActiveConversation();
            scrollToBottom(true);
            if (!isTouch()) input.focus();
        } catch (err) {
            if (epoch !== chatEpoch) return;
            box.innerHTML = welcomeHtml();
            box.insertAdjacentHTML('beforeend', errorHtml(err.message || 'Could not open that chat.', false));
        }
    }
    async function deleteConversation(id) {
        if (!activeClient || !id) return;
        if (!confirm('Delete this chat? It will be removed from your list.')) return;
        try {
            const res = await authFetch('/api/xp/chat/' + encodeURIComponent(activeClient.id) + '/conversations/' + encodeURIComponent(id), { method: 'DELETE' });
            if (!res.ok && res.status !== 404) throw new Error('Could not delete that chat. Please try again.');
            if (id === conversationId) newChat();
            loadConversations();
        } catch (err) { alert(err.message || 'Could not delete that chat.'); }
    }
    function closeConvMenu(refocus) {
        const m = $('conv-menu');
        if (m.classList.contains('hidden')) return;
        m.classList.add('hidden');
        const btn = convMenuFor && document.querySelector(`#chat-history [data-conv-menu="${CSS.escape(convMenuFor)}"]`);
        if (btn) { btn.setAttribute('aria-expanded', 'false'); if (refocus) btn.focus(); }
        convMenuFor = null;
    }
    function toggleConvMenu(btn, fromKeyboard) {
        const id = btn.dataset.convMenu, again = convMenuFor === id;
        closeConvMenu();
        if (again) return;
        const m = $('conv-menu');
        convMenuFor = id;
        m.classList.remove('hidden');
        btn.setAttribute('aria-expanded', 'true');
        const r = btn.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
        m.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
        m.style.top = `${r.bottom + 4 + h <= window.innerHeight - 8 ? r.bottom + 4 : Math.max(8, r.top - h - 4)}px`;
        if (fromKeyboard) m.querySelector('[role="menuitem"]').focus();
    }
    function renameConversation(id) {
        const row = id && document.querySelector(`#chat-history .conv-row[data-conv="${CSS.escape(id)}"]`);
        if (!row || !activeClient) return;
        const item = row.closest('.conv-item'), name = row.querySelector('[data-name]');
        const old = row.getAttribute('title') || name.textContent;
        const field = document.createElement('input');
        Object.assign(field, { type: 'text', className: 'conv-edit', value: old, maxLength: 80, autocomplete: 'off', spellcheck: false });
        field.setAttribute('aria-label', 'Chat name');
        item.classList.add('editing');
        item.prepend(field);
        field.focus(); field.select();
        let done = false;
        const finish = async (save, refocus) => {
            if (done) return;
            done = true;
            const title = field.value.replace(/\s+/g, ' ').trim();
            try {
                if (save && field.isConnected && activeClient && title && title !== old) {
                    field.disabled = true;
                    const res = await authFetch('/api/xp/chat/' + encodeURIComponent(activeClient.id) + '/conversations/' + encodeURIComponent(id), {
                        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title })
                    });
                    const data = await res.json().catch(() => ({}));
                    if (!res.ok) throw new Error(data.error || 'Could not rename that chat. Please try again.');
                    row.setAttribute('title', data.title || title);
                    name.textContent = data.title || title;
                }
            } catch (err) { alert(err.message || 'Could not rename that chat.'); }
            finally {
                field.remove();
                item.classList.remove('editing');
                if (refocus && row.isConnected) row.focus();
                if (convReloadPending) { convReloadPending = false; loadConversations(); }
            }
        };
        field.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); finish(true, true); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false, true); }
        });
        field.addEventListener('blur', () => finish(true, false));
    }
})();
