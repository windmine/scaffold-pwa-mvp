import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { reportSelfEmailStatus, reportSubmissionState, reportSubmissionReceipt } from '../assets/js/report-status.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const origin = 'http://127.0.0.1:59943';
const output = path.join(root, 'output/report-status.local');
const markup = `<!doctype html><html lang="en-NZ"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/assets/css/styles.css"></head><body class="report-only-mode"><main style="width:100%;max-width:1000px;margin:auto;padding:12px;box-sizing:border-box"><h1>My Reports</h1><div id="historyList" class="records-list"></div><div id="detailList"></div><div hidden><div id="workerSummary"></div><input id="historySearchInput"><select id="historyTypeFilter"><option value="form">Form</option></select><select id="historyStatusFilter"><option value=""></option></select><input id="historyDateFilter" type="date"><span id="historyResultCount"></span><button id="refreshHistoryButton">Refresh</button><button id="clearHistoryFiltersButton">Clear filters</button></div><button id="language" data-language-toggle>Language</button><template id="recordTemplate"><article class="record-card"><div class="record-header"><div><h3 class="record-title"></h3><p class="record-meta"></p></div><span class="badge"></span></div><p class="record-detail"></p><div class="record-extra"></div><div class="record-actions hidden"></div></article></template></main></body></html>`;
const receipt = { backendRecordId: 71, syncStatus: 'synced', pdfEmailSelf: { status: 'pending' } };
assert.equal(reportSubmissionState(receipt).key, 'submitted');
for (const record of [{}, {syncStatus:'synced'}, {backendRecordId:71}, {...receipt, isDraftRecovery:true}]) assert.notEqual(reportSubmissionState(record).key, 'submitted');
for (const state of ['queued','syncing']) assert.match(reportSubmissionReceipt({...receipt,backendRecordId:null,syncStatus:state}), /not yet confirmed/);
for (const state of ['pending','accepted','failed','uncertain','unknown','unrecognized']) {
  const text=reportSelfEmailStatus({status:state,recipient:'secret@example.invalid',deliveries:[{recipient:'private@example.invalid'}],failure_code:'secret'});
  assert.doesNotMatch(text,/secret|private|@/);
  if(state==='accepted') assert.match(text,/Inbox delivery is unconfirmed/);
}
console.log('ok - state model requires a server receipt and never equates queued or SMTP acceptance with delivery');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block'});
context.setDefaultTimeout(6000);
let backend=[]; let unavailable=false; let pending;
await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  assert.equal(url.origin,origin,'No external requests permitted');
  if(url.pathname==='/') return route.fulfill({contentType:'text/html',body:markup});
  if(url.pathname==='/api/my-form-submissions') {
    assert.equal(route.request().method(),'GET');
    if(pending) await pending;
    if(unavailable) return route.abort('failed');
    return route.fulfill({contentType:'application/json',body:JSON.stringify(backend)});
  }
  if(url.pathname==='/favicon.ico') return route.fulfill({status:204});
  assert.match(url.pathname,/^\/assets\/(js\/[a-z0-9-]+\.js|css\/styles\.css)$/);
  return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:await readFile(path.join(root,url.pathname),'utf8')});
});
const page=await context.newPage(); const errors=[];
page.on('pageerror',e=>errors.push(e.message));
async function setup() {
  await page.goto(origin);
  await page.evaluate(async()=>{
    const {createHistoryModule}=await import('/assets/js/history.js');
    const storage=await import('/assets/js/db.js');
    const i18n=await import('/assets/js/i18n.js');
    const els=Object.fromEntries([...document.querySelectorAll('[id]')].map(n=>[n.id,n]));
    const worker={id:12,departmentId:3,role:'worker',status:'active'};
    localStorage.setItem('geo_user',JSON.stringify(worker));
    const state={user:worker,historyRecords:[],sites:[]};
    const module=createHistoryModule({els,state,reportOnly:true,photoViewer:{closeForSources:()=>{}},renderStatusBanner:()=>{},handleSessionExpired:()=>{state.user=null;module.resetSession();},canWorkerEditRecord:()=>false});
    const base={id:'form-71',backendRecordId:71,type:'form',userId:12,departmentId:3,submissionPurpose:'report',formName:'Inspection',workDate:'2026-11-11',createdAt:'2026-11-11T00:00:00Z',syncStatus:'synced',source:'backend',fields:[],answers:{},photoUrls:[]};
    const render=(overrides={})=>{state.historyRecords=[{...base,...overrides}];module.renderFilteredHistory();};
    window.fixture={els,worker,state,module,storage,i18n,base,render};
    i18n.initLanguageToggle({button:els.language});
    module.bindEvents();
  });
}
try {
  await setup();
  assert.equal(await page.evaluate(() => window.fixture.i18n.translateText('Syncing', 'zh')), '正在同步');
  for(const state of ['pending','accepted','failed','uncertain','unknown']) {
    await page.evaluate(status=>window.fixture.render({pdfEmailSelf:{status},pdfEmail:{status:'accepted',recipient:'private@example.invalid',deliveries:[{recipient:'secret@example.invalid',status:'failed'}]}}),state);
    const card=page.locator('#historyList');
    assert.equal(await card.locator('.badge').innerText(),'Submitted');
    assert.match(await card.locator('.report-submission-receipt').innerText(),/#71/);
    assert.doesNotMatch(await card.innerText(),/@|private|secret/);
    assert.equal(await card.locator('.report-pdf-email-status').count(),0);
    if(state==='accepted') assert.match(await card.innerText(),/Inbox delivery is unconfirmed/);
    await card.getByRole('button',{name:'Show details',exact:true}).click();
    assert.equal(await card.locator('.report-submission-receipt').count(),1,'Receipt not repeated in expanded card');
    await card.locator('.record-report-more-details summary').click();
    assert.match(await card.locator('.record-report-more-details').innerText(),/Report number: #71/);
  }
  console.log('ok - all own-copy mail outcomes are visible on compact receipts, with no other recipients or duplicate details');
  for(const state of ['queued','syncing']) {
    await page.evaluate(syncStatus=>window.fixture.render({source:'local',backendRecordId:null,syncStatus,pdfEmailSelf:{status:'accepted'}}),state);
    assert.doesNotMatch(await page.locator('#historyList').innerText(),/mail server|Inbox delivery/);
    assert.match(await page.locator('#historyList .record-report-cue').innerText(),/not yet confirmed/);
    assert.equal(await page.locator('#historyList .badge').innerText(),state==='queued'?'Waiting to sync':'Syncing');
  }
  await page.evaluate(()=>window.fixture.render({backendRecordId:null,syncStatus:'queued',isDraftRecovery:true}));
  assert.equal(await page.locator('#historyList .badge').innerText(),'Saved on this device');
  for(const who of [{userId:13},{departmentId:4}]) {
    await page.evaluate(v=>window.fixture.render(v),who);
    assert.equal(await page.locator('#historyList .record-card').count(),0);
  }
  console.log('ok - queued, interrupted and recovery copies do not claim submission/email; account and Department isolation preserved');
  await page.evaluate(async()=>{
    const {storage,base}=window.fixture;
    await storage.put('records',{...base,id:'local-retry',backendRecordId:null,source:'local',ownerWorkerId:12,ownerRole:'worker',clientSubmissionId:'same-submit',syncStatus:'queued',capturedAnswers:{answer:'original'},answers:{answer:'original'}});
    await storage.put('queue',{id:'local-retry',type:'form'});
  });
  unavailable=true;
  await page.evaluate(()=>window.fixture.module.renderHistory());
  assert.equal(await page.locator('#historyList .badge').innerText(),'Waiting to sync');
  await setup(); // real IndexedDB survives restart of the document
  await page.evaluate(()=>window.fixture.module.renderHistory());
  assert.equal(await page.locator('#historyList .badge').innerText(),'Waiting to sync');
  unavailable=false;
  backend=[{id:71,worker_id:12,department_id:3,form_id:4,form_name:'Inspection',submission_purpose:'report',work_date:'2026-11-11',created_at:'2026-11-11T00:00:00Z',client_submission_id:'same-submit',fields:[],answers:{answer:'original'},photo_urls:[],pdf_email_self:{status:'pending'}}];
  await page.evaluate(()=>window.fixture.module.renderHistory());
  assert.equal(await page.locator('#historyList .record-report-compact').count(),1);
  assert.equal(await page.locator('#historyList .badge').innerText(),'Submitted');
  assert.equal(await page.evaluate(async()=>(await window.fixture.storage.get('queue','local-retry')).id),'local-retry');
  assert.equal(await page.evaluate(async()=>(await window.fixture.storage.get('records','local-retry')).capturedAnswers.answer),'original');
  backend[0].pdf_email_self.status='accepted';
  await page.evaluate(()=>window.fixture.module.renderHistory());
  assert.match(await page.locator('#historyList').innerText(),/Inbox delivery is unconfirmed/);
  console.log('ok - no-network restart preserves queue, reconnect reconciles a lost POST response once, and mail status refreshes without rewriting queued evidence');
  let release;
  pending=new Promise(resolve=>{release=resolve;});
  await page.evaluate(()=>{window.fixture.refresh=window.fixture.module.renderHistory();});
  await page.evaluate(()=>{window.fixture.state.user={id:99,departmentId:4,role:'worker'};window.fixture.module.resetSession();});
  release();pending=null;
  await page.evaluate(()=>window.fixture.refresh);
  assert.equal(await page.locator('#historyList .record-card').count(),0);
  await page.evaluate(()=>{window.fixture.state.user=window.fixture.worker;});
  for(const [width,language,theme] of [[320,'en','light'],[390,'zh','dark'],[1200,'en','light']]) {
    await page.setViewportSize({width,height:900});
    await page.evaluate(({language,theme})=>{
      document.documentElement.dataset.theme=theme;
      window.fixture.i18n.setLanguage(language);
      window.fixture.render({pdfEmailSelf:{status:'uncertain'}});
      window.fixture.i18n.applyLanguage();
    },{language,theme});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No horizontal overflow');
    if(language==='zh') assert.doesNotMatch(await page.locator('.report-submission-receipt').innerText(),/Your PDF email|Do not submit/);
    await page.screenshot({path:path.join(output,`receipt-${width}-${language}-${theme}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  console.log('ok - late responses cannot cross accounts; mobile/desktop English/Chinese light/dark receipts have no overflow');
} finally { await context.close();await browser.close(); }
