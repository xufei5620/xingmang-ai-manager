'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.XINGMANG_PLAYWRIGHT_MODULE || '@playwright/test');
const specRoot = path.resolve(__dirname, '..');
const publicPrototype = path.join(specRoot, 'prototype', '星芒AI管理工具-可交互原型.html');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const labels = { home: '首页', chat: '聊天', sessions: '记录', canvas: '画布', mcp: '外接工具', skills: '技能', plugins: '插件', tutorial: '教程', health: '检查', maintenance: '安装卸载', backups: '备份', feedback: '反馈', updates: '更新', settings: '设置', welcome: '欢迎', onboarding: '首次引导', login: '登录', register: '注册', recovery: '找回密码' };
const ordinaryPages = Object.keys(labels);
const accountTabs = ['overview', 'dashboard', 'keys', 'usage', 'tasks', 'recharge', 'orders', 'invite', 'devices'];
const settingsTabs = ['外观', '启动与关闭', '工具', '网络', '通知', '账号', '隐私与数据', '关于'];
const pageIds = [...ordinaryPages, ...accountTabs.map(id => 'account-' + id), ...settingsTabs.slice(1).map((_, index) => 'settings-' + (index + 1))];
const listPages = ['mcp', 'skills', 'plugins', 'backups', 'sessions', 'feedback'];
const accountStateTabs = ['dashboard', 'keys', 'usage', 'tasks', 'orders', 'devices'];
function supportFor(id, state) {
  if (state === 'default') return { supported: true, method: 'documented page entry' };
  if (listPages.includes(id)) return { supported: true, method: 'XM.scene' };
  if (id.startsWith('account-') && accountStateTabs.includes(id.slice(8))) return { supported: true, method: 'A.accountScenario' };
  if (id === 'updates' && state !== 'empty') return { supported: true, method: 'A.maintenanceScenario(update)' };
  if (id === 'health') return { supported: true, method: 'A.healthRun/A.maintenanceScenario(health)' };
  if (id === 'chat') return { supported: true, method: state === 'empty' ? 'empty account conversation data' : state === 'loading' ? 'A.chatSend (generating)' : 'A.chatScenario(timeout)' };
  if (id === 'canvas') return { supported: true, method: state === 'loading' ? 'A.canvasSave (saving)' : 'A.canvasScenario' };
  if (['login', 'register', 'recovery', 'onboarding'].includes(id) && state !== 'empty') return { supported: true, method: 'offline form/guide submit and documented fault preset' };
  if (id === 'welcome') return { supported: false, reason: '欢迎页是静态入口，原型没有列表空态/加载态/读取失败态。' };
  return { supported: false, reason: '当前公开原型没有该页面的独立 ' + state + ' 场景；不构造替代画面冒充。' };
}
async function launch() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1460, height: 1080 }, locale: 'zh-CN' });
  const errors = []; const remoteRequests = [];
  await context.route(/^https?:/i, route => { remoteRequests.push(route.request().url()); return route.abort(); });
  context.on('page', page => { page.setDefaultTimeout(7000); page.setDefaultNavigationTimeout(15000); page.on('pageerror', error => errors.push(error.message)); });
  return { browser, context, errors, remoteRequests };
}
async function open(page) {
  await page.goto(pathToFileURL(publicPrototype).href);
  await page.waitForFunction(() => typeof window.XM?.reviewScenario === 'function' && typeof A?.go === 'function');
  await page.evaluate(() => document.fonts.ready);
}
async function setPage(page, id, state = 'default', os = 'win', theme = 'light') {
  await page.evaluate(({ id, state, os, theme, settingsTabs }) => {
    S = freshState(!['welcome', 'onboarding', 'login', 'register', 'recovery'].includes(id));
    S.os = os; S.theme = theme; S.layoutMode = 'fixed'; S.collapsed = false;
    Object.assign(S.settings, { themePref: theme, uiScale: 'auto', reduceMotion: true, skin: theme === 'dark' ? 'obsidian' : 'dawn' });
    S.skin = theme === 'dark' ? 'obsidian' : 'dawn'; S.update.dismissed = true; S.update.dismissedDl = true; S.update.dismissedOk = true; S.coach = null; S.dialogs = [];
    Object.assign(document.getElementById('winbox').style, { width: '1280px', height: '900px', minWidth: '0', minHeight: '0' });
    if (id.startsWith('account-')) { A.openAccount(id.slice(8)); if (state !== 'default') A.accountScenario(id.slice(8), state); }
    else if (id.startsWith('settings-')) { A.go('settings'); A.settingSection(settingsTabs[Number(id.slice(9))]); }
    else if (id === 'welcome') { S.view = 'welcome'; render(); }
    else if (id === 'onboarding') { S.view = 'welcome'; render(); A.dialog('login'); }
    else if (id === 'login' || id === 'register') { S.view = 'welcome'; render(); A.dialog(id); }
    else if (id === 'recovery') { S.view = 'welcome'; render(); A.recoveryScenario('ready'); }
    else if (id === 'canvas') { A.canvasScenario(state === 'empty' ? 'empty' : state === 'error' ? 'saveFailure' : 'demo'); if (state === 'loading') A.canvasSave(); }
    else {
      A.go(id);
      if (['mcp', 'skills', 'plugins', 'backups', 'sessions', 'feedback'].includes(id) && state !== 'default') { if (id === 'feedback' && state === 'empty') { S.logs = []; render(); } else XM.scene(id, state); }
      if (id === 'updates' && state !== 'default') A.maintenanceScenario('update', state === 'loading' ? 'checking' : 'failed');
      if (id === 'health') { if (state === 'loading') A.healthRun(); else if (state === 'error') { A.maintenanceScenario('health', 'failed'); A.healthRun(); } }
      if (id === 'chat') { if (state === 'empty') { S.chat.convs = []; S.chat.active = null; render(); } else if (state === 'error' || state === 'loading') { if (state === 'error') A.chatScenario('timeout'); A.chatDraft('帮我整理任务'); document.getElementById('chatIn').value = '帮我整理任务'; A.chatSend(); } }
    }
    render();
  }, { id, state, os, theme, settingsTabs });
  if (id === 'onboarding') {
    await page.getByTestId('login-account').fill('ui-review-demo');
    await page.getByTestId('login-password').fill('ReviewPass123');
    await page.getByTestId('auth-agree').check();
    await page.getByTestId('login-submit').click();
    await page.getByTestId('guide-heading').waitFor();
    if (state === 'error') await page.evaluate(() => A.guideScene('detect-failed'));
    if (state === 'loading') await page.evaluate(() => { A.guideChoose('claude'); A.guideNext(); });
  }
  if (id === 'login' && state !== 'default') await page.evaluate(state => { Object.assign(S.form, { acc: 'ui-review-demo', pw: state === 'error' ? 'wrong' : 'ReviewPass123', agree: true }); A.login(); }, state);
  if (id === 'register' && state !== 'default') {
    await page.evaluate(state => { if (state === 'error') { A.guideScene('register-failed'); } Object.assign(S.form, { email: 'ui-review@example.com', sent: true, code: '123456', user: 'ui-review-demo', pw: 'ReviewPass123', pw2: 'ReviewPass123', agree: true }); A.register(); }, state);
    if (state === 'error') await page.waitForFunction(() => Boolean(S.form.err) && !S.form.busy);
  }
  if (id === 'recovery' && state !== 'default') {
    await page.evaluate(state => { A.recoveryScenario(state === 'error' ? 'emailFailure' : 'ready'); A.sendReset(); }, state);
    if (state === 'error') await page.waitForFunction(() => topDialog()?.recovery?.sendState === 'failed');
  }
  if (id === 'canvas' && state === 'error') await page.waitForFunction(() => S.canvas45.save.phase === 'failed');
  if (id === 'health' && state === 'error') await page.waitForFunction(() => S.health.status === 'done');
  await page.evaluate(({ theme }) => { S.settings.skin = theme === 'dark' ? 'obsidian' : 'dawn'; S.settings.reduceMotion = true; render(); }, { theme });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return page.evaluate(() => {
    const win = document.getElementById('win'); const content = document.getElementById('content') || document.getElementById('main'); const rect = win.getBoundingClientRect();
    return { view: S.view, page: S.page, accountTab: S.accountTab, os: S.os, theme: S.theme, skin: win.dataset.skin, zoom: win.dataset.zoom, window: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, content: content ? { scrollWidth: content.scrollWidth, clientWidth: content.clientWidth, scrollHeight: content.scrollHeight, clientHeight: content.clientHeight } : null };
  });
}
async function observedState(page, id) {
  return page.evaluate(id => {
    if (id === 'canvas') return { phase: S.canvas45.save.phase, nodes: S.canvas45.project?.nodes.length };
    if (id === 'health') return { phase: S.health.status, issues: S.health.items.filter(item => item.st === 'bad').length };
    if (id === 'updates') return { phase: S.update.phase };
    if (id === 'chat') return { error: Boolean(document.querySelector('.xm-chat-error')), conversations: S.chat.convs.length, generating: Boolean(S.chat.convs.find(conv => conv.id === S.chat.active)?.request) };
    if (id === 'onboarding') return { phase: XM.onboardingState().status, selected: document.querySelectorAll('[data-testid^="guide-route-"][aria-pressed="true"]').length };
    if (id === 'login' || id === 'register') return { type: topDialog()?.type, busy: Boolean(S.form.busy), error: Boolean(S.form.err) };
    if (id === 'recovery') return { phase: topDialog()?.recovery?.sendState };
    if (id.startsWith('account-')) return { phase: XM.accountData()?.scenes[id.slice(8)] ?? 'ready' };
    return { phase: XM.pageStatus(id), ...(id === 'feedback' ? { logs: S.logs.length } : {}) };
  }, id);
}
function matchesState(id, state, observed) {
  if (state === 'default') return true;
  if (id === 'canvas') return state === 'error' ? observed.phase === 'failed' : state === 'loading' ? observed.phase === 'saving' : observed.nodes === 0;
  if (id === 'health') return state === 'error' ? observed.phase === 'done' && observed.issues > 0 : state === 'loading' ? observed.phase === 'running' : observed.phase === 'idle';
  if (id === 'updates') return observed.phase === (state === 'error' ? 'failed' : 'checking');
  if (id === 'chat') return state === 'error' ? observed.error : state === 'loading' ? observed.generating : observed.conversations === 0;
  if (id === 'onboarding') return observed.phase === (state === 'error' ? 'detect-failed' : 'checking');
  if (id === 'login' || id === 'register') return state === 'error' ? observed.error && !observed.busy : observed.busy;
  if (id === 'recovery') return observed.phase === (state === 'error' ? 'failed' : 'sending');
  if (id === 'feedback' && state === 'empty') return observed.logs === 0;
  return observed.phase === state;
}
module.exports = { specRoot, publicPrototype, hash, pageIds, accountTabs, settingsTabs, labels, supportFor, launch, open, setPage, observedState, matchesState };
