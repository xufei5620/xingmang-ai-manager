import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';

let browser, server, origin;
before(async () => {
  server = await createServer({ configFile: false, plugins: [react()], root: path.resolve('.'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await server.listen();
  origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  browser = await chromium.launch({ headless: true, executablePath: process.env.XINGMANG_E2E_CHROMIUM || undefined });
});
after(async () => { await browser?.close(); await server?.close(); });
async function gallery(query = '') {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  await page.goto(origin + '/src/renderer-v2/gallery.html' + query);
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
    await coach.getByRole('button', { name: '下一步' }).click();
    await coach.getByRole('heading', { name: '随时返回这里' }).waitFor();
    await trigger.evaluate((button) => { button.hidden = true });
    await coach.waitFor({ state: 'hidden' });
    await trigger.evaluate((button) => { button.hidden = false });
    await coach.waitFor();
    await coach.getByRole('button', { name: '跳过' }).click();
    await coach.waitFor({ state: 'hidden' });
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
    await page.mouse.click(8, 8);
    assert.equal(await dialog.isVisible(), true);
    assert.equal(await page.getByLabel('配置草稿').inputValue(), '未保存内容');
    await page.keyboard.press('Escape');
    await dialog.getByText('要放弃未保存的修改吗？').waitFor();
    await dialog.getByRole('button', { name: '继续编辑' }).click();
    assert.equal(await page.getByLabel('配置草稿').inputValue(), '未保存内容');
    await page.keyboard.press('Escape');
    await dialog.getByRole('button', { name: '放弃修改' }).click();
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
    await toasts.getByRole('status').first().waitFor({ state: 'detached', timeout: 4000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.waitForFunction(() => document.documentElement.dataset.systemReducedMotion === 'true');
    assert.equal(await page.locator('.xm-spin').first().evaluate(el => getComputedStyle(el).animationName), 'none');
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
      assert.equal(columns.length, 6); assert.deepEqual(columns.slice(-3), ['72px', '92px', '32px']);
      assert.equal(await page.locator('.xm-brand > svg').count(), 9);
      const images = await page.locator('.xm-logo').evaluateAll(elements => elements.every(el => el.complete && el.naturalWidth > 0));
      assert.equal(images, true);
      const token = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim().toUpperCase());
      assert.equal(token, theme === 'dark' ? '#0B0C10' : '#FAF7EE');
      await page.screenshot({ path: 'artifacts/renderer-v2-components/' + os + '-' + theme + '.png', fullPage: true });
    } finally { await page.close(); }
  }
});
