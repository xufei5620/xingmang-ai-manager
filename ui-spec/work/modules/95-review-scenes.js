/* Scenario controls are outside the product window. */
(() => {
 const XM=window.XM;
 const scenes=[
  ['日常','home','首页与工具'],['日常','official','官方账号与额度'],['日常','officialMissing','官方账号待登录'],['日常','unknown','已有第三方配置'],['日常','config','共享配置与保存方式'],
  ...['dashboard','keys','usage','tasks','recharge','orders','invite','devices'].map(page=>['个人中心','account:'+page,({dashboard:'用量看板',keys:'访问密钥',usage:'调用明细',tasks:'异步任务',recharge:'充值与订阅',orders:'我的订单',invite:'邀请返利',devices:'登录设备'})[page]]),
  ...['mcp','skills','plugins','backups','sessions'].flatMap(page=>['ready','loading','empty','filterEmpty','error','readonly'].map(status=>['列表状态',page+':'+status,({mcp:'外接工具',skills:'技能',plugins:'插件',backups:'备份',sessions:'记录'})[page]+' · '+({ready:'正常',loading:'加载',empty:'空态',filterEmpty:'筛选无结果',error:'读取失败',readonly:'只读'})[status]])),
  ['异常与恢复','chat:timeout','聊天请求未完成'],['异常与恢复','chat:rate','聊天请求频繁'],['异常与恢复','chat:model','聊天模型不可用'],['异常与恢复','chat:balance','聊天额度不足'],['异常与恢复','installFailure','工具安装失败'],['异常与恢复','configFailure','配置保存失败'],['异常与恢复','updateFailure','更新失败'],['异常与恢复','settingsFailure','设置保存失败'],['异常与恢复','backupFailure','备份恢复校验失败'],['异常与恢复','oauthFailure','授权过期'],['异常与恢复','switchPartial','账号切换部分同步'],['异常与恢复','noPayment','没有可用支付渠道']
 ];
 XM.reviewScenarios=scenes.map(([group,id,label])=>({group,id,label}));
 XM.reviewScenario=id=>{
  const old={os:S.os,theme:S.theme,collapsed:S.collapsed,layoutMode:S.layoutMode,scale:S.settings.uiScale,motion:S.settings.reduceMotion};
  S=freshState(true);Object.assign(S,{os:old.os,theme:old.theme,collapsed:old.collapsed,layoutMode:old.layoutMode});Object.assign(S.settings,{themePref:old.theme,uiScale:old.scale,reduceMotion:old.motion});S.update.dismissed=true;S.coach=null;
  const [page,status]=id.split(':');
  if(page==='account')return A.openAccount(status);
  if(['mcp','skills','plugins','backups','sessions'].includes(page)){XM.scene(page,status);return A.go(page);}
  if(page==='chat'){A.go('chat');if(status==='balance'){const d=XM.accountData();d.user.balance=0;d.preference='balance_only';}else A.chatScenario(status);const el=document.getElementById('chatIn');el.value='帮我把这个想法整理成三个步骤';A.chatDraft(el.value);A.chatSend();return;}
  if(id==='official'||id==='officialMissing'){A.toolScenario(id==='official'?'officialReady':'officialMissing');return A.go('home');}
  if(id==='unknown'){A.toolScenario('unknown');return A.dialog('config',{tool:'codexDesktop'});}
  if(id==='config')return A.dialog('config',{tool:'codexDesktop'});
  if(id==='installFailure'){A.toolScenario('install');A.go('home');return A.install('claude');}
  if(id==='configFailure'){A.toolScenario('config');return A.dialog('config',{tool:'codexDesktop'});}
  if(id==='updateFailure'){A.maintenanceScenario('update','failed');return A.go('updates');}
  if(id==='settingsFailure'){A.maintenanceScenario('settings','failed');A.go('settings');return A.settingSection('启动与关闭');}
  if(id==='backupFailure'){A.ext30Scenario('backupRestore','validation');return A.go('backups');}
  if(id==='oauthFailure'){A.ext30Scenario('mcpOAuth','expired');return A.go('mcp');}
  if(id==='switchPartial'){A.accountScenario('switch','partial');return A.openAccount();}
  if(id==='noPayment'){A.accountScenario('channels','none');return A.openAccount('recharge');}
  A.go('home');
 };
 XM.afterRender(()=>{
  const bar=document.querySelector('.proto-bar');if(!bar||document.getElementById('xm-review-scene'))return;
  const label=document.createElement('label');label.className='xm-review-select';label.innerHTML='页面与状态 <select id="xm-review-scene" title="切换会重置演示数据，不影响真实账户"><option value="">选择检查场景…</option>'+[...new Set(scenes.map(s=>s[0]))].map(group=>'<optgroup label="'+group+'">'+scenes.filter(s=>s[0]===group).map(([,id,title])=>'<option value="'+id+'">'+title+'</option>').join('')+'</optgroup>').join('')+'</select>';bar.append(label);label.querySelector('select').addEventListener('change',event=>{if(event.target.value)XM.reviewScenario(event.target.value);});
 });
 const originalSim=A.sim;
 A.sim=function(value){if(value.startsWith('fail-')){S.sim='';A.toolScenario('install');return A.install('claude');}if(value==='zero'&&!S.user)return A.dialog('login');return originalSim(value);};
 const previousDeepLink=A.deepLink;
 A.deepLink=function(url){let u;try{u=new URL(url);}catch(_){return A.toast('这个链接无法识别','warn');}if(u.protocol!=='xingmang:')return A.toast('这个链接不是星芒入口','warn');if(u.hostname==='open'){const segments=u.pathname.split('/').filter(Boolean);const aliases={overview:'home',home:'home',chat:'chat',sessions:'sessions',mcp:'mcp',skills:'skills',plugins:'plugins',backups:'backups',health:'health',tutorial:'tutorial',maintenance:'maintenance',feedback:'feedback',updates:'updates',settings:'settings'};if(segments[0]==='account')return A.openAccount(segments[1]);if(aliases[segments[0]])return A.go(aliases[segments[0]]);return A.toast('这个页面入口暂不可用','warn');}if(u.hostname==='tool'){const parts=u.pathname.split('/').filter(Boolean);if(TOOLS[parts[0]]&&parts[1]==='launch')return A.launch(parts[0]);return A.toast('这个工具入口暂不可用','warn');}return previousDeepLink(url);};
})();
