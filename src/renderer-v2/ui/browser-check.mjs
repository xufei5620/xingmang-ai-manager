import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { chromium } from '@playwright/test';
import react from '@vitejs/plugin-react';
import { createFixtureServer } from '../../../e2e/harness.mjs';
import { openFixturePage, waitForFixtureMount } from '../../../e2e/fixture-readiness.mjs';

let browser, server, origin;
before(async () => {
  ({ server, origin } = await createFixtureServer({ configFile: false, plugins: [react()], root: path.resolve('.'), logLevel: 'error' }));
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined });
});
after(async () => { await browser?.close(); await server?.close(); });
async function gallery(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  // The heading was doubling as the mount wait on Playwright's 30s action
  // default, so a cold open of the gallery would be reported as a missing
  // heading. Bound the mount with the shared budget and leave the heading - and
  // every assertion after it - on the default. One of the fourteen Windows
  // browser-shard failures between 2026-09-19 and 2026-09-21 was this open, and
  // it was not slow: the page never came back, so the budget goes on up to
  // three navigations rather than one stare at a dead page.
  await openFixturePage(page, origin + '/src/renderer-v2/gallery.html' + query,
    (timeout) => waitForFixtureMount(page, { timeout, what: 'the component gallery fixture' }),
    { label: 'the component gallery fixture' });
  await page.getByRole('heading', { name: '星芒 AI / 组件检阅' }).waitFor();
  return page;
}
const focused = async locator => locator.evaluate(element => element === document.activeElement);

test('Tooltip is available on focus, dismisses with Escape, and preserves trigger focus', async () => {
  const page = await gallery();
  try {
    const trigger = page.getByTestId('gallery-tooltip-trigger');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await page.getByRole('tooltip').waitFor();
    assert.ok(await trigger.getAttribute('aria-describedby'));
    await trigger.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.equal(await focused(trigger), true);
  } finally { await page.close(); }
});

test('Coachmark advances, never points at a hidden target, and can always be skipped', async () => {
  const page = await gallery();
  try {
    const trigger = page.getByTestId('gallery-coach-open');
    await trigger.click();
    const coach = page.getByTestId('gallery-coach');
    // v4: the bubble sits below its target (above when the window has no room under it) with the
    // arrow over the target's centre, and the target itself is outlined while it is being explained.
    await page.waitForFunction(() => document.querySelector('[data-testid="gallery-coach"]')?.style.visibility === 'visible');
    assert.equal(await trigger.getAttribute('data-coach-target'), 'true');
    const [side, anchor, bubble, arrow] = await Promise.all([coach.getAttribute('data-side'), trigger.boundingBox(), coach.boundingBox(), coach.evaluate(el => parseFloat(el.style.getPropertyValue('--coach-arrow-x')))]);
    if (side === 'below') assert.ok(bubble.y > anchor.y + anchor.height, 'the bubble opens below the target');
    else { assert.equal(side, 'above'); assert.ok(bubble.y + bubble.height < anchor.y, 'the bubble opens above the target'); }
    assert.ok(Math.abs(bubble.x + arrow - (anchor.x + anchor.width / 2)) <= 1, 'the arrow points at the target centre');
    await coach.getByRole('button', { name: '下一步' }).click();
    await coach.getByRole('heading', { name: '随时返回这里' }).waitFor();
    await trigger.evaluate((button) => { button.hidden = true });
    await coach.waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('data-coach-target'), null);
    await trigger.evaluate((button) => { button.hidden = false });
    await coach.waitFor();
    await coach.getByRole('button', { name: '跳过' }).click();
    await coach.waitFor({ state: 'hidden' });
    assert.equal(await trigger.getAttribute('data-coach-target'), null);
  } finally { await page.close(); }
});

test('Button preserves submit semantics, loading and password feedback association', async () => {
  const page = await gallery();
  try {
    await page.getByLabel('配置名称', { exact: true }).fill('工作配置');
    await page.getByRole('button', { name: '提交表单' }).click();
    assert.equal(await page.getByTestId('gallery-result').innerText(), '表单已提交：工作配置');
    assert.equal(await page.getByRole('button', { name: '处理中' }).first().isDisabled(), true);
    const password = page.getByTestId('gallery-password');
    assert.equal(await password.getAttribute('aria-invalid'), 'true');
    assert.equal(await password.evaluate(el => document.getElementById(el.getAttribute('aria-describedby')).textContent), '请检查密码');
    await page.getByRole('button', { name: '显示密码' }).click();
    assert.equal(await password.getAttribute('type'), 'text');
    assert.equal(await password.inputValue(), 'draft-secret');
    await page.getByRole('button', { name: '隐藏密码' }).press('Space');
    assert.equal(await password.getAttribute('type'), 'password');
  } finally { await page.close(); }
});
test('Switch labels activate once and Tabs use selected roving focus while skipping disabled choices', async () => {
  const page = await gallery();
  try {
    const toggle = page.getByRole('switch', { name: '完成后通知', exact: true });
    await page.getByText('完成后通知', { exact: true }).click();
    assert.equal(await toggle.getAttribute('aria-checked'), 'false');
    await toggle.focus(); await page.keyboard.press('Space');
    assert.equal(await toggle.getAttribute('aria-checked'), 'true');
    const tabs = page.getByRole('tablist', { name: '任务筛选' });
    await tabs.getByRole('tab', { name: '全部任务' }).focus(); await page.keyboard.press('ArrowRight');
    assert.equal(await focused(tabs.getByRole('tab', { name: '启用中' })), true);
    assert.equal(await tabs.getByRole('tab', { name: '启用中' }).getAttribute('aria-selected'), 'false');
    await page.keyboard.press('Enter');
    assert.equal(await tabs.getByRole('tab', { name: '启用中' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Home');
    assert.equal(await focused(tabs.getByRole('tab', { name: '全部任务' })), true);
    await page.keyboard.press('Enter');
    assert.equal(await tabs.locator('[tabindex="0"]').count(), 1);
  } finally { await page.close(); }
});
test('Dialog traps focus, protects dirty backdrop/escape, preserves draft and returns focus', async () => {
  const page = await gallery();
  try {
    const trigger = page.getByRole('button', { name: '打开配置', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '工具配置' });
    assert.equal(await focused(page.getByLabel('配置草稿')), true);
    await dialog.getByRole('button', { name: '保存配置' }).focus(); await page.keyboard.press('Tab');
    assert.equal(await focused(dialog.getByRole('button', { name: '关闭', exact: true })), true);
    await page.getByLabel('配置草稿').fill('未保存内容');
    // v4: a dirty close keeps the form in view and swaps the footer for a bar at the bottom.
    const bar = dialog.locator('.xm-leave-bar');
    await page.mouse.click(8, 8);
    await bar.getByText('有修改还没保存，关掉会丢掉这些修改').waitFor();
    assert.equal(await bar.getAttribute('role'), 'alert');
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.getByLabel('配置草稿').isVisible(), true);
    assert.equal(await page.getByLabel('配置草稿').inputValue(), '未保存内容');
    assert.equal(await dialog.getByRole('button', { name: '保存配置' }).isVisible(), false);
    assert.equal(await focused(bar.getByRole('button', { name: '继续编辑' })), true);
    // Esc on the bar means keep editing; the footer comes back.
    await page.keyboard.press('Escape');
    await bar.waitFor({ state: 'detached' });
    assert.equal(await dialog.getByRole('button', { name: '保存配置' }).isVisible(), true);
    assert.equal(await focused(page.getByLabel('配置草稿')), true);
    await page.keyboard.press('Escape');
    await bar.waitFor();
    // A second close attempt while the bar is up shakes it instead of closing.
    assert.doesNotMatch(await bar.getAttribute('class'), /is-nudged/);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.locator('.xm-leave-bar.is-nudged').waitFor();
    assert.equal(await dialog.isVisible(), true);
    await bar.getByRole('button', { name: '继续编辑' }).click();
    assert.equal(await page.getByLabel('配置草稿').inputValue(), '未保存内容');
    // Chromium stops letting a page veto the <dialog> cancel event after a few Esc presses in a row;
    // the dialog must stay open (and stay React's) however many times Esc goes back and forth.
    for (let press = 0; press < 6; press += 1) await page.keyboard.press('Escape');
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.getByLabel('配置草稿').inputValue(), '未保存内容');
    await page.keyboard.press('Escape');
    assert.doesNotMatch(await bar.getAttribute('class'), /is-nudged/);
    await bar.getByRole('button', { name: '不保存' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focused(trigger), true);
  } finally { await page.close(); }
});
test('Menu keyboard, typeahead, disabled item, outside close and nested drawer escape work', async () => {
  const page = await gallery();
  try {
    const trigger = page.getByRole('button', { name: '文本操作', exact: true });
    await trigger.click();
    const menu = page.getByRole('menu', { name: '文本操作' });
    assert.equal(await focused(menu.getByRole('menuitem', { name: '复制', exact: true })), true);
    await page.keyboard.press('ArrowDown');
    assert.equal(await focused(menu.getByRole('menuitem', { name: 'Save' })), true);
    await page.keyboard.type('save'); await page.keyboard.press('Space');
    assert.equal(await page.getByTestId('gallery-result').innerText(), '已保存');
    assert.equal(await focused(trigger), true);
    await trigger.click(); await page.getByRole('heading', { name: '星芒 AI / 组件检阅' }).click();
    assert.equal(await menu.count(), 0);
    await trigger.click(); await page.keyboard.press('Tab');
    assert.equal(await focused(page.getByRole('button', { name: '配置提示', exact: true })), true);
    await page.getByRole('button', { name: '打开详情', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '详细配置' });
    await drawer.getByRole('button', { name: '详情操作' }).click();
    await page.getByRole('menu', { name: '详情操作' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await drawer.isVisible(), true);
    assert.equal(await page.getByRole('menu', { name: '详情操作' }).count(), 0);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'detached' });
  } finally { await page.close(); }
});
test('Popover remains inside modal focus ownership and restores its trigger', async () => {
  const page = await gallery();
  try {
    await page.getByRole('button', { name: '打开详情', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: '详细配置' });
    const trigger = drawer.getByRole('button', { name: '附加选项', exact: true });
    await trigger.click();
    const popover = page.getByRole('dialog', { name: '附加选项', exact: true });
    await popover.getByRole('button', { name: '附加动作' }).click();
    await page.keyboard.press('Escape');
    await popover.waitFor({ state: 'detached' });
    assert.equal(await focused(trigger), true);
    assert.equal(await drawer.isVisible(), true);
    await trigger.click(); await popover.getByRole('button', { name: '关闭', exact: true }).click();
    assert.equal(await focused(trigger), true);
  } finally { await page.close(); }
});
test('Confirm acknowledgement and Table keyboard preserve independent inner actions', async () => {
  const page = await gallery();
  try {
    const row = page.getByRole('table', { name: '配置记录' }).getByRole('row').nth(1);
    await row.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.getByTestId('gallery-result').innerText(), '表格行已打开');
    await row.getByRole('button', { name: '独立动作' }).click();
    assert.equal(await page.getByTestId('gallery-result').innerText(), '内部动作');
    await page.getByRole('button', { name: '确认删除', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: '删除配置' });
    assert.equal(await confirm.getByRole('button', { name: '删除配置' }).isDisabled(), true);
    await confirm.getByRole('checkbox').check();
    await confirm.getByRole('button', { name: '删除配置' }).click();
    assert.equal(await page.getByTestId('gallery-result').innerText(), '确认删除完成');
  } finally { await page.close(); }
});
test('Toast keeps three unique items and expires; reduced motion disables animation', async () => {
  const page = await gallery();
  try {
    await page.getByRole('button', { name: '连续通知' }).click();
    const toasts = page.getByTestId('gallery-toasts');
    assert.equal(await toasts.getByRole('status').count(), 3);
    assert.doesNotMatch(await toasts.innerText(), /第一条/);
    // v4: toasts stack in the bottom-right corner above the status bar, each led by its tone mark.
    const corner = await toasts.getByRole('status').last().boundingBox();
    assert.ok(Math.abs(1280 - corner.x - corner.width - 16) <= 1, 'toasts hug the right edge');
    assert.ok(900 - corner.y - corner.height >= 30, 'toasts clear the status bar');
    assert.equal(await toasts.locator('.xm-toast > svg').count(), 3);
    await toasts.getByRole('status').first().waitFor({ state: 'detached', timeout: 4000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.documentElement.dataset.systemReducedMotion === 'true');
    assert.equal(await page.locator('.xm-spin').first().evaluate(el => getComputedStyle(el).animationName), 'none');
  } finally { await page.close(); }
});
test('Toast pauses under the mouse and keeps warnings until closed', async () => {
  const page = await gallery();
  try {
    await page.getByRole('button', { name: '长提示' }).click();
    const toasts = page.getByTestId('gallery-toasts');
    const warning = toasts.getByRole('status').filter({ hasText: '模型没换成' });
    const long = toasts.getByRole('status').filter({ hasText: '兼容方式显示' });
    await long.hover();
    await page.waitForTimeout(7000);
    assert.equal(await long.count(), 1);
    await page.mouse.move(0, 0);
    await long.waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(await warning.count(), 1);
    await warning.getByRole('button', { name: '关闭' }).click();
    await warning.waitFor({ state: 'detached', timeout: 2000 });
  } finally { await page.close(); }
});
test('ToolRow uses six fixed columns, real brands and exact theme tokens across Win/Mac light/dark', async () => {
  await fs.mkdir('artifacts/renderer-v2-components', { recursive: true });
  for (const os of ['win', 'mac']) for (const theme of ['light', 'dark']) {
    const page = await gallery('?os=' + os + '&theme=' + theme);
    try {
      const row = page.getByTestId('gallery-tool-row');
      assert.match(await row.innerText(), /Claude Code/);
      assert.match(await row.innerText(), /已配好/);
      assert.doesNotMatch(await row.innerText(), /星芒中转|ready/);
      const columns = await row.evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' '));
      assert.equal(columns.length, 6); assert.deepEqual(columns.slice(-2), ['92px', '32px']);
      // The extra column follows its button (v4 batch 04): a fixed 72px let a long label spill left over the status.
      const extraButton = await row.locator('.xm-tool-extra .xm-btn').evaluate(el => el.getBoundingClientRect().width);
      assert.ok(parseFloat(columns[3]) >= extraButton - 0.5, `extra column ${columns[3]} fits its ${extraButton}px button`);
      assert.equal(await page.locator('.xm-brand > svg').count(), 12);
      const images = await page.locator('.xm-logo').evaluateAll(elements => elements.every(el => el.complete && el.naturalWidth > 0));
      assert.equal(images, true);
      const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toUpperCase());
      assert.equal(token, theme === 'dark' ? '#101116' : '#FBFAF6');
      await page.screenshot({ path: 'artifacts/renderer-v2-components/' + os + '-' + theme + '.png', fullPage: true });
    } finally { await page.close(); }
  }
});

// 批次性能要求 04：「改用 388290490@qq.c…」压在状态牌上。一个 15 位以上的邮箱用户名配最长的那个状态，
// 深浅两套、宽窄两种都不许叠：放得下时全显示，放不下时各自省略，谁也不盖谁。卡片同样。
test('a long account name and the longest status never overlap on a tool row or card, light or dark', async () => {
  for (const theme of ['light', 'dark']) {
    const page = await gallery('?os=win&theme=' + theme);
    try {
      const measure = () => page.evaluate(() => {
        const box = (selector) => { const rect = document.querySelector(selector).getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width }; };
        const clipped = (selector) => { const element = document.querySelector(selector); return element.scrollWidth > element.clientWidth + 1; };
        return {
          row: box('[data-testid="gallery-tool-row-long"]'), pill: box('[data-testid="gallery-tool-row-long"] .xm-tool-status .xm-pill'),
          extra: box('[data-testid="gallery-tool-row-long"] .xm-tool-extra .xm-btn'), primary: box('[data-testid="gallery-tool-row-long"] .xm-tool-primary .xm-btn'),
          extraClipped: clipped('[data-testid="gallery-tool-row-long"] .xm-tool-extra .xm-btn > span'),
          card: box('[data-testid="gallery-tool-card-long"]'), badge: box('[data-testid="gallery-tool-card-long"] .xm-tool-card-badge'),
          actions: box('[data-testid="gallery-tool-card-long"] .xm-tool-card-actions'), action: box('[data-testid="gallery-tool-card-long"] .xm-tool-card-actions > .xm-btn'),
        };
      });
      const assertApart = (layout, label) => {
        assert.ok(layout.pill.right <= layout.extra.left + 0.5, `${label}: status ends ${layout.pill.right}, button starts ${layout.extra.left}`);
        assert.ok(layout.extra.right <= layout.primary.left + 0.5, `${label}: the long button stays left of 打开`);
        assert.ok(layout.extra.left >= layout.row.left && layout.primary.right <= layout.row.right + 0.5, `${label}: the row keeps its buttons inside`);
        assert.ok(layout.badge.right <= layout.actions.left + 0.5, `${label}: card status ends ${layout.badge.right}, buttons start ${layout.actions.left}`);
        assert.ok(layout.actions.right <= layout.card.right + 0.5 && layout.badge.left >= layout.card.left - 0.5, `${label}: the card keeps its foot inside`);
        assert.ok(layout.action.width > 40, `${label}: the long card button stays readable (${layout.action.width}px)`);
      };
      const wide = await measure();
      assertApart(wide, theme + ' wide');
      assert.equal(wide.extraClipped, false, 'a wide row shows the whole account name');
      // Narrowest the home page gets: a 560px row and a single 220px card.
      await page.evaluate(() => {
        document.querySelector('[data-testid="gallery-tool-row-long"]').parentElement.style.width = '560px';
        document.querySelector('.xm-gallery-tool-cards').style.width = '220px';
      });
      const narrow = await measure();
      assert.ok(Math.abs(narrow.card.width - 220) < 1, `the card is ${narrow.card.width}px wide`);
      assertApart(narrow, theme + ' narrow');
    } finally { await page.close(); }
  }
});
