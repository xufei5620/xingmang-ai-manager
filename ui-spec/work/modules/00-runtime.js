/* Shared runtime for the offline design prototype. No business service is called. */
(() => {
  const XM = window.XM = window.XM || {};
  const renderHooks = [];
  let inHooks = false;
  XM.state = (name, factory = () => ({})) => {
    S._xm ||= {};
    if (!Object.prototype.hasOwnProperty.call(S._xm, name)) S._xm[name] = factory(S);
    return S._xm[name];
  };
  XM.addState = XM.state;
  XM.usd = value => value!==null && value!==undefined && value!=='' && Number.isFinite(Number(value)) ? '$' + Number(value).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:Math.abs(Number(value)) > 0 && Math.abs(Number(value)) < .01 ? 6 : 2}) : '—';
  XM.afterRender = fn => { if (typeof fn === 'function' && !renderHooks.includes(fn)) renderHooks.push(fn); };
  XM.scene = (page, status = 'ready') => { XM.state('scenes')[page] = status; render(); };
  XM.pageStatus = page => {
    const scenes = XM.state('scenes');
    return scenes[page] || (String(page).startsWith('account') ? scenes.account : null) || 'ready';
  };
  XM.defer = (fn, ms = 450) => { const owner = S; return later(() => { if (S === owner) fn(); }, ms); };
  XM.statePanel = (page, title, emptyText = '现在还没有内容', next = '') => {
    const state = XM.pageStatus(page);
    if (state === 'ready' || state === 'readonly') return '';
    const retry = `<button class="btn btn-secondary" data-testid="${page}-retry" onclick="XM.scene('${page}','ready')">重新读取</button>`;
    let body;
    if (state === 'loading') body = `<div class="xm-loading" role="status"><span class="spin">${ic('refresh')}</span><strong>正在读取${esc(title)}</strong><p>页面会保留在这里，读取完成后自动显示。</p><div class="xm-skeleton"></div><div class="xm-skeleton"></div><div class="xm-skeleton"></div></div>`;
    else if (state === 'error') body = emptyHtml('info', `${title}暂时没有读取成功`, '检查网络连接后再试一次。已保存的内容不会被清除。', retry);
    else if (state === 'filterEmpty') body = emptyHtml('search','没有找到匹配结果','试试减少筛选条件，或换一个关键词。',`<button class="btn btn-secondary" onclick="XM.scene('${page}','ready')">清除筛选</button>`);
    else body = emptyHtml('folder', emptyText, '从下面的入口开始，之后可以随时回来查看。', next || retry);
    return `<section class="page">${pageHead(title,'') }<div class="card">${body}</div></section>`;
  };
  const applyHooks = () => {
    if (inHooks) return;
    inHooks = true;
    try {
      for (const hook of renderHooks) hook();
      const win = document.getElementById('win');
      if (win) {
        win.dataset.motion = S.settings.reduceMotion ? 'reduced' : 'normal';
        win.dataset.contrast = S.settings.highContrast ? 'high' : 'normal';
      }
      const toasts = document.getElementById('toasts');
      if (toasts) { toasts.setAttribute('role','status');toasts.setAttribute('aria-live','polite'); }
    } finally { inHooks = false; }
  };
  const baseRender = render, baseRerender = rerenderMain;
  render = function () { baseRender(); applyHooks(); };
  rerenderMain = function () { baseRerender(); applyHooks(); };
  XM.navigate = (page, section) => {
    if (page === 'account') return A.openAccount(section || 'overview');
    A.go(page);
    if (page === 'settings' && section) A.settingSection(section);
  };
  A.menu = (event, items) => {
    event.stopPropagation();
    const r=event.currentTarget.getBoundingClientRect(),w=document.getElementById('win').getBoundingClientRect(),z=Number(document.getElementById('win').dataset.zoom)||1;
    S.menu={x:Math.max(8,Math.min((r.right-w.left)/z-180,w.width/z-196)),y:Math.max(8,(r.bottom-w.top)/z+6),items,returnFocus:focusRecord(event.currentTarget)};render();
  };
  XM.afterRender(()=>{
    const win=document.getElementById('win'),w=win?.getBoundingClientRect();if(!w)return;const z=Number(win.dataset.zoom)||1;
    document.querySelectorAll('#overlays > .menu,#overlays > .kf-pop,#overlays > .acc-pop,#overlays > .ann-pop').forEach(el=>{
      const r=el.getBoundingClientRect(),left=parseFloat(el.style.left)||0,top=parseFloat(el.style.top)||0;
      const dx=r.right>w.right-8*z?(w.right-8*z-r.right)/z:r.left<w.left+8*z?(w.left+8*z-r.left)/z:0;
      const dy=r.bottom>w.bottom-8*z?(w.bottom-8*z-r.bottom)/z:r.top<w.top+8*z?(w.top+8*z-r.top)/z:0;
      el.style.left=Math.max(8,left+dx)+'px';el.style.top=Math.max(8,top+dy)+'px';el.style.maxHeight=Math.max(120,w.height/z-16)+'px';el.style.overflowY='auto';
    });
  });
  XM.showHelp = (title, text, destination) => A.dialog('xmHelp', {title,text,destination});
  DIALOGS.xmHelp = p => dialogShell({title:p.title,body:`<p class="xm-help-copy">${esc(p.text)}</p>`,footer:`<span class="spacer"></span><button class="btn btn-ghost" onclick="A.closeDialog()">我知道了</button>${p.destination?`<button class="btn btn-primary" onclick="A.closeDialog();XM.navigate('${p.destination}')">去${({tutorial:'教程',health:'检查',home:'首页',settings:'设置'})[p.destination]||'查看'}</button>`:''}`});
})();
