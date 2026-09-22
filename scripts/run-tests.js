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
    const n = m ? parseInt(m[1], 10) : 0;
    // A smoke test prints "smoke: ok" rather than a count. That exact phrase
    // is the ONLY way a file with no count passes. Anything else with no
    // count is a file that ran nothing — and once, every file ran nothing:
    // server.js threw at load, its crash handler exited 0, and this runner
    // called all eleven of them "ok" with a total of 36. Silence is failure.
    const smokeOk = /smoke: ok/.test(out);
    const crashed = /"event":"uncaught_exception"|ReferenceError:|SyntaxError:|TypeError: Cannot/.test(out);
    const noResult = !m && !smokeOk;
    const label = m ? `${n} passed` : (smokeOk ? 'ok' : 'NO RESULT');
    total += n;
    const failures = (out.match(/^\s*FAIL /gm) || []).length;
    if (code !== 0 || failures || crashed || noResult) {
        failedFiles.push(f);
        console.log(`\n=== ${f} — ${failures || (crashed ? 'crashed' : noResult ? 'produced no result' : '?')} ===`);
        if (crashed || noResult) {
            // The first line that looks like the reason, so nobody has to re-run it.
            const why = out.split('\n').find(l => /uncaught_exception|Error:|Cannot access/.test(l)) || out.split('\n').find(l => l.trim()) || '(no output at all)';
            console.log('       ' + why.slice(0, 300));
        }
        // Print only what failed, plus its detail lines, so a long green run
        // does not bury the one thing that broke.
        out.split('\n').forEach((line, i, all) => {
            if (/^\s*FAIL /.test(line)) {
                console.log(line);
                for (let j = i + 1; j < all.length && /^\s{6,}\S/.test(all[j]); j++) console.log(all[j]);
            }
        });
    }
    // The same condition as the failure list above, or a crashed file prints
    // "PASS … NO RESULT" on one line and "FAILED" three lines later.
    const ok = code === 0 && !failures && !crashed && !noResult;
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${f.padEnd(22)} ${label}`);
}

console.log('\n' + '='.repeat(52));
console.log(`${files.length} files, ${total} checks passed`);
if (failedFiles.length) {
    console.log(`FAILED: ${failedFiles.join(', ')}`);
    process.exit(1);
}
console.log('All green.');
