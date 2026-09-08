/* Conversation recovery and account-owned demonstration billing. */
(() => {
  const XM=window.XM,ux=()=>XM.state('chatUX',()=>({next:null}));
  const current=()=>S.chat.convs.find(c=>c.id===S.chat.active);
  const errorCopy={offline:['网络暂时不可用','输入已保留。恢复连接后可以重新发送。'],expired:['请重新登录星芒账号','工具中已保存的配置不会被清除。登录后再继续这段聊天。'],balance:['可用额度不足','可以补充余额、购买订阅，或调整个人中心的扣费偏好。'],timeout:['这次没有取得回复','输入和已有对话都保留着，可以再试一次。'],rate:['请求有些频繁','稍等片刻再发送，或切换其他模型。'],model:['这个模型暂时不可用','换一个模型后再试，输入不会丢失。']};
  const errorState=()=>current()||S.chat;
  const setError=(kind,text)=>{errorState().uiError={kind,text};render();};
  const oldChatHtml=chatHtml,oldSend=A.chatSend;
  chatHtml=function(){
    let html=oldChatHtml();const failure=errorState().uiError;
    if(failure){const [title,description]=errorCopy[failure.kind]||errorCopy.timeout;let action=failure.kind==='expired'?'<button class="btn btn-secondary sm" onclick="A.dialog(\'login\')">重新登录</button>':failure.kind==='balance'?'<button class="btn btn-secondary sm" onclick="A.openAccount(\'recharge\')">查看余额与订阅</button>':failure.kind==='model'?'<button class="btn btn-secondary sm" onclick="A.chatChooseModel()">更换模型</button>':'<button class="btn btn-secondary sm" onclick="A.chatRetrySend()">重新发送</button>';html=html.replace('<div class="composer">',`<div class="xm-chat-error" role="alert"><div><strong>${title}</strong><p>${esc(failure.text||description)}</p></div>${action}<button class="btn btn-ghost icon sm" aria-label="收起提示" onclick="A.chatDismissError()">${ic('x')}</button></div><div class="composer">`);}
    html=html.replace("onclick=\"A.toast('内容已复制')\"",'onclick="A.chatCopyMessage(this)"');
    return html;
  };
  A.chatScenario=(kind='ready')=>{ux().next=kind==='ready'?null:kind;if(kind==='ready')errorState().uiError=null;render();};
  A.chatSend=function(){
    const input=document.getElementById('chatIn');if(!input||input.dataset.composing==='true')return;rememberChatDraft();
    if(!input.value.trim()||current()?.request)return;
    if(!S.user)return setError('expired');
    if(S.sim==='offline')return setError('offline');if(S.sim==='expired')return setError('expired');
    const cost=S.chat.mode==='image'?.24:.03,capacity=XM.accountCanCharge?.(cost,S.user.name);
    if(capacity&&!capacity.ok)return setError('balance',capacity.message||capacity.error);
    if(ux().next){const next=ux().next;ux().next=null;return setError(next);}
    errorState().uiError=null;oldSend();
  };
  A.chatRetrySend=()=>{errorState().uiError=null;A.chatSend();};
  A.chatDismissError=()=>{errorState().uiError=null;render();};
  A.chatChooseModel=()=>{errorState().uiError=null;render();document.querySelector('.composer .modelsel select')?.focus();};
  const originalAuth=XM.authComplete;
  XM.authComplete=function(...args){const result=originalAuth?.(...args);if(S.sim==='expired')S.sim='';if(S.chat)errorState().uiError=null;return result;};
  startConversationRequest=function(conv,text,options={}){
    cancelConversationRequest(conv);
    const owner=S.user?.name,session=S,record=XM.accountStore?.().records?.[owner];
    const request={id:++requestSequence,cancelled:false,owner,image:options.image??S.chat.mode==='image',model:options.model||(S.chat.mode==='image'?S.chat.imgModel:S.chat.model),size:options.size||S.chat.imgSize,group:S.chat.group};
    conv.request=request;conv.uiError=null;render();
    const msgs=document.getElementById('msgs');if(msgs&&S.chat.active===conv.id)msgs.scrollTop=msgs.scrollHeight;
    request.timer=later(()=>{
      if(S!==session||request.cancelled||conv.request?.id!==request.id||S.user?.name!==owner||!S.chat.convs.includes(conv))return;
      const cost=request.image?.24:.03,charged=XM.accountCharge?.(cost,owner);
      if(charged&&!charged.ok){conv.request=null;conv.uiError={kind:'balance',text:charged.message||charged.error};render();return;}
      const message=request.image?{role:'ai',text:`按「${text}」生成 · ${request.model} · ${request.size}`,img:true,model:request.model,size:request.size}:{role:'ai',text:reply(text)+(options.retry?'\n\n这是重新生成的回复。':''),model:request.model};
      if(options.replace){const index=conv.msgs.indexOf(options.replace);if(index<0){conv.request=null;return;}conv.msgs.splice(index,1,message);}else conv.msgs.push(message);
      conv.request=null;
      if(record){record.user.usedMonth=(record.user.usedMonth||0)+cost;record.usage.unshift({id:'CHAT-'+request.id,requestId:'chat-demo-'+request.id,t:new Date().toLocaleString('zh-CN',{hour12:false}),daysAgo:0,model:request.model,key:'星芒内置聊天',group:request.group,inTok:Math.max(1,text.length),outTok:request.image?0:message.text.length,cost,ms:request.image?2200:1100,stream:!request.image,status:'success',billing:charged?.source||'balance',cacheTokens:0,firstTokenMs:240});}
      render();const el=document.getElementById('msgs');if(el&&S.chat.active===conv.id)el.scrollTop=el.scrollHeight;
    },request.image?2200:1100);
  };
  A.chatCopyMessage=async button=>{
    const elements=[...document.querySelectorAll('#msgs .msg')],index=elements.indexOf(button.closest('.msg')),message=current()?.msgs[index];if(!message)return;
    try{if(!navigator.clipboard?.writeText)throw new Error('unavailable');await navigator.clipboard.writeText(message.text||'');A.toast('内容已复制');}catch(_){A.dialog('xmCopyText',{text:message.text||''});}
  };
  DIALOGS.xmCopyText=p=>dialogShell({title:'复制这段内容',body:`<p>自动复制暂时不可用。选中下面的内容后，使用系统复制快捷键。</p><textarea class="input" rows="8" readonly data-autofocus>${esc(p.text)}</textarea>`,footer:'<span class="spacer"></span><button class="btn btn-secondary" onclick="A.closeDialog()">关闭</button>'});
})();
