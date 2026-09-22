#!/usr/bin/env node
/**
 * Run every test file and aggregate. One runner, so adding tests/foo.test.js
 * is the whole job of wiring it in.
 *
 * Why this exists rather than `a && b && c` in package.json: && short-circuits.
 * A failure in an early file silently skips every later one, and the pass count
 * printed at the end is then a lie about how much was checked. That happened
 * here once — 25 of 132 tests ran and the run looked clean.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'tests');
const files = fs.readdirSync(dir).filter(f => /\.(test|smoke)\.js$/.test(f)).sort();
if (!files.length) { console.error('No test files found in tests/'); process.exit(1); }

let total = 0, failedFiles = [];
for (const f of files) {
    let out = '', code = 0;
    try {
        out = execFileSync(process.execPath, [path.join(dir, f)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        out = String(e.stdout || '') + String(e.stderr || '');
        code = e.status == null ? 1 : e.status;
    }
    const m = out.match(/(\d+)\s+(?:checks\s+)?passed/);
    // A smoke test prints "ok" rather than a count. Reporting it as "0 passed"
    // reads as a file that ran nothing, which is worse than saying "ok".
    const n = m ? parseInt(m[1], 10) : 0;
    const label = m ? `${n} passed` : (code === 0 ? 'ok' : 'no result');
    total += n;
    const failures = (out.match(/^\s*FAIL /gm) || []).length;
    if (code !== 0 || failures) {
        failedFiles.push(f);
        console.log(`\n=== ${f} — ${failures || '?'} failing ===`);
        // Print only what failed, plus its detail lines, so a long green run
        // does not bury the one thing that broke.
        out.split('\n').forEach((line, i, all) => {
            if (/^\s*FAIL /.test(line)) {
                console.log(line);
                for (let j = i + 1; j < all.length && /^\s{6,}\S/.test(all[j]); j++) console.log(all[j]);
            }
        });
    }
    console.log(`${code === 0 && !failures ? 'PASS' : 'FAIL'}  ${f.padEnd(22)} ${label}`);
}

console.log('\n' + '='.repeat(52));
console.log(`${files.length} files, ${total} checks passed`);
if (failedFiles.length) {
    console.log(`FAILED: ${failedFiles.join(', ')}`);
    process.exit(1);
}
console.log('All green.');
