'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { launch, open, setPage, pageIds, supportFor, publicPrototype, hash, observedState, matchesState } = require('../ui-spec/work/reference-harness.cjs');
const output = path.resolve('docs/prototype-refs/current');
const states = ['default', 'empty', 'loading', 'error'];
const requestedPages = process.argv.filter(arg => arg.startsWith('--page=')).map(arg => arg.slice(7));
if (requestedPages.some(page => !pageIds.includes(page))) throw new Error('Unknown --page filter');
const allTasks = ['win', 'mac'].flatMap(os => ['light', 'dark'].flatMap(theme => pageIds.flatMap(page => states.map(state => ({ os, theme, page, state })))));
const tasks = requestedPages.length ? allTasks.filter(task => requestedPages.includes(task.page)) : allTasks;
let active;
(async () => {
  fs.mkdirSync(output, { recursive: true });
  const sourceHash = hash(publicPrototype); active = await launch();
  const previous = requestedPages.length ? JSON.parse(fs.readFileSync(path.join(output, 'manifest.json'), 'utf8')) : null;
  if (previous && previous.sourceSha256 !== sourceHash) throw new Error('Cannot partially update screenshots from another prototype hash');
  const records = previous ? previous.records.filter(row => !requestedPages.includes(row.page)) : []; let cursor = 0;
  const started = Date.now();
  async function worker() {
    const page = await active.context.newPage();
    await page.clock.install({ time: new Date('2026-09-07T04:00:00Z') });
    await open(page);
    while (cursor < tasks.length) {
      const task = tasks[cursor++]; const support = supportFor(task.page, task.state);
      if (!support.supported) { records.push({ ...task, status: 'not-applicable', reason: support.reason }); continue; }
      const relative = task.os + '/' + task.theme + '/' + task.page + '--' + task.state + '.png';
      const file = path.join(output, relative);
      try {
        const geometry = await setPage(page, task.page, task.state, task.os, task.theme);
        if (geometry.skin !== (task.theme === 'dark' ? 'obsidian' : 'dawn')) throw new Error('Requested brand skin was not applied');
        const frozenAt = await page.evaluate(() => Date.now() + 25);
        await page.clock.pauseAt(frozenAt);
        const selector = task.page === 'canvas' && await page.locator('.cx-window').count() ? '.cx-window' : '#win';
        const target = page.locator(selector);
        await target.waitFor({ state: 'visible' });
        const before = await observedState(page, task.page);
        if (!matchesState(task.page, task.state, before)) throw new Error('Requested state was not reached: ' + JSON.stringify(before));
        const visibleStates = await page.evaluate(() => Array.from(document.querySelectorAll('[data-testid$="-loading"],[data-testid$="-error"],[data-testid$="-empty"],.xm-loading,.xm-chat-error')).filter(element => element.getClientRects().length).map(element => element.getAttribute('data-testid') || element.className));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await target.screenshot({ path: file, animations: 'disabled', timeout: 10000 });
        const after = await observedState(page, task.page);
        if (!matchesState(task.page, task.state, after)) throw new Error('State changed before screenshot finished: ' + JSON.stringify(after));
        const size = fs.statSync(file).size;
        if (size < 2000) throw new Error('Screenshot unexpectedly small');
        records.push({ ...task, status: 'captured', method: support.method, file: relative.replaceAll('\\', '/'), sha256: hash(file), bytes: size, selector, geometry, observed: after, browserClock: new Date(frozenAt).toISOString(), visibleStates });
        await page.clock.resume();
      } catch (error) {
        records.push({ ...task, status: 'failed', error: String(error.message).replace(/data:image\/[^\s"'<>]+/g, '[image data omitted]').slice(0, 1200) });
        await page.clock.resume(); await open(page);
      }
      if (records.filter(row => row.status === 'captured').length % 40 === 0) console.log(JSON.stringify({ captured: records.filter(row => row.status === 'captured').length, processed: records.length, total: tasks.length }));
    }
    await page.close();
  }
  // Playwright Clock belongs to the context; one worker avoids freezing another page's setup.
  await worker();
  const report = {
    checkedAt: new Date().toISOString(), scope: 'Current public offline UI prototype; Win/Mac are appearance and keyboard simulations, not native machines',
    source: path.relative(path.resolve('.'), publicPrototype).replaceAll('\\', '/'), sourceSha256: sourceHash, sourceUnchanged: sourceHash === hash(publicPrototype),
    logicalWindow: { width: 1280, height: 900 }, themes: { light: 'dawn', dark: 'obsidian' }, requestedStates: states, pages: pageIds, seconds: Math.round((Date.now() - started) / 1000),
    presentation: { sidebar: 'expanded 216px', moreGroup: 'prototype navigation default', transientUpdateNotices: 'dismissed as in XM.reviewScenario', reduceMotion: true, clockInitialTime: '2026-09-07T04:00:00Z' },
    capturePass: { pages: requestedPages.length ? requestedPages : 'all', preservesPreviousMatchingSourceRecords: Boolean(previous) },
    counts: { requested: allTasks.length, captured: records.filter(row => row.status === 'captured').length, notApplicable: records.filter(row => row.status === 'not-applicable').length, failed: records.filter(row => row.status === 'failed').length },
    browserErrors: active.errors, blockedExternalRequests: active.remoteRequests,
    notes: [
      'Only supported runtime states are captured; unsupported combinations remain explicit not-applicable records.',
      'Onboarding default enters through the real login form using fictional offline credentials; the guideScene(welcome) debug preset preserves a prior desktop route and is not the new-user login path.',
      'The screenshot excludes the external prototype review toolbar and records its exact target selector.',
      'Playwright Clock is installed before navigation and paused only after reaching the requested runtime state; short loading states cannot finish mid-capture.',
      'Existing preview PNG files outside current/ are historical references, not evidence of current runtime behavior.',
    ],
    records: records.sort((a, b) => [a.os, a.theme, a.page, a.state].join('/').localeCompare([b.os, b.theme, b.page, b.state].join('/'))),
  };
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ...report.counts, sourceUnchanged: report.sourceUnchanged, browserErrors: active.errors.length, blockedExternalRequests: active.remoteRequests.length, manifest: 'docs/prototype-refs/current/manifest.json' }));
  if (report.counts.failed || active.errors.length || active.remoteRequests.length || !report.sourceUnchanged) process.exitCode = 1;
})().catch(error => { console.error(String(error.message).slice(0, 1200)); process.exitCode = 1; }).finally(async () => { await active?.browser.close(); });
