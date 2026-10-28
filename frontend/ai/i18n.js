// Edge Meta AI in English or বাংলা (phase 83), as in the Owner Assistant's i18n.js. Loaded in the page head.
// The app is written in English; this file swaps each English text for its Bangla as the page draws it, so the
// rest of the code stays as it was. What people wrote themselves is never touched: questions, answers (the
// assistant answers in Bangla itself: the chat sends lang), chat titles, names, the agency's to-dos and posts.
//
// The words live in ai/i18n-bn.js, keyed by the English text. A changing part is written {1}, {2}, …; a sentence
// with bold or linked words inside it is one key, the inline parts written <0>…</0>, <1>…</1>, so a translation
// can put them where its grammar needs them.
//
// The choice is kept on this device (ema_lang); until one is made, a browser set to Bangla gets Bangla. Switching
// back to English reloads the page, because the English is not kept once it has been replaced.
(function () {
  'use strict';
  const LANGS = { en: { name: 'English', locale: 'en-US' }, bn: { name: 'বাংলা', locale: 'bn-BD' } };
  const KEY = 'ema_lang';
  // never translated: people's own words, the brand, code, and what is typed
  const SKIP = '.user-bubble, .answer, [data-no-i18n], [data-name], .oa-name, .oa-by, .ai-title, #acct-name, #acct-sub, .hub-prof-mail, script, style, textarea, pre, code';
  const INLINE = new Set(['STRONG', 'B', 'EM', 'I', 'A', 'CODE', 'SPAN', 'KBD', 'BR', 'SMALL', 'U']);
  const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];

  const stored = (() => { try { return localStorage.getItem(KEY); } catch { return null; } })();
  const fromBrowser = /^bn\b/i.test(navigator.language || '') ? 'bn' : 'en';
  let lang = LANGS[stored] ? stored : fromBrowser;
  let exact = new Map(), patterns = [], ready = false, observer = null;

  const norm = (s) => s.replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function compile(dict) {
    exact = new Map(); patterns = [];
    for (const [en, tr] of Object.entries(dict)) {
      if (typeof tr !== 'string' || !tr) continue;
      const k = norm(en);
      if (/\{\d+\}/.test(k)) patterns.push({ re: new RegExp('^' + esc(k).replace(/\\\{\d+\\\}/g, '([\\s\\S]+?)') + '$'), tr });
      else exact.set(k, tr);
    }
    // longer keys first, so "Saved on {1}." beats "Saved {1}"
    patterns.sort((a, b) => b.re.source.length - a.re.source.length);
  }

  // One text, exact or with its changing parts; a "A · B" line part by part.
  function lookup(s) {
    const k = norm(s);
    if (!k) return null;
    if (exact.has(k)) return exact.get(k);
    for (const p of patterns) {
      const m = k.match(p.re);
      if (m) return p.tr.replace(/\{(\d+)\}/g, (_, i) => fill(m[Number(i)]));
    }
    if (k.includes(' · ')) {
      // a part that is one bold word ("<0>overdue since Oct 25</0>") is translated inside its marks
      const part = (x) => { const w = x.match(/^<(\d+)>([\s\S]*)<\/\1>$/); return w ? `<${w[1]}>${lookup(w[2]) || w[2]}</${w[1]}>` : (lookup(x) || x); };
      const parts = k.split(' · ').map(part);
      const joined = parts.join(' · ');
      return joined !== k ? joined : null;
    }
    return null;
  }
  // A filled-in part that is itself an interface word ("reach", "Reels") is translated too.
  function fill(v) {
    if (v === undefined) return '';
    const k = norm(v);
    if (!k || /\d/.test(k)) return v;
    const cap = k.charAt(0).toUpperCase() + k.slice(1);
    return exact.get(k) || exact.get(cap) || v;
  }
  function t(s) { if (lang === 'en' || !ready || typeof s !== 'string') return s; const r = lookup(s); return r === null ? s : r; }

  const skipped = (el) => !!(el && el.closest && el.closest(SKIP));

  function textNode(n) {
    const v = n.nodeValue;
    if (!v || !/[A-Za-z]/.test(v) || skipped(n.parentElement)) return;
    const r = lookup(v);
    if (r === null) return;
    const lead = v.match(/^\s*/)[0], trail = v.match(/\s*$/)[0];
    const next = lead + r + trail;
    if (next !== v) n.nodeValue = next;
  }

  // A sentence with inline words: the element's own text and its simple inline children, as one key.
  function block(el) {
    if (skipped(el)) return false;
    let hasText = false, hasInline = false;
    for (const c of el.childNodes) {
      if (c.nodeType === 3) { if (/[A-Za-z]/.test(c.nodeValue)) hasText = true; continue; }
      if (c.nodeType !== 1) continue;
      if (!INLINE.has(c.tagName) || c.children.length) return false;
      hasInline = true;
    }
    if (!hasText || !hasInline) return false;
    let n = 0, key = '';
    const inl = [];
    for (const c of el.childNodes) {
      if (c.nodeType === 3) key += c.nodeValue;
      else if (c.nodeType === 1) { key += `<${n}>${c.tagName === 'BR' ? '' : c.textContent}</${n}>`; inl.push(c); n++; }
    }
    const r = lookup(key);
    if (r === null) return false;
    const frag = document.createDocumentFragment();
    const re = /<(\d+)>([\s\S]*?)<\/\1>/g;
    let last = 0, m;
    while ((m = re.exec(r))) {
      if (m.index > last) frag.appendChild(document.createTextNode(r.slice(last, m.index)));
      const node = inl[Number(m[1])];
      if (node) { if (node.tagName !== 'BR') node.textContent = m[2]; frag.appendChild(node); }
      last = re.lastIndex;
    }
    if (last < r.length) frag.appendChild(document.createTextNode(r.slice(last)));
    el.textContent = '';
    el.appendChild(frag);
    return true;
  }

  function attrs(el) {
    // a text box's own hint is translated; what is typed in it never is
    if (skipped(el.tagName === 'TEXTAREA' ? el.parentElement : el)) return;
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v || !/[A-Za-z]/.test(v)) continue;
      const r = lookup(v);
      if (r !== null && r !== v) el.setAttribute(a, r);
    }
  }

  function apply(root) {
    if (lang === 'en' || !ready || !root) return;
    if (root.nodeType === 3) { textNode(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    const start = root.nodeType === 9 ? root.body : root;
    if (!start) return;
    const done = new Set();
    const els = [start, ...start.querySelectorAll('*')];
    for (const el of els) {
      attrs(el);   // checks its own skipping, so a text box's hint is still translated
      if (skipped(el)) continue;
      if (el.parentElement && done.has(el.parentElement)) continue;   // already part of a translated sentence
      if (block(el)) { done.add(el); continue; }
      for (const c of el.childNodes) if (c.nodeType === 3) textNode(c);
    }
  }

  function watch() {
    if (observer || lang === 'en') return;
    observer = new MutationObserver((muts) => {
      const seen = new Set();
      for (const m of muts) {
        if (m.type === 'characterData') { textNode(m.target); continue; }
        if (m.type === 'attributes') { attrs(m.target); continue; }
        // the whole sentence first, so its pieces are not translated one by one
        if (m.target && m.target.nodeType === 1 && !seen.has(m.target)) { seen.add(m.target); if (block(m.target)) continue; }
        for (const n of m.addedNodes) apply(n);
      }
      observer.takeRecords();   // our own changes
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  function start() {
    ready = true;
    document.documentElement.lang = lang;
    if (document.body) apply(document.body);
    watch();
    document.documentElement.classList.remove('i18n-wait');
  }

  function load(l, done) {
    if (l === 'en') { ready = true; document.documentElement.classList.remove('i18n-wait'); return done && done(); }
    const have = window.I18N_DICTS && window.I18N_DICTS[l];
    if (have) { compile(have); start(); return done && done(); }
    const s = document.createElement('script');
    // the page's <base> makes this the site's ai/ folder, wherever the page is opened from
    s.src = `ai/i18n-${l}.js?v=2`;
    s.onload = () => { compile((window.I18N_DICTS || {})[l] || {}); start(); if (done) done(); };
    s.onerror = () => { ready = true; document.documentElement.classList.remove('i18n-wait'); };
    document.head.appendChild(s);
  }

  // A question the app asks with confirm(), or tells with alert(), is translated too.
  const nativeConfirm = window.confirm.bind(window), nativeAlert = window.alert.bind(window);
  window.confirm = (m) => nativeConfirm(t(String(m)));
  window.alert = (m) => nativeAlert(t(String(m)));

  window.ELLang = {
    LANGS,
    current: () => lang,
    locale: () => LANGS[lang].locale,
    t,
    // A new choice: kept on the device; shown at once when leaving English, else the page reloads.
    set(l) {
      if (!LANGS[l] || l === lang) return false;
      try { localStorage.setItem(KEY, l); } catch { /* this visit only */ }
      if (lang !== 'en') { location.reload(); return true; }
      lang = l;
      document.documentElement.classList.add('i18n-wait');
      load(l);
      return true;
    }
  };

  document.documentElement.lang = lang;
  if (lang !== 'en') {
    // Hidden for a moment until the words arrive, so English does not flash first (never longer than 1.5 s).
    document.documentElement.classList.add('i18n-wait');
    setTimeout(() => document.documentElement.classList.remove('i18n-wait'), 1500);
    const go = () => load(lang);
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  } else ready = true;
})();
