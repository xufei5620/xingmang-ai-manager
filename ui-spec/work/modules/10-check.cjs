/* Focused state-contract tests. Loads the offline source in a VM; no browser, network or installations. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const dir = __dirname;
const queue = new Map();
let clockId = 0;
const context = vm.createContext({ console, setTimeout: fn => { const id=++clockId;queue.set(id,fn);return id; }, clearTimeout: id=>queue.delete(id), Date, Math, JSON, document: { querySelector:()=>null, querySelectorAll:()=>[], getElementById:()=>null, documentElement:{style:{setProperty(){}}}, activeElement:null }, navigator:{}, window:null });
context.window=context;
const run = code=>vm.runInContext(code,context);
run(fs.readFileSync(path.join(dir,'..','prototype.js'),'utf8').replace(/\ninitProto\(\);\s*$/,''));
run('render=function(){};rerenderMain=function(){};rememberChatDraft=function(){};rememberDialogControls=function(){};focusRecord=function(){return null;};renderToasts=function(){};');
for(const name of ['00-runtime.js','10-onboarding.js','40-tools.js'])run(fs.readFileSync(path.join(dir,name),'utf8'));
run("XM.authComplete=function(user,meta){S._authHook={name:user.name,...meta};if(!S.accounts.some(a=>a.name===user.name))S.accounts.push({...user});};");
const drain=async()=>{for(let count=0;queue.size&&count<200;count++){const [id,fn]=queue.entries().next().value;queue.delete(id);await fn();await Promise.resolve();}assert.equal(queue.size,0,'pending timer queue should finish');};
const inspect=code=>JSON.parse(run(`JSON.stringify(${code})`));
let checks=0;
const check=(name,fn)=>{fn();checks++;console.log('PASS '+name);};
(async()=>{
  for(const name of Object.keys(inspect('XM.onboardingScenarios'))){run(`A.guideScene(${JSON.stringify(name)})`);const html=run("S.view==='welcome'?welcomeHtml():onboardHtml()");check('scene renders '+name,()=>assert.match(html,/data-testid/));}
  run("A.guideScene('installed')");
  check('desktop without Node advances',()=>{assert.equal(run('envReady()'),false);run('A.guideNext()');assert.equal(run('XM.onboardingState().step'),2);});
  run("A.guideScene('official');A.guideNext()");
  check('official source retained',()=>{assert.equal(run("XM.toolSource('codexDesktop')"),'official');assert.equal(run('XM.onboardingState().step'),3);});
  run("A.guideScene('unknown');A.guideNext()");
  check('unknown source opens configuration',()=>{assert.equal(run('topDialog().type'),'config');assert.equal(run("XM.toolSource('codexDesktop')"),'unknown');});
  run("A.guideScene('unknown');XM.setToolConfig('codexDesktop',{configured:true});A.guideNext()");
  check('unknown remains protected even when configured flag is true',()=>assert.equal(run('topDialog().type'),'config'));
  run("A.guideScene('linux')");
  check('Linux has CLI route without desktop requirement',()=>{assert.equal(run('XM.onboardingState().route'),'cli');assert.match(run('onboardHtml()'),/命令行/);});
  run("A.guideScene('detect-failed');A.guideDetect()");await drain();
  check('detect failure retries',()=>assert.equal(run('XM.onboardingState().status'),'checked'));
  run("A.guideScene('new');A.guideNext();A.guidePause()");await drain();
  check('late detection cannot reopen paused guide',()=>assert.equal(run('S.view'),'app'));
  run("A.guideScene('new');A.guideNext();A.guideScene('welcome')");await drain();
  check('reset isolates timer callbacks',()=>assert.equal(run('S.view'),'welcome'));
  run("A.guideScene('register-failed');Object.assign(S.form,{email:'new@example.com',sent:true,code:'123456',user:'new-demo',pw:'Pass12345',pw2:'Pass12345',agree:true});A.register()");await drain();
  check('register failure preserves values',()=>{assert.equal(run('S.form.user'),'new-demo');assert.equal(run('S.form.pw'),'Pass12345');assert.match(run('S.form.err'),/重试/);});
  run('A.register()');await drain();
  check('register retry automatically logs in',()=>{assert.equal(run('S.user.name'),'new-demo');assert.equal(run('S.view'),'onboard');assert.equal(run('S._authHook.registered'),true);assert.equal(run('S.dialogs.length'),0);});
  run("A.guideScene('auto-login-failed');Object.assign(S.form,{email:'retry@example.com',sent:true,code:'123456',user:'retry-demo',pw:'Pass12345',pw2:'Pass12345',agree:true});A.register()");await drain();
  check('automatic login failure prefills username',()=>{assert.equal(run('topDialog().type'),'login');assert.equal(run('S.form.acc'),'retry-demo');assert.equal(run('S.user'),null);});
  run("A.guideScene('welcome');A.dialog('login');Object.assign(S.form,{acc:'draft@example.com',pw:'keep-my-draft',agree:true});A.dialog('legal',{kind:'terms'});A.closeDialog()");
  check('legal dialog preserves parent draft',()=>{assert.equal(run('topDialog().type'),'login');assert.equal(run('S.form.pw'),'keep-my-draft');});
  run("A.guideAuthSwitch('register');Object.assign(S.form,{email:'switched@example.com',sent:true,code:'123456',user:'switched',pw:'Pass12345',pw2:'Pass12345',agree:true});A.register()");await drain();
  check('switching auth mode does not leave a stale login layer',()=>{assert.equal(run('S.dialogs.length'),0);assert.equal(run('S.view'),'onboard');});
  run("A.guideScene('installed');A.dialog('config',{tool:'codexDesktop'});S.form.manual='config-draft';A.dialog('login');Object.assign(S.form,{acc:'nested-demo',pw:'Pass12345',agree:true});A.login()");await drain();
  check('nested login returns to configuration draft',()=>{assert.equal(run('topDialog().type'),'config');assert.equal(run('S.form.manual'),'config-draft');});
  run("A.guideScene('installed');S.q.tutorial='no-such-section';A.guideTutorial('first')");
  check('tutorial jump clears incompatible search',()=>{assert.equal(run('S.page'),'tutorial');assert.equal(run('S.tutSection'),'first');assert.equal(run('S.q.tutorial'),'');});
  run("A.guideScene('installed');A.guidePause()");
  check('home keeps grid and avoids Node-gated setup',()=>{const html=run('homeHtml()');assert.match(html,/home-grid/);assert.doesNotMatch(run('setupCard()'),/一键安装 Node|所有 AI 编程工具都靠/);});
  console.log(JSON.stringify({passed:checks,network:'none',nativeOperations:'none'}));
  if(process.argv.includes('--browser'))await browserCheck();
})().catch(error=>{console.error(error);process.exitCode=1;});

async function browserCheck(){
  const {chromium}=require(process.env.XINGMANG_PLAYWRIGHT_MODULE||require.resolve('playwright',{paths:[process.cwd()]}));
  const base=path.join(dir,'..');
  let html=fs.readFileSync(path.join(base,'integration-preview.html'),'utf8');
  const modules=fs.readdirSync(dir).filter(x=>x.endsWith('.js')).sort();
  const script=fs.readFileSync(path.join(base,'prototype.js'),'utf8').replace(/\ninitProto\(\);\s*$/,'')+'\n'+modules.map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n')+'\ninitProto();render();';
  const css=fs.readFileSync(path.join(base,'prototype.css'),'utf8')+'\n'+fs.readdirSync(dir).filter(x=>x.endsWith('.css')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n');
  html=html.replace(/<script>[\s\S]*?<\/script>/,()=>'<script>'+script+'</script>').replace(/<style>[\s\S]*?<\/style>/,()=>'<style>'+css+'</style>');
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1580,height:1000},offline:true});
    const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:/,r=>r.abort());
    await page.setContent(html,{waitUntil:'domcontentloaded'});
    const sizes=[];
    for(const os of ['win','mac','linux'])for(const theme of ['dark','light'])for(const size of [[1280,820],[960,560]]){
      await page.evaluate(({os,theme,size})=>{S.os=os;S.theme=theme;S.settings.themePref=theme;S.layoutMode='fixed';S.settings.uiScale='auto';const box=document.querySelector('#winbox');box.style.width=size[0]+'px';box.style.height=size[1]+'px';A.guideScene('welcome');},{os,theme,size});
      const welcome=await page.locator('[data-testid="welcome-page"]').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,cta:!!el.querySelector('[data-testid="welcome-login"]')}));
      assert.equal(welcome.cta,true);
      const cut=await page.locator('[data-testid="welcome-help"]').evaluate(el=>{const r=el.getBoundingClientRect(),main=document.querySelector('#main').getBoundingClientRect();return r.bottom>main.bottom+1;});
      assert.equal(cut,false,`welcome footer clipped ${os}/${theme}/${size}`);
      await page.evaluate(()=>A.startOnboard());
      const guideFit=await page.getByTestId('onboarding-page').evaluate(el=>{const r=el.getBoundingClientRect(),a=el.querySelector('[data-testid="guide-next"]').getBoundingClientRect();return a.right<=r.right+1&&a.bottom<=r.bottom+1;});
      assert.equal(guideFit,true,`guide action clipped ${os}/${theme}/${size}`);
      sizes.push({os,theme,size: size.join('x'),welcome,guideFit});
    }
    await page.evaluate(()=>{S.os='win';A.guideScene('register-failed');});
    await page.getByTestId('register-email').fill('browser@example.com');
    await page.getByTestId('register-send-code').click();
    await page.getByTestId('register-code').fill('123456');
    await page.getByTestId('register-user').fill('browser-demo');
    await page.getByTestId('register-password').fill('Browser12345');
    await page.getByTestId('register-password-confirm').fill('Browser12345');
    await page.getByTestId('auth-terms').click();await page.keyboard.press('Escape');
    assert.equal(await page.getByTestId('register-password').inputValue(),'Browser12345');
    await page.getByTestId('auth-agree').check();
    await page.getByTestId('register-submit').click();await page.waitForTimeout(650);
    assert.match(await page.getByTestId('auth-error').innerText(),/重试/);
    assert.equal(await page.getByTestId('register-user').inputValue(),'browser-demo');
    await page.getByTestId('register-submit').click();await page.waitForTimeout(650);
    assert.equal(await page.getByTestId('onboarding-page').count(),1);
    await page.evaluate(()=>A.guideHelp('steps'));await page.keyboard.press('Tab');
    const trapped=await page.evaluate(()=>document.activeElement?.closest('[role="dialog"]')!==null);assert.equal(trapped,true);
    await page.keyboard.press('Escape');assert.equal(await page.locator('[role="dialog"]').count(),0);
    await page.evaluate(()=>{A.guideScene('welcome');S.settings.reduceMotion=true;render();});
    assert.equal(await page.locator('.xm-orbits b').evaluate(el=>getComputedStyle(el).animationName),'none');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browser:{sizeChecks:sizes.length,authRetry:true,draft:true,tabTrap:true,escape:true,reducedMotion:true,pageErrors:errors,network:'offline'}}));
  }finally{await browser.close();}
}
