/* First-use guide. Offline state transitions only; install/configuration delegate to their owners. */
(function () {
  'use strict';
  const guideState = () => { S._xm ||= {}; const g=S._xm.onboarding ||= { route: S.os === 'linux' ? 'cli' : 'desktop', step: 0, status: 'idle', run: 0, seen: false, finished: false, scenario: '', fault: '' };if(S.os==='linux'&&g.route==='desktop')g.route='cli';return g; };
  const caps = () => window.XM?.platformCapabilities?.() || { desktopAvailable: S.os !== 'linux', desktopInstall: S.os === 'win' ? 'managed' : S.os === 'mac' ? 'external' : 'unavailable', nodeInstall: S.os === 'win' ? 'managed' : 'external' };
  const toolId = () => guideState().route === 'cli' ? 'codex' : 'codexDesktop';
  const tool = () => S.tools[toolId()];
  const source = () => window.XM?.toolSource?.(toolId()) || tool()?.source;
  const connected = () => source()!=='unknown' && (Boolean(tool()?.configured)||source()==='official');
  const ready = () => Boolean(tool()?.installed && connected());
  const btn = (label, action, testid, cls = 'secondary', disabled = false) => `<button class="btn btn-${cls}" data-testid="${testid}" onclick="${action}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  const message = (text, kind = '') => `<div class="callout ${kind}" role="status">${ic(kind === 'bad' ? 'info' : 'check')}<span>${text}</span></div>`;
  const stages = ['选一种开始方式', '准备工具', '确认连接', '开始使用'];

  welcomeHtml = function () {
    return `<div class="welcome xm-welcome ${S.settings.reduceMotion ? 'xm-still' : ''}" data-testid="welcome-page"><div class="hero"><div class="xm-welcome-copy">
      <div class="brandline xm-brand-lockup">${logo('micro', 32)}${logo('wordmark', 32)}</div><h1>让 AI 帮你，<br>从这里开始。</h1><p class="sub">不用敲命令，跟着做就能开始。<br>先选一个顺手的工具，星芒陪你完成安装、连接和第一次使用。</p>
      <div class="brands"><span>${brand('codexDesktop', 'xs')}Codex 桌面端</span><span>${ic('chat')}直接聊天</span><span>${ic('book')}图文引导</span></div>
      <div class="cta">${btn('已有账号，登录', "A.guideAuth('login')", 'welcome-login', 'primary')}${btn('创建账号', "A.guideAuth('register')", 'welcome-register')}</div>
      <div class="xm-welcome-links">${btn('先看看使用步骤', "A.guideHelp('steps')", 'welcome-steps', 'ghost')}${btn(S.settings.reduceMotion ? '开启动画' : '减少动画', 'A.guideMotion()', 'welcome-motion', 'ghost')}</div>
      <div class="legal">${btn('用户协议', "A.dialog('legal',{kind:'terms'})", 'welcome-terms', 'ghost')}${btn('隐私政策', "A.dialog('legal',{kind:'privacy'})", 'welcome-privacy', 'ghost')}</div></div>
      <div class="preview xm-orbit-preview"><div class="xm-orbits" aria-hidden="true"><i></i><i></i><i></i><b></b></div><div class="frame"><div class="prail"><span class="plogo">${logo('micro',22)}</span><i class="on"></i><i></i><i></i><i></i></div><div class="pmain"><div class="ph"><strong>你的 AI 工作台</strong><span class="xm-preview-label">开始使用</span></div><div class="xm-preview-tool">${brand('codexDesktop')}<div><strong>Codex 桌面端</strong><span>看得见的界面，一步步上手</span></div></div><div class="xm-preview-steps"><span><i>1</i>准备工具</span><span><i>2</i>确认连接</span><span><i>3</i>开始使用</span></div><div class="prow">${ic('chat')}也可以先在星芒里问一个问题</div><div class="xm-preview-prompt">帮我把一个想法，变成第一步。<span>${ic('spark')}</span></div></div></div></div></div>
      <div class="foot"><div class="card feat"><span class="fi">${ic('zap')}</span><div><strong>新手也能上手</strong><p>每一步告诉你做什么，遇到问题随时返回。</p></div></div><div class="card feat"><span class="fi">${ic('key')}</span><div><strong>连接方式看得清</strong><p>星芒、官方或自定义来源，由你选择。</p></div></div><div class="card feat"><span class="fi">${ic('book')}</span><div><strong>先学一点，再试一点</strong><p>工具、配置与教程都有对应入口。</p></div></div><div class="card support"><span class="fi">${ic('chat')}</span><div><strong>卡住了，有地方问</strong><span class="muted">打开帮助，查看下一步。</span><br>${btn('查看帮助', "A.guideHelp('support')", 'welcome-help', 'ghost')}</div></div></div></div>`;
  };

  onboardHtml = function () {
    const g = guideState(), desktop = caps().desktopAvailable;
    if (!desktop && g.route === 'desktop') g.route = 'cli';
    const t = tool(), id = toolId();
    const installResult=S._xm?.tools?.lastResult;
    if(g.step===1&&installResult?.id===id&&installResult.type==='failed'&&!t.installed)g.status='install-failed';
    if(g.step===2&&t.configured&&g.status==='config-partial')g.status='checked';
    const heading = g.step === 3 ? '可以开始了' : stages[g.step];
    let body = '', actions = '';
    if (g.step === 0) {
      body = `<p class="lead">${S.user ? '账号已登录。' : ''}选一个适合你的开始方式，之后还可以切换。</p><div class="xm-guide-choices">
        ${desktop ? `<button class="xm-guide-choice ${g.route === 'desktop' ? 'selected' : ''}" aria-pressed="${g.route === 'desktop'}" data-testid="guide-route-desktop" onclick="A.guideChoose('desktop')">${brand('codexDesktop')}<strong>Codex 桌面端 <small>新手推荐</small></strong><span>通过图形界面完成任务，无需先装 Node.js。</span></button>` : `<button class="xm-guide-choice ${g.route === 'cli' ? 'selected' : ''}" aria-pressed="${g.route === 'cli'}" data-testid="guide-route-cli" onclick="A.guideChoose('cli')">${brand('codex')}<strong>Codex 命令行工具</strong><span>此系统使用命令行工具，按图文步骤准备运行环境。</span></button>`}
        <button class="xm-guide-choice ${g.route === 'chat' ? 'selected' : ''}" aria-pressed="${g.route === 'chat'}" data-testid="guide-route-chat" onclick="A.guideChoose('chat')">${ic('chat')}<strong>先在星芒里聊天</strong><span>直接描述你的问题，稍后再准备编程工具。</span></button></div><p class="xm-guide-note">${desktop ? 'Node.js、npm 和命令行工具都可以稍后按需准备。' : '暂时不想处理运行环境，可以先进入聊天。'}</p>`;
      actions = btn('下一步：准备工具', 'A.guideNext()', 'guide-next', 'primary');
    } else if (g.step === 1) {
      if (g.route === 'chat') { body = message('聊天在星芒内打开，这一步无需安装其他工具。'); actions = btn('下一步：确认连接', 'A.guideNext()', 'guide-next', 'primary'); }
      else if (g.status === 'checking') { body = `<div class="xm-guide-task" role="status" aria-live="polite">${ic('refresh','spin')}正在核对 ${TOOLS[id].name} 的安装状态</div><p class="xm-guide-note">当前任务：${g.task || '读取工具状态'}。完成后显示检测结果。</p>`; }
      else if (g.status === 'detect-failed') { body = message('暂时无法确认工具是否已安装。可以重试，或查看图文排查步骤。', 'bad'); actions = btn('重新检测', 'A.guideDetect()', 'guide-retry-detect', 'primary') + btn('查看排查步骤', "A.guideHelp('detect')", 'guide-detect-help'); }
      else if (t.installed) { body = message(`已找到 ${TOOLS[id].name}${t.version ? ' · ' + esc(t.version) : ''}。${g.route === 'desktop' ? '桌面端无需先安装 Node.js。' : '接下来确认连接方式。'}`); actions = btn('下一步：确认连接', 'A.guideNext()', 'guide-next', 'primary') + btn('重新检测', 'A.guideDetect()', 'guide-rescan'); }
      else { const external = g.route === 'desktop' && caps().desktopInstall === 'external';
        body = `<p class="lead">${g.status === 'install-failed' ? '上次安装未完成，可以重试或按图文步骤处理。' : `还没有找到 ${TOOLS[id].name}。`}</p>${message(external ? 'macOS 需要在应用外完成安装。安装后回到这里重新检测。' : g.route === 'cli' ? '命令行工具需要 Node.js 和 npm。图文指南会分别说明环境与工具的准备步骤。' : '下一步会打开安装选项，完成后回到这里继续。', g.status === 'install-failed' ? 'bad' : '')}`;
        if (S.installing[id] != null) body += `<div class="xm-guide-task" role="status">${ic('refresh','spin')}正在准备 ${TOOLS[id].name}，可在任务状态里查看结果。</div>`;
        actions = btn(external ? '查看安装指南' : g.route === 'cli' ? '查看命令行准备步骤' : '安装 Codex 桌面端', g.route === 'cli' ? "A.guideHelp('cli')" : 'A.guideInstall()', 'guide-install', 'primary', S.installing[id] != null) + btn('我已安装，重新检测', 'A.guideDetect()', 'guide-installed-rescan'); }
    } else if (g.step === 2) {
      if (g.route === 'chat') { body = message('进入聊天后，选择分组和模型，再输入第一个问题。可用模型与费用以所选连接的实际信息为准。'); actions = btn('下一步：开始使用', 'A.guideNext()', 'guide-next', 'primary'); }
      else { const src=source(), official = src === 'official', unknown=src==='unknown';
        body = `<p class="lead">${TOOLS[id].name} 的连接方式：<strong>${official ? '官方账号' : src === 'account' ? '星芒账号' : unknown ? '已有第三方配置' : '手动填写密钥'}</strong></p>${g.status === 'config-partial' ? message('工具已安装，连接配置还有一项未完成。已完成的部分保留，可以继续处理。', 'bad') : message(unknown ? '已保留现有第三方配置。请先查看处理步骤，确认哪些设置需要保留后再决定如何连接。' : official ? '保留当前官方来源。官方账号的登录和可用额度，请在工具内确认。' : t.configured ? '已有连接配置。需要更换 Key 或模型时，可以打开配置检查。' : '先选好连接来源、Key 和模型，再开始使用。')}`;
        actions = (connected() ? btn(official ? '保留官方来源，继续' : '保留当前连接，继续', 'A.guideNext()', official ? 'guide-keep-official' : 'guide-next', 'primary') : '') + btn(unknown ? '查看已有配置处理步骤' : t.configured ? '查看连接配置' : '去完成连接配置', 'A.guideConfig()', 'guide-config', connected() ? 'secondary' : 'primary'); }
    } else {
      body = `<p class="lead">${g.route === 'chat' ? '从一个问题开始，慢慢熟悉你的 AI 工作台。' : ready() ? `${TOOLS[id].name} 已准备好。打开工具，即可开始第一次任务。` : '引导已保存。你可以先聊天，也可以回首页继续准备工具。'}</p><div class="xm-guide-finish">${ic('check')}<span>有需要时，可从首页重新打开这份引导。</span></div>`;
      actions = (g.route !== 'chat' && t.installed ? btn(`打开 ${TOOLS[id].name}`, 'A.guideOpenTool()', 'guide-open-tool', 'primary') : btn('开始聊天', 'A.guideChat()', 'guide-chat', 'primary')) + btn('进入首页', 'A.enterApp()', 'guide-home') + btn('查看首次使用教程', "A.guideTutorial('first')", 'guide-tutorial', 'ghost'); }
    return `<div class="onboard xm-onboard" data-testid="onboarding-page"><div class="card"><div class="xm-guide-brand"><div class="xm-brand-lockup">${logo('micro',24)}${logo('wordmark',28)}</div><span>第 ${g.step + 1} 步，共 4 步</span></div><ol class="xm-guide-progress" aria-label="首次使用进度">${stages.map((name,i) => `<li class="${i === g.step ? 'current' : i < g.step ? 'done' : ''}" ${i === g.step ? 'aria-current="step"' : ''}><i>${i < g.step ? '✓' : i + 1}</i><span>${name}</span></li>`).join('')}</ol><h2 tabindex="-1" data-testid="guide-heading">${heading}</h2><div class="xm-guide-body">${body}</div><div class="xm-guide-actions">${g.step > 0 ? btn('上一步','A.guideBack()','guide-back','ghost') : ''}<span class="spacer"></span>${actions}</div><div class="xm-guide-foot">${btn('稍后继续，先到首页','A.guidePause()','guide-pause','ghost')}${btn('需要帮助',"A.guideHelp('support')",'guide-help','ghost')}</div></div></div>`;
  };

  A.startOnboard = function () { const g=guideState(); g.step=0; g.status='idle'; g.run++; g.seen=true; g.finished=false; if (!caps().desktopAvailable && g.route==='desktop') g.route='cli'; S.onboard={xm:true}; S.view='onboard'; S.coach=null; render(); };
  A.guideChoose = function (route) { if(!['desktop','cli','chat'].includes(route)||route==='desktop'&&!caps().desktopAvailable)return;guideState().route=route; render(); };
  A.guideNext = function () { const g=guideState(); if (g.step===2 && g.route!=='chat' && !connected()) { A.guideConfig(); return; } g.step=Math.min(3,g.step+1); if(g.step===1 && g.route!=='chat') A.guideDetect(); else render(); };
  A.guideBack = function () { const g=guideState(); g.run++; g.step=Math.max(0,g.step-1); g.status='idle'; render(); };
  A.guideDetect = function () { const g=guideState(), session=S, run=++g.run; g.status='checking'; g.task='核对安装位置与版本'; render(); later(()=>{if(S!==session || g.run!==run || S.view!=='onboard')return; g.status=g.fault==='detect-failed' ? 'detect-failed' : 'checked'; g.fault=''; render();},450); };
  A.guideInstall = function () { A.install(toolId()); };
  A.guideConfig = function () { A.dialog('config',{tool:toolId()}); };
  A.guidePause = function () { const g=guideState(); g.run++; S.view='app'; S.page='home'; S.onboard=null; render(); };
  A.enterApp = function () { const g=guideState(); g.run++; g.finished=g.step===3; S.view='app'; S.page='home'; S.onboard=null; S.coach=null; render(); };
  A.guideChat = function () { A.enterApp(); A.go('chat'); };
  A.guideOpenTool = function () { A.enterApp(); A.launch(toolId()); };
  A.guideTutorial = function (section='first') { A.guidePause(); S.q.tutorial=''; A.go('tutorial',section); };
  A.replayOnboarding = function () { if(S.dialogs.length) { A.requestDialogClose('dismiss'); return; } A.startOnboard(); };
  A.guideMotion = function () { S.settings.reduceMotion=!S.settings.reduceMotion; document.documentElement.style.setProperty('--motion',S.settings.reduceMotion?'0':'1'); render(); };
  A.guideAuth = function (type) { A.dialog(type); };
  A.guideHelp = function (topic) { A.dialog('guideHelp',{topic}); };
  DIALOGS.guideHelp = function (p) {
    const topics={steps:['从一个工具开始','登录账号，选择桌面端或聊天，确认连接方式，再开始第一次任务。每一步都可以返回。'],support:['卡住了，从这里继续','安装问题先重新检测；连接问题到工具配置查看来源、Key 和模型。需要更多说明时打开教程。'],detect:['已安装却没有找到','先确认工具已安装到应用目录并能手动打开，再回到星芒重新检测。仍然无法识别时可查看检查与反馈。'],cli:['命令行工具准备步骤','按顺序准备环境、工具和连接。macOS 与 Linux 的运行环境需要按外部安装指南处理；暂时不想处理，也可以先聊天。']};
    const [title,copy]=topics[p.topic]||topics.support;
    let body=`<p class="xm-guide-help-copy">${copy}</p>`,footer=btn('返回继续',"A.requestDialogClose('dismiss')",'guide-help-back','primary');
    if(p.topic==='cli')body+=`<ol class="xm-help-steps"><li><strong>准备 Node.js 与 npm</strong><p>${envReady()?'已经检测到运行环境，可以继续下一步。':'安装一次，供命令行工具使用。'}</p>${btn(envReady()?'查看环境状态':S.os==='win'?'准备运行环境':'打开环境安装指南',"A.guideHelpAction('node')",'guide-cli-node')}</li><li><strong>安装 Codex CLI</strong><p>${S.tools.codex.installed?'已经检测到 Codex CLI。':'环境准备好后，再打开工具安装步骤。'}</p>${btn(S.tools.codex.installed?'重新检测工具':'准备 Codex CLI',"A.guideHelpAction('cli')",'guide-cli-install')}</li><li><strong>确认连接并开始</strong><p>可使用星芒、官方或自定义来源。已有来源会保留。</p>${btn('我已安装，继续检测',"A.guideHelpAction('detect')",'guide-cli-rescan')}</li></ol>`;
    else if(p.topic==='steps')body+=`<ol class="xm-help-steps"><li><strong>登录或创建账号</strong><p>注册成功后自动登录。</p></li><li><strong>${caps().desktopAvailable?'准备 Codex 桌面端':'准备命令行工具，或先聊天'}</strong><p>${caps().desktopAvailable?'已有工具会先检测，不必重复安装。':'Linux 引导包含运行环境与 Codex CLI 的准备步骤。'}</p></li><li><strong>确认连接方式</strong><p>保留已有来源，按需查看 Key 和模型。</p></li><li><strong>开始第一次任务</strong><p>打开工具或聊天，随时回到首页继续。</p></li></ol>`;
    else footer=btn('查看排查教程',"A.guideHelpAction('tutorial')",'guide-help-tutorial')+btn('打开检查',"A.guideHelpAction('health')",'guide-help-health')+footer;
    return dialogShell({title,sub:'随时返回原来的页面继续',body,footer});
  };
  A.guideHelpAction = function (action) {
    if(topDialog()?.type!=='guideHelp')return;
    A.closeDialog();
    if(action==='node'){if(envReady()){A.go('health');return;}A.install('node');return;}
    if(action==='cli'){guideState().route='cli';if(S.tools.codex.installed){A.guideResume(1);return;}A.install('codex');return;}
    if(action==='detect'){guideState().route='cli';A.guideResume(1);return;}
    if(action==='health'){A.guidePause();A.go('health');return;}
    A.guideTutorial('trouble');
  };

  /* Preserve the established home columns; the guide uses the selected tool, not global Node readiness. */
  setupCard = function () {
    const g=guideState(), id=toolId(), t=tool(), official=t.source==='official';
    const completed=[Boolean(S.user),g.route==='chat'||t.installed,g.route==='chat'||connected(),Boolean(S.launched)||g.finished];
    let at=completed.findIndex(x=>!x); if(at<0)at=3;
    const titles=['登录星芒账号',g.route==='cli'?'准备命令行工具':'准备 Codex 桌面端','确认连接方式','开始第一次使用'];
    const copy=[ '登录后查看属于你的 Key、余额与聊天记录。',g.route==='cli'?'此系统使用命令行工具。按图文指南准备 Node.js、npm 和 Codex CLI；也可先聊天。':'推荐从有图形界面的 Codex 桌面端开始，无需先安装 Node.js。',official?'将保留当前官方来源，登录与额度在工具内确认。':'检查当前来源、Key 和模型，完成后即可打开工具。','打开工具做第一个任务，也可以先在星芒里问一个问题。'];
    const action=!S.user?btn('登录账号',"A.guideAuth('login')",'home-guide-login','primary'):at===1?btn(g.route==='cli'?'查看准备步骤':'继续准备工具',"A.guideResume(1)",'home-guide-install','primary'):at===2?btn('去确认连接',"A.guideResume(2)",'home-guide-config','primary'):g.route==='chat'?btn('开始聊天','A.guideChat()','home-guide-chat','primary'):btn(`打开 ${TOOLS[id].name}`,'A.guideOpenTool()','home-guide-open','primary');
    return `<div class="card setup xm-setup" data-testid="home-setup"><div class="card-head"><h2>${g.finished?'接下来可以做什么':'继续开始使用'}</h2><span>${g.finished?'随时可以重看引导':`第 ${at+1} 步，共 4 步`}</span><div class="bar">${completed.map((done,i)=>`<i class="${done?'done':i===at?'now':''}"></i>`).join('')}</div></div><div class="focus"><span class="num">${g.finished?'✓':at+1}</span><div class="txt"><h3>${titles[at]}</h3><p>${copy[at]}</p></div><div class="cta">${action}${btn('查看首次使用教程',"A.guideTutorial('first')",'home-guide-tutorial','ghost')}</div></div><div class="xm-setup-links">${btn('从头查看引导','A.replayOnboarding()','home-guide-replay','ghost')}${btn('先去聊天','A.guideChat()','home-guide-chat-secondary','ghost')}${btn('需要命令行工具？',"A.guideHelp('cli')",'home-guide-cli','ghost')}</div></div>`;
  };
  homeHtml = function () {
    const g=guideState(), working=Boolean(S.user)&&TOOL_ORDER.some(id=>S.tools[id].installed&&(S.tools[id].configured||S.tools[id].source==='official'));
    const showGuide=!S.launched||g.seen&&!g.finished;
    const head=pageHead(S.user?`你好，${esc(S.user.display||S.user.name)}`:'欢迎来到星芒',working?'选择工具开始任务，或打开聊天描述你的问题。':'不用敲命令，跟着做就能开始。先准备一个适合你的工具。',`${btn('新手引导','A.replayOnboarding()','home-replay','secondary')}${btn('重新检测','A.rescan()','home-rescan','secondary')}`);
    return `<section class="page xm-home" data-testid="home-page">${head}${S.notify.nodeRestart?`<div class="banner">${ic('info')}<span>Node.js 已安装。命令行工具若暂时识别不到，可重启后再检测。桌面端可以继续使用。</span><div class="right">${btn('知道了','A.dismissRestart()','home-node-dismiss','ghost')}</div></div>`:''}<div class="home-grid"><div class="col">${showGuide?setupCard():''}${toolsGrid()}${S.user&&S.launched?recentCard():''}</div><div class="col">${envCard()}${accountCard()}${tipsCard(working)}</div></div></section>`;
  };
  A.guideResume = function (step) { const g=guideState(); g.step=step; g.seen=true; g.run++; S.view='onboard'; S.onboard={xm:true}; S.coach=null; if(step===1&&g.route!=='chat')A.guideDetect();else render(); };

  /* Native form controls use the existing modal stack, focus trap, and draft-close confirmation. */
  const agreement = f => `<div class="xm-auth-agreement"><label class="xm-auth-check"><input data-testid="auth-agree" type="checkbox" ${f.agree?'checked':''} onchange="F.set('agree',this.checked)">我已阅读并同意</label>${btn('用户协议',"A.dialog('legal',{kind:'terms'})",'auth-terms','ghost')}${btn('隐私政策',"A.dialog('legal',{kind:'privacy'})",'auth-privacy','ghost')}</div>`;
  const authError = f => f.err?`<div class="callout bad" role="alert" data-testid="auth-error">${ic('info')}<span>${esc(f.err)}</span></div>`:'';
  DIALOGS.login = function () { const f=S.form; return dialogShell({title:'登录星芒账号',sub:'登录后继续你的工作台',body:`<div class="field"><label>用户名或邮箱</label><input class="input" data-autofocus data-testid="login-account" autocomplete="username" placeholder="输入用户名或邮箱" value="${esc(f.acc||'')}" oninput="F.set('acc',this.value)"></div><div class="field"><label>密码</label><div class="field-row"><input class="input" data-testid="login-password" type="${f.showPw?'text':'password'}" autocomplete="current-password" placeholder="输入密码" value="${esc(f.pw||'')}" oninput="F.set('pw',this.value)" onkeydown="if(event.key==='Enter')A.login()">${btn(f.showPw?'隐藏':'显示','S.form.showPw=!S.form.showPw;render()','login-show-password')}</div></div><div class="xm-auth-options"><label class="xm-auth-check"><input type="checkbox" ${f.remember!==false?'checked':''} onchange="F.set('remember',this.checked)">记住密码</label><label class="xm-auth-check"><input type="checkbox" ${f.auto?'checked':''} onchange="F.set('auto',this.checked)">自动登录</label></div>${agreement(f)}${authError(f)}`,footer:`${btn('找回密码',"A.dialog('forgot')",'login-forgot','ghost')}${btn('创建账号',"A.guideAuthSwitch('register')",'login-register','ghost')}<span class="spacer"></span>${btn('取消',"A.requestDialogClose('dismiss')",'login-cancel','ghost')}${btn(f.busy?'登录中…':'登录','A.login()','login-submit','primary',f.busy)}`}); };
  DIALOGS.register = function () { const f=S.form; return dialogShell({title:'创建星芒账号',sub:'注册成功后自动登录，继续新手引导',body:`<div class="field"><label>邮箱</label><div class="field-row"><input class="input" data-autofocus data-testid="register-email" type="email" autocomplete="email" placeholder="you@example.com" value="${esc(f.email||'')}" oninput="F.set('email',this.value)">${btn(f.cd?`${f.cd} 秒后重发`:f.sent?'重新获取':'获取验证码','A.sendCode()','register-send-code','secondary',Boolean(f.cd))}</div><div class="hint">${f.sent?'请填写邮件中的验证码。':'用于接收验证码和找回账号。'}</div></div><div class="grid2"><div class="field"><label>验证码</label><input class="input" data-testid="register-code" inputmode="numeric" maxlength="6" placeholder="6 位数字" value="${esc(f.code||'')}" oninput="F.set('code',this.value)"></div><div class="field"><label>用户名</label><input class="input" data-testid="register-user" autocomplete="username" placeholder="至少 3 位" value="${esc(f.user||'')}" oninput="F.set('user',this.value)"></div></div><div class="grid2"><div class="field"><label>密码</label><input class="input" data-testid="register-password" type="password" autocomplete="new-password" placeholder="至少 8 位" value="${esc(f.pw||'')}" oninput="F.set('pw',this.value)"></div><div class="field"><label>确认密码</label><input class="input" data-testid="register-password-confirm" type="password" autocomplete="new-password" placeholder="再次输入密码" value="${esc(f.pw2||'')}" oninput="F.set('pw2',this.value)" onkeydown="if(event.key==='Enter')A.register()"></div></div><div class="field"><label>邀请码 <span class="faint">（选填）</span></label><input class="input" data-testid="register-invite" placeholder="邀请码或邀请链接" value="${esc(f.invite||'')}" oninput="F.set('invite',this.value)"></div>${agreement(f)}${authError(f)}`,footer:`${btn('已有账号，登录',"A.guideAuthSwitch('login')",'register-login','ghost')}<span class="spacer"></span>${btn('取消',"A.requestDialogClose('dismiss')",'register-cancel','ghost')}${btn(f.busy?'创建并登录中…':'创建账号并登录','A.register()','register-submit','primary',f.busy)}`}); };
  A.guideAuthSwitch = function (type) { A.dialog(type,{addAccount:Boolean(S.form.addAccount||topDialog()?.props?.addAccount)}); };
  const finishAuth = async (f,owner,session,registered) => {
    if(S!==session||!S.dialogs.includes(owner))return;
    const g=guideState();
    if(g.authFault==='login-failed'||g.authFault==='register-failed') { g.authFault=''; f.busy=false; f.err=registered?'暂时未能创建账号，输入已保留。请重试。':'暂时未能登录，输入已保留。请重试。'; render(); return; }
    if(registered&&g.authFault==='auto-login-failed') { g.authFault=''; f.busy=false; const username=f.user; S.dialogs.splice(S.dialogs.indexOf(owner)); S.form=topDialog()?.form||S.pageForm||{}; A.dialog('login',{addAccount:Boolean(f.addAccount||owner.props.addAccount)}); S.form.acc=username; S.form.err='账号已创建，自动登录暂未完成。请输入密码继续登录。'; topDialog().initial=formFingerprint(S.form); render(); return; }
    const previousUser=S.user, adding=Boolean(f.addAccount||owner.props.addAccount), index=S.dialogs.indexOf(owner);
    let authRoot=index; while(authRoot>0&&['login','register'].includes(S.dialogs[authRoot-1].type))authRoot--;
    const nested=authRoot>0;
    const name=registered?f.user:String(f.acc).trim(), known=(S.accounts||[]).find(a=>a.name===name||a.email===name);
    const user=known?{...known}:{name:name.includes('@')?name.split('@')[0]:name,display:registered?f.user:name.includes('@')?name.split('@')[0]:name,email:registered?f.email:name.includes('@')?name:'',avatar:false,balance:0,usedMonth:0,invite:'',reward:0};
    S.user=user;
    try { if(window.XM?.authComplete) await window.XM.authComplete(S.user,{adding,registered,previousUser}); else { if(previousUser?.name!==user.name) { S.keys=[]; S.orders=[]; S.usage=[]; S.devices=[]; S.chat.convs=[]; S.chat.active=null; S.chat.draft=''; } if(!(S.accounts||[]).some(a=>a.name===user.name))S.accounts.push({...user}); } }
    catch(error) { if(S!==session)return; S.user=previousUser; f.busy=false; f.err='已验证账号，但工作台暂未准备完成。请重试。'; render(); return; }
    if(S!==session||!S.dialogs.includes(owner))return;
    S.dialogs.splice(authRoot); S.form=topDialog()?.form||S.pageForm||{}; pendingFocus=owner.returnFocus;
    if(S.sim==='expired')S.sim='';
    if(nested) { Object.assign(S,owner.origin); render(); A.toast(registered?'账号已创建并登录，可以继续填写。':'已登录，可以继续填写。'); return; }
    if(adding) { S.view='app'; S.page='home'; render(); A.toast('账号已添加并登录'); return; }
    if(known&&!registered) { S.view='app'; S.page='home'; render(); A.toast('已登录，欢迎回来'); return; }
    A.startOnboard(); A.toast(registered?'账号已创建并自动登录':'登录成功');
  };
  A.login = function () { const f=S.form,owner=topDialog(),session=S; if(!owner||f.busy)return; const err=!String(f.acc||'').trim()||!f.pw?'请输入账号和密码':!f.agree?'请先勾选同意用户协议和隐私政策':f.pw==='wrong'?'账号或密码不正确，请检查后重试。':''; if(err){f.err=err;render();return;} f.err='';f.busy=true;render();later(()=>finishAuth(f,owner,session,false),450); };
  A.register = function () { const f=S.form,owner=topDialog(),session=S; if(!owner||f.busy)return; const err=!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f.email||'')?'请填写正确的邮箱':!f.sent?'请先获取验证码':!/^\d{6}$/.test(f.code||'')?'验证码是 6 位数字':!(f.user&&f.user.length>=3)?'用户名至少 3 位':f.user==='admin'?'用户名已被占用':!(f.pw&&f.pw.length>=8)?'密码至少 8 位':f.pw!==f.pw2?'两次密码不一致':!f.agree?'请先勾选同意用户协议和隐私政策':''; if(err){f.err=err;render();return;} f.err='';f.busy=true;render();later(()=>finishAuth(f,owner,session,true),450); };

  /* Debug fixtures are callable and exposed only in the prototype control bar. */
  const scenarios={welcome:'欢迎页',new:'新用户 / 未安装',installed:'已装桌面端 / 无 Node',official:'保留官方来源',unknown:'自定义来源待确认',mac:'macOS 外部安装',linux:'Linux 命令行引导','detect-failed':'检测失败','install-failed':'安装失败','config-partial':'配置部分失败','register-failed':'注册失败后重试','auto-login-failed':'注册成功 / 自动登录失败','login-failed':'登录失败后重试',complete:'完成引导'};
  A.guideScene=function(name){
    if(!Object.prototype.hasOwnProperty.call(scenarios,name))return false;
    timers.forEach(clearTimeout);
    const prev={os:S.os,theme:S.theme,layoutMode:S.layoutMode,settings:{reduceMotion:S.settings.reduceMotion,uiScale:S.settings.uiScale}};
    S=freshState(!['welcome','new','register-failed','auto-login-failed','login-failed'].includes(name));
    Object.assign(S,{os:prev.os,theme:prev.theme,layoutMode:prev.layoutMode});Object.assign(S.settings,prev.settings,{themePref:prev.theme});
    const g=guideState();g.scenario=name;g.route=S.os==='linux'?'cli':'desktop';g.seen=true;
    S.dialogs=[];S.form={};S.coach=null;S.launched=false;
    if(name==='welcome'){S.view='welcome';render();return true;}
    if(['register-failed','auto-login-failed','login-failed'].includes(name)){S.view='welcome';g.authFault=name;render();A.dialog(name==='login-failed'?'login':'register');return true;}
    if(!S.user){S.user={name:'first-time-demo',display:'新朋友',email:'demo@example.com',balance:0,usedMonth:0,invite:'',reward:0,avatar:false};S.accounts=[{...S.user}];}
    if(name==='mac'){S.os='mac';g.route='desktop';}if(name==='linux'){S.os='linux';g.route='cli';}
    if(['new','mac','linux','install-failed'].includes(name)){S.tools.codexDesktop.installed=false;S.tools.codex.installed=false;S.tools.codexDesktop.configured=false;S.tools.codex.configured=false;S.env.node=null;S.env.npm=null;}
    if(name==='installed'){S.os='win';g.route='desktop';S.env.node=null;S.env.npm=null;S.tools.codexDesktop.installed=true;}
    const id=toolId();
    if(name==='official'||name==='unknown'){const patch={source:name==='official'?'official':'unknown',configured:name==='official',key:null};if(window.XM?.setToolConfig)window.XM.setToolConfig(id,patch);else Object.assign(tool(),patch);}
    if(name==='config-partial'){if(window.XM?.setToolConfig)window.XM.setToolConfig(id,{configured:false});else tool().configured=false;}
    g.step=['official','unknown','config-partial'].includes(name)?2:name==='complete'?3:name==='new'?0:1;
    g.status=['detect-failed','install-failed','config-partial'].includes(name)?name:'checked';
    S.view='onboard';S.onboard={xm:true};render();return true;
  };
  if(window.XM){window.XM.onboardingScenarios=scenarios;window.XM.onboardingState=guideState;}
  const installDebug=()=>{const bar=document.querySelector('.proto-bar');if(!bar||bar.querySelector('[data-testid="guide-scene-selector"]'))return;const label=document.createElement('label');label.className='xm-guide-debug';label.textContent='新手场景 ';const select=document.createElement('select');select.setAttribute('data-testid','guide-scene-selector');select.setAttribute('aria-label','新手引导演示场景');select.innerHTML='<option value="">选择场景</option>'+Object.entries(scenarios).map(([key,title])=>`<option value="${key}">${title}</option>`).join('');select.addEventListener('change',()=>{if(select.value)A.guideScene(select.value);select.value='';});label.append(select);bar.append(label);};
  if(window.XM?.afterRender)window.XM.afterRender(installDebug);else installDebug();
})();
