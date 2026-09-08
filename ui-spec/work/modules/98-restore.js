/* v3.0.2 restore module — reinstates product decisions from v2 on top of the v3 guide:
   Claude Code as the recommended first tool (Codex desktop as the parallel no-terminal option),
   welcome page (brand headline, four tool chips, 128px horizontal logo, real customer-service QR),
   balance urgency (days estimate + three-tier colors + meter), payment brand icons, time-based greeting,
   dialog focus goes to the first field instead of the close button. Loads after all v3 modules. */
(function () {
  'use strict';
  const ROUTES = ['claude', 'cli', 'desktop', 'gemini', 'grok', 'chat'];
  const ROUTE_TOOL = { claude: 'claude', cli: 'codex', desktop: 'codexDesktop', gemini: 'gemini', grok: 'grok' };
  const gs = () => { S._xm ||= {}; const g = S._xm.onboarding ||= { route: '', step: 0, status: 'idle', run: 0, seen: false, finished: false, scenario: '', fault: '' }; if (g.route && !ROUTES.includes(g.route)) g.route = ''; if (g.route === 'desktop' && S.os === 'linux') g.route = ''; return g; };
  const toolId = () => ROUTE_TOOL[gs().route] || 'claude';
  const tool = () => S.tools[toolId()];
  const needsNode = () => ['claude', 'cli', 'gemini', 'grok'].includes(gs().route);
  const source = () => window.XM?.toolSource?.(toolId()) || tool()?.source;
  const connected = () => source() !== 'unknown' && (Boolean(tool()?.configured) || source() === 'official');
  const ready = () => Boolean(tool()?.installed && connected());
  const btn = (label, action, testid, cls = 'secondary', disabled = false) => `<button class="btn btn-${cls}" data-testid="${testid}" onclick="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const message = (text, kind = '') => `<div class="callout ${kind}" role="status">${ic(kind === 'bad' ? 'info' : 'check')}<span>${text}</span></div>`;
  const stages = ['选一种开始方式', '准备工具', '确认连接', '开始使用'];
  window.greetingText = () => { const h = new Date().getHours(); return h < 11 ? '早上好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好'; };

  /* ---------- 欢迎页 ---------- */
  welcomeHtml = function () {
    const pt = (id, name, meta, ok) => `<div class="ptile">${brand(id)}<div><strong>${name}</strong><span>${meta}</span></div><span class="pb ${ok ? '' : 'g'}">${ok ? '打开' : '安装'}</span></div>`;
    const chips = TOOL_ORDER.filter((id) => id !== 'codexDesktop').map((id) => `<span>${brand(id, 'xs')}${TOOLS[id].name}</span>`).join('');
    return `<div class="welcome xm-welcome ${S.settings.reduceMotion ? 'xm-still' : ''}" data-testid="welcome-page"><div class="hero"><div class="xm-welcome-copy">
      <div class="brandline">${logo('horizontal', 128)}</div>
      <h1>装好就能用的<br><em>AI 编程工具</em></h1>
      <p class="sub">一个账号，四家工具。环境、安装、Key 全都由这里帮你配好——不用敲命令，不用改配置文件。</p>
      <div class="brands">${chips}</div>
      <div class="cta">${btn('登录', "A.guideAuth('login')", 'welcome-login', 'primary')}${btn('注册新账号', "A.guideAuth('register')", 'welcome-register')}</div>
      <div class="xm-welcome-links">${btn('先看看使用步骤', "A.guideHelp('steps')", 'welcome-steps', 'ghost')}${btn(S.settings.reduceMotion ? '开启动画' : '减少动画', 'A.guideMotion()', 'welcome-motion', 'ghost')}</div>
      <div class="legal">${btn('用户协议', "A.dialog('legal',{kind:'terms'})", 'welcome-terms', 'ghost')}${btn('隐私政策', "A.dialog('legal',{kind:'privacy'})", 'welcome-privacy', 'ghost')}</div></div>
      <div class="preview xm-orbit-preview"><div class="xm-orbits" aria-hidden="true"><i></i><i></i><i></i><b></b></div><div class="frame"><div class="prail"><span class="plogo">${logo('micro', 22)}</span><i class="on"></i><i></i><i></i><i></i><i></i></div>
        <div class="pmain"><div class="ph"><strong>${greetingText()}，徐飞</strong>${pill('ok', '环境正常')}</div>
          <div class="pt">${pt('claude', 'Claude Code', 'v2.1.4 · 已配好', true)}${pt('codex', 'Codex CLI', 'v0.49.0 · 已配好', true)}${pt('gemini', 'Gemini CLI', '未安装', false)}${pt('grok', 'Grok CLI', '未安装', false)}</div>
          <div class="prow">${ic('key')}星芒 Key 已自动写入 2 个工具<b style="margin-left:auto">${money(12.4)}</b></div>
          <div class="prow">${ic('clock')}修复登录接口的 token 过期问题<b style="margin-left:auto">今天 14:32</b></div></div></div></div></div>
      <div class="foot">
        <div class="card feat"><span class="fi">${ic('zap')}</span><div><strong>不用敲命令</strong><p>环境、工具、配置点几下就好。装失败会自动撤回，不留半成品。</p></div></div>
        <div class="card feat"><span class="fi">${ic('key')}</span><div><strong>一个账号就够</strong><p>注册后自动准备四把 Key，额度共用，不用到处申请再一个个填。</p></div></div>
        <div class="card feat"><span class="fi">${ic('shield')}</span><div><strong>用的就是原厂模型</strong><p>请求转到各家官方接口，不会偷偷换成更小的模型，用量随时能对账。</p></div></div>
        <div class="card support" data-testid="welcome-support"><span class="qr s"><svg><use href="#q-kf"/></svg></span><div><strong>微信扫码找客服</strong><span class="muted">装不上、付了没到账，扫这个。</span><br><span class="link accent" style="font-size:12px" data-testid="welcome-help" onclick="A.openKf()">在浏览器打开 ↗</span><span class="faint" style="font-size:11.5px"> · 工作日 9:00–22:00</span></div></div>
      </div></div>`;
  };

  /* ---------- 首次引导：Claude Code 优先，Codex 桌面端并列 ---------- */
  const nodeStep = () => { const ok = envReady(); const managed = S.os === 'win'; const busy = S.installing.node != null; return `<div class="st ${ok ? 'done' : 'now'}"><span class="m">${ok ? '✓' : '1'}</span><div><strong>Node.js 运行环境</strong><div class="faint" style="font-size:12px">${ok ? `已找到 ${S.env.node}` : managed ? '命令行工具都靠它运行，只装一次，约 1 分钟' : 'macOS / Linux 需要在应用外安装，装好回来重新检测'}</div></div>${ok ? '<span class="d">已就绪</span>' : busy ? `<span class="d">${S.installing.node}%</span>` : btn(managed ? '一键安装' : '安装指南', managed ? "A.install('node')" : "A.dialog('nodeGuide')", 'guide-node', 'primary')}</div>`; };
  const pyStep = () => { const ok = Boolean(S.env.python); const busy = S.installing.python != null; return `<div class="st ${ok ? 'done' : envReady() ? 'now' : ''}"><span class="m">${ok ? '✓' : '2'}</span><div><strong>Python</strong><div class="faint" style="font-size:12px">${ok ? `已找到 ${S.env.python}` : 'Gemini CLI 需要，会一起装好'}</div></div>${ok ? '<span class="d">已就绪</span>' : busy ? `<span class="d">${S.installing.python}%</span>` : btn('一键安装', "A.install('python')", 'guide-python', 'primary', !envReady())}</div>`; };
  const toolStep = () => { const id = toolId(), t = tool(), ok = t.installed, busy = S.installing[id] != null, can = (envReady() || !needsNode()) && (id !== 'gemini' || Boolean(S.env.python)); return `<div class="st ${ok ? 'done' : can ? 'now' : ''}"><span class="m">${ok ? '✓' : '2'}</span><div><strong>${TOOLS[id].name}</strong><div class="faint" style="font-size:12px">${ok ? `已找到${t.version ? ' v' + esc(t.version) : ''}` : can ? '装好后自动写入星芒 Key' : '先装好运行环境'}</div></div>${ok ? '<span class="d">已就绪</span>' : busy ? `<span class="d">${S.installing[id]}%</span>` : btn('安装', TOOLS[id].desktop ? "A.dialog('codexDesktopWay')" : `A.install('${id}')`, 'guide-install', 'primary', !can)}</div>`; };

  onboardHtml = function () {
    const g = gs(), id = toolId(), t = tool();
    const heading = g.step === 3 ? '可以开始了' : stages[g.step];
    let body = '', actions = '';
    if (g.step === 0) {
      const choice = (r, tid, title, desc, tsid) => `<button class="xm-guide-choice ${g.route === r ? 'selected' : ''}" aria-pressed="${g.route === r}" data-testid="${tsid}" onclick="A.guideChoose('${r}')">${tid ? brand(tid) : ic('chat')}<strong>${title}</strong><span>${desc}</span></button>`;
      body = `<p class="lead">${S.user ? '账号已登录。' : ''}你的账号可以用下面所有工具，选一个先开始，之后随时可以再装别的。</p><div class="xm-guide-choices three">
        ${choice('claude', 'claude', 'Claude Code', 'Anthropic · 命令行，需要 Node.js', 'guide-route-claude')}
        ${choice('cli', 'codex', 'Codex CLI', 'OpenAI · 命令行，需要 Node.js', 'guide-route-cli')}
        ${S.os !== 'linux' ? choice('desktop', 'codexDesktop', 'Codex 桌面端', 'OpenAI · 图形界面，不需要 Node.js', 'guide-route-desktop') : ''}
        ${choice('gemini', 'gemini', 'Gemini CLI', 'Google · 命令行，需要 Node.js 和 Python', 'guide-route-gemini')}
        ${choice('grok', 'grok', 'Grok CLI', 'xAI · 命令行，需要 Node.js', 'guide-route-grok')}
        ${choice('chat', null, '先在星芒里聊天', '直接描述你的问题，稍后再准备编程工具', 'guide-route-chat')}</div>
        <p class="xm-guide-note">不确定选哪个？Claude Code 和 Codex CLI 写代码最常用，Codex 桌面端不用碰命令行。</p>`;
      actions = btn('下一步：准备工具', 'A.guideNext()', 'guide-next', 'primary', !g.route);

    } else if (g.step === 1) {
      if (g.route === 'chat') { body = message('聊天在星芒内打开，这一步无需安装其他工具。'); actions = btn('下一步：确认连接', 'A.guideNext()', 'guide-next', 'primary'); }
      else if (g.status === 'checking') { body = `<div class="xm-guide-task" role="status" aria-live="polite">${ic('refresh', 'spin')}正在核对 ${TOOLS[id].name} 的安装状态</div>`; }
      else if (g.status === 'detect-failed') { body = message('暂时无法确认工具是否已安装。可以重试，或查看图文排查步骤。', 'bad'); actions = btn('重新检测', 'A.guideDetect()', 'guide-retry-detect', 'primary') + btn('查看排查步骤', "A.guideHelp('detect')", 'guide-detect-help'); }
      else {
        body = `<p class="lead">${ready() || t.installed ? `${TOOLS[id].name} 已经装好。` : `按顺序装好这${toolId() === 'gemini' ? '三' : needsNode() ? '两' : '一'}项，中间不用碰命令行。`}</p><div class="xm-guide-sub">${needsNode() ? nodeStep() : ''}${toolId() === 'gemini' ? pyStep() : ''}${toolStep().replace('<span class="m">2</span>', toolId() === 'gemini' ? '<span class="m">3</span>' : '<span class="m">2</span>')}</div>${g.status === 'install-failed' ? message('上次安装没有完成，已自动撤回。可以重试，或按弹窗里的步骤处理。', 'bad') : ''}`;
        actions = (t.installed ? btn('下一步：确认连接', 'A.guideNext()', 'guide-next', 'primary') : '') + btn('我已装好，重新检测', 'A.guideDetect()', 'guide-installed-rescan', t.installed ? 'secondary' : 'secondary');
      }
    } else if (g.step === 2) {
      if (g.route === 'chat') { body = message('进入聊天后，选择分组和模型，再输入第一个问题。'); actions = btn('下一步：开始使用', 'A.guideNext()', 'guide-next', 'primary'); }
      else { const src = source(), official = src === 'official', unknown = src === 'unknown';
        body = `<p class="lead">${TOOLS[id].name} 的连接方式：<strong>${official ? '官方账号' : src === 'account' ? '星芒账号' : unknown ? '已有第三方配置' : '手动填写密钥'}</strong></p>${message(unknown ? '已保留现有第三方配置。请先查看处理步骤，确认哪些设置需要保留后再决定如何连接。' : official ? '保留当前官方来源。官方账号的登录和可用额度，请在工具内确认。' : t.configured ? '注册时服务端已为你准备好 4 把 Key，这一把已自动写入，不用手动配置。需要换 Key 或模型时再打开配置。' : '登录后 Key 会自动写入；也可以打开配置选 Key 和模型。')}`;
        actions = (connected() ? btn(official ? '保留官方来源，继续' : '保留当前连接，继续', 'A.guideNext()', official ? 'guide-keep-official' : 'guide-next', 'primary') : '') + btn(unknown ? '查看已有配置处理步骤' : t.configured ? '查看连接配置' : '去完成连接配置', 'A.guideConfig()', 'guide-config', connected() ? 'secondary' : 'primary'); }
    } else {
      body = `<p class="lead">${g.route === 'chat' ? '从一个问题开始，慢慢熟悉你的 AI 工作台。' : ready() ? `${TOOLS[id].name} 已准备好。打开工具，即可开始第一次任务。` : '引导已保存。你可以先聊天，也可以回首页继续准备工具。'}</p><div class="xm-guide-finish">${ic('check')}<span>有需要时，可从首页重新打开这份引导。</span></div>`;
      actions = (g.route !== 'chat' && t.installed ? btn(`打开 ${TOOLS[id].name}`, 'A.guideOpenTool()', 'guide-open-tool', 'primary') : btn('开始聊天', 'A.guideChat()', 'guide-chat', 'primary')) + btn('进入首页', 'A.enterApp()', 'guide-home') + btn('查看首次使用教程', "A.guideTutorial('first')", 'guide-tutorial', 'ghost'); }
    return `<div class="onboard xm-onboard" data-testid="onboarding-page"><div class="card"><div class="xm-guide-brand"><div class="xm-brand-lockup">${logo('micro', 28)}${logo('wordmark', 22)}</div><span>第 ${g.step + 1} 步，共 4 步</span></div><ol class="xm-guide-progress" aria-label="首次使用进度">${stages.map((name, i) => `<li class="${i === g.step ? 'current' : i < g.step ? 'done' : ''}" ${i === g.step ? 'aria-current="step"' : ''}><i>${i < g.step ? '✓' : i + 1}</i><span>${name}</span></li>`).join('')}</ol><h2 tabindex="-1" data-testid="guide-heading">${heading}</h2><div class="xm-guide-body">${body}</div><div class="xm-guide-actions">${g.step > 0 ? btn('上一步', 'A.guideBack()', 'guide-back', 'ghost') : ''}<span class="spacer" style="flex:1"></span>${actions}${g.step < 3 ? btn('稍后继续，先到首页', 'A.guidePause()', 'guide-pause', 'ghost') : ''}${btn('需要帮助', "A.guideHelp('support')", 'guide-help', 'ghost')}</div></div></div>`;
  };
  A.guideChoose = function (route) { if (!ROUTES.includes(route) || (route === 'desktop' && S.os === 'linux')) return; gs().route = route; render(); };
  const _guideNext = A.guideNext;
  A.guideNext = function () { const g = gs(); if (g.step === 0 && !g.route) { A.toast('先选一种开始方式', 'warn'); return; } _guideNext(); };
  A.guideInstall = function () { const id = toolId(); if (needsNode() && !envReady()) { A.install('node'); return; } A.install(id); };
  A.guideConfig = function () { A.dialog('config', { tool: toolId() }); };
  A.guideOpenTool = function () { A.enterApp(); A.launch(toolId()); };
  const _startOnboard = A.startOnboard;
  A.startOnboard = function () { const g = gs(); if (!g.seen) g.route = ''; _startOnboard(); };

  /* ---------- 首页向导卡（跟随所选路线） ---------- */
  setupCard = function () {
    const g = gs(), id = toolId(), t = tool(), official = t.source === 'official';
    const completed = [Boolean(S.user), g.route === 'chat' || t.installed, g.route === 'chat' || connected(), Boolean(S.launched) || g.finished];
    let at = completed.findIndex((x) => !x); if (at < 0) at = 3;
    const names = ['登录星芒账号', g.route === 'chat' ? '不用装工具' : `装好 ${TOOLS[id].name}`, '确认连接方式', '打开，开始用'];
    const copy = ['登录后 Key 自动写入已装好的工具，四家工具共用一个余额。', g.route === 'chat' ? '先在星芒里聊天，之后随时回来装工具。' : needsNode() && !envReady() ? `先装 Node.js 运行环境（约 1 分钟），再装 ${TOOLS[id].name}，装好自动写入 Key。` : `装 ${TOOLS[id].name}，装好自动写入星芒 Key。`, official ? '将保留当前官方来源，登录与额度在工具内确认。' : '检查当前来源、Key 和模型，完成后即可打开工具。', `打开 ${g.route === 'chat' ? '聊天' : TOOLS[id].name} 做第一个任务。`];
    const action = !S.user ? btn('登录账号', "A.guideAuth('login')", 'home-guide-login', 'primary') : at === 1 ? (g.route === 'chat' ? btn('开始聊天', 'A.guideChat()', 'home-guide-chat', 'primary') : needsNode() && !envReady() ? (S.os === 'win' ? btn(`${ic('dl')}一键安装 Node.js`, "A.install('node')", 'home-guide-node', 'primary') : btn('Node.js 安装指南', "A.dialog('nodeGuide')", 'home-guide-node', 'primary')) : btn(`${ic('dl')}安装 ${TOOLS[id].name}`, TOOLS[id].desktop ? "A.dialog('codexDesktopWay')" : `A.install('${id}')`, 'home-guide-install', 'primary', S.installing[id] != null)) : at === 2 ? btn('去确认连接', 'A.guideResume(2)', 'home-guide-config', 'primary') : g.route === 'chat' ? btn('开始聊天', 'A.guideChat()', 'home-guide-chat', 'primary') : btn(`${ic('open')}打开 ${TOOLS[id].name}`, 'A.guideOpenTool()', 'home-guide-open', 'primary');
    const extra = at === 1 && g.route !== 'chat' ? `<span class="link" onclick="A.guideResume(0)">换一种开始方式</span><span class="link" onclick="A.dialog('support')">卡住了？找客服</span>` : at === 0 ? `<span class="link" onclick="A.guideAuth('register')">还没账号，注册</span>` : '';
    return `<div class="card setup xm-setup" data-testid="home-setup"><div class="card-head"><h2>${g.finished ? '接下来可以做什么' : '开始使用'}</h2><span>${g.finished ? '随时可以重看引导' : `第 ${at + 1} 步，共 4 步`}</span><div class="bar">${completed.map((done, i) => `<i class="${done ? 'done' : i === at ? 'now' : ''}"></i>`).join('')}</div></div><div class="focus"><span class="num ${g.finished ? 'done' : ''}">${g.finished ? '✓' : at + 1}</span><div class="txt"><h3>${names[at]}</h3><p>${copy[at]}</p></div><div class="cta">${action}${extra}</div></div><div class="later">${names.map((n, i) => `<div class="${completed[i] ? 'done' : i === at ? 'now' : ''}"><span class="n">${completed[i] ? '✓' : i + 1}</span>${n}</div>`).join('')}</div></div>`;
  };

  /* ---------- 首页问候（按时段） ---------- */
  const _homeHtml = homeHtml;
  homeHtml = function () { return _homeHtml().replace(/<h1>你好，/, `<h1>${greetingText()}，`); };

  /* ---------- 账号卡：三色余额 + 用量条 + 天数估算 + 三色充值按钮 ---------- */
  const _accountCard = accountCard;
  accountCard = function () {
    if (!S.user) return _accountCard();
    const u = S.user, t = balTier(u), pct = Math.min(100, Math.round(u.balance / Math.max(0.01, (u.usedMonth || 0) + u.balance) * 100));
    const written = TOOL_ORDER.filter((id) => S.tools[id].installed && S.tools[id].configured).length;
    const base = `<div class="card" data-testid="home-account"><div class="card-head"><h2>账户余额</h2><span class="right">${written ? pill('ok', `Key 已写入 ${written} 个工具`) : pill('', '还没写入 Key')}</span></div>
      <div class="acct"><div class="bal"><b class="tier-${t}">${money(u.balance)}</b><span>可用余额 · 美元</span></div><div class="bal-meter ${t}"><i style="width:${pct}%"></i></div><div class="sub"><span>本月已用 ${money(u.usedMonth || 0)}</span><span class="tier-${t}">${balHint(u)}</span></div>
      <div class="acts">${rechargeBtn('sm')}<button class="btn btn-ghost sm" onclick="A.openAccount('dashboard')">用量看板</button></div></div></div>`;
    return base + (window.XM?.officialMeter ? XM.officialMeter() : '');
  };

  /* ---------- 渲染后处理：支付图标、订单方式图标、弹窗焦点 ---------- */
  const PAY_ICONS = { stripe: ['stripe', 'alipay'], creem: ['wechat', 'alipay'], alipay: ['alipay'], wechat: ['wechat'] };
  function post() {
    document.querySelectorAll('.pay-opt[data-testid^="payment-channel-"]').forEach((el) => { if (el.dataset.iconized) return; const id = el.dataset.testid.replace('payment-channel-', ''); const icons = PAY_ICONS[id] || PAY_ICONS[Object.keys(PAY_ICONS).find((k) => id.includes(k))] ; if (!icons) return; const ico = el.querySelector('.ico'); if (ico) { ico.outerHTML = `<span class="icons">${icons.map((i) => `<span class="ico"><svg><use href="#x-${i}"/></svg></span>`).join('')}</span>`; el.dataset.iconized = '1'; } });
    document.querySelectorAll('td').forEach((td) => { const v = td.textContent.trim(); const k = v === 'Stripe' ? 'stripe' : v === 'Creem' ? 'wechat' : null; if (k && !td.dataset.iconized) { td.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px"><span class="ico inline"><svg><use href="#x-${k}"/></svg></span>${esc(v)}</span>`; td.dataset.iconized = '1'; } });
    const dlg = [...document.querySelectorAll('.dialog')].pop();
    if (dlg && dlg.contains(document.activeElement) && document.activeElement.closest('header')) { const first = dlg.querySelector('.body input:not([disabled]):not([type=hidden]), .body select:not([disabled]), .body textarea:not([disabled]), .body .segment button.on, .body button:not([disabled])') || dlg.querySelector('footer .btn-primary'); if (first) first.focus({ preventScroll: true }); }
  }
  /* 产品决策：注册后服务端自动建齐 4 把 Key；已登录且已安装、来源为星芒账号的工具自动写入对应 Key */
  const KEY_DEFS = [['k1', 'Claude Code · 本机', 'Claude 专线', 'A7f2', ['claude']], ['k2', 'Codex · 本机', 'GPT 专线', 'Q9d1', ['codex', 'codexDesktop']], ['k3', 'Gemini · 本机', '默认分组', 'G4e7', ['gemini']], ['k4', 'Grok · 本机', '默认分组', 'X1b5', ['grok']]];
  function reconcile() {
    if (!S.user) return;
    if (!Array.isArray(S.keys)) S.keys = [];
    KEY_DEFS.forEach(([id, name, group, tail]) => { if (!S.keys.find((k) => k.id === id)) S.keys.push({ id, name, group, masked: `sk-xm-****-${tail}`, full: `sk-xm-3f9c2a17e4b8d0a6c5e1f7b2${tail}`, status: 'active', created: '2026-09-06', used: '从未', show: false }); });
    KEY_DEFS.forEach(([id, , , , tools]) => tools.forEach((tid) => { const t = S.tools[tid]; if (t && t.installed && !t.configured && (t.source === 'account' || !t.source) && S.installing[tid] == null && S.sim !== 'revoked') { t.configured = true; t.source = 'account'; t.key = id; } }));
  }
  const _render = render; render = function () { reconcile(); _render(); post(); };
  const _rerender = rerenderMain; rerenderMain = function () { reconcile(); _rerender(); post(); };
  if (typeof window.XM === 'object' && XM) XM.restoreV302 = true;
})();
