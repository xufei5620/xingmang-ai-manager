'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { launch, open, setPage, pageIds, publicPrototype, specRoot, hash } = require('./reference-harness.cjs');
const group = process.argv[2];
if (!['journeys', 'layout', 'icons', 'shell-close'].includes(group)) {
  console.error('Usage: node reference-check.cjs journeys|layout|icons|shell-close');
  process.exit(2);
}
let active;
(async () => {
  active = await launch(); const page = await active.context.newPage(); const checks = []; const failures = []; const started = Date.now(); await open(page);
  const record = (name, pass, details) => { checks.push({ name, passed: Boolean(pass), ...(details ? { details } : {}) }); if (!pass) failures.push(name); };
  if (group === 'journeys') {
    await setPage(page, 'welcome'); record('welcome login and help entries exist', await page.getByTestId('welcome-login').isVisible() && await page.getByTestId('welcome-help').isVisible());
    await page.getByTestId('welcome-login').click(); record('welcome opens real prototype login dialog', await page.getByTestId('login-password').count() > 0);
    await page.getByTestId('login-account').fill('ui-review-demo'); await page.getByTestId('login-password').fill('ReviewPass123'); await page.getByTestId('auth-agree').check(); await page.getByTestId('login-submit').click(); await page.getByTestId('guide-heading').waitFor();
    const selected = await page.locator('[data-testid^="guide-route-"][aria-pressed="true"]').evaluateAll(items => items.map(item => item.getAttribute('data-testid'))); record('onboarding after welcome login has no default tool selection', selected.length === 0, { selected });
    await setPage(page, 'home'); record('home retains installed / available / recent structure', await page.locator('.home-grid').count() === 1 && /你的工具/.test(await page.locator('#content').innerText()));
    await setPage(page, 'mcp', 'error'); const retry = page.getByTestId('mcp-retry'); record('list failure has recoverable retry', await retry.isVisible()); await retry.click(); await page.waitForFunction(() => XM.pageStatus('mcp') === 'ready'); record('list retry restores the same page', await page.evaluate(() => S.page === 'mcp' && XM.pageStatus('mcp') === 'ready'));
    await setPage(page, 'account-keys'); record('account page exposes nine tabs', await page.locator('[data-testid^="account-tab-"]').count() === 9);
    await setPage(page, 'chat', 'error'); record('chat failure preserves a retryable draft', await page.evaluate(() => Boolean(document.querySelector('.xm-chat-error')) && document.getElementById('chatIn').value === '帮我整理任务'));
    await setPage(page, 'recovery'); record('password recovery has actual email entry', await page.getByTestId('recovery-email').isVisible());
  }
  if (group === 'layout') {
    for (const os of ['win', 'mac']) for (const theme of ['light', 'dark']) for (const id of pageIds) {
      const geometry = await setPage(page, id, 'default', os, theme);
      const visible = await page.locator('#win').isVisible();
      const text = await page.locator('#win').innerText();
      const measured = await page.evaluate(() => {
        const main = document.getElementById('main'); const win = document.getElementById('win');
        return { logicalWidth: win.offsetWidth, contentOverflow: main ? main.scrollWidth - main.clientWidth : 0, sidebarWidth: document.getElementById('sidebar')?.offsetWidth, titlebar: document.querySelector('.titlebar')?.getBoundingClientRect().height };
      });
      record(os + '/' + theme + '/' + id, visible && text.trim().length > 40 && measured.logicalWidth === 1280 && geometry.window.width > 700 && measured.contentOverflow <= 2, { ...measured, view: geometry.view });
    }
  }
  if (group === 'icons') {
    for (const os of ['win', 'mac']) for (const theme of ['light', 'dark']) for (const id of ['home', 'welcome', 'account-recharge', 'settings', 'canvas']) {
      await setPage(page, id, 'default', os, theme);
      const result = await page.evaluate(async () => {
        const images = Array.from(document.querySelectorAll('#win img, .cx-window img'));
        await Promise.allSettled(images.map(img => img.decode()));
        const broken = images.filter(img => !img.complete || !img.naturalWidth).map(img => ({ alt: img.alt, sourceKind: img.src.startsWith('data:') ? 'embedded' : img.src.split('/').at(-1) }));
        const refs = Array.from(document.querySelectorAll('#win use, .cx-window use'));
        const unresolved = refs.map(use => use.getAttribute('href') || use.getAttribute('xlink:href')).filter(href => href?.startsWith('#') && !document.getElementById(href.slice(1)));
        return { images: images.length, broken, references: refs.length, unresolved };
      });
      record(os + '/' + theme + '/' + id, result.images > 0 && result.broken.length === 0 && result.unresolved.length === 0, result);
    }
  }
  if (group === 'shell-close') {
    for (const os of ['win', 'mac']) {
      await setPage(page, 'home', 'default', os, 'light');
      await page.keyboard.press(os === 'mac' ? 'Meta+k' : 'Control+k');
      record(os + ' command shortcut opens palette', await page.evaluate(() => Boolean(S.palette)));
      await page.keyboard.press('Escape'); record(os + ' Escape closes command palette', await page.evaluate(() => !S.palette));
      await page.keyboard.press(os === 'mac' ? 'Meta+,' : 'Control+,'); record(os + ' settings shortcut', await page.evaluate(() => S.page === 'settings'));
      await page.evaluate(() => { S.settings.closeAction = 'ask'; A.closeWindow(); }); record(os + ' close asks before choosing policy', await page.evaluate(() => topDialog()?.type === 'closeAsk'));
      await page.keyboard.press('Escape'); record(os + ' close prompt Escape keeps window', await page.evaluate(() => !S.dialogs.length) && await page.locator('#win').isVisible());
      await page.evaluate(() => { S.settings.closeAction = 'tray'; A.closeWindow(); }); record(os + ' close to tray exposes return entry', await page.locator('#tray').count() === 1);
      await page.keyboard.press('Escape'); record(os + ' Escape closes tray only', await page.locator('#tray').count() === 0 && await page.locator('#win').isVisible());
    }
  }
  record('no browser exceptions', active.errors.length === 0, active.errors);
  record('no production or external HTTP requests', active.remoteRequests.length === 0, active.remoteRequests);
  const report = { group, checkedAt: new Date().toISOString(), scope: 'Current public v3.1.1 offline prototype; platform appearance simulation only', prototypeSha256: hash(publicPrototype), seconds: (Date.now() - started) / 1000, passed: checks.filter(row => row.passed).length, total: checks.length, failures, checks };
  const output = path.join(specRoot, 'qa/current-results'); fs.mkdirSync(output, { recursive: true }); fs.writeFileSync(path.join(output, group + '.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ group, passed: report.passed, total: report.total, failures }));
  assert.equal(failures.length, 0, 'Prototype checks failed: ' + failures.join(', '));
})().catch(error => { console.error(String(error.message).slice(0, 2000)); process.exitCode = 1; }).finally(async () => { await active?.browser.close(); });
