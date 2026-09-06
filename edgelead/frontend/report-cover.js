/* =========================================================================
   EDGELEAD — SHARED REPORT COVER + PDF EXPORT
   -------------------------------------------------------------------------
   One cover page for every report (IG audit, IG benchmark, FB page, FB
   community) and one PDF exporter that all four pages call, so the blank
   first page and the scroll-offset capture are fixed in one place.

   Load after app.css and before the page's own <script>:
       <script src="report-cover.js"></script>

   API (window.ELCover):
     ELCover.html({ kind, target, sub, stats, elapsedSec, date, preparedFor })
         → cover markup string. Prepend it to the report paper.
     ELCover.exportPdf(node, filename, { format: 'letter'|'a4', margin })
         → Promise. Sizes the cover to exactly one page, forces a break
           after it, captures from scroll 0, then restores the screen layout.
   ========================================================================= */
(function () {
    'use strict';

    const CSS = `
.el-cover { position:relative; display:flex; flex-direction:column; min-height:640px;
    padding:40px 44px 36px 60px; margin:-34px -34px 30px; background:#0b1329;
    border-radius:16px 16px 0 0; overflow:hidden; color:#fff; }
.el-cover::before { content:""; position:absolute; left:34px; top:40px; bottom:36px; width:3px;
    background:linear-gradient(180deg,#3b82f6 0%,#8b5cf6 100%); border-radius:2px; }
.el-cover .ec-brand { display:flex; justify-content:space-between; align-items:baseline; gap:16px; }
.el-cover .ec-brand strong { font-size:0.95rem; font-weight:800; letter-spacing:-0.01em; }
.el-cover .ec-brand span { font-size:0.82rem; color:#94a3b8; }
.el-cover .ec-kind { margin-top:56px; font-size:0.95rem; font-weight:600; color:#60a5fa; }
.el-cover .ec-target { margin-top:8px; font-size:clamp(2.2rem, 6vw, 4.1rem); font-weight:800;
    line-height:1.02; letter-spacing:-0.035em; word-break:break-word; max-width:16ch; }
.el-cover .ec-sub { margin-top:14px; font-size:1rem; color:#94a3b8; max-width:60ch; }
.el-cover .ec-what { margin-top:34px; max-width:58ch; font-size:1.02rem; line-height:1.6; color:#e2e8f0; }
.el-cover .ec-what p + p { margin-top:10px; }
.el-cover .ec-spacer { flex:1 1 auto; min-height:28px; }
.el-cover .ec-receipt { display:grid; grid-template-columns:repeat(auto-fit, minmax(120px, 1fr));
    border-top:1px solid rgba(255,255,255,0.12); border-bottom:1px solid rgba(255,255,255,0.12); }
.el-cover .ec-receipt div { padding:14px 14px 14px 0; border-right:1px solid rgba(255,255,255,0.08); }
.el-cover .ec-receipt div + div { padding-left:14px; }
.el-cover .ec-receipt div:last-child { border-right:0; }
.el-cover .ec-receipt b { display:block; font-family:'JetBrains Mono', monospace; font-weight:600;
    font-size:1.55rem; letter-spacing:-0.02em; }
.el-cover .ec-receipt small { display:block; margin-top:3px; font-size:0.74rem; color:#94a3b8; }
.el-cover .ec-foot { display:flex; justify-content:space-between; gap:16px; flex-wrap:wrap;
    margin-top:18px; font-size:0.8rem; color:#94a3b8; }
.el-cover .ec-foot b { color:#fff; font-weight:600; }
.report-paper.pdf-mode { border-radius:0; border:0; }
.report-paper.pdf-mode .el-cover { border-radius:0; page-break-after:always; break-after:page; }
.report-paper.pdf-mode table, .report-paper.pdf-mode .kpi-grid, .report-paper.pdf-mode .kpi-box,
.report-paper.pdf-mode .works, .report-paper.pdf-mode .ai-panel h4, .report-paper.pdf-mode tr
    { page-break-inside:avoid; break-inside:avoid; }
.report-paper.pdf-mode h2, .report-paper.pdf-mode h3 { page-break-after:avoid; break-after:avoid; }
@media (max-width: 640px) { .el-cover { padding:28px 22px 24px 40px; margin:-20px -20px 22px; }
    .el-cover::before { left:18px; } }
`;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);

    const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const num = n => (n == null || isNaN(n)) ? '—' : Number(n).toLocaleString();
    const fmtDate = d => new Date(d || Date.now()).toLocaleDateString(undefined,
        { day: 'numeric', month: 'long', year: 'numeric' });

    function elapsedText(sec) {
        if (!sec || sec <= 0) return null;
        if (sec < 90) return `${Math.round(sec)} seconds`;
        const m = Math.round(sec / 60);
        return `${m} minute${m === 1 ? '' : 's'}`;
    }

    /**
     * kind        'Facebook community report' etc.
     * target      the room / page / handle — this is the hero
     * sub         one line under the target (window, mode, location)
     * stats       [{ value, label }] — the measurement receipt, 3–5 items
     * elapsedSec  run time if known; drives the speed sentence
     * date        ISO or Date
     * preparedFor optional name
     * what        optional array of sentences replacing the default copy
     */
    function html(o) {
        const stats = (o.stats || []).filter(s => s && s.value != null && s.value !== '');
        const el = elapsedText(o.elapsedSec);
        const what = o.what || [
            `EdgeLead read every public post in the window, scored each one against its own room's median so formats and framings are compared fairly, and pulled out the buying signals people posted in plain sight.`,
            el ? `The whole run — scraping, scoring, ranking and the written strategy — took ${el}. The same work by hand takes a strategist most of a day.`
               : `The whole run — scraping, scoring, ranking and the written strategy — completes in minutes. The same work by hand takes a strategist most of a day.`
        ];
        return `<section class="el-cover">
  <div class="ec-brand"><strong>EdgeLead</strong><span>Social intelligence, measured</span></div>
  <div class="ec-kind">${esc(o.kind || 'Report')}</div>
  <h1 class="ec-target">${esc(o.target || 'Report')}</h1>
  ${o.sub ? `<p class="ec-sub">${esc(o.sub)}</p>` : ''}
  <div class="ec-what">${what.map(p => `<p>${esc(p)}</p>`).join('')}</div>
  <div class="ec-spacer"></div>
  ${stats.length ? `<div class="ec-receipt">${stats.map(s =>
        `<div><b>${esc(typeof s.value === 'number' ? num(s.value) : s.value)}</b><small>${esc(s.label)}</small></div>`).join('')}</div>` : ''}
  <div class="ec-foot">
    <span>${o.preparedFor ? `Prepared for <b>${esc(o.preparedFor)}</b> · ` : ''}${esc(fmtDate(o.date))}</span>
    <span>Public data only. Reach, saves and impressions are not measurable from outside an account and are not claimed here.</span>
  </div>
</section>`;
    }

    /**
     * Page aspect after margins, so the cover is sized to fill exactly one
     * PDF page. html2pdf scales the element so its width equals the printable
     * width, so cover height = element width × (printable H / printable W).
     */
    function pageRatio(format, margin, unit) {
        const inch = unit === 'mm' ? 25.4 : 1;
        const sizes = { letter: [8.5, 11], a4: [8.27, 11.69] };
        const [w, h] = sizes[format] || sizes.letter;
        const m = (margin || 0) / inch;
        return (h - 2 * m) / (w - 2 * m);
    }

    async function exportPdf(node, filename, opts = {}) {
        if (!node || !node.innerHTML.trim()) { alert('Nothing to export yet.'); return; }
        if (typeof html2pdf !== 'function') { alert('PDF library did not load. Check your connection and try again.'); return; }

        const format = opts.format || 'letter';
        const unit   = opts.unit || (format === 'a4' ? 'mm' : 'in');
        const margin = opts.margin ?? (unit === 'mm' ? 8 : 0.4);

        // <details> closed on screen prints as one line — open them for capture.
        const closed = [...node.querySelectorAll('details:not([open])')];
        closed.forEach(d => d.setAttribute('open', ''));

        const cover = node.querySelector('.el-cover');
        const prevMin = cover ? cover.style.minHeight : null;
        const prevMax = cover ? cover.style.maxHeight : null;
        node.classList.add('pdf-mode');
        if (cover) {
            // Cover spans the full paper width (negative margins undo the
            // padding), so the page width is the paper's outer width.
            const w = node.getBoundingClientRect().width;
            const h = Math.floor(w * pageRatio(format, margin, unit)) - 1;
            cover.style.minHeight = h + 'px';
            cover.style.maxHeight = h + 'px';
        }

        const y = window.scrollY;
        window.scrollTo(0, 0);
        try {
            await html2pdf().set({
                margin,
                filename,
                image: { type: 'jpeg', quality: 0.96 },
                html2canvas: { scale: 2, backgroundColor: '#0b1329', useCORS: true,
                               scrollX: 0, scrollY: 0, windowWidth: document.documentElement.clientWidth },
                jsPDF: { unit, format, orientation: 'portrait' },
                pagebreak: { mode: ['css', 'legacy'], after: '.el-cover' }
            }).from(node).save();
        } finally {
            node.classList.remove('pdf-mode');
            if (cover) { cover.style.minHeight = prevMin || ''; cover.style.maxHeight = prevMax || ''; }
            closed.forEach(d => d.removeAttribute('open'));
            window.scrollTo(0, y);
        }
    }

    /** Seconds between two ISO stamps, or null. */
    function elapsed(startIso, endIso) {
        if (!startIso || !endIso) return null;
        const s = (new Date(endIso) - new Date(startIso)) / 1000;
        return isFinite(s) && s > 0 ? s : null;
    }

    window.ELCover = { html, exportPdf, elapsed };
})();
