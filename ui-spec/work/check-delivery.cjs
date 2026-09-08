const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');const{pathToFileURL,fileURLToPath}=require('node:url');const{chromium}=require(process.env.XINGMANG_PLAYWRIGHT_MODULE||'playwright');
let browser;
(async()=>{
 const root=path.resolve(process.argv[2]||path.join(__dirname,'..')),out=path.resolve(process.argv[3]||path.join(__dirname,'delivery-check'));fs.mkdirSync(out,{recursive:true});
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],requests=[],missing=[],visited=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url());});await page.route(/^https?:/,r=>r.abort());
 const open=async rel=>{await page.goto(pathToFileURL(path.join(root,rel)).href);if(rel==='品牌素材（中文）/点这里开始.html')await page.waitForURL(/%E7%B4%A0%E6%9D%90%E5%9B%BE%E5%86%8C|素材图册/);await page.evaluate(()=>document.fonts.ready);visited.push(rel);};
 const localLinks=async()=>{const links=await page.locator('a[href]').evaluateAll(a=>a.map(e=>({raw:e.getAttribute('href'),url:e.href})));for(const l of links){if(!l.raw||l.raw.startsWith('#')||!l.url.startsWith('file:'))continue;const u=new URL(l.url);u.hash='';u.search='';const p=fileURLToPath(u);if(!fs.existsSync(p))missing.push({page:visited.at(-1),href:l.raw});}};
 const images=async()=>{await page.locator('img').evaluateAll(imgs=>{imgs.forEach(i=>i.loading='eager');return Promise.allSettled(imgs.map(i=>i.decode()));});const bad=await page.locator('img').evaluateAll(imgs=>imgs.filter(i=>!i.complete||!i.naturalWidth).map(i=>i.getAttribute('src')));assert.deepEqual(bad,[]);};
 await open('点这里开始.html');await images();await localLinks();await page.screenshot({path:path.join(out,'入口.png')});
 await page.getByRole('link',{name:'从欢迎页开始体验'}).click();assert(await page.getByRole('heading',{name:/让 AI 帮你/}).isVisible());assert.equal(await page.evaluate(()=>S.view),'welcome');await images();
 await open('xingmang-ui-spec/prototype/星芒AI管理工具-完整可交互原型-v2.html');assert.equal(await page.evaluate(()=>S.view),'app');assert(await page.locator('#win').isVisible());assert(await page.evaluate(()=>typeof A.canvasScenario==='function'&&typeof A.guideScene==='function'));await images();
 await open('xingmang-ui-spec/prototype/components.html');assert.equal(await page.locator('[data-component]').count(),45);await localLinks();await images();
 await open('xingmang-ui-spec/设计规范总览.html');assert.equal(await page.locator('article').count(),18);await localLinks();await page.getByRole('link',{name:/16 · v3.0 最终验证/}).click();assert(await page.locator('#doc-16').isVisible());assert.match(await page.locator('#doc-16').textContent(),/13组全部通过/);await page.screenshot({path:path.join(out,'规范.png')});
 await open('品牌素材（中文）/点这里开始.html');await images();await localLinks();const brandImages=await page.locator('img').count();assert.equal(brandImages,111);
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[]);assert.deepEqual(missing,[]);
 const report={checkedAt:new Date().toISOString(),root,visited,brandImages,documentCount:18,componentCount:45,errors,requests,missing};fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser.close();
})().catch(async e=>{console.error(e);if(browser)await browser.close();process.exitCode=1;});
