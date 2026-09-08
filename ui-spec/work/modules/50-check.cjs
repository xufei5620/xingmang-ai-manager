/* Browser validation of prototype scenarios; does not test native OS compatibility. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.XINGMANG_PLAYWRIGHT_MODULE||'playwright');
let activeBrowser;

(async () => {
  const root = path.resolve(__dirname, '../..');
  const html = process.argv.find((arg) => arg.endsWith('.html')) || path.join(root, 'xingmang-ui-spec/prototype/星芒AI管理工具-完整可交互原型-v2.html');
  const browser = await chromium.launch({ headless: true });
  activeBrowser = browser;
  const page = await browser.newPage({ viewport: { width: 1640, height: 1100 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route(/^https?:/, (route) => route.abort());
  await page.goto(pathToFileURL(html).href);
  const assembled = await page.evaluate(() => Boolean(window.XM?.platformPresentationVersion));
  if (!assembled) {
    await page.addStyleTag({ path: path.join(root, 'work/sidebar-collapse-fix.css') });
    await page.addStyleTag({ path: path.join(__dirname, '50-platform.css') });
    await page.evaluate(() => { window.XM = window.XM || {}; window.XM.moduleIdentityMarker = 'preserve-me'; });
    await page.addScriptTag({ path: path.join(__dirname, '00-runtime.js') });
    await page.addScriptTag({ path: path.join(__dirname, '50-platform.js') });
    assert.equal(await page.evaluate(() => window.XM.moduleIdentityMarker), 'preserve-me');
  }
  const profiles = await page.evaluate(() => XM.platformProfiles);
  assert.equal(profiles.length, 11);
  let scenarios = 0;
  for (const p of profiles) {
    await page.evaluate((id) => XM.setPlatformVersion(id), p.id);
    const variants = p.os === 'linux' ? await page.evaluate(() => XM.platformSessions.map((s) => s.id)) : [null];
    for (const session of variants) {
      if (session) await page.evaluate((id) => XM.setPlatformSession(id), session);
      const v = await page.evaluate(() => {
        const c = XM.platformCapabilities();
        return { c, version: document.getElementById('xmPlatformVersion').value, os: S.os,
          frame: document.getElementById('win').dataset.platformFrame,
          corner: getComputedStyle(document.getElementById('win')).borderTopLeftRadius,
          trayDisabled: document.getElementById('trayBtn').disabled,
          linuxTray: S.linuxTrayOk, details: document.getElementById('xmPlatformDetails').textContent,
          kbd: document.querySelector('.cmd-trigger kbd')?.textContent };
      });
      assert.equal(v.c.id, p.id); assert.equal(v.os, p.os); assert.equal(v.version, p.id);
      assert.equal(v.c.scenarioOnly, true); assert.equal(v.c.verifiedOnDevice, false);
      assert.equal(v.frame, p.frame); assert.equal(v.c.desktopAvailable, p.os !== 'linux');
      assert.equal(v.c.nodeInstall, p.os === 'win' ? 'managed' : 'external');
      assert.equal(v.c.desktopInstall, p.os === 'win' ? 'managed' : p.os === 'mac' ? 'external' : 'unavailable');
      assert.equal(v.trayDisabled, !v.c.trayCapabilities.available);
      if (p.os === 'linux') assert.equal(v.linuxTray, v.c.trayCapabilities.available);
      if (p.id === 'win10') assert.equal(v.corner, '0px');
      if (p.id === 'win11') assert.equal(v.corner, '8px');
      assert.match(v.details, /未做跨平台真机验证/);
      assert.equal(v.kbd, p.os === 'mac' ? '⌘K' : 'Ctrl+K');
      scenarios++;
    }
  }
  // UI controls and after-render synchronization are exercised through actual DOM changes.
  await page.locator('.proto-bar [data-ctl="os"] button[data-v="win"]').click();
  assert.equal(await page.locator('#xmPlatformSessionLabel').isVisible(), false);
  await page.locator('#xmPlatformVersion').selectOption('win10');
  assert.equal(await page.evaluate(() => XM.platformCapabilities().desktopInstall), 'managed');
  await page.locator('#xmPlatformDetailsToggle').click();
  assert.equal(await page.locator('#xmPlatformDetails').isVisible(), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#xmPlatformDetails').isVisible(), false);
  await page.evaluate(() => { XM.setPlatformVersion('ubuntu2404'); XM.setPlatformSession('x11-no-service'); S.settings.closeAction = 'tray'; A.openTray(); A.closeWindow(); A.osNotify('测试通知', '服务不可用'); });
  assert.equal(await page.locator('#tray').count(), 0);
  assert.equal(await page.evaluate(() => S.settings.closeAction), 'tray');
  assert.match(await page.locator('#toasts').textContent(), /保留窗口/);
  assert.match(await page.locator('#toasts').textContent(), /应用内提醒/);
  await page.evaluate(() => { A.go('settings'); S.settingsTab = '启动与关闭'; render(); });
  const traySetting = page.locator('.setting').filter({ hasText: '点关闭按钮时' }).getByRole('button', { name: '缩到托盘', exact: true });
  if (await traySetting.count()) assert.equal(await traySetting.isDisabled(), true);
  await page.evaluate(() => { XM.setPlatformVersion('win11'); XM.platformNotify = 'blocked'; A.osNotify('权限通知', '未授权'); });
  assert.equal(await page.evaluate(() => XM.platformCapabilities().notify.delivery), 'in-app');
  await page.evaluate(() => { delete XM.platformNotify; });
  let geometryCases = 0;
  for (const os of ['win11', 'mac15', 'ubuntu2404']) for (const theme of ['light', 'dark']) for (const collapsed of [false, true]) for (const mode of ['fixed', 'fluid']) {
    await page.evaluate(({ os, theme, collapsed, mode }) => {
      XM.setPlatformVersion(os); S.theme = theme; S.settings.themePref = theme; S.collapsed = collapsed;
      S.layoutMode = mode; S.view = 'app'; S.page = 'home'; S.moreOpen = true; S.dialogs = [];
      Object.assign(document.getElementById('winbox').style, { width: '1093px', height: '574px', minWidth: '0', minHeight: '0' });
      render();
    }, { os, theme, collapsed, mode });
    const geometry = await page.evaluate(() => {
      const rail = document.getElementById('sidebar').getBoundingClientRect();
      const zoom = Number(document.getElementById('win').dataset.zoom);
      const links = [...document.querySelectorAll('.nav a')].filter((a) => a.getBoundingClientRect().height);
      const inside = [...document.querySelectorAll('#sidebar .avatar,#sidebar .account .sw,#sidebar .account .bal .btn,#sidebar .brand .logo,#sidebar .brand .collapse')].every((el) => {
        const r = el.getBoundingClientRect();
        return !r.width || r.left >= rail.left - .5 && r.right <= rail.right + .5 && r.top >= rail.top - .5 && r.bottom <= rail.bottom + .5;
      });
      const sizes = links.map((el) => ({ height: parseFloat(getComputedStyle(el).height), font: getComputedStyle(el).fontSize, gap: getComputedStyle(el).gap,
        icon: getComputedStyle(el.querySelector('.xm-ui-icon')).width }));
      return { inside, width: rail.width / zoom, sizes };
    });
    assert.equal(geometry.inside, true, JSON.stringify({ os, theme, collapsed, mode, geometry }));
    if (collapsed || mode === 'fluid') assert.ok(Math.abs(geometry.width - 60) < .5);
    for (const item of geometry.sizes) { assert.ok(Math.abs(item.height - 36) < .05); assert.equal(item.font, '14px'); assert.equal(item.gap, '10px'); assert.ok(Math.abs(parseFloat(item.icon) - 20) < .05); }
    geometryCases++;
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ result: 'PASS', browserPrototypeOnly: true, profiles: profiles.length, scenarios, geometryCases, uiNavigationIcon: '20px', navigationRow: '36px', noTrayFallback: 'keep-window', notificationsFallback: 'in-app', errors }, null, 2));
  await browser.close();
})().catch(async (error) => { console.error(error); await activeBrowser?.close(); process.exitCode = 1; });
