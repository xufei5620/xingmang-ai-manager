/* Global acceleration prototype: illustrative connection only, never changes the network. */
const accelerationPrototypeTrialSeconds = 20 * 60;
const accelerationPrototypeLines = [
  { id: 'preview-jp', name: '日本线路 1', region: 'JP' },
  { id: 'preview-sg', name: '新加坡线路 2', region: 'SG' },
  { id: 'preview-us', name: '美国线路 3', region: 'US' }
];
function accelerationPrototypeState() {
  return S.acceleration ?? (S.acceleration = { remaining: accelerationPrototypeTrialSeconds, started: null, tun: false, session: 0 });
}
function accelerationPrototypeClock() {
  const state = accelerationPrototypeState();
  const elapsed = state.started === null ? 0 : Math.max(0, (performance.now() - state.started) / 1000);
  const remaining = Math.max(0, state.remaining - elapsed);
  return { remaining, session: state.session + Math.min(elapsed, state.remaining) };
}
function accelerationPrototypeTime(value) {
  value = Math.max(0, Math.floor(value));
  return [Math.floor(value / 3600), Math.floor(value % 3600 / 60), value % 60].map(n => String(n).padStart(2, '0')).join(':');
}
A.accelerationToggle = function () {
  const state = accelerationPrototypeState(), clock = accelerationPrototypeClock();
  if (state.started !== null) {
    state.remaining = clock.remaining; state.session = clock.session; state.started = null;
  } else if (state.remaining > 0) { state.started = performance.now(); state.session = 0; }
  A.accelerationRefreshNetwork();
};
A.accelerationRefreshNetwork = function () {
  const sequence = (S.accelerationNetwork?.sequence ?? 0) + 1;
  S.accelerationNetwork = { sequence, busy: true, text: '正在检测网络位置…' };
  render();
  setTimeout(() => {
    if (S.accelerationNetwork.sequence !== sequence) return;
    S.accelerationNetwork = { sequence, busy: false, text: accelerationPrototypeState().started === null ? '中国 · 198.51.100.18' : '新加坡 · 203.0.113.24' };
    render();
  }, 350);
};
XM.afterRender(() => {
  const previous = document.querySelector('.statusbar > .it:nth-child(2)');
  if (!previous) return;
  const state = S.accelerationNetwork;
  const button = document.createElement('button');
  button.className = 'it acceleration-network-position';
  button.dataset.testid = 'shell-network-location';
  button.type = 'button';
  button.disabled = Boolean(state?.busy);
  button.setAttribute('aria-label', '刷新网络位置');
  button.setAttribute('aria-busy', String(Boolean(state?.busy)));
  button.title = '演示网络位置；点击刷新';
  button.innerHTML = `${ic('globe')}<span aria-live="polite">${state?.text ?? '网络位置未知'}</span>`;
  button.onclick = A.accelerationRefreshNetwork;
  previous.replaceWith(button);
});
A.accelerationTun = function () { const state = accelerationPrototypeState(); if (state.started === null) { state.tun = !state.tun; render(); } };
A.accelerationSelectLine = function (id) {
  const state = accelerationPrototypeState();
  if (state.started !== null) return;
  state.selectedLineId = accelerationPrototypeLines.some(line => line.id === id) ? id : null;
  render();
};
A.accelerationOpenLines = function () {
  const state = accelerationPrototypeState();
  if (state.started !== null) return;
  state.linesOpen = !state.linesOpen;
  render();
};
function accelerationPrototypeLinePicker() {
  const state = accelerationPrototypeState();
  if (state.started !== null) return '';
  const rows = [{ id: null, name: '智能分配', region: '连接时自动测速，选择最快可用线路' }, ...accelerationPrototypeLines];
  return `<div class="acceleration-line-picker"><button class="btn btn-ghost" onclick="A.accelerationOpenLines()" aria-expanded="${Boolean(state.linesOpen)}">${state.linesOpen ? '收起线路' : '选择加速线路'}</button>${state.linesOpen ? `<div class="acceleration-line-list" role="listbox" aria-label="加速线路选择"><div class="acceleration-line-list-head">${accelerationPrototypeLines.length} 条演示线路</div>${rows.map(line => `<div class="acceleration-line-option${line.id === null ? ' acceleration-line-auto' : ''}${(state.selectedLineId ?? null) === line.id ? ' is-selected' : ''}" role="option" aria-selected="${(state.selectedLineId ?? null) === line.id}" ${line.id === null ? 'data-testid="acceleration-line-auto"' : ''}><button type="button" onclick="A.accelerationSelectLine(${line.id === null ? 'null' : `'${line.id}'`})"><strong>${line.name}</strong><small>${line.region}</small></button></div>`).join('')}</div>` : ''}</div>`;
}
function accelerationPrototypeHtml() {
  const state = accelerationPrototypeState(), clock = accelerationPrototypeClock(), active = state.started !== null;
  const globe = `<svg viewBox="0 0 440 260" aria-hidden="true"><defs><radialGradient id="acc-p-glow"><stop stop-color="var(--xm-slate)" stop-opacity=".8"/><stop offset="1" stop-color="var(--xm-navy)"/></radialGradient></defs><g transform="translate(220 130)"><circle r="109" fill="url(#acc-p-glow)" stroke="var(--xm-sky)" stroke-opacity=".24"/>${[30,58,86].map(r=>`<ellipse rx="${r}" ry="109" fill="none" stroke="var(--xm-sky)" stroke-opacity=".2"/>`).join('')}${[-70,-35,0,35,70].map(y=>`<ellipse cy="${y}" rx="${Math.sqrt(109*109-y*y)}" ry="15" fill="none" stroke="var(--xm-sky)" stroke-opacity=".2"/>`).join('')}<ellipse rx="156" ry="51" transform="rotate(-25)" fill="none" stroke="var(--xm-gold)" stroke-opacity=".75"/><circle cx="138" cy="-64" r="4" fill="var(--xm-gold)"/><circle cx="-95" cy="58" r="3" fill="var(--xm-sky)"/></g></svg>`;
  return `<section class="page acceleration-page" data-phase="${active ? 'active' : 'idle'}">
    <header class="acceleration-heading"><div><div class="acceleration-heading-title"><h1>游戏加速</h1><span class="acceleration-preview">交互预览</span></div><p>选择游戏加速线路，按需连接，随时停止。</p></div></header>
    <div class="acceleration-workbench">
      <section class="acceleration-stage"><div class="acceleration-stage-top"><span class="acceleration-eyebrow">GAME CONNECT</span><span class="acceleration-stage-scope">${state.tun ? '增强模式' : '标准模式'}</span></div><div class="acceleration-stage-title"><h2>连接热爱，准备开局。</h2><p>从这里出发，连接你的游戏世界。</p></div><div class="acceleration-orb">${globe}</div><div class="acceleration-route-info"><div class="acceleration-route-name"><span>加速线路</span><strong data-testid="acceleration-line-current">${accelerationPrototypeLines.find(line => line.id === state.selectedLineId)?.name ?? '智能分配'}</strong></div><div class="acceleration-route-latency"><span>连接延迟</span><strong>—</strong></div></div>${accelerationPrototypeLinePicker()}<div class="acceleration-stage-bottom"><span>${active ? '演示连接已开启' : '准备就绪'}</span><span>演示数据 · 未连接实际节点</span></div></section>
      <section class="acceleration-console"><div class="acceleration-console-top"><span>免费体验</span><span class="acceleration-quota-badge">20 分钟</span></div><div class="acceleration-quota"><svg class="acceleration-quota-ring" viewBox="0 0 220 220" aria-hidden="true"><circle class="acceleration-quota-track" cx="110" cy="110" r="96"/><circle class="acceleration-quota-progress" cx="110" cy="110" r="96" pathLength="100" stroke-dasharray="${clock.remaining / accelerationPrototypeTrialSeconds * 100} 100" transform="rotate(-90 110 110)"/></svg><div class="acceleration-quota-label"><span>剩余免费时长</span><strong id="acceleration-proto-remaining">${accelerationPrototypeTime(clock.remaining)}</strong><small>${active ? '正在计时' : '未计时'}</small></div></div><button class="btn btn-primary" style="width:100%;min-height:46px" onclick="A.accelerationToggle()" ${clock.remaining <= 0 ? 'disabled' : ''}>${active ? '停止加速' : clock.remaining > 0 ? '开始加速' : '免费体验已用完'}</button><p class="acceleration-quota-note">连接成功才计时，随时停止，剩余下次继续</p><div class="acceleration-mode"><div><strong>TUN 模式</strong><p>${active ? '停止加速后可切换模式' : state.tun ? '扩展游戏与应用的连接范围' : '开启后可扩展连接范围'}</p></div><button class="btn btn-secondary sm" role="switch" aria-label="TUN 模式" aria-checked="${state.tun}" onclick="A.accelerationTun()" ${active ? 'disabled' : ''}>${state.tun ? '开' : '关'}</button></div></section>
    </div><div class="acceleration-details"><div><div><span>本次连接</span><strong id="acceleration-proto-session">${accelerationPrototypeTime(clock.session)}</strong></div><small>按连接时长计时</small></div><div><div><span>累计使用</span><strong id="acceleration-proto-used">${accelerationPrototypeTime(accelerationPrototypeTrialSeconds-clock.remaining)}</strong></div><small>停止后不扣时</small></div><div><div><span>免费额度规则</span><strong>随用随停，保留剩余</strong></div><small>每账号累计 20 分钟，不每日重置</small></div></div>
  </section>`;
}
sidebarHtml = (function (previous) { return function () {
  const item = `<a class="${S.page === 'acceleration' ? 'active' : ''}" onclick="A.go('acceleration')" data-testid="nav-acceleration">${ic('globe')}<span class="lbl">游戏加速</span></a>`;
  return previous().replace('<div class="sep"></div>', item + '<div class="sep"></div>');
}; })(sidebarHtml);
mainHtml = (function (previous) { return function () { return S.view === 'app' && S.page === 'acceleration' ? accelerationPrototypeHtml() : previous(); }; })(mainHtml);
setInterval(() => {
  if (!S.acceleration || S.acceleration.started === null) return;
  const clock = accelerationPrototypeClock();
  if (clock.remaining <= 0) { S.acceleration.remaining = 0; S.acceleration.session = clock.session; S.acceleration.started = null; A.accelerationRefreshNetwork(); return; }
  const remaining = document.getElementById('acceleration-proto-remaining'), session = document.getElementById('acceleration-proto-session'), used = document.getElementById('acceleration-proto-used');
  if (remaining) remaining.textContent = accelerationPrototypeTime(clock.remaining);
  if (session) session.textContent = accelerationPrototypeTime(clock.session);
  if (used) used.textContent = accelerationPrototypeTime(accelerationPrototypeTrialSeconds-clock.remaining);
}, 1000);
setTimeout(() => { if (location.hash === '#acceleration') { S.view = 'app'; S.page = 'acceleration'; render(); } }, 0);
