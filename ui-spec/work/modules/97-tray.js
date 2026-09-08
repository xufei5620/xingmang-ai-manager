/* Compact tray menu: preserve the original grouping and always retain the balance position. */
(() => {
  const XM=window.XM=window.XM||{};
  let returnFocus=null,signature='';
  const available=()=>XM.platformCapabilities?.().trayCapabilities.available ?? true;
  const syncHost=()=>{
    const host=document.getElementById('trayHost');if(!host)return;
    host.dataset.theme=S.theme;host.dataset.os=S.os;
    host.classList.toggle('hc',Boolean(S.settings.highContrast));
  };
  const balance=value=>value===null||value===undefined||value===''||!Number.isFinite(Number(value))?'—':money(value);
  const item=(id,label,icon,action,extra='')=>`<button type="button" class="i" role="menuitem" tabindex="-1" data-tray-item="${id}" onclick="A.closeTray(false);${action}">${icon}<span class="tray-label">${esc(label)}</span>${extra}</button>`;
  trayHtml=function(){
    const user=S.user, tools=TOOL_ORDER.filter(id=>S.tools[id]?.installed);
    const account=user?`<div class="tray-balance"><span>余额</span><strong data-tray-balance title="当前账号余额">${balance(user.balance)}</strong></div>`:`<button type="button" class="tray-login" role="menuitem" tabindex="-1" data-tray-item="login" onclick="A.closeTray(false);A.dialog('login')">登录查看余额</button>`;
    return `<div class="tray-stage" id="tray"><div class="tray-menu" role="menu" aria-label="星芒托盘菜单"><div class="h">${logo('micro',26)}<strong>星芒 AI</strong>${account}</div>${item('home','打开星芒',ic('open'),"A.go('home')")}${tools.length?`<hr role="separator">${tools.map(id=>item(id,'打开 '+TOOLS[id].name,brand(id,'xs'),`A.launch('${id}')`,kbd('⌘'+(TOOL_ORDER.indexOf(id)+1)))).join('')}`:''}<hr role="separator">${item('recharge','充值',ic('zap'),"A.openAccount('recharge')")}${item('updates','检查更新',ic('refresh'),"A.go('updates')",S.update.phase==='available'?'<span class="dot" aria-label="有新版本"></span>':'')}${item('settings','设置',ic('gear'),"A.go('settings')")}<hr role="separator">${item('quit','退出星芒',ic('x'),"A.toast('星芒已退出（演示）')")}</div><div class="taskbar" aria-label="系统托盘演示"><span class="tico" aria-hidden="true">${ic('globe')}</span><button type="button" class="tico on" title="星芒 AI 托盘图标" aria-label="星芒 AI 托盘图标" onclick="A.closeTray()" oncontextmenu="event.preventDefault();document.querySelector('[data-tray-item=home]')?.focus()"><img alt="" src="${LOGOS['m16-gold']}"></button><span>中 · 14:52</span></div></div>`;
  };
  const items=()=>[...document.querySelectorAll('#tray [role="menuitem"]')];
  A.openTray=function(){
    if(!available())return A.toast('当前会话没有系统托盘，请从主窗口打开工具。','warn');
    syncHost();returnFocus=document.activeElement;
    document.getElementById('trayHost').innerHTML=trayHtml();signature=trayHtml();
    document.querySelector('[data-tray-item="home"]')?.focus({preventScroll:true});
  };
  A.closeTray=function(restore=true){
    document.getElementById('trayHost').innerHTML='';signature='';
    if(restore&&returnFocus?.isConnected)returnFocus.focus({preventScroll:true});
    returnFocus=null;
  };
  document.addEventListener('keydown',event=>{
    if(!document.getElementById('tray'))return;
    if(event.key==='Escape'||event.key==='Tab'){
      if(event.key==='Escape')event.preventDefault();event.stopImmediatePropagation();A.closeTray();return;
    }
    if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key))return;
    event.preventDefault();event.stopImmediatePropagation();const all=items(),index=all.indexOf(document.activeElement);
    const next=event.key==='Home'?0:event.key==='End'?all.length-1:(index+(event.key==='ArrowDown'?1:-1)+all.length)%all.length;
    all[next]?.focus();
  },true);
  XM.afterRender?.(()=>{
    syncHost();if(!document.getElementById('tray'))return;
    if(!available()){A.closeTray();return;}
    const html=trayHtml();if(html===signature)return;
    const focused=document.activeElement?.dataset.trayItem;
    document.getElementById('trayHost').innerHTML=html;signature=html;
    if(focused)[...document.querySelectorAll('[data-tray-item]')].find(e=>e.dataset.trayItem===focused)?.focus({preventScroll:true});
  });
  XM.trayRevision='v3.0.1';syncHost();
})();
