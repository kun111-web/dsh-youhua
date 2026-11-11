// Layout and heatmap display rules adapted directly from zai-org/ZCode (Apache-2.0).
import { addDayTokenBreakdown, shiftDay } from '../aggregate.js';
export const COLORS = ['#3997ff','#3cbd72','#7e57e7','#ff575f','#f5b642','#29b5bf'];
export const compact = n => new Intl.NumberFormat('zh-CN', { notation: n >= 10000 ? 'compact' : 'standard', maximumFractionDigits: n >= 10000 ? 1 : 0 }).format(n);
export const shortDate = date => `${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`;
export function duration(ms) {
  const minutes = Math.floor(ms / 60000);
  if (!minutes) return ms > 0 ? '不足 1 分钟' : '0 分钟';
  return [minutes >= 1440 ? `${Math.floor(minutes/1440)} 天` : '', minutes >= 60 ? `${Math.floor(minutes%1440/60)} 小时` : '', minutes%60 ? `${minutes%60} 分钟` : ''].filter(Boolean).join(' ');
}
export function windowData(snapshot, count) {
  const start = shiftDay(snapshot.today, 1-count);
  const included = snapshot.days.filter(d => d.date >= start && d.date <= snapshot.today);
  const tokenBreakdown = { unclassifiedTokens: 0 };
  for (const day of included) addDayTokenBreakdown(tokenBreakdown, day);
  const models = new Map();
  for (const day of included) for (const model of day.models) {
    const item = models.get(model.key) ?? {...model, tokens: 0}; item.tokens += model.tokens; models.set(model.key,item);
  }
  const ranked = [...models.values()].filter(m=>m.tokens>0).sort((a,b)=>b.tokens-a.tokens || a.key.localeCompare(b.key));
  const labelCounts = new Map();
  for (const m of ranked) labelCounts.set(m.model, (labelCounts.get(m.model)??0)+1);
  ranked.forEach((m,i)=> { m.series = `m${i}`; m.color=COLORS[i%COLORS.length]; m.label = labelCounts.get(m.model)>1 ? `${m.model} · ${m.provider}` : m.model; });
  const byDate = new Map(included.map(d=>[d.date,d]));
  const rows = Array.from({length:count},(_,i)=> {
    const date = shiftDay(start,i); const day=byDate.get(date);
    return {date, total:day?.tokens??0, ...Object.fromEntries(ranked.map(m=>[m.series,day?.models.find(v=>v.key===m.key)?.tokens??0]))};
  });
  return {models:ranked, rows, total:included.reduce((sum,d)=>sum+d.tokens,0), tokenBreakdown};
}
export function heatmap(snapshot, mode) {
  const endSunday = shiftDay(snapshot.today, -new Date(snapshot.today+'T00:00:00Z').getUTCDay());
  const first = shiftDay(endSunday,-51*7); const byDate=new Map(snapshot.days.map(d=>[d.date,d]));
  const weeks=Array.from({length:52},(_,w)=>Array.from({length:7},(_,d)=> {
    const date=shiftDay(first,w*7+d); return {date,tokens:byDate.get(date)?.tokens??0,turns:byDate.get(date)?.turns??0,tools:byDate.get(date)?.tools??0,future:date>snapshot.today};
  }));
  let running=0;
  const values=weeks.map(week=> {const total=week.reduce((n,d)=>n+d.tokens,0);running+=total;return mode==='cumulative'?running:total;});
  const max=mode==='daily'?Math.max(0,...weeks.flat().map(d=>d.tokens)):Math.max(0,...values);
  const columns=weeks.map((week,i)=> {
    const value=values[i]; const height=max>0?Math.ceil(value/max*7):0;
    return { month:(week.find(d=>d.date.endsWith('-01'))??week[0]).date.slice(0,7), cells:week.map((d,r)=> {
      const n=mode==='daily'?d.tokens:value;
      return {...d,future:mode==='daily'&&d.future,level:mode==='daily'?(d.future?0:n>0?Math.min(4,Math.max(1,Math.ceil(n/max*4))):0):(r>=7-height?Math.min(4,Math.max(1,Math.ceil(n/max*4))):0),
        title:mode==='daily'?`${d.date} · ${compact(d.tokens)} tokens · ${d.turns} 轮 · ${d.tools} 次工具`:`${week[0].date} 当周${mode==='cumulative'?'及之前累计':''} · ${compact(n)} tokens`};
    })};
  });
  const months=[];
  for(const column of columns) {const last=months.at(-1); if(last?.month===column.month) last.span++; else months.push({month:column.month,span:1});}
  months.forEach((month,index)=>{month.show=index>=months.length-12;});
  // Keep the same 52-column month ruler as ZCode, suppressing clipped edge labels.
  return {columns,months};
}
