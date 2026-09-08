/* Bounded recovery-only checks. UI and transport outcomes are simulated; no HTTP or real auth. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const dir=__dirname,base=path.join(dir,'..'),queue=new Map();let timerId=0,written='',clipboardResolve;
const sandbox={console,URL,Date,Math,JSON,setTimeout:fn=>{const id=++timerId;queue.set(id,fn);return id;},clearTimeout:id=>queue.delete(id),document:{querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,documentElement:{style:{setProperty(){}}},activeElement:null},navigator:{clipboard:{writeText:async value=>{written=value;}}},window:null};
const context=vm.createContext(sandbox);context.window=context;
const run=source=>vm.runInContext(source,context);
run(fs.readFileSync(path.join(base,'prototype.js'),'utf8').replace(/\ninitProto\(\);\s*$/,''));
run('render=function(){};rerenderMain=function(){};rememberChatDraft=function(){};rememberDialogControls=function(){};focusRecord=function(){return null;};renderToasts=function(){};');
for(const name of ['00-runtime.js','10-onboarding.js','12-recovery.js'])run(fs.readFileSync(path.join(dir,name),'utf8'));
run('function recoveryHtml(){renderingDialog=topDialog();const html=DIALOGS.forgot();renderingDialog=null;return html;}');
const next=async()=>{const entry=queue.entries().next().value;if(!entry)return;queue.delete(entry[0]);await entry[1]();await Promise.resolve();};
const clear=()=>{queue.clear();run("S=freshState(false);S.dialogs=[];S.form={};");};
const inspect=source=>JSON.parse(run(`JSON.stringify(${source})`));
let count=0;const check=(name,fn)=>{fn();count++;console.log('PASS '+name);};
(async()=>{
  const parse=value=>inspect(`XM.parseRecoveryToken(${JSON.stringify(value)})`);
  for(const [name,input] of [['empty',' '],['internal whitespace','bad token'],['missing token','https://mail.example/reset?a=1'],['empty token','https://mail.example/reset?token=%20'],['duplicate token','https://mail.example/reset?token=a&token=b'],['fragment token','https://mail.example/reset#token=a'],['nonweb scheme','javascript:alert(1)']])check('reject '+name,()=>assert.ok(parse(input).error));
  check('trim raw token',()=>assert.equal(parse('  opaque-token  ').token,'opaque-token'));
  check('extract exact URL parameter once',()=>assert.equal(parse('https://mail.example/reset?email=a%40b.test&token=opaque%2Btoken%3D').token,'opaque+token='));
  clear();run("A.dialog('login');S.form.acc='parent@example.com';S.form.pw='old-password';S.form.addAccount=true;A.dialog('forgot');recoveryHtml()");
  check('initial email inherits parent login',()=>assert.equal(run('S.form.email'),'parent@example.com'));
  run("topDialog().recovery.fault='emailFailure';A.sendReset();A.sendReset()");
  check('send is busy and ignores double click',()=>{assert.equal(run('topDialog().recovery.sendState'),'sending');assert.equal(queue.size,1);});await next();
  check('send failure keeps address private and editable',()=>{assert.equal(run('S.form.email'),'parent@example.com');assert.match(run('topDialog().recovery.error'),/未完成/);assert.doesNotMatch(run('topDialog().recovery.error'),/未注册|不存在/);});
  run('A.sendReset()');await next();
  check('successful request has visible cooldown',()=>{assert.equal(run('topDialog().recovery.phase'),'token');assert.equal(run('topDialog().recovery.cooldown'),60);});
  run("A.recoveryInput('token','https://mail.example/reset?token=valid-token')");await next();
  check('cooldown decrements and preserves token',()=>{assert.equal(run('topDialog().recovery.cooldown'),59);assert.match(run('S.form.token'),/valid-token/);});
  run('A.resetPw()');while(run('topDialog().recovery.phase')!=='done')await next();
  check('password is initially hidden',()=>{assert.equal(run('topDialog().recovery.showPassword'),false);assert.ok(run('topDialog().recovery.newPassword'));});
  await run('A.recoveryCopy()');check('copy success follows resolved API write',()=>{assert.equal(run('topDialog().recovery.copyState'),'success');assert.match(written,/Demo/);});
  run('A.recoveryGoLogin()');
  check('return reuses parent login with reset email and context',()=>{assert.equal(run('S.dialogs.length'),1);assert.equal(run('topDialog().type'),'login');assert.equal(run('S.form.acc'),'parent@example.com');assert.equal(run('S.form.pw'),'');assert.equal(run('S.form.addAccount'),true);});
  clear();run("A.recoveryScenario('expired');A.resetPw()");await next();
  check('expired token cannot reset',()=>{assert.equal(run('topDialog().recovery.phase'),'token');assert.match(run('topDialog().recovery.error'),/过期/);});
  run('A.resetPw()');check('same expired token remains rejected',()=>assert.equal(run('topDialog().recovery.resetState'),'expired'));
  run("A.recoveryInput('token','new-token');A.resetPw()");await next();
  check('new token can retry after expiry',()=>assert.equal(run('topDialog().recovery.phase'),'done'));
  clear();run("A.recoveryScenario('resetFailure');A.resetPw()");await next();
  check('reset failure preserves input',()=>{assert.equal(run('S.form.token'),'demo-recovery-token');assert.equal(run('topDialog().recovery.resetState'),'failed');});run('A.resetPw()');await next();
  check('reset failure can retry',()=>assert.equal(run('topDialog().recovery.phase'),'done'));
  clear();run("A.recoveryScenario('clipboardFailure')");await run('A.recoveryCopy()');
  check('clipboard failure offers manual readonly selection',()=>{assert.equal(run('topDialog().recovery.copyState'),'failed');assert.equal(run('topDialog().recovery.manualCopy'),true);assert.match(run('recoveryHtml()'),/readonly rows="2"/);});
  clear();run("A.recoveryScenario('ready');A.sendReset();A.recoveryInput('email','changed@example.com')");await next();
  check('editing during request cancels stale email result',()=>{assert.equal(run('topDialog().recovery.phase'),'email');assert.equal(run('topDialog().recovery.sendState'),'idle');assert.equal(run('S.form.email'),'changed@example.com');});
  clear();run("A.recoveryScenario('ready');A.sendReset();A.closeDialog();A.dialog('forgot');recoveryHtml()");await next();
  check('closed dialog response cannot alter reopened modal',()=>{assert.equal(run('topDialog().recovery.phase'),'email');assert.equal(run('S.form.email||\'\''),'');});
  clear();run("A.recoveryScenario('ready');A.sendReset();S=freshState(false)");await next();
  check('session reset rejects old request callback',()=>assert.equal(run('S.dialogs.length'),0));
  console.log(JSON.stringify({stateChecks:count,HTTP:'none',clipboard:'stubbed API resolution'}));
  if(process.argv.includes('--browser'))await browserCheck();
})().catch(error=>{console.error(error);process.exitCode=1;});

async function browserCheck(){
  const {chromium}=require(process.env.XINGMANG_PLAYWRIGHT_MODULE||require.resolve('playwright',{paths:[process.cwd()]}));
  let html=fs.readFileSync(path.join(base,'integration-preview.html'),'utf8');
  const script=fs.readFileSync(path.join(base,'prototype.js'),'utf8').replace(/\ninitProto\(\);\s*$/,'')+'\n'+fs.readdirSync(dir).filter(x=>x.endsWith('.js')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n')+'\ninitProto();render();';
  const css=fs.readFileSync(path.join(base,'prototype.css'),'utf8')+'\n'+fs.readdirSync(dir).filter(x=>x.endsWith('.css')).sort().map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('\n');
  html=html.replace(/<script>[\s\S]*?<\/script>/,()=>'<script>'+script+'</script>').replace(/<style>[\s\S]*?<\/style>/,()=>'<style>'+css+'</style>');
  const browser=await chromium.launch({headless:true});
  try{
    const context=await browser.newContext({viewport:{width:1320,height:850},offline:true}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route(/^https?:/,r=>r.abort());await page.setContent(html,{waitUntil:'domcontentloaded'});
    await page.evaluate(()=>{timers.forEach(clearTimeout);S=freshState(false);S.os='win';render();A.dialog('login');S.form.acc='parent@example.com';S.form.pw='old-password';render();});
    await page.getByTestId('login-forgot').click();assert.equal(await page.getByTestId('recovery-email').inputValue(),'parent@example.com');
    await page.evaluate(()=>{topDialog().recovery.fault='emailFailure';});await page.getByTestId('recovery-send').click();assert.match(await page.getByTestId('recovery-send').innerText(),/正在发送/);await page.waitForTimeout(550);assert.match(await page.getByTestId('recovery-page').innerText(),/请求未完成/);
    await page.getByTestId('recovery-send').click();await page.waitForTimeout(550);await page.getByTestId('recovery-token').fill('https://mail.example/reset?token=browser-token');await page.getByTestId('recovery-parse').click();assert.match(await page.getByTestId('recovery-page').innerText(),/已从链接提取/);
    await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>topDialog().type),'confirm');await page.keyboard.press('Escape');assert.equal(await page.getByTestId('recovery-token').inputValue(),'https://mail.example/reset?token=browser-token');
    await page.getByTestId('recovery-reset').click();await page.waitForTimeout(580);assert.equal(await page.getByTestId('recovery-new-password').getAttribute('type'),'password');await page.getByTestId('recovery-show').click();assert.equal(await page.getByTestId('recovery-new-password').getAttribute('type'),'text');
    await page.evaluate(()=>{topDialog().recovery.fault='clipboardFailure';});await page.getByTestId('recovery-copy').click();assert.equal(await page.getByTestId('recovery-manual-password').getAttribute('readonly'),'');assert.match(await page.getByTestId('recovery-page').innerText(),/没有复制成功/);
    const selected=await page.getByTestId('recovery-manual-password').evaluate(el=>el.selectionStart===0&&el.selectionEnd===el.value.length);assert.equal(selected,true);
    await page.evaluate(()=>{const box=document.querySelector('#winbox');box.style.width='960px';box.style.height='560px';S.settings.uiScale='auto';render();});const fit=await page.getByTestId('recovery-go-login').evaluate(el=>{const r=el.getBoundingClientRect(),w=document.querySelector('#win').getBoundingClientRect();return r.bottom<=w.bottom+1&&r.right<=w.right+1;});assert.equal(fit,true);
    await page.getByTestId('recovery-go-login').click();assert.equal(await page.locator('[role="dialog"]').count(),1);assert.equal(await page.getByTestId('login-account').inputValue(),'parent@example.com');assert.equal(await page.getByTestId('login-password').inputValue(),'');
    await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>!!document.activeElement.closest('[role="dialog"]')),true);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browser:{sendRetry:true,linkParsing:true,dirtyEscape:true,draft:true,passwordReveal:true,clipboardFailure:true,manualSelection:true,parentLogin:true,tabTrap:true,smallWindow:fit,pageErrors:errors,HTTP:'none'}}));
  }finally{await browser.close();}
}
