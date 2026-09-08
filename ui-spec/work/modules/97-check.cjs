/* Isolated tray component fixture. No navigation to the user's browser or local preview URL. */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{chromium}=require(process.env.XINGMANG_PLAYWRIGHT_MODULE||'playwright');
let browser;
(async()=>{
 const work=path.resolve(__dirname,'..'),out=path.join(work,'tray-review');fs.mkdirSync(out,{recursive:true});
 const before=process.argv.includes('--before');
 const css=fs.readFileSync(path.join(work,'prototype.css'),'utf8')+(!before&&fs.existsSync(path.join(__dirname,'97-tray.css'))?fs.readFileSync(path.join(__dirname,'97-tray.css'),'utf8'):'');
 const template=fs.readFileSync(path.join(work,'base-template.html'),'utf8');
 let defs=[...template.matchAll(/<defs>[\s\S]*?<\/defs>/g)].map(m=>m[0]).join('');
 for(const m of template.matchAll(/<symbol\b[^>]*id="([^"]+)"[^>]*>[\s\S]*?<\/symbol>/g))if(!defs.includes('id="'+m[1]+'"'))defs+=m[0];
 for(const name of ['60-icons.svg','61-icons.svg'])for(const m of fs.readFileSync(path.join(__dirname,name),'utf8').matchAll(/<symbol\b[^>]*id="(i-[^"]+)"[^>]*>[\s\S]*?<\/symbol>/g))defs=defs.replace(new RegExp('<symbol\\b[^>]*id="'+m[1]+'"[^>]*>[\\s\\S]*?<\\/symbol>'),()=>m[0]);
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:660,height:760}}),errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});await page.route(/^https?:/,r=>r.abort());
 await page.setContent(`<style>${css}</style><svg style="display:none">${defs}</svg><button id="trayBtn" type="button">托盘预览</button><div id="trayHost"></div>`);
 await page.addScriptTag({content:fs.readFileSync(path.join(work,'prototype.js'),'utf8').replace(/initProto\(\);\s*$/,'')});
 await page.evaluate(()=>{
   window.calls=[];window.hooks=[];window.XM={afterRender:fn=>hooks.push(fn),platformCapabilities:()=>({trayCapabilities:{available:S.os!=='linux'||S.linuxTrayOk}})};
   render=()=>hooks.forEach(fn=>fn());A.toast=(...args)=>calls.push(['toast',...args]);A.go=p=>calls.push(['go',p]);A.launch=id=>calls.push(['launch',id]);A.openAccount=tab=>calls.push(['account',tab]);A.dialog=kind=>calls.push(['dialog',kind]);
   document.getElementById('trayBtn').onclick=()=>document.getElementById('tray')?A.closeTray():A.openTray();
 });
 if(!before&&fs.existsSync(path.join(__dirname,'97-tray.js')))await page.addScriptTag({path:path.join(__dirname,'97-tray.js')});
 const reset=async(os,theme,ready=true)=>{await page.evaluate(({os,theme,ready})=>{A.closeTray();S=freshState(ready);S.os=os;S.theme=theme;S.settings.highContrast=false;S.linuxTrayOk=true;TOOL_ORDER=TOOL_ORDER_ALL.filter(id=>os!=='linux'||id!=='codexDesktop');window.calls=[];render();},{os,theme,ready});await page.locator('#trayBtn').click();};
 if(before){for(const theme of ['light','dark']){await reset('win',theme);await page.locator('#tray').screenshot({path:path.join(out,'before-'+theme+'.png')});}await reset('win','light',false);console.log(JSON.stringify(await page.evaluate(()=>({balancePrompt:document.querySelector('#tray').textContent.includes('登录查看余额'),theme:document.querySelector('#trayHost').dataset.theme||null,icon:getComputedStyle(document.querySelector('.tray-menu .i svg')).width}))));await browser.close();return;}
 const checks=[];
 for(const os of ['win','mac','linux'])for(const theme of ['light','dark']){
  await reset(os,theme);const v=await page.evaluate(()=>{const menu=document.querySelector('.tray-menu'),r=menu.getBoundingClientRect(),style=getComputedStyle(menu);return{theme:document.getElementById('trayHost').dataset.theme,bg:style.backgroundColor,text:style.color,font:style.fontSize,width:r.width,bounds:r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,balance:menu.querySelector('[data-tray-balance]')?.textContent,icons:[...menu.querySelectorAll('.i>svg,.i .ico svg')].map(x=>getComputedStyle(x).width),kbd:menu.querySelector('kbd')?.textContent};});
  assert.equal(v.theme,theme);assert.equal(v.bg,theme==='light'?'rgb(255, 255, 255)':'rgb(19, 32, 57)');assert.match(v.balance,/\$12\.40/);assert.equal(v.font,'13px');assert(v.bounds);assert(v.icons.every(x=>x==='16px'));assert(v.kbd.startsWith(os==='mac'?'⌘':'Ctrl+'));
  assert(await page.locator('#tray use').evaluateAll(a=>a.every(e=>document.querySelector(e.getAttribute('href')))));
  await page.locator('#tray').screenshot({path:path.join(out,os+'-'+theme+'.png')});checks.push(os+'-'+theme);
 }
 await reset('win','light',false);assert(await page.getByRole('menuitem',{name:'登录查看余额'}).isVisible());await page.getByRole('menuitem',{name:'登录查看余额'}).click();assert.deepEqual(await page.evaluate(()=>calls.at(-1)),['dialog','login']);checks.push('logged-out balance position');
 await reset('win','dark');await page.evaluate(()=>{S.user.balance=null;render();});assert.equal(await page.locator('[data-tray-balance]').textContent(),'—');checks.push('unknown is not zero');
 await page.evaluate(()=>{S.user.balance=0;render();});assert.equal(await page.locator('[data-tray-balance]').textContent(),'$0.00');await page.evaluate(()=>{S.user.balance=987.65;render();});assert.equal(await page.locator('[data-tray-balance]').textContent(),'$987.65');checks.push('live balance refresh');
 await reset('win','light');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'打开星芒');await page.keyboard.press('ArrowDown');assert.match(await page.evaluate(()=>document.activeElement.textContent),/Claude Code/);await page.keyboard.press('Enter');assert.deepEqual(await page.evaluate(()=>calls.at(-1)),['launch','claude']);checks.push('keyboard launch');
 await reset('win','light');await page.keyboard.press('End');assert.equal(await page.evaluate(()=>document.activeElement.textContent.trim()),'退出星芒');await page.keyboard.press('Escape');assert.equal(await page.locator('#tray').count(),0);assert(await page.locator('#trayBtn').evaluate(e=>e===document.activeElement));checks.push('escape focus return');
 await reset('win','light');await page.getByRole('menuitem',{name:'充值',exact:true}).click();assert.deepEqual(await page.evaluate(()=>calls.at(-1)),['account','recharge']);
 await reset('win','light');await page.getByRole('menuitem',{name:'设置',exact:true}).click();assert.deepEqual(await page.evaluate(()=>calls.at(-1)),['go','settings']);checks.push('original shortcuts retained');
 await reset('win','light');await page.evaluate(()=>{S.settings.highContrast=true;render();});assert(await page.locator('#trayHost').evaluate(e=>e.classList.contains('hc')));await page.evaluate(()=>{S.theme='dark';render();});assert.equal(await page.locator('#trayHost').getAttribute('data-theme'),'dark');checks.push('live theme contrast');
 await page.evaluate(()=>{S.os='linux';S.linuxTrayOk=false;render();});assert.equal(await page.locator('#tray').count(),0);await page.locator('#trayBtn').click();assert.equal(await page.locator('#tray').count(),0);checks.push('no-tray fallback');
 await page.setViewportSize({width:420,height:360});await reset('win','light');assert(await page.locator('.tray-menu').evaluate(e=>{const r=e.getBoundingClientRect();return r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;}));checks.push('small viewport scroll');
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);const report={scope:'isolated component, not user tab or native tray',checks,passed:checks.length,errors,requests};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
