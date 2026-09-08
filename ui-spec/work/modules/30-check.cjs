/* Browser-only prototype checks. Blocks every HTTP request; no native file or account operation. */
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require(process.env.XINGMANG_PLAYWRIGHT_MODULE || 'playwright');
(async () => {
  const root = path.resolve(__dirname, '../..');
  const html = process.argv[2] || path.join(root, 'xingmang-ui-spec/prototype/星芒AI管理工具-完整可交互原型-v2.html');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1520, height: 1100 } });
    const errors = [], passed = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(/^https?:/, route => route.abort());
    await page.goto(pathToFileURL(path.resolve(html)).href);
    if (!await page.evaluate(() => Boolean(window.XM))) await page.addScriptTag({ path: path.join(__dirname, '00-runtime.js') });
    if (!await page.evaluate(() => Boolean(window.XM?.extensions))) { await page.addStyleTag({ path: path.join(__dirname, '30-extensions.css') }); await page.addScriptTag({ path: path.join(__dirname, '30-extensions.js') }); }
    const reset = async () => page.evaluate(() => { S = freshState(true); S.view = 'app'; S.page = 'mcp'; S.os = 'win'; XM.extensions.state(); render(); });
    const done = async (status = 'success') => { await page.waitForFunction(s => S.ext30.op?.status === s, status, { timeout: 6000 }); };
    const check = async (name, fn) => { await reset(); await fn(); passed.push(name); };
    await check('all pages / three platforms / six scenes render', async () => {
      const count = await page.evaluate(() => { let count = 0; for (const os of ['win','mac','linux']) { S.os = os; for (const pageName of ['mcp','skills','plugins','backups','sessions']) for (const state of ['ready','loading','empty','filterEmpty','error','readonly']) { XM.scene(pageName, state); S.page = pageName; render(); const node = document.querySelector('#main'); if (!node?.textContent.trim()) throw Error(pageName + ' blank'); count++; } } return count; });
      assert.equal(count, 90);
    });
    await check('MCP validation, clean defaults and edit isolation', async () => {
      assert.equal(await page.evaluate(() => { A.mcpNew(); return dialogDirty(topDialog()); }), false);
      await page.evaluate(() => { S.form.mname = 'new-test'; S.form.mtarget = 'invalid'; A.mcpAdd(); });
      assert.match(await page.locator('[data-testid="form-error"]').innerText(), /完整服务地址/);
      await page.evaluate(() => { S.dialogs = []; S.form = {}; const row = S.mcp.claude[0]; A.mcpEdit(row.id); S.form.mname = 'edited-files'; S.mcpProv = 'codex'; A.mcpAdd(); });
      await done();
      assert.deepEqual(await page.evaluate(() => ({ count: S.mcp.claude.length, edited: S.mcp.claude[0].name, codex: S.mcp.codex[0].name })), { count:3, edited:'edited-files', codex:'filesystem' });
    });
    await check('Bearer requires environment variable name', async () => { await page.evaluate(() => { A.mcpNew(); Object.assign(S.form,{mname:'Bearer sample',mtarget:'https://example.com/mcp',mauth:'bearer',bearerEnv:'token-value-123'});A.mcpAdd(); }); assert.match(await page.locator('[data-testid="form-error"]').innerText(), /环境变量名称/); });
    await check('Transport change recomputes OAuth capability',async()=>{await page.evaluate(()=>{A.mcpEdit(1);Object.assign(S.form,{mtype:'http',mauth:'oauth',mtarget:'https://example.com/mcp'});A.mcpAdd();});await done();assert.equal(await page.evaluate(()=>S.mcp.claude[0].capability.oauth),true);await page.evaluate(()=>{A.ext30OperationClose();A.mcpOAuth(1);});assert.equal(await page.evaluate(()=>topDialog().type),'mcpOAuth');});
    await check('OAuth expiry, retry, login and logout', async () => {
      await page.evaluate(() => { A.ext30Scenario('mcpOAuth','expired'); A.mcpOAuth(2); A.mcpOAuthRun(); }); await done('error');
      assert.equal(await page.evaluate(() => S.mcp.claude[1].authState), 'expired');
      await page.evaluate(() => { A.ext30OperationClose(); A.mcpOAuthRun(); }); await done();
      assert.equal(await page.evaluate(() => S.mcp.claude[1].authState), 'signedIn');
      await page.evaluate(() => { A.ext30OperationClose(); A.mcpOAuth(2); A.mcpOAuthRun(); }); await done();
      assert.equal(await page.evaluate(() => S.mcp.claude[1].authState), 'signedOut');
    });
    await check('Cancelled operation does not commit and keeps form', async () => {
      await page.evaluate(() => { A.mcpNew(); Object.assign(S.form,{mname:'cancel-me',mtarget:'https://example.com/mcp'}); A.mcpAdd(); A.ext30Cancel(); A.ext30OperationClose(); });
      await page.waitForTimeout(1100);
      assert.equal(await page.evaluate(() => S.mcp.claude.some(x=>x.name==='cancel-me')), false);
      assert.equal(await page.evaluate(() => S.form.mname), 'cancel-me');
    });
    await check('Closed operation and reset reject late completion', async () => {
      await page.evaluate(() => { A.mcpToggle(1); A.closeDialog(); }); await page.waitForTimeout(1100);
      assert.equal(await page.evaluate(() => S.mcp.claude[0].enabled), true);
      await page.evaluate(() => { A.mcpToggle(1); S = freshState(true); XM.extensions.state(); render(); }); await page.waitForTimeout(1100);
      assert.equal(await page.evaluate(() => S.mcp.claude[0].enabled), true);
    });
    await check('Builtin skill purpose and source lifecycle', async () => {
      assert.deepEqual(await page.evaluate(() => { const labels=[]; labels.push(XM.extensions.builtinState('codex').label); S.tools.codex.source='official'; labels.push(XM.extensions.builtinState('codex').label); S.tools.codex.source='account'; labels.push(XM.extensions.builtinState('codex').label); S.user=null; labels.push(XM.extensions.builtinState('codex').label); return labels; }), ['已就绪','暂不可用','已就绪','待配置']);
      assert.equal(await page.evaluate(() => S.plugins.some(x=>x.name==='xingmang-ai')), false);
      assert.match(await page.evaluate(() => S.skills.find(x=>x.builtin).desc), /图片/);
    });
    await check('System readonly and capability guards apply to direct calls', async () => {
      const v = await page.evaluate(() => { const x=S.skills.find(x=>x.builtin);const n=S.skills.length;A.skillRemove(x.id);A.skillToggle(x.id);const p=S.plugins[0];p.capability.toggle=false;A.pluginToggle(p.id);XM.scene('mcp','readonly');A.mcpToggle(1);return {n:S.skills.length,expected:n,dialogs:S.dialogs.length,enabled:S.mcp.claude[0].enabled,plugin:p.enabled}; });
      assert.equal(v.n,v.expected);assert.equal(v.dialogs,0);assert.equal(v.enabled,true);assert.equal(v.plugin,true);
    });
    await check('Codex skill recycle and restore only', async () => {
      const id=await page.evaluate(() => { const x=S.skills.find(x=>x.provider==='codex'&&!x.builtin); A.skillRemove(x.id); A.confirmRun(); return x.id; }); await done();
      assert.equal(await page.evaluate(id=>S.ext30.trash.some(x=>x.id===id),id),true);
      await page.evaluate(id=>{A.ext30OperationClose();A.backupSkillRestore(id);A.confirmRun();},id);await done();
      assert.equal(await page.evaluate(id=>S.skills.some(x=>x.id===id)&&!S.ext30.trash.some(x=>x.id===id),id),true);
    });
    await check('Accurate file whitelist and redacted previews', async () => {
      assert.deepEqual(await page.evaluate(()=>XM.extensions.files),{claude:['settings.json'],codex:['config.toml','auth.json'],gemini:['settings.json','.env'],grok:['config.toml']});
      await page.evaluate(()=>{S.page='backups';A.backupPreview(S.backups.find(b=>b.tool==='codex').id);});
      const content=await page.locator('[data-testid="backup-detail"]').innerText();assert.match(content,/已隐藏/);assert.doesNotMatch(content,/sk-xm-/);
    });
    await check('Configuration module snapshots without fileNames remain restorable',async()=>{await page.evaluate(()=>{S.page='backups';S.backups.push({id:99999,tool:'codex',when:'刚刚',kind:'保存前',files:['~/.codex/config.toml','~/.codex/auth.json'],size:'2.6 KB'});A.backupRestore(99999);S.form.confirmed=true;A.backupRestoreRun();});await done();assert.equal(await page.evaluate(()=>S.backups.find(x=>x.id===99999).verification),'passed');});
    await check('Backup captures provider before asynchronous work', async()=>{
      await page.evaluate(()=>{S.page='backups';S.backupTool='claude';A.backupNow();S.form.confirmed=true;A.backupCreateRun();S.backupTool='grok';});await done();
      assert.deepEqual(await page.evaluate(()=>({p:S.backups[0].tool,files:S.backups[0].fileNames})),{p:'claude',files:['settings.json']});
    });
    await check('Repeated filenames cannot satisfy backup completeness',async()=>{await page.evaluate(()=>{S.page='backups';const b=S.backups.find(b=>b.tool==='codex');b.fileNames=['config.toml','config.toml'];A.backupRestore(b.id);S.form.confirmed=true;A.backupRestoreRun();});await done('error');assert.match(await page.locator('[data-testid="operation-error"]').innerText(),/缺少必需文件/);});
    await check('Readonly transition after confirmation blocks deletion',async()=>{const n=await page.evaluate(()=>{const n=S.backups.length;A.backupDelete(1);XM.scene('backups','readonly');A.confirmRun();return n;});await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>S.backups.length),n);});
    await check('Removed marketplace blocks installed plugin updates',async()=>{await page.evaluate(()=>{const x=S.plugins.find(x=>x.provider==='codex');S.markets=S.markets.filter(m=>m.provider!=='codex');A.pluginUpdate(x.id);});assert.equal(await page.evaluate(()=>S.ext30.op),null);assert.equal(await page.evaluate(()=>S.plugins.find(x=>x.provider==='codex').version),'1.0.0');});
    for (const failure of ['backupfail','missing','validation','failure','readback']) await check('Restore boundary '+failure, async()=>{
      const n=await page.evaluate(f=>{S.page='backups';const b=S.backups.find(b=>b.tool==='codex');A.ext30Scenario('backupRestore',f);A.backupRestore(b.id);S.form.confirmed=true;const n=S.backups.length;A.backupRestoreRun();return n;},failure);await done('error');
      assert.equal(await page.evaluate(()=>S.backups.length),n+(failure==='backupfail'?0:1));
      const text=await page.locator('[data-testid="operation-error"]').innerText();assert.doesNotMatch(text,/已回滚|配置恢复完成/);
    });
    await check('Restore success has prior snapshot and verified result',async()=>{await page.evaluate(()=>{S.page='backups';A.backupRestore(2);S.form.confirmed=true;A.backupRestoreRun();});await done();assert.equal(await page.evaluate(()=>S.backups[0].kind),'恢复前');assert.equal(await page.evaluate(()=>S.backups.find(x=>x.id===2).verification),'passed');});
    await check('Records paginate, search ID and gate archive',async()=>{
      await page.evaluate(()=>{S.page='sessions';A.ext30SessionPage(2);});assert.match(await page.locator('[data-testid="sessions-pagination"]').innerText(),/第 2/);
      const selected=await page.evaluate(()=>{const id=S.sessions.at(-1).id;A.ext30Search('sessions',String(id));return id;});assert.equal(await page.evaluate(()=>S.ext30.sessionPage),1);assert.equal(await page.locator('#list-sessions .sess').count(),1);assert.equal(await page.locator('#list-sessions .sess').getAttribute('data-testid'),'session-row-'+selected);
      await page.evaluate(()=>{A.ext30Clear('sessions');A.sessionArchive(1);});assert.equal(await page.evaluate(()=>S.dialogs.length),0);
      await page.evaluate(()=>{A.ext30Scenario('sessionCapability','missing');A.sessionArchive(2);});assert.equal(await page.evaluate(()=>S.dialogs.length),0);
      await page.evaluate(()=>{A.ext30Scenario('sessionCapability','ready');A.sessionArchive(2);A.confirmRun();});await done();assert.equal(await page.evaluate(()=>S.sessions.find(x=>x.id===2).archived),true);
    });
    await check('No result picker leaks into product dialogs',async()=>{await page.evaluate(()=>A.mcpOAuth(2));const text=await page.locator('.dialog').innerText();assert.doesNotMatch(text,/演示结果|授权成功|授权失败|开始授权演示/);});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed:passed.length,scenes:90,checks:passed,pageErrors:errors},null,2));
  } finally { await browser.close(); }
})().catch(e=>{console.error(e);process.exitCode=1;});
