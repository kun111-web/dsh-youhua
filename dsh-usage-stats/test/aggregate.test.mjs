import test from 'node:test';
import assert from 'node:assert/strict';
import { foldSession,summarizeSessions } from '../src/aggregate.js';
import { createCollector } from '../src/collector.js';
import { authorize,apply } from '../src/index.js';
import { heatmap,windowData } from '../src/client/model.js';
import { storageFixture } from './helpers/storage.mjs';
const now=Date.parse('2026-11-09T12:00:00+08:00');
const event=(seq,tokens=100,date='2026-11-09',model='demo')=>({seq,time:Date.parse(date+'T10:00:00+08:00'),type:'assistant/message',data:{usage:{totalTokens:tokens},message:{source:{provider:'test',model}}}});
test('使用报告总数；缺省时才汇总互斥桶，负值和缺失不估算',()=>{
  const a=event(0);a.data.usage={inputTokens:70,outputTokens:10,cacheReadTokens:20,totalTokens:100};
  const b=event(1);b.data.usage={inputTokens:5,outputTokens:3,cacheWriteTokens:2};
  const bad=event(2);bad.data.usage={inputTokens:-2};
  const missing=event(3);delete missing.data.usage;
  const fold=foldSession([a,b,b,bad,missing]);assert.equal(fold.days[0].tokens,110);assert.equal(fold.invalidUsage,1);assert.equal(fold.missingUsage,1);
  assert.deepEqual(fold.days[0].tokenBreakdown, {
    unclassifiedTokens: 0, inputTokens: 75, outputTokens: 13, cacheReadTokens: 20, cacheWriteTokens: 2,
  });
});
test('部分拆分、总量冲突和旧摘要按范围汇总，保留未知用量', () => {
  const partial = event(0);
  partial.data.usage = { inputTokens: 80, outputTokens: 20, totalTokens: 120 };
  const inconsistent = event(1);
  inconsistent.data.usage = { inputTokens: 90, outputTokens: 20, totalTokens: 100 };
  const current = foldSession([partial, inconsistent]);
  const legacy = foldSession([event(2, 35, '2026-10-27')]);
  delete legacy.days[0].tokenBreakdown;

  const snapshot = summarizeSessions([current, legacy], { now });
  assert.equal(snapshot.summary.totalTokens, 255);
  assert.deepEqual(windowData(snapshot, 7).tokenBreakdown, { inputTokens: 80, outputTokens: 20, unclassifiedTokens: 120 });
  assert.deepEqual(windowData(snapshot, 30).tokenBreakdown, { inputTokens: 80, outputTokens: 20, unclassifiedTokens: 155 });
});
test('只统计本分支新产生事件，不重复继承历史',()=>{
 const fold=foldSession([event(0,500),event(1,100)],{inheritedEventCount:1});assert.equal(fold.days[0].tokens,100);
});
test('同 turn/step 不同 seq 的独立请求保留；stream 不重复计入',()=>{
 const a=event(0),b=event(2);a.data.turn=b.data.turn=0;a.data.step=b.data.step=0;
 const fold=foldSession([a,{...a,seq:1,type:'assistant/attempt'},b]);assert.equal(fold.days[0].tokens,200);
});
test('跨时区自然日和连续天数，当前范围锚定今天',()=>{
 const snap=summarizeSessions([foldSession([event(0,10,'2026-11-07'),event(1,20,'2026-11-08')])],{now});
 assert.equal(snap.summary.currentStreakDays,2);assert.equal(snap.summary.longestStreakDays,2);assert.equal(snap.summary.peakDayTokens,20);
 const data=windowData(snap,7);assert.equal(data.rows[0].date,'2026-11-03');assert.equal(data.rows.at(-1).date,'2026-11-09');assert.equal(data.rows.at(-1).total,0);
 const crossing=event(0);crossing.time=Date.parse('2026-11-08T17:00:00Z');assert.equal(foldSession([crossing]).days[0].date,'2026-11-09');
});
test('同名不同供应商分开，折线与占比总数一致',()=>{
 const a=event(0),b=event(1,200);b.data.message.source.provider='second';
 const snap=summarizeSessions([foldSession([a,b])],{now});const view=windowData(snap,30);
 assert.equal(view.models.length,2);assert.ok(view.models.every(m=>m.label.includes(' · ')));assert.equal(view.total,300);assert.equal(view.rows.reduce((s,r)=>s+r.total,0),300);
});
test('52 周 × 7 日，三种模式、空数据与未来日期',()=>{
 const snap=summarizeSessions([foldSession([event(0)])],{now});
 for(const mode of ['daily','weekly','cumulative']){const grid=heatmap(snap,mode);assert.equal(grid.columns.length,52);assert.equal(grid.columns.flatMap(c=>c.cells).length,364);assert.equal(grid.months.reduce((n,m)=>n+m.span,0),52);assert.ok(grid.columns.flatMap(c=>c.cells).filter(c=>c.future).every(c=>c.level===0));}
 assert.equal(heatmap(summarizeSessions([],{now}),'daily').columns.length,52);
 assert.ok(heatmap(snap,'daily').months.filter(m=>m.show).length<=12);
 assert.ok(heatmap(snap,'weekly').columns.at(-1).cells.some(c=>c.level>0),'本周聚合柱应可见，不应被未来日期空格裁掉');
});
test('缓存复用、失效、删除、异常会话提示、读句柄关闭',async()=>{
 let reads=0,closes=0,revision=1,fail=false,deleted=false;
 const storage={list:async()=>deleted?[]:[{header:{id:'s'},revision}],open:async()=>({inheritedEventCount:1,read:async()=>{reads++;if(fail)throw Error('broken');return {events:[event(0,999),event(1)]};},close:async()=>{closes++;}})};
 const collect=createCollector(storage,{now:()=>now});assert.equal((await collect()).summary.totalTokens,100);await collect();assert.equal(reads,1);assert.equal(closes,1);
 revision++;fail=true;const partial=await collect();assert.equal(partial.coverage.skippedSessions,1);assert.equal(partial.summary.totalTokens,100);assert.equal(closes,2);
 deleted=true;const retained=await collect();assert.equal(retained.coverage.sessions,1);assert.equal(retained.coverage.retainedSessions,1);assert.equal(retained.summary.totalTokens,100);
});
test('同时刷新合并扫描',async()=>{
 let calls=0;const c=createCollector({list:async()=>{calls++;await new Promise(r=>setTimeout(r,10));return[];}},{now:()=>now});await Promise.all([c(),c(),c()]);assert.equal(calls,1);
});
test('同源只读路由：拒绝外部地址、跨站来源和无标头请求',()=>{
 const req={method:'GET',socket:{remoteAddress:'127.0.0.1'},headers:{host:'127.0.0.1:19419','x-dsh-usage-stats':'1'}};assert.equal(authorize(req),200);
 assert.equal(authorize({...req,method:'POST'}),405);assert.equal(authorize({...req,socket:{remoteAddress:'10.0.0.1'}}),403);
 for(const headers of [{...req.headers,origin:'https://other.example'},{...req.headers,'sec-fetch-site':'cross-site'},{host:req.headers.host}])assert.equal(authorize({...req,headers}),403);
});
test('插件路由和持久化生命周期可卸载',async()=>{
 const storage=storageFixture();const cleanups=[];let route,disposed=false;
 await apply({storageDomain:storage.facility,sessionPersistence:{list:async()=>[]},effect:f=>{cleanups.push(f());},webServer:{register:r=>{route=r;return()=>{disposed=true;};}}});
 assert.equal(route.kind,'exact');assert.equal(route.path,'/api/dsh-usage-stats-local/snapshot');
 for(const cleanup of cleanups.reverse())await cleanup();assert.ok(disposed);assert.equal(storage.closed(),1);
});
