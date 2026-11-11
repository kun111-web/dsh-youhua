import React from 'react';
import {createRoot} from 'react-dom/client';
import {App} from '../src/client/App.jsx';
import css from '../src/client/style.css';
const tag=document.createElement('style');tag.textContent=css;document.head.append(tag);
const params=new URLSearchParams(location.search);
const days = Array.from({ length: 60 }, (_, i) => {
  const date = new Date(Date.parse('2026-11-09T00:00:00Z') - i * 86400000).toISOString().slice(0, 10);
  const models = ['GLM-5.3-Flash', 'Hy4', 'deepseek-flash', 'GLM-5.3'].map((model, k) => ({
    key: String(k), provider: 'demo', model, tokens: i % 6 === 0 ? 0 : Math.round((Math.sin(i * .7 + k) + 1) * 800000 / (k + 1)),
  }));
  const tokens = models.reduce((sum, model) => sum + model.tokens, 0);
  const day = { date, tokens, turns: 8, tools: 23, models };
  if (i > 18) return day;
  const inputTokens = Math.floor(tokens * .18), outputTokens = Math.floor(tokens * .1);
  const cacheWriteTokens = Math.floor(tokens * .02);
  return { ...day, tokenBreakdown: {
    inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens: tokens - inputTokens - outputTokens - cacheWriteTokens,
    unclassifiedTokens: 0,
  } };
});
const fixture={ok:true,generatedAt:Date.parse('2026-11-09T12:00:00+08:00'),timeZone:'Asia/Shanghai',today:'2026-11-09',days,coverage:{sessions:12,skippedSessions:0,missingUsage:0,invalidUsage:0},summary:{totalTokens:500000000,peakDayTokens:210000000,longestSessionMs:5880000,currentStreakDays:0,longestStreakDays:4}};
const load=async()=>{
 if(params.has('error'))throw Error('演示：会话记录暂时无法读取');
 if(params.has('empty'))return{...fixture,days:[],summary:{totalTokens:0,peakDayTokens:0,longestSessionMs:0,currentStreakDays:0,longestStreakDays:0},coverage:{sessions:0,skippedSessions:0,missingUsage:0,invalidUsage:0}};
 if(params.has('demo'))return fixture;
 const res=await fetch('/local-data.json');if(!res.ok)throw Error('请先运行本机记录验证脚本');return res.json();
};
document.getElementById('notice').textContent=params.has('error')?'状态测试 · 模拟读取失败':params.has('empty')?'状态测试 · 模拟空记录':params.has('demo')?'样式演示 · 模拟数据，不代表实际用量':'本地预览 · 本机记录快照';
document.getElementById('theme').onclick=()=>document.documentElement.classList.toggle('light');
document.getElementById('width').onclick=()=>document.getElementById('panel').classList.toggle('narrow');
createRoot(document.getElementById('root')).render(<App loader={load} autoRefresh={false}/>);
