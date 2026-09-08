/* Tool configuration and lifecycle: offline UI behavior, never native commands. */
(() => {
  const XM=window.XM;
  const cfgFields=['configured','source','key','model','manual'];
  const state=()=>XM.state('tools',()=>({running:{},official:{},jobs:{},failNext:null,lastResult:null}));
  const provider=id=>id==='codexDesktop'?'codex':id;
  const officialName=id=>({codex:'ChatGPT 账号',claude:'Claude 账号',gemini:'Google 账号'})[provider(id)]||null;
  XM.toolSource=id=>S.tools[provider(id)]?.source||'account';
  XM.setToolConfig=(id,patch)=>{const key=provider(id);Object.assign(S.tools[key],patch);if(key==='codex')for(const field of cfgFields)S.tools.codexDesktop[field]=S.tools.codex[field];};
  XM.onAccountSwitched=(previousUser,nextUser)=>{
    if(!nextUser)return {ok:true,failed:[],message:'已退出账号，工具中保存的配置保持不变'};
    const failed=[];
    for(const id of ['claude','codex','gemini','grok']){
      if(S.tools[id].source!=='account')continue;
      const key=S.keys.find(k=>k.status==='active'&&(k.name.toLowerCase().includes(id)||id==='codex'&&k.name.includes('Codex')))||S.keys.find(k=>k.status==='active');
      const fail=state().failNext==='sync'&&id==='codex';
      XM.setToolConfig(id,{key:key?.id||null,configured:!!key&&!fail});if(fail||!key)failed.push(TOOLS[id].name);
    }
    state().failNext=null;
    return {ok:!failed.length,failed,message:failed.length?'部分工具还需要重新连接账号':'使用星芒账号的工具已更新配置'};
  };
  const official=id=>state().official[provider(id)] ||= {signedIn:false,email:'',plan:'',renewal:null,resets:null,windows:[],status:'idle'};
  const primaryAction=(text,action,extra='')=>`<button class="btn btn-primary sm" onclick="${action}" ${extra}>${text==='打开'?ic('open'):''}${text}</button>`;
  const sharedHint=id=>provider(id)==='codex'?'<div class="xm-note">'+ic('info')+'<p><strong>Codex 桌面端与 Codex CLI 共用这份配置。</strong><br>在任一入口修改，另一个入口会同步；官方账号的模型在 Codex 窗口内选择。</p></div>':'';
  const fileList=id=>({claude:['~/.claude/settings.json'],codex:['~/.codex/config.toml','~/.codex/auth.json'],gemini:['~/.gemini/settings.json','~/.gemini/.env'],grok:['~/.grok/config.toml']})[provider(id)];
  const configSourceLabel=(id,src)=>src==='official'?officialName(id):src==='unknown'?'已有第三方配置':src==='manual'?'自己填写的星芒密钥':'星芒账号';

  DIALOGS.config=p=>{
    const id=S.form.tab||p.tool||'codexDesktop', f=S.form,t=S.tools[provider(id)],own=S.tools[id],src=f.src||t.source,off=official(id);
    const tabs=`<div class="tabs" role="tablist" aria-label="选择要配置的工具">${TOOL_ORDER.map(k=>`<button class="xm-config-tab ${id===k?'on':''}" role="tab" aria-selected="${id===k}" onclick="A.configTab('${k}')">${brand(k,'xs')}${TOOLS[k].name}</button>`).join('')}</div>`;
    if(src==='unknown')return dialogShell({title:TOOLS[id].name+' 配置',wide:true,body:tabs+sharedHint(id)+`<div class="callout warn">这份配置连接了其他服务。为保留你的设置，当前不能一键切换账号来源。</div><div class="field"><label>配置文件</label><div class="xm-code-preview">${fileList(id).map(esc).join('<br>')}</div></div><p>先查看当前配置，再按教程决定如何迁移。系统不会直接覆盖它。</p>`,footer:`<button class="btn btn-ghost" onclick="A.requestDialogClose()">关闭</button><span class="spacer"></span><button class="btn btn-primary" onclick="A.closeDialog();XM.showHelp('处理已有第三方配置','先备份上面的配置文件，确认其中的自定义模型、服务地址和工具连接是否需要保留。再到工具中更换账号来源。','tutorial')">查看处理步骤</button>`});
    const options=[['account','使用星芒账号'],...(officialName(id)?[['official',officialName(id)]]:[]),['manual','自己填写密钥']];
    let body=tabs+sharedHint(id)+`<div class="field"><label>用哪个账号使用 AI</label><div class="segment xm-source-options">${options.map(([value,label])=>`<button class="${src===value?'on':''}" aria-pressed="${src===value}" onclick="F.set('src','${value}');render()">${label}</button>`).join('')}</div><p class="xm-field-help">选择你已有的账号。官方订阅与星芒账户的额度分别计算。</p></div>`;
    if(src==='official')body+=`<div class="xm-official-summary">${brand(id)}<div><strong>${off.signedIn?esc(off.email):'还没有在工具中登录'}</strong><p>${off.signedIn?esc(off.plan||'已连接官方账号'):'先保存来源，再打开工具完成官方登录。'}</p></div>${off.signedIn?pill('ok','已登录'):pill('warn','待登录')}</div><p class="xm-field-help">${provider(id)==='codex'?'模型在 Codex 窗口内选择；切换来源会保存当前档案，并尝试重新打开桌面端。':'保存后在对应工具中登录，不需要在这里填写官方密码。'}</p>`;
    else if(src==='account')body+=S.user?`<div class="field"><label>访问密钥（Key）</label><div class="field-row"><select class="input" onchange="F.set('key',this.value)">${S.keys.filter(k=>k.status==='active').map(k=>`<option value="${esc(k.id)}" ${(f.key||t.key)===k.id?'selected':''}>${esc(k.name)} · ${esc(k.masked)}</option>`).join('')}</select><button class="btn btn-secondary" onclick="A.dialog('keyEditor')">新建密钥</button></div><p class="xm-field-help">密钥让工具使用你的星芒额度。看不懂时保留当前选择即可。</p></div>`:`<div class="callout warn">先登录星芒账号，才能选择账户里的访问密钥。</div><button class="btn btn-secondary" onclick="A.dialog('login')">登录星芒账号</button>`;
    else body+=`<div class="field"><label>星芒访问密钥</label><input class="input mono" type="password" value="${esc(f.manual??t.manual??'')}" placeholder="粘贴你在星芒创建的密钥" oninput="F.set('manual',this.value)"><p class="xm-field-help">不要分享密钥。其他服务的配置请按对应工具教程处理。</p></div>`;
    if(src!=='official')body+=`<div class="field"><label>默认模型</label><select class="input" onchange="F.set('model',this.value)">${[...new Set([f.model||t.model,...TOOLS[provider(id)].models].filter(Boolean))].map(model=>`<option ${(f.model||t.model)===model?'selected':''}>${esc(model)}</option>`).join('')}</select><p class="xm-field-help">先用默认模型即可，之后随时可以更换。</p></div>`;
    body+=`<div class="field"><label>打开工具时进入的文件夹</label><div class="field-row"><input class="input mono" readonly value="${esc(S.settings.workdir)}"><button class="btn btn-secondary" onclick="A.dialog('pickFolder')">选择文件夹</button></div></div>`;
    if(id==='codexDesktop')body+=`<details class="xm-advanced"><summary>界面语言与文件夹权限</summary><div class="xm-inline-actions"><button class="btn btn-secondary sm" onclick="A.toolLocale()">${own.zh?'检查中文界面':'启用中文界面'}</button><button class="btn btn-secondary sm" onclick="A.toolTrust()">${own.trusted?'已信任当前文件夹':'查看文件夹权限'}</button></div><p class="xm-field-help">中文资源是否可用、文件夹是否可信，会分别显示检查结果。</p></details>`;
    body+=`<details class="xm-advanced"><summary>查看配置文件与保存方式</summary><div class="xm-code-preview">${fileList(id).map(esc).join('<br>')}</div><p class="xm-field-help">保存前会创建备份。已有自定义设置时，可选择保留其他设置或重置初始配置。</p></details>`;
    return dialogShell({title:TOOLS[id].name+' 配置',sub:'选好账号后，保存并打开工具即可开始。',wide:true,body,footer:`<button class="btn btn-ghost" onclick="A.requestDialogClose()">取消</button><span class="spacer"></span><button class="btn btn-primary" data-testid="tool-save-config" onclick="A.saveConfig('${id}')">保存配置</button>`});
  };
  A.saveConfig=id=>{
    const f=S.form,t=S.tools[provider(id)],source=f.src||t.source,manual=f.manual??t.manual??'';
    if(source==='account'&&!S.user)return A.toast('先登录星芒账号再继续','warn');
    if(source==='manual'&&!manual.trim())return A.toast('请先填写访问密钥','warn');
    const key=S.keys.find(k=>k.id===(f.key||t.key)&&k.status==='active')||S.keys.find(k=>k.status==='active');
    if(source==='account'&&!key)return A.toast('还没有可用密钥，请先新建一把','warn');
    const patch={source,configured:true,key:source==='account'?key.id:null,model:source==='official'?null:(f.model||t.model||TOOLS[id].models[0]),manual};
    const parent=topDialog();
    A.dialog('xmSaveMode',{id,patch,parentId:parent.id,changedSource:source!==t.source});
  };
  DIALOGS.xmSaveMode=p=>dialogShell({title:p.changedSource?'切换账号来源并保存？':'怎样保存这份配置？',sub:TOOLS[p.id].name,body:`${sharedHint(p.id)}<p>目标来源：<strong>${esc(configSourceLabel(p.id,p.patch.source))}</strong></p><div class="xm-save-options"><button class="xm-choice" onclick="A.commitToolConfig('merge')"><strong>保留其他设置（推荐）</strong><span>只修改账号来源、密钥和模型，自定义设置继续保留。</span></button><button class="xm-choice" onclick="A.commitToolConfig('reset')"><strong>使用初始配置</strong><span>先保留当前备份，再替换为星芒初始配置。</span></button></div>${p.changedSource&&provider(p.id)==='codex'?'<div class="callout info">来源档案会分别保存，Codex CLI 与桌面端会同步。若桌面端正在运行，会提示重新打开。</div>':''}`,footer:'<span class="spacer"></span><button class="btn btn-ghost" onclick="A.closeDialog()">返回修改</button>'});
  A.commitToolConfig=mode=>{
    const d=topDialog(),p=d.props;
    if(mode==='reset'&&!p.resetConfirmed)return A.confirm({title:'使用初始配置？',body:'会先保留当前配置备份，再替换这份工具配置。工具的历史会话不在此次替换范围内。',ok:'备份并重置',danger:true,run:()=>{p.resetConfirmed=true;A.commitToolConfig('reset');}});
    if(state().failNext==='config'){state().failNext=null;return A.toast('配置没有保存成功，输入已保留。可以重试或返回修改。','bad');}
    S.backups.unshift({id:Date.now(),tool:provider(p.id),when:'刚刚',kind:'保存前',files:fileList(p.id),size:'2.6 KB'});
    XM.setToolConfig(p.id,p.patch);
    const id=p.id;A.closeDialog();
    const parent=topDialog();if(parent?.id===p.parentId){parent.initial=formFingerprint(parent.form);parent.dirty=false;parent.tabInitial ||= {};parent.tabInitial[id]=parent.initial;const otherDrafts=Object.entries(parent.tabForms||{}).some(([tab,form])=>tab!==id&&formFingerprint(form)!==parent.tabInitial[tab]);if(!otherDrafts)A.closeDialog();}
    A.toast(mode==='merge'?'配置已保存，其他设置已保留':'已保留备份并写入初始配置');
    if(provider(id)==='codex'&&state().running.codexDesktop)A.dialog('xmRestart',{id:'codexDesktop'});
    else render();
  };

  toolRow=(id,i)=>{
    const own=S.tools[id],t=S.tools[provider(id)],job=state().jobs[id],src=t.source,off=official(id);
    let status,action='',extra='',subtitle=own.installed?'v'+own.version:TOOLS[id].company;
    if(job){status=pill('accent','正在'+(job.wasInstalled?'更新':'安装'));action=`<button class="btn btn-secondary sm" onclick="A.cancelToolInstall('${id}')">取消</button>`;subtitle=job.percent+'% · '+job.label;}
    else if(!own.installed){status='<span>需要时再安装</span>';action=`<button class="btn btn-secondary sm" onclick="A.install('${id}')">安装</button>`;}
    else if(src==='unknown'){status=pill('warn','检查配置');action=primaryAction('查看配置',`A.dialog('config',{tool:'${id}'})`);}
    else if(src==='official'){status=pill(off.signedIn?'ok':'warn',off.signedIn?'官方已登录':'官方待登录');action=primaryAction(off.signedIn?'打开':'去登录',`A.launch('${id}')`);subtitle+=' · '+(off.signedIn?off.email:officialName(id));}
    else if(!t.configured){status=pill('warn','待连接');action=primaryAction('连接账号',`A.dialog('config',{tool:'${id}'})`);}
    else{const key=S.keys.find(k=>k.id===t.key),bad=src==='account'&&(!key||key.status!=='active');status=pill(bad?'bad':'ok',bad?'检查密钥':'已配好');action=primaryAction(bad?'查看密钥':'打开',bad?"A.openAccount('keys')":`A.launch('${id}')`);subtitle+=' · '+(t.model||'默认模型');}
    if(!job&&own.installed&&own.version!==TOOLS[id].latest)extra=`<button class="btn btn-ghost sm" onclick="A.install('${id}')" title="更新到 ${TOOLS[id].latest}">${ic('dl')}更新</button>`;
    return `<div class="trow ${own.installed?'':'dim'}" data-testid="tool-row-${id}">${brand(id)}<div class="name"><strong title="${TOOLS[id].name}">${TOOLS[id].name}</strong><span title="${esc(subtitle)}">${esc(subtitle)}</span></div><div class="st">${status}${job?`<progress class="xm-tool-progress" max="100" value="${job.percent}" aria-label="安装进度">${job.percent}%</progress>`:''}</div><div class="upd">${extra}</div><div class="pri">${action}</div><div>${own.installed&&!job?`<button class="btn btn-ghost icon sm" title="${TOOLS[id].name}更多操作" onclick="A.toolMenu(event,'${id}')">${ic('dots')}</button>`:''}</div></div>`;
  };
  const cap=()=>XM.platformCapabilities?.()||{desktopAvailable:S.os!=='linux',desktopInstall:S.os==='win'?'managed':S.os==='mac'?'external':'unavailable',nodeInstall:S.os==='win'?'managed':'external'};
  A.install=id=>{
    if(state().jobs[id])return;
    const capabilities=cap();
    if(id==='codexDesktop'&&!capabilities.desktopAvailable)return XM.showHelp('当前系统使用命令行工具','这个系统没有可用的 Codex 桌面端。你仍可以选择 Codex CLI、Claude Code 或 Gemini CLI，跟随安装步骤完成准备。','home');
    if((id==='codexDesktop'&&capabilities.desktopInstall!=='managed')||(['node','python'].includes(id)&&S.os!=='win'))return A.dialog('xmExternalInstall',{id});
    if(!['node','python','codexDesktop'].includes(id)&&!envReady())return A.dialog('xmRuntimeNeeded',{id});
    const jobs=state().jobs,session=S,old=id==='node'||id==='python'?null:{...S.tools[id]};
    const job=jobs[id]={id,percent:0,wasInstalled:!!old?.installed,old,label:'准备安装文件'};S.installing[id]=0;render();
    const step=()=>{
      if(S!==session||state().jobs[id]!==job)return;
      job.percent=Math.min(100,job.percent+20);job.label=job.percent<40?'准备安装文件':job.percent<80?'正在安装':'检查安装结果';S.installing[id]=job.percent;
      if(state().failNext==='install'&&job.percent>=40){state().failNext=null;delete jobs[id];delete S.installing[id];state().lastResult={id,type:'failed'};render();A.dialog('xmInstallFailed',{id});return;}
      if(job.percent<100){render();XM.defer(step,350);return;}
      delete jobs[id];delete S.installing[id];
      if(id==='node'){S.env.node='22.11.0';S.env.npm='10.9.2';}
      else if(id==='python')S.env.python='3.12.4';
      else{S.tools[id].installed=true;S.tools[id].version=TOOLS[id].latest;}
      state().lastResult={id,type:'success'};render();A.toast((TOOLS[id]?.name||({node:'Node.js',python:'Python'})[id])+'已安装，下一步检查账号配置');
    };XM.defer(step,350);
  };
  A.cancelToolInstall=id=>{const job=state().jobs[id];if(!job)return;delete state().jobs[id];delete S.installing[id];state().lastResult={id,type:'cancelled'};render();A.toast('已取消这次安装，可重新检测后继续');};
  DIALOGS.xmRuntimeNeeded=p=>dialogShell({title:'先准备运行环境',body:`<p>${TOOLS[p.id].name} 需要 Node.js 和 npm。准备一次后，其他命令行工具也可以使用。</p><p class="xm-field-help">Codex 桌面端不需要这一步；你可以返回首页先使用桌面端。</p>`,footer:`<button class="btn btn-ghost" onclick="A.closeDialog()">返回</button><span class="spacer"></span><button class="btn btn-primary" onclick="A.closeDialog();A.install('node')">准备 Node.js</button>`});
  DIALOGS.xmExternalInstall=p=>dialogShell({title:'按步骤安装 '+(TOOLS[p.id]?.name||p.id),body:`<ol class="xm-instructions"><li>打开对应工具的官方安装页面，选择与你系统匹配的安装包。</li><li>${S.os==='mac'?'打开安装包并放入“应用程序”；首次启动按系统提示确认。':'按发行版的软件安装方式完成安装。不同桌面环境的按钮名称可能不同。'}</li><li>回到这里，点击“我已安装，重新检测”。</li></ol><div class="callout info">本页是安装步骤原型；真实下载入口与发行版支持范围见开发规格。</div>`,footer:`<button class="btn btn-ghost" onclick="A.closeDialog()">稍后安装</button><span class="spacer"></span><button class="btn btn-primary" onclick="A.externalInstalled('${p.id}')">我已安装，重新检测</button>`});
  A.externalInstalled=id=>{if(id==='node'){S.env.node='22.11.0';S.env.npm='10.9.2';}else if(id==='python')S.env.python='3.12.4';else{S.tools[id].installed=true;S.tools[id].version=TOOLS[id].latest;}state().lastResult={id,type:'success'};A.closeDialog();render();A.toast('已检测到工具，可以继续下一步');};
  DIALOGS.xmInstallFailed=p=>dialogShell({title:'这次安装没有完成',body:'<p>可能是网络、文件权限或安装程序未完成。请重新检测当前状态，再决定是否重试；已有工具配置仍保留。</p>',footer:`<button class="btn btn-ghost" onclick="A.closeDialog();A.go('health')">去检查</button><span class="spacer"></span><button class="btn btn-primary" onclick="A.closeDialog();A.install('${p.id}')">重试安装</button>`});

  A.launch=id=>{
    const t=S.tools[provider(id)];if(!S.tools[id]?.installed)return A.install(id);
    if(t.source==='unknown'||(!t.configured&&t.source!=='official'))return A.dialog('config',{tool:id});
    if(t.source==='official'&&!official(id).signedIn)return A.dialog('xmOfficialLogin',{id});
    if(id==='codexDesktop'&&state().running[id])return A.dialog('xmRestart',{id});
    state().running[id]=true;S.launched=true;render();A.toast(TOOLS[id].name+' 已打开');
  };
  DIALOGS.xmOfficialLogin=p=>dialogShell({title:'在 '+TOOLS[p.id].name+' 中登录',body:`<p>使用你的${officialName(p.id)}完成登录，密码只在官方工具里输入。</p><ol class="xm-instructions"><li>在工具中选择官方账号登录。</li><li>完成浏览器或工具里的登录提示。</li><li>回到这里检查登录状态。</li></ol>`,footer:`<button class="btn btn-ghost" onclick="A.closeDialog()">稍后</button><span class="spacer"></span><button class="btn btn-primary" onclick="A.checkOfficialLogin('${p.id}')">我已登录，重新检测</button>`});
  A.checkOfficialLogin=id=>{if(state().failNext==='official'){state().failNext=null;return A.toast('暂时没有检测到登录，请完成工具中的步骤后再试','warn');}Object.assign(official(id),{signedIn:true,email:'demo@example.com',plan:'Plus',renewal:'2026-10-06',resets:2,status:'ready',windows:[{label:'当前使用窗口',remaining:72,reset:'约2小时后重置'},{label:'每周额度',remaining:88,reset:'约5天后重置'}]});XM.setToolConfig(id,{source:'official',configured:true,model:null});state().running[id]=true;A.closeDialog();render();A.toast('已检测到官方登录');};
  DIALOGS.xmRestart=p=>dialogShell({title:TOOLS[p.id].name+' 已在运行',body:'<p>打开窗口会回到当前任务。重新启动可让刚保存的配置生效；开始前请保存工具内尚未完成的内容。</p>',footer:`<button class="btn btn-ghost" onclick="A.closeDialog()">取消</button><span class="spacer"></span><button class="btn btn-secondary" onclick="A.closeDialog();A.toast('已打开现有窗口')">打开窗口</button><button class="btn btn-primary" onclick="A.restartTool('${p.id}')">重新启动</button>`});
  A.restartTool=id=>{if(state().failNext==='restart'){state().failNext=null;return A.toast('配置已保存，但没有重新打开工具。请手动打开，或稍后重试。','warn');}state().running[id]=true;A.closeDialog();render();A.toast('工具已重新打开');};
  A.toolLocale=()=>{if(state().failNext==='locale'){state().failNext=null;return XM.showHelp('中文界面暂不可用','当前工具版本的本地中文资源没有读取成功。可以先使用现有界面，之后更新工具再试。');}S.tools.codexDesktop.zh=true;render();A.toast('中文界面已准备好，重新打开 Codex 后生效');};
  A.toolTrust=()=>A.confirm({title:'允许 Codex 使用当前文件夹？',body:'仅对你确认可信的项目授予访问权限。当前文件夹：'+S.settings.workdir,ok:'信任这个文件夹',run:()=>{S.tools.codexDesktop.trusted=true;A.toast('当前文件夹已标记为可信');}});
  A.toolScenario=(kind,id='codexDesktop')=>{if(['install','config','restart','official','locale','sync'].includes(kind))state().failNext=kind;else if(kind==='officialReady'){XM.setToolConfig(id,{source:'official',configured:true,model:null});Object.assign(official(id),{signedIn:true,email:'demo@example.com',plan:'Plus',renewal:'2026-10-06',resets:2,status:'ready',windows:[{label:'当前窗口',remaining:72,reset:'约2小时后重置'},{label:'本周额度',remaining:88,reset:'约5天后重置'}]});}else if(kind==='officialMissing'){XM.setToolConfig(id,{source:'official',configured:true,model:null});official(id).signedIn=false;}else if(kind==='unknown')XM.setToolConfig(id,{source:'unknown',configured:true});render();};
  A.toolMenu=(event,id)=>{
    const source=XM.toolSource(id),items=[{label:'账号与模型配置',icon:'gear',run:()=>A.dialog('config',{tool:id})}];
    if(source==='official')items.push({label:'查看官方登录状态',icon:'user',run:()=>XM.showHelp(officialName(id),official(id).signedIn?'已登录：'+official(id).email+'。官方额度与星芒余额分别计算。':'还没有检测到官方登录，请打开工具完成登录。')});
    else if(source==='account'||source==='manual')items.push({label:'查看访问密钥',icon:'key',run:()=>source==='account'?A.openAccount('keys'):XM.showHelp('手填访问密钥','当前使用你自己填写的星芒访问密钥。需要更换时，打开账号与模型配置。')});
    else items.push({label:'查看已有配置说明',icon:'info',run:()=>A.dialog('config',{tool:id})});
    if(S.tools[id].installed&&S.tools[id].version!==TOOLS[id].latest)items.push({label:'更新工具',icon:'dl',run:()=>A.install(id)});
    items.push({label:'备份配置',icon:'archive',run:()=>{S.backupTool=provider(id);A.go('backups');}},'hr',{label:'卸载工具',icon:'trash',danger:true,run:()=>A.uninstall(id)});A.menu(event,items);
  };
  A.uninstall=id=>{
    if(id==='codexDesktop'&&S.os!=='win')return XM.showHelp('在系统中卸载','请在系统应用管理中卸载 Codex。此操作不会自动删除保存的配置。之后回到星芒重新检测即可。','maintenance');
    A.confirm({title:'卸载 '+TOOLS[id].name+'？',body:'只移除工具程序，保留配置和历史会话。'+(provider(id)==='codex'?'Codex CLI 与桌面端共用的配置仍保留。':''),ok:'卸载工具',danger:true,run:()=>{S.tools[id].installed=false;S.tools[id].version=null;delete state().running[id];render();A.toast('工具已卸载，配置仍保留');}});
  };
  A.fixKey=()=>{const account=S.user?.name,session=S;A.toast('正在检查账户里的可用密钥');XM.defer(()=>{if(S!==session||S.user?.name!==account)return;const result=XM.onAccountSwitched(S.user,S.user);render();A.toast(result.message,result.ok?undefined:'warn');},650);};
  XM.officialMeter=()=>{
    if(XM.toolSource('codex')!=='official')return '';
    const o=official('codex');return `<div class="card xm-official-meter"><div class="card-head"><h2>ChatGPT 官方额度</h2><button class="btn btn-ghost icon sm" title="刷新官方额度" onclick="A.refreshOfficialUsage()">${ic('refresh')}</button></div><div class="card-body">${o.signedIn?`<strong>${esc(o.email)}</strong><p>${esc(o.plan)} · 与星芒余额分别计算</p><dl class="xm-official-meta"><dt>订阅续期</dt><dd>${esc(o.renewal||'尚未获取')}</dd><dt>可用额度重置</dt><dd>${o.resets==null?'尚未获取':o.resets+' 次'}</dd></dl>${o.status==='error'?'<div class="callout warn">额度暂时没有读取成功，工具仍可打开。</div>':o.status==='loading'?'<p role="status">正在读取官方额度…</p>':(o.windows||[]).map(w=>`<div class="xm-meter-row"><span>${esc(w.label)}</span><b>${w.remaining}%</b><progress max="100" value="${w.remaining}"></progress><small>${esc(w.reset)}</small></div>`).join('')}`:'<p>先在 Codex 中登录 ChatGPT 账号，再查看这里的额度。</p><button class="btn btn-secondary sm" onclick="A.launch(\'codexDesktop\')">去登录</button>'}</div></div>`;
  };
  A.refreshOfficialUsage=()=>{const o=official('codex');if(!o.signedIn)return A.toast('先在 Codex 中完成官方登录','warn');o.status='loading';render();XM.defer(()=>{o.status=state().failNext==='official'?'error':'ready';state().failNext=null;render();},650);};
  const oldAccountCard=accountCard;accountCard=function(){return oldAccountCard()+XM.officialMeter();};
})();
