/* Platform presentation scenarios, not a release/support matrix or device detection.
 * Source: Electron BaseWindow (roundedCorners/titleBarStyle), BrowserWindow (Wayland),
 * Tray (desktop-dependent SNI support), Notifications (OS notification services).
 * https://www.electronjs.org/docs/latest/api/base-window
 * https://www.electronjs.org/docs/latest/api/browser-window
 * https://www.electronjs.org/docs/latest/api/tray
 * https://www.electronjs.org/docs/latest/tutorial/notifications
 * Installation modes follow the source capability table verified by the root task at 0c9:
 * Windows: managed Node + desktop; macOS: external Node + desktop;
 * Linux: external Node + unavailable desktop. Version selections only affect presentation.
 * Each CLI/release/CPU still needs its own compatibility checks.
 */
(() => {
  'use strict';
  const XM = window.XM = window.XM || {};
  if (XM.platformPresentationVersion) return;
  XM.platformPresentationVersion = '3.0.0';
  const familyCapabilities = {
    win: { desktopInstall: 'managed', nodeInstall: 'managed' },
    mac: { desktopInstall: 'external', nodeInstall: 'external' },
    linux: { desktopInstall: 'unavailable', nodeInstall: 'external' },
  };
  const profiles = [
    { id: 'win10', os: 'win', label: 'Windows 10 · 22H2', version: '10', frame: 'win-legacy', note: '旧窗口使用直角与独立标题栏。沿用 Windows 应用内安装能力，安装前核对具体安装包的系统要求；此版本未经真机验证。' },
    { id: 'win11', os: 'win', label: 'Windows 11 · 24H2', version: '11', frame: 'win-modern', note: '演示 Windows 11 小圆角与独立标题栏；窗口边框由实际系统绘制。' },
    { id: 'mac13', os: 'mac', label: 'macOS 13 · Ventura', version: '13', frame: 'mac-classic', note: '保留经典标题区和红黄绿按钮。先核对官方渠道的系统及芯片要求，外部安装后回来检测。' },
    { id: 'mac14', os: 'mac', label: 'macOS 14 · Sonoma', version: '14', frame: 'mac-classic', note: '使用经典 macOS 标题区、红黄绿按钮与普通圆角。运行环境与桌面端均采用外部安装。' },
    { id: 'mac15', os: 'mac', label: 'macOS 15 · Sequoia', version: '15', frame: 'mac-classic', note: '使用经典 macOS 标题区；菜单栏、Dock 与应用窗口各自承担导航职责。运行环境与桌面端均采用外部安装。' },
    { id: 'mac26', os: 'mac', label: 'macOS 26 · Tahoe', version: '26', frame: 'mac-current', note: '演示较大窗口圆角；系统材质交给原生窗口。版本变化不增加应用内安装能力，仍采用外部安装。' },
    { id: 'ubuntu2204', os: 'linux', label: 'Ubuntu 22.04 LTS', version: '22.04', frame: 'linux-csd', session: 'x11-tray', note: '代表 Ubuntu 22.04 桌面配置；运行环境采用外部安装，需校验 CPU 架构、发行包与实际依赖。' },
    { id: 'ubuntu2404', os: 'linux', label: 'Ubuntu 24.04 LTS', version: '24.04', frame: 'linux-csd', session: 'wayland-no-tray', note: '代表 Ubuntu 24.04 桌面配置；运行环境采用外部安装，托盘与窗口控制取决于桌面会话。' },
    { id: 'debian12', os: 'linux', label: 'Debian 12', version: '12', frame: 'linux-csd', session: 'x11-no-tray', note: '代表 Debian 12 桌面配置；运行环境采用外部安装，通知服务与终端需分别检测。' },
    { id: 'uos20', os: 'linux', label: '统信 UOS 20', version: '20', frame: 'linux-legacy', session: 'x11-tray', note: '采用外部安装后重新检测流程；国产系统、CPU 架构及 CLI 发布包需逐项验证。' },
    { id: 'kylin10', os: 'linux', label: '银河麒麟 V10', version: 'V10', frame: 'linux-legacy', session: 'x11-tray', note: '采用外部安装后重新检测流程；不把同名 V10 的不同架构视作同一运行环境。' },
  ];
  const sessions = [
    { id: 'x11-tray', label: 'X11 · 有系统托盘', protocol: 'x11', tray: true, notify: true },
    { id: 'wayland-tray', label: 'Wayland · 有系统托盘', protocol: 'wayland', tray: true, notify: true },
    { id: 'x11-no-tray', label: 'X11 · 无系统托盘', protocol: 'x11', tray: false, notify: true },
    { id: 'wayland-no-tray', label: 'Wayland · 无系统托盘', protocol: 'wayland', tray: false, notify: true },
    { id: 'x11-no-service', label: 'X11 · 无托盘 / 通知服务', protocol: 'x11', tray: false, notify: false },
  ];
  const defaults = { win: 'win11', mac: 'mac15', linux: 'ubuntu2404' };
  const modeLabel = { managed: '应用内安装（演示）', external: '官方渠道安装后重新检测', unavailable: '本示例未提供桌面端安装' };
  const e = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const getState = () => typeof S !== 'undefined' ? S : { os: 'mac' };
  let lastOs = '';
  let lastProfile = '';
  let remembered = { ...defaults };
  if (!XM.platformVersion) XM.platformVersion = { ...defaults };
  XM.platformProfiles = profiles.map((p) => ({ ...p }));
  XM.platformSessions = sessions.map((s) => ({ ...s }));

  function profile() {
    const os = getState().os || 'mac';
    const wanted = typeof XM.platformVersion === 'string' ? XM.platformVersion : XM.platformVersion[os];
    return profiles.find((p) => p.os === os && (p.id === wanted || p.version === String(wanted))) || profiles.find((p) => p.id === (remembered[os] || defaults[os]));
  }
  function session(p) {
    return sessions.find((s) => s.id === XM.platformSession) || sessions.find((s) => s.id === p.session) || sessions[0];
  }
  XM.platformCapabilities = function () {
    const p = profile(), s = session(p), linux = p.os === 'linux', mac = p.os === 'mac', family = familyCapabilities[p.os];
    const tray = !linux || s.tray;
    const notifyAvailable = !linux || s.notify;
    const permissionBlocked = XM.platformNotify === 'blocked';
    return {
      scenarioOnly: true, verifiedOnDevice: false, os: p.os, id: p.id, version: p.version, label: p.label,
      frame: p.frame, session: linux ? s.id : 'native', protocol: linux ? s.protocol : 'native',
      desktopInstall: family.desktopInstall, desktopAvailable: family.desktopInstall !== 'unavailable', nodeInstall: family.nodeInstall,
      modifier: mac ? '⌘' : 'Ctrl', searchShortcut: mac ? '⌘K' : 'Ctrl+K',
      dataPath: p.os === 'win' ? '%APPDATA%\\xingmang' : mac ? '~/Library/Application Support/xingmang' : '~/.config/xingmang',
      workPath: p.os === 'win' ? 'D:\\projects' : mac ? '~/Projects' : '~/projects',
      terminal: p.os === 'win' ? 'Windows Terminal → PowerShell → cmd；按实际检测结果选择' : mac ? 'Terminal.app；iTerm2 仅在已安装时可选' : '按已安装项选择 gnome-terminal / Konsole / xterm，不假定发行版自带',
      titlebar: mac ? '红黄绿按钮在左侧；⌘W 关闭窗口，⌘Q 退出应用' : '独立标题栏；系统窗口按钮在右侧',
      notify: { available: notifyAvailable, permission: permissionBlocked ? 'blocked' : notifyAvailable ? 'system-dependent' : 'unavailable', delivery: notifyAvailable && !permissionBlocked ? 'native-with-in-app-fallback' : 'in-app', fallback: '应用内消息中心与状态提示', reason: permissionBlocked ? '系统通知已禁用' : !notifyAvailable ? '当前会话没有通知服务' : mac ? '取决于系统通知设置、签名与勿扰模式' : linux ? '取决于桌面通知服务与勿扰设置' : '取决于系统通知权限、应用标识与勿扰设置' },
      trayCapabilities: { available: tray, minimizeToTray: tray, location: mac ? '菜单栏' : '系统托盘', closeFallback: tray ? 'configured' : 'keep-window', activation: linux ? '由桌面环境决定点击方式' : '点击图标打开菜单', reason: tray ? '本场景提供托盘入口；实际可用性须运行时检测' : '本场景无系统托盘；保留窗口与任务栏入口，不静默退出' },
      windowControl: linux && s.protocol === 'wayland' ? '窗口定位、聚焦及部分最小化行为由合成器决定；保留系统窗口操作' : '使用系统窗口操作',
      note: p.note, installationNote: '安装能力沿用当前平台实现；版本选择仅模拟呈现，不增加安装能力。每个 CLI、系统版本、CPU 架构与安装包需独立校验，未做跨平台真机验证。',
    };
  };

  XM.setPlatformVersion = function (id) {
    const p = profiles.find((item) => item.id === id);
    if (!p) return false;
    getState().os = p.os;
    if (!XM.platformVersion || typeof XM.platformVersion !== 'object') XM.platformVersion = { ...remembered };
    XM.platformVersion[p.os] = p.id;
    remembered[p.os] = p.id;
    if (p.os === 'linux') XM.platformSession = p.session;
    syncState();
    if (typeof render === 'function') render();
    return true;
  };
  XM.setPlatformSession = function (id) {
    if (!sessions.some((s) => s.id === id)) return false;
    XM.platformSession = id;
    syncState();
    if (typeof render === 'function') render();
    return true;
  };

  function syncState() {
    const p = profile(), state = getState();
    if (p.os !== lastOs || p.id !== lastProfile) {
      if (p.os === 'linux' && lastProfile !== p.id) XM.platformSession = p.session;
      lastOs = p.os; lastProfile = p.id; remembered[p.os] = p.id;
    }
    const cap = XM.platformCapabilities();
    if (state.os === 'linux') state.linuxTrayOk = cap.trayCapabilities.available;
    return cap;
  }

  function detailHtml(c) {
    return `<strong>${e(c.label)} · 呈现与能力示例</strong><p class="xm-platform-disclaimer">设计模拟，未做跨平台真机验证。下列安装方式不是 CLI 的系统支持承诺。</p><dl><dt>窗口</dt><dd>${e(c.note)} ${e(c.titlebar)}</dd><dt>快捷键</dt><dd><kbd>${e(c.searchShortcut)}</kbd> 打开命令面板；界面随平台切换 Ctrl / ⌘。</dd><dt>路径</dt><dd>工作目录示例 <code>${e(c.workPath)}</code><br>应用数据 <code>${e(c.dataPath)}</code></dd><dt>终端</dt><dd>${e(c.terminal)}</dd><dt>桌面端安装</dt><dd>${e(modeLabel[c.desktopInstall])}</dd><dt>Node.js</dt><dd>${e(modeLabel[c.nodeInstall])}；与各 CLI 的最低版本要求分别判断。</dd><dt>托盘 / 关闭</dt><dd>${e(c.trayCapabilities.reason)}</dd><dt>通知</dt><dd>${e(c.notify.reason)}；不可用时保留${e(c.notify.fallback)}。</dd>${c.os === 'linux' ? `<dt>桌面会话</dt><dd>${e(c.protocol.toUpperCase())} · ${e(c.windowControl)}</dd>` : ''}</dl><p class="xm-platform-sources">呈现依据：<a href="https://www.electronjs.org/docs/latest/api/base-window" target="_blank" rel="noreferrer">窗口</a> · <a href="https://www.electronjs.org/docs/latest/api/tray" target="_blank" rel="noreferrer">托盘</a> · <a href="https://www.electronjs.org/docs/latest/tutorial/notifications" target="_blank" rel="noreferrer">通知</a></p>`;
  }

  function ensureControls() {
    const bar = document.querySelector('.proto-bar');
    if (!bar || document.getElementById('xmPlatformControls')) return;
    const controls = document.createElement('span');
    controls.id = 'xmPlatformControls';
    controls.className = 'xm-platform-controls';
    controls.innerHTML = '<label for="xmPlatformVersion">版本 <select id="xmPlatformVersion" class="pbtn" aria-label="模拟系统版本"></select></label><label for="xmPlatformSession" id="xmPlatformSessionLabel">桌面会话 <select id="xmPlatformSession" class="pbtn" aria-label="模拟 Linux 桌面会话"></select></label><button type="button" class="pbtn" id="xmPlatformDetailsToggle" aria-expanded="false" aria-controls="xmPlatformDetails">平台差异 · 设计模拟</button><div id="xmPlatformDetails" class="xm-platform-details" role="region" aria-label="平台差异说明" hidden></div>';
    const platformControl = bar.querySelector('[data-ctl="os"]')?.parentElement;
    if (platformControl) platformControl.after(controls); else bar.append(controls);
    document.getElementById('xmPlatformVersion').addEventListener('change', (event) => XM.setPlatformVersion(event.target.value));
    document.getElementById('xmPlatformSession').addEventListener('change', (event) => XM.setPlatformSession(event.target.value));
    document.getElementById('xmPlatformDetailsToggle').addEventListener('click', () => {
      const panel = document.getElementById('xmPlatformDetails');
      panel.hidden = !panel.hidden;
      document.getElementById('xmPlatformDetailsToggle').setAttribute('aria-expanded', String(!panel.hidden));
    });
    document.addEventListener('keydown', (event) => {
      const panel = document.getElementById('xmPlatformDetails');
      if (event.key === 'Escape' && panel && !panel.hidden) {
        panel.hidden = true;
        const toggle = document.getElementById('xmPlatformDetailsToggle');
        toggle.setAttribute('aria-expanded', 'false'); toggle.focus();
      }
    });
  }

  function syncPresentation() {
    const c = syncState();
    ensureControls();
    ['win', 'winbox'].forEach((id) => {
      const node = document.getElementById(id);
      if (node) Object.assign(node.dataset, { platformVersion: c.id, platformFrame: c.frame, platformSession: c.session, tray: c.trayCapabilities.available ? 'available' : 'unavailable', notify: c.notify.delivery });
    });
    Object.assign(document.body.dataset, { platformOs: c.os, platformVersion: c.id });
    const versions = document.getElementById('xmPlatformVersion');
    if (versions) {
      if (versions.dataset.os !== c.os) {
        versions.innerHTML = profiles.filter((p) => p.os === c.os).map((p) => `<option value="${p.id}">${e(p.label)}</option>`).join('');
        versions.dataset.os = c.os;
      }
      versions.value = c.id;
    }
    const sessionLabel = document.getElementById('xmPlatformSessionLabel');
    if (sessionLabel) sessionLabel.hidden = c.os !== 'linux';
    const sessionSelect = document.getElementById('xmPlatformSession');
    if (sessionSelect) {
      if (!sessionSelect.options.length) sessionSelect.innerHTML = sessions.map((s) => `<option value="${s.id}">${e(s.label)}</option>`).join('');
      sessionSelect.value = c.session;
    }
    document.querySelectorAll('.proto-bar [data-ctl="os"] button').forEach((button) => button.classList.toggle('on', button.dataset.v === c.os));
    const details = document.getElementById('xmPlatformDetails');
    if (details) details.innerHTML = detailHtml(c);
    const trayButton = document.getElementById('trayBtn');
    if (trayButton) {
      trayButton.disabled = !c.trayCapabilities.available;
      trayButton.textContent = c.trayCapabilities.available ? (c.os === 'mac' ? '模拟菜单栏菜单' : '模拟托盘菜单') : '当前会话无系统托盘';
      trayButton.title = c.trayCapabilities.reason;
    }
    if (!c.trayCapabilities.available) {
      const trayHost = document.getElementById('trayHost');
      if (trayHost) trayHost.innerHTML = '';
    }
    // Replace only the obsolete platform warning; preserve other feature/error banners.
    document.querySelectorAll('.alertbar.info').forEach((bar) => {
      if (!bar.textContent.includes('GNOME') && !bar.classList.contains('xm-platform-tray-note')) return;
      if (c.os !== 'linux' || c.trayCapabilities.available) { bar.remove(); return; }
      bar.classList.add('xm-platform-tray-note');
      bar.innerHTML = '<svg aria-hidden="true"><use href="#i-info"/></svg><span>当前演示会话没有系统托盘。关闭操作将保留窗口，工具仍可从主窗口打开。</span>';
    });
    // Native service availability does not change the user's saved preference.
    document.querySelectorAll('.setting').forEach((row) => {
      const label = row.querySelector('.l strong')?.textContent;
      if (label !== '点关闭按钮时') return;
      const desc = row.querySelector('.l span');
      if (desc) desc.textContent = c.trayCapabilities.available ? '按你的选择关闭窗口或缩到托盘；实际行为取决于系统环境' : '当前会话无系统托盘：保留窗口。明确选择“直接退出”时才退出。';
      row.querySelectorAll('button').forEach((button) => {
        if (button.textContent.includes('缩到托盘')) {
          button.disabled = !c.trayCapabilities.available;
          button.title = c.trayCapabilities.reason;
        }
      });
    });
    // Only UI symbols get semantic markers; brand symbols retain their rendering and size.
    document.querySelectorAll('svg > use[href^="#i-"]').forEach((use) => {
      if (use.getAttribute('href') === '#i-wechat') return;
      const svg = use.parentElement;
      svg.classList.add('xm-ui-icon');
      if (!svg.hasAttribute('aria-label') && !svg.hasAttribute('role')) svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
    });
  }
  XM.syncPlatformPresentation = syncPresentation;

  // These wrappers concern only OS surfaces; page, account, onboarding and tool logic stay owned by their modules.
  if (typeof A !== 'undefined') {
    const originalTray = A.openTray, originalClose = A.closeWindow, originalNotify = A.osNotify;
    A.openTray = function (...args) {
      if (!XM.platformCapabilities().trayCapabilities.available) return A.toast('当前会话没有系统托盘，请从主窗口打开工具。', 'warn');
      return originalTray.apply(this, args);
    };
    A.closeWindow = function (...args) {
      const c = XM.platformCapabilities();
      if (!c.trayCapabilities.available) {
        if (getState().settings?.closeAction === 'quit') return A.toast('退出应用（演示）；下次可从应用启动器打开。');
        return A.toast('当前会话没有系统托盘，已保留窗口。可从任务栏切换；需要退出时在设置中选择直接退出。', 'warn');
      }
      return originalClose.apply(this, args);
    };
    A.osNotify = function (title, body, ...rest) {
      const c = XM.platformCapabilities();
      if (c.notify.delivery === 'in-app') return A.toast(`${title}：${body}（应用内提醒）`);
      return originalNotify.call(this, title, body, ...rest);
    };
  }
  if (typeof XM.afterRender === 'function') XM.afterRender(syncPresentation);
  else if (typeof render === 'function') {
    const originalRender = render;
    render = function (...args) { syncState(); const result = originalRender.apply(this, args); syncPresentation(); return result; };
  }
  syncPresentation();
})();
