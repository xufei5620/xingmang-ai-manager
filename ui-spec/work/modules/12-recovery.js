/* Offline recovery UI. Verified client mail request: GET /api/reset_password?email=...
 * No HTTP is made here. Full-link token extraction is an added prototype interaction.
 * This password is a visible demonstration result, never a real credential. */
(function () {
  'use strict';
  const SAMPLE_PASSWORD='Xm-Demo-7kQ2p-93Lr';
  const cooldownSeconds=60;
  const fields=()=>{const d=topDialog();return d?.type==='forgot'?d:null;};
  const details=d=>d.recovery ||= {requestId:0,copyRequestId:0,cooldownId:0,phase:'email',sendState:'idle',resetState:'idle',copyState:'idle',showPassword:false,manualCopy:false,newPassword:'',sentEmail:'',cooldown:0,parsedInput:'',parsedToken:'',tokenKind:'',expiredToken:'',fault:''};
  const valid=(session,d,id)=>S===session&&S.dialogs.includes(d)&&details(d).requestId===id;
  const button=(label,action,id,primary=false,disabled=false)=>`<button class="btn btn-${primary?'primary':'secondary'}" data-testid="${id}" onclick="${action}" ${disabled?'disabled':''}>${label}</button>`;
  const alert=(text,bad=false)=>`<div class="callout ${bad?'bad':''} xm-recovery-message" role="${bad?'alert':'status'}">${ic(bad?'info':'check')}<span>${esc(text)}</span></div>`;
  const emailPattern=/^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function parseToken(raw) {
    const input=String(raw||'').trim();
    if(!input)return {error:'先粘贴邮件中的重置码或完整链接。'};
    if(/^[a-z][a-z\d+.-]*:/i.test(input)||input.includes('://')) {
      let url;try{url=new URL(input);}catch(_){return {error:'这条链接不完整，请复制邮件中的完整重置链接。'};}
      if(!['https:','http:'].includes(url.protocol))return {error:'请粘贴邮件中的 http 或 https 重置链接。'};
      const tokens=url.searchParams.getAll('token');
      if(tokens.length!==1)return {error:tokens.length?'链接里出现了多个重置码，请重新复制邮件中的完整链接。':'没有从链接中找到重置码，请确认链接带有 token 参数。'};
      const token=tokens[0].trim();
      if(!token||/\s/.test(token))return {error:'链接中的重置码为空或包含空格，请重新复制。'};
      return {input,token,kind:'link'};
    }
    if(/\s/.test(input))return {error:'重置码中不能夹有空格或换行，请重新复制邮件中的内容。'};
    return {input,token:input,kind:'token'};
  }
  function initialise(d) {
    const r=details(d),f=d.form;if(r.initialised)return r;r.initialised=true;
    const previous=S.dialogs.slice(0,S.dialogs.indexOf(d)).reverse().find(x=>x.type==='login');
    r.parentLoginId=previous?.id||null;
    if(!f.email&&emailPattern.test(previous?.form?.acc||''))f.email=previous.form.acc;
    d.initial=formFingerprint(f);
    return r;
  }
  DIALOGS.forgot=function(){
    const d=renderingDialog?.type==='forgot'?renderingDialog:fields();if(!d)return '';
    const r=initialise(d),f=S.form,step=r.phase==='email'?1:r.phase==='token'?2:3;
    const progress=`<ol class="xm-recovery-progress" aria-label="找回密码进度">${['获取邮件','粘贴重置码','取得新密码'].map((title,i)=>`<li class="${i+1===step?'current':i+1<step?'done':''}" ${i+1===step?'aria-current="step"':''}><b>${i+1<step?'✓':i+1}</b>${title}</li>`).join('')}</ol>`;
    let body=progress,footer='';
    if(r.phase==='email'){
      body+=`<div class="field"><label>注册邮箱</label><input class="input" type="email" data-autofocus data-testid="recovery-email" autocomplete="email" placeholder="输入注册时使用的邮箱" value="${esc(f.email||'')}" oninput="A.recoveryInput('email',this.value)" onkeydown="if(event.key==='Enter')A.sendReset()"><div class="hint">若该邮箱已注册，你会收到一封重置邮件。页面不会显示邮箱是否已注册。</div></div>${r.sendState==='sending'?alert('正在提交发送请求，请稍候。'):''}${r.error?alert(r.error,true):''}`;
      footer=button('返回',"A.requestDialogClose('dismiss')",'recovery-close')+'<span class="spacer"></span>'+button(r.sendState==='sending'?'正在发送…':r.cooldown?`${r.cooldown} 秒后可重发`:r.sendState==='failed'?'重试发送':'发送重置邮件','A.sendReset()','recovery-send',true,r.sendState==='sending'||r.cooldown>0);
    }else if(r.phase==='token'){
      body+=alert('发送请求已完成。若该邮箱已注册，请在收件箱或垃圾邮件中查找重置邮件。')+`<div class="xm-recovery-email-line"><span>${esc(r.sentEmail||f.email||'')}</span>${button('换个邮箱','A.recoveryBackEmail()','recovery-change-email')}</div><div class="field"><label>重置码或完整链接</label><textarea class="input mono" data-autofocus data-testid="recovery-token" rows="3" placeholder="粘贴邮件中的重置码，或带 token 参数的完整链接" oninput="A.recoveryInput('token',this.value)">${esc(f.token||'')}</textarea><div class="hint">完整链接只读取其中的 token 参数；也可以直接粘贴重置码。</div></div><div class="xm-recovery-inline">${button('检查粘贴内容','A.recoveryParse()','recovery-parse')}${button(r.sendState==='sending'?'正在发送…':r.cooldown?`${r.cooldown} 秒后可重发`:'重新获取邮件','A.sendReset()','recovery-resend',false,r.sendState==='sending'||r.cooldown>0||r.resetState==='working')}</div>${r.parsedInput&&r.parsedInput===(f.token||'').trim()&&!r.error?alert(r.tokenKind==='link'?'已从链接提取重置码，可以继续。':'已识别重置码，可以继续。'):''}${r.sendState==='sending'?alert('正在重新提交发送请求，已填写的内容会保留。'):''}${r.resetState==='working'?alert('正在处理密码重置，请稍候。'):''}${r.error?alert(r.error,true):''}`;
      footer=button('上一步','A.recoveryBackEmail()','recovery-back')+'<span class="spacer"></span>'+button(r.resetState==='working'?'正在重置…':r.resetState==='failed'?'重试重置':'重置密码','A.resetPw()','recovery-reset',true,r.resetState==='working'||r.sendState==='sending');
    }else{
      body+=alert('密码已重置。请保存新密码，再返回登录。')+`<div class="field"><label>新密码</label><div class="field-row"><input class="input mono" readonly data-testid="recovery-new-password" type="${r.showPassword?'text':'password'}" value="${esc(r.newPassword)}">${button(r.showPassword?'隐藏':'显示','A.recoveryTogglePassword()','recovery-show')}</div></div><div class="xm-recovery-inline">${button(r.copyState==='copying'?'正在复制…':'复制新密码','A.recoveryCopy()','recovery-copy',true,r.copyState==='copying')}${button('手动选择复制','A.recoverySelectPassword()','recovery-manual')}</div>${r.copyState==='success'?alert('新密码已复制。'):r.copyState==='failed'?alert('没有复制成功。可在下方选择新密码，手动复制。',true):''}${r.manualCopy?`<div class="field"><label>选择并复制新密码</label><textarea class="input mono xm-recovery-select" readonly rows="2" id="recovery-copy-${d.id}" data-testid="recovery-manual-password" onclick="this.select()">${esc(r.newPassword)}</textarea><div class="hint">点击选中内容，再按 ${S.os==='mac'?'⌘C':'Ctrl+C'} 或用右键菜单复制。</div></div>`:''}<p class="xm-recovery-followup">登录后，请到「个人中心 → 修改密码」换成你自己的密码。</p>`;
      footer=button('返回登录','A.recoveryGoLogin()','recovery-go-login',true);
    }
    return dialogShell({title:'找回密码',sub:`第 ${step} 步，共 3 步`,body:`<div class="xm-recovery" data-testid="recovery-page">${body}</div>`,footer});
  };
  A.recoveryInput=function(key,value){const d=fields();if(!d||!['email','token'].includes(key))return;const r=details(d);d.form[key]=value;d.dirty=true;r.error='';r.requestId++;r.resetState='idle';r.sendState='idle';d.form.busy=false;if(key==='token'){r.parsedInput='';r.parsedToken='';r.tokenKind='';}else if(value!==r.sentEmail){r.cooldownId++;r.cooldown=0;}render();};
  A.recoveryParse=function(){const d=fields();if(!d)return null;const r=details(d),result=parseToken(d.form.token);if(!result.error&&result.token===r.expiredToken)result.error='这个重置码已过期，请重新获取邮件并粘贴新的重置码。';r.error=result.error||'';if(!result.error){r.parsedInput=result.input;r.parsedToken=result.token;r.tokenKind=result.kind;}else{r.parsedInput='';r.parsedToken='';r.tokenKind='';}render();return result.error?null:result.token;};
  function cooldown(session,d){const r=details(d),id=++r.cooldownId;r.cooldown=cooldownSeconds;const tick=()=>{if(S!==session||!S.dialogs.includes(d)||details(d).cooldownId!==id)return;r.cooldown=Math.max(0,r.cooldown-1);render();if(r.cooldown)later(tick,1000);};later(tick,1000);}
  A.sendReset=function(){
    const d=fields();if(!d)return;const r=initialise(d),f=d.form,session=S;
    if(r.sendState==='sending'||r.resetState==='working'||r.cooldown>0)return;
    const email=String(f.email||'').trim();if(!emailPattern.test(email)){r.error='请填写正确的邮箱地址。';render();return;}
    const id=++r.requestId;r.sendState='sending';r.error='';f.busy=true;render();
    later(()=>{if(!valid(session,d,id))return;f.busy=false;if(r.fault==='emailFailure'){r.fault='';r.sendState='failed';r.error='发送请求未完成，请检查连接后重试。已填写的邮箱会保留。';render();return;}r.sendState='sent';r.phase='token';r.sentEmail=email;r.resetState='idle';cooldown(session,d);render();},420);
  };
  A.resetPw=function(){
    const d=fields();if(!d)return;const r=initialise(d),f=d.form,session=S;
    if(r.resetState==='working'||r.sendState==='sending'||r.phase!=='token')return;
    const parsed=parseToken(f.token);if(parsed.error){r.error=parsed.error;render();return;}
    r.parsedInput=parsed.input;r.parsedToken=parsed.token;r.tokenKind=parsed.kind;
    if(r.expiredToken===parsed.token){r.error='这个重置码已过期，请重新获取邮件并粘贴新的重置码。';r.resetState='expired';render();return;}
    const id=++r.requestId;r.resetState='working';r.error='';f.busy=true;render();
    later(()=>{if(!valid(session,d,id))return;f.busy=false;if(r.fault==='expired'){r.fault='';r.expiredToken=parsed.token;r.resetState='expired';r.error='这个重置码已过期，请重新获取邮件并粘贴新的重置码。';render();return;}if(r.fault==='resetFailure'){r.fault='';r.resetState='failed';r.error='密码暂时没有重置成功，已粘贴的内容会保留。请重试。';render();return;}r.phase='done';r.resetState='success';r.cooldownId++;r.cooldown=0;r.newPassword=SAMPLE_PASSWORD;r.showPassword=false;r.copyState='idle';r.manualCopy=false;d.initial=formFingerprint(f);d.dirty=false;render();},460);
  };
  A.recoveryBackEmail=function(){const d=fields();if(!d)return;const r=details(d);r.requestId++;r.phase='email';r.sendState='idle';r.resetState='idle';r.error='';d.form.busy=false;render();};
  A.recoveryTogglePassword=function(){const d=fields();if(!d)return;details(d).showPassword=!details(d).showPassword;render();};
  A.recoverySelectPassword=function(){const d=fields();if(!d||!details(d).newPassword)return;details(d).manualCopy=true;render();const input=document.getElementById(`recovery-copy-${d.id}`);input?.focus();input?.select();};
  A.recoveryCopy=async function(){const d=fields();if(!d)return;const r=details(d),session=S;if(!r.newPassword||r.copyState==='copying')return;const id=++r.copyRequestId;r.copyState='copying';render();try{if(r.fault==='clipboardFailure'){r.fault='';throw new Error('simulated clipboard unavailable');}if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(r.newPassword);if(S!==session||!S.dialogs.includes(d)||r.copyRequestId!==id)return;r.copyState='success';render();}catch(_){if(S!==session||!S.dialogs.includes(d)||r.copyRequestId!==id)return;r.copyState='failed';r.manualCopy=true;render();const input=document.getElementById(`recovery-copy-${d.id}`);input?.focus();input?.select();}};
  A.recoveryGoLogin=function(){const d=fields();if(!d||details(d).phase!=='done')return;const r=details(d),email=r.sentEmail||d.form.email;r.requestId++;r.copyRequestId++;r.cooldownId++;A.closeDialog();if(topDialog()?.type!=='login')A.dialog('login');const login=topDialog();login.form.acc=email;login.form.pw='';login.form.showPw=false;login.form.err='';login.form.busy=false;S.form=login.form;login.initial=formFingerprint(login.form);render();A.toast('请用新密码登录，登录后到个人中心修改密码。');};
  const scenarios={emailFailure:'重置邮件发送失败',expired:'重置码过期',resetFailure:'重置失败',clipboardFailure:'复制失败',ready:'正常找回密码'};
  A.recoveryScenario=function(kind){if(!Object.hasOwn(scenarios,kind))return false;A.dialog('forgot');const d=fields(),r=initialise(d);d.form.email='recovery-demo@example.com';r.fault=kind==='ready'?'':kind;if(['expired','resetFailure'].includes(kind)){r.phase='token';r.sentEmail=d.form.email;d.form.token='demo-recovery-token';}if(kind==='clipboardFailure'){r.phase='done';r.newPassword=SAMPLE_PASSWORD;r.sentEmail=d.form.email;}d.initial=formFingerprint(d.form);d.dirty=false;render();return true;};
  if(window.XM){window.XM.recoveryScenarios=scenarios;window.XM.parseRecoveryToken=parseToken;}
  function debugBar(){const bar=document.querySelector('.proto-bar');if(!bar||bar.querySelector('[data-testid="recovery-scenario"]'))return;const label=document.createElement('label');label.className='xm-recovery-debug';label.textContent='找回密码 ';const select=document.createElement('select');select.setAttribute('aria-label','找回密码演示场景');select.setAttribute('data-testid','recovery-scenario');select.innerHTML='<option value="">选择场景</option>'+Object.entries(scenarios).map(([value,text])=>`<option value="${value}">${text}</option>`).join('');select.addEventListener('change',()=>{if(select.value)A.recoveryScenario(select.value);select.value='';});label.append(select);bar.append(label);const note=document.createElement('span');note.className='xm-recovery-demo-note';note.textContent='找回密码为离线演示，新密码为固定示例';bar.append(note);}
  if(window.XM?.afterRender)window.XM.afterRender(debugBar);else debugBar();
})();
