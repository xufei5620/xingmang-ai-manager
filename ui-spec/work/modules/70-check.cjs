/* Component prototype checks. This validates selected browser interactions,
   not every visual state, operating system, screen reader, or product backend. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.XINGMANG_PLAYWRIGHT_MODULE||'playwright');
let browser;
(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(7000);
  const errors = [], requests = [], checks = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.route(/^https?:/, r => r.abort());
  const candidatePaths = [
    path.resolve(__dirname, '../../xingmang-ui-spec/prototype/components-v3.html'),
    path.resolve(__dirname, '../../prototype/components-v3.html'),
    path.resolve(__dirname, '../../prototype/components.html'),
  ];
  const componentsPath = candidatePaths.find(p => require('node:fs').existsSync(p));
  if (!componentsPath) throw new Error('components page not found in delivery: ' + candidatePaths.join(', '));
  await page.goto(pathToFileURL(componentsPath).href);
  const check = (name, value) => { assert.ok(value, name); checks.push(name); };
  check('45 unique component types', await page.locator('[data-component]').count() === 45 && await page.evaluate(() => new Set(window.__componentRegistry.map(x => x.id)).size === 45));
  check('45 registry numbers', await page.evaluate(() => new Set(window.__componentRegistry.map(x => x.registry)).size === 45));
  check('all SVG use references resolve', await page.evaluate(() => [...document.querySelectorAll('use')].every(x => document.querySelector(x.getAttribute('href')))));
  check('no duplicate element IDs', await page.evaluate(() => { const ids = [...document.querySelectorAll('[id]')].map(e => e.id); return ids.length === new Set(ids).size; }));
  await page.locator('#demo-switch').click();
  check('switch toggles with click', await page.locator('#demo-switch').getAttribute('aria-checked') === 'false');
  await page.locator('#demo-switch').press('Space');
  check('switch toggles with Space', await page.locator('#demo-switch').getAttribute('aria-checked') === 'true');
  await page.locator('#tab-overview').focus(); await page.keyboard.press('ArrowRight');
  check('tabs arrow moves focus without activation', await page.locator('#tab-models').evaluate(e => e === document.activeElement) && await page.locator('#tab-overview').getAttribute('aria-selected') === 'true');
  await page.keyboard.press('Enter');
  check('tabs Enter activates corresponding panel', await page.locator('#tab-models').getAttribute('aria-selected') === 'true' && await page.locator('#panel-models').isVisible());
  await page.locator('#field-form button').click();
  check('empty form associates and focuses error', await page.locator('#field-error').isVisible() && await page.locator('#field-name').getAttribute('aria-invalid') === 'true' && await page.locator('#field-name').evaluate(e => e === document.activeElement));
  await page.locator('#field-name').fill('测试连接'); await page.locator('#field-form button').click();
  check('form can recover without losing input', !await page.locator('#field-error').isVisible() && await page.locator('#field-success').innerText() === '连接名称已保存');
  const dialogTrigger = page.locator('[data-component="Dialog"] [data-open]');
  await dialogTrigger.click();
  check('dialog opens at named field', await page.locator('#edit-dialog').evaluate(e => e.open) && await page.locator('#edit-name').evaluate(e => e === document.activeElement));
  await page.locator('#edit-form [type="submit"]').focus(); await page.keyboard.press('Tab');
  check('dialog Tab stays inside', await page.evaluate(() => document.activeElement.closest('dialog')?.id === 'edit-dialog'));
  await page.keyboard.press('Escape');
  check('dialog Escape restores trigger focus', !await page.locator('#edit-dialog').evaluate(e => e.open) && await dialogTrigger.evaluate(e => e === document.activeElement));
  await page.locator('[data-component="Confirm"] [data-open]').click();
  check('confirm defaults to preserve action', await page.locator('#confirm-dialog [data-close]').evaluate(e => e === document.activeElement));
  await page.locator('#confirm-action').click();
  check('confirm completes only local sample', !await page.locator('#confirm-dialog').evaluate(e => e.open) && (await page.locator('#toast').innerText()).includes('示例连接已删除'));
  await page.locator('[data-component="Drawer"] [data-open]').click(); await page.keyboard.press('Escape');
  check('drawer opens and closes with Escape', !await page.locator('#detail-drawer').evaluate(e => e.open));
  await page.locator('#combo-input').fill('学'); await page.keyboard.press('Enter');
  check('combobox filters and selects with Enter', await page.locator('#combo-input').inputValue() === '学习项目' && await page.locator('#combo-input').getAttribute('aria-expanded') === 'false');
  await page.locator('#combo-input').fill('不存在');
  check('combobox shows no-result state', await page.locator('#combo-list').innerText() === '没有匹配的连接');
  await page.keyboard.press('Escape');
  check('combobox Escape collapses list', await page.locator('#combo-input').getAttribute('aria-expanded') === 'false');
  await page.locator('[data-page="3"]').click();
  check('pagination changes data and last boundary', await page.locator('#page-rows').innerText() === '临时项目\n7' && await page.locator('[data-page="next"]').isDisabled());
  await page.locator('[data-page="1"]').click();
  check('pagination first boundary', await page.locator('[data-page="prev"]').isDisabled());
  await page.locator('#step-next').click(); await page.locator('#step-name').fill(''); await page.locator('#step-next').click();
  check('stepper validates current step', await page.locator('#step-error').isVisible());
  await page.locator('#step-name').fill('练习连接'); await page.locator('#step-next').click(); await page.locator('#step-prev').click();
  check('stepper back preserves entered name', await page.locator('#step-name').inputValue() === '练习连接');
  await page.locator('#step-next').click(); await page.locator('#step-next').click();
  check('stepper reaches local completion', (await page.locator('#step-content').innerText()).includes('连接示例已添加'));
  await page.locator('[data-component="CommandPalette"] [data-open]').click(); await page.locator('#palette-search').fill('服务连接'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => !document.getElementById('palette-dialog').open && document.querySelector('#component-Drawer h3') === document.activeElement);
  check('command palette chooses and closes', !await page.locator('#palette-dialog').evaluate(e => e.open) && await page.locator('#component-Drawer h3').evaluate(e => e === document.activeElement));
  await page.keyboard.press('Control+k'); await page.locator('#palette-search').fill('不存在');
  check('command palette shortcut and empty state', await page.locator('#palette-dialog').evaluate(e => e.open) && await page.locator('#palette-empty').isVisible());
  await page.keyboard.press('Escape');
  await page.locator('#search').fill('Combobox');
  check('component search filters accurately', await page.locator('[data-component]:visible').count() === 1 && await page.locator('[data-component="Combobox"]').isVisible());
  await page.locator('#search').fill(''); await page.locator('#state').selectOption('static');
  check('static filter describes actual sample kind', await page.locator('[data-component]:visible').count() === await page.evaluate(() => window.__componentRegistry.filter(x => x.kind === 'static').length));
  await page.locator('#state').selectOption('all');
  await page.setViewportSize({ width: 960, height: 800 });
  for (const theme of ['dark', 'light']) {
    await page.locator('#theme').selectOption(theme); await page.locator('#contrast').check();
    check(`${theme} high contrast 960px has no page overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('.canvas').scrollWidth <= document.querySelector('.canvas').clientWidth));
  }
  await page.locator('#platform').selectOption('mac'); await page.locator('#reduce').check();
  check('platform and reduced-motion controls', await page.evaluate(() => document.documentElement.dataset.os === 'mac' && document.documentElement.dataset.reduceMotion === 'true') && await page.locator('#shortcut-key').innerText() === '⌘ K');
  check('no JavaScript errors', errors.length === 0);
  check('no HTTP requests', requests.length === 0);
  console.log(JSON.stringify({ passed: checks.length, checks, errors, httpRequests: requests.length, scope: 'Selected interactions and 960px browser layout; not exhaustive five-state, native platform, or assistive-technology testing.' }, null, 2));
  await browser.close();
})().catch(async error => { console.error(error); if (browser) await browser.close(); process.exitCode = 1; });
