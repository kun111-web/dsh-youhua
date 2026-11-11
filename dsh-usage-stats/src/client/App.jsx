/** Direct adaptation of ZCode's AppUsagePanel layout; see NOTICE.md. */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RefreshCcw, BarChart3, Download, AlertCircle } from 'lucide-react';
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell } from 'recharts';
import { compact, duration, heatmap, windowData, shortDate } from './model.js';

const ENDPOINT='/api/dsh-usage-stats-local/snapshot';
const TOKEN_LABELS = [
  ['inputTokens', '未缓存输入'],
  ['outputTokens', '输出'],
  ['cacheReadTokens', '缓存读取'],
  ['cacheWriteTokens', '缓存写入'],
];
const exactTokens = new Intl.NumberFormat('zh-CN');
export async function loadSnapshot(signal) {
  const response=await fetch(ENDPOINT,{signal,headers:{'x-dsh-usage-stats':'1',accept:'application/json'}});
  if(!response.ok) throw new Error(`读取失败（HTTP ${response.status}）`);
  const result=await response.json();
  if(!result.ok) throw new Error(result.error??'读取失败');
  return result;
}
function Switch({label,options,value,onChange}) {
  return <div className="dus-switch" role="group" aria-label={label}>{options.map(([key,text])=><button key={key} type="button" aria-pressed={key===value} onClick={()=>onChange(key)}>{text}</button>)}</div>;
}
function NumberSummary({summary}) {
  const values=[['累计 Token 数',compact(summary.totalTokens).replace(/(?<=\d)(?=[万亿])/u,' '),'已记录的历史 Token 总量，含已删除会话'],['峰值 Token 数',compact(summary.peakDayTokens).replace(/(?<=\d)(?=[万亿])/u,' '),'单个自然日的最高 Token 用量'],['最长聊天时长',duration(summary.longestSessionMs),'单会话首末活动跨度，包含等待时间'],['当前连续天数',`${summary.currentStreakDays} 天`,'持续到今天或昨天的使用天数'],['最长连续天数',`${summary.longestStreakDays} 天`,'历史记录中连续有 Token 使用的最长天数']];
  return <section className="dus-summary" aria-label="累计摘要">{values.map(([label,value,hint])=><div key={label} className="dus-metric" title={hint}><strong>{value}</strong><span>{label}</span></div>)}</section>;
}
function TokenBreakdown({data}) {
  const breakdown = data.tokenBreakdown;
  return <section className="dus-card" aria-label="Token 明细">
    <h3>Token 明细</h3>
    {data.total === 0 ? <p className="dus-token-note">此时间范围内暂无用量</p> : <>
      <dl className="dus-token-split">
        {TOKEN_LABELS.map(([field, label]) => {
          const amount = breakdown[field];
          const exact = amount === undefined ? '无可用记录' : `${exactTokens.format(amount)} Token`;
          return <div key={field} title={exact}>
            <dt>{label}</dt>
            <dd aria-label={exact}>{amount === undefined ? '—' : compact(amount)}</dd>
          </div>;
        })}
      </dl>
      <p className="dus-token-note">
        {breakdown.unclassifiedTokens > 0 && <span>未拆分 {exactTokens.format(breakdown.unclassifiedTokens)} Token，仍计入总量。 </span>}
        <span>分项按日志可核对的记录汇总，— 表示该项无可用记录。</span>
      </p>
    </>}
  </section>;
}
function Activity({snapshot}) {
  const [mode,setMode]=useState('daily'); const grid=useMemo(()=>heatmap(snapshot,mode),[snapshot,mode]);
  return <section className="dus-card"><div className="dus-section-head"><h3>Token 活动</h3><Switch label="热力图模式" options={[["daily","每日"],["weekly","每周"],["cumulative","累计"]]} value={mode} onChange={setMode}/></div>
    <div className="dus-heatmap" role="img" aria-label={`过去 52 周 Token 活动，${mode==='daily'?'每日':mode==='weekly'?'每周':'累计'}模式`}>{grid.columns.map((column,i)=><div className="dus-week" key={i}>{column.cells.map(cell=><div key={cell.date} className="dus-cell" data-level={cell.level} data-future={cell.future||undefined} title={cell.title}/>)}</div>)}</div>
    <div className="dus-months">{grid.months.map(m=><span key={m.month} style={{gridColumn:`span ${m.span}`}}>{m.show&&m.span>=2?`${Number(m.month.slice(5))}月`:''}</span>)}</div>
  </section>;
}
function TrendTip({active,payload,label}) {
  if(!active||!payload?.length)return null;
  const entries=payload.filter(p=>p.value>0); const total=entries.reduce((n,p)=>n+p.value,0);
  return <div className="dus-tooltip"><strong>{shortDate(label)} · {compact(total)} tokens</strong>{entries.map(p=><div key={p.dataKey}><span><i style={{background:p.color}}/>{p.name}</span><span>{compact(p.value)} tokens</span></div>)}</div>;
}
function Trend({data}) {
  const [hidden,setHidden]=useState(new Set());
  return <section className="dus-card"><h3>每日 Token 趋势图</h3>
    <div className="dus-legend">{data.models.map(m=><button type="button" key={m.key} aria-pressed={!hidden.has(m.key)} title={`${m.label}：${compact(m.tokens)} tokens，点击切换显示`} onClick={()=>setHidden(old=>{const next=new Set(old);next.has(m.key)?next.delete(m.key):next.add(m.key);return next;})}><i style={{background:m.color}}/>{m.label}</button>)}</div>
    {data.total===0?<div className="dus-chart-empty">此时间范围内暂无用量</div>:<div className="dus-line"><ResponsiveContainer width="100%" height="100%"><LineChart data={data.rows} margin={{top:14,right:28,left:14,bottom:4}} accessibilityLayer>
      <CartesianGrid stroke="var(--dus-border)" strokeDasharray="3 5" vertical={false}/><XAxis dataKey="date" tickFormatter={shortDate} tick={{fill:'var(--dus-muted)',fontSize:11}} axisLine={false} tickLine={false} minTickGap={20}/><YAxis hide domain={[0,'auto']}/><Tooltip content={<TrendTip/>}/>
      {data.models.map(m=><Line key={m.key} dataKey={m.series} name={m.label} stroke={m.color} hide={hidden.has(m.key)} type="monotone" strokeWidth={2} dot={false} activeDot={{r:4}} isAnimationActive={false}/>)}
    </LineChart></ResponsiveContainer></div>}
  </section>;
}
function ModelUsage({data}) {
  return <section className="dus-card"><h3>模型用量</h3>{data.total===0?<div className="dus-chart-empty">此时间范围内暂无用量</div>:<div className="dus-models"><div className="dus-donut"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data.models} dataKey="tokens" nameKey="label" innerRadius="65%" outerRadius="90%" paddingAngle={data.models.length>1?2:0} stroke="none" isAnimationActive={false}>{data.models.map(m=><Cell key={m.key} fill={m.color}/>)}</Pie><Tooltip formatter={v=>[`${compact(Number(v))} tokens`,'用量']} contentStyle={{background:'var(--dus-tip)',border:'1px solid var(--dus-border)',borderRadius:10,color:'var(--dus-text)'}}/></PieChart></ResponsiveContainer><div className="dus-donut-center"><strong>{compact(data.total)}</strong><span>总 Token 数</span></div></div>
    <ul className="dus-model-list">{data.models.map(m=><li key={m.key}><span title={`${m.provider} / ${m.model}`}><i style={{background:m.color}}/>{m.label}</span><span>{compact(m.tokens)}</span><strong>{new Intl.NumberFormat('zh-CN',{style:'percent',maximumFractionDigits:1}).format(m.tokens/data.total)}</strong></li>)}</ul></div>}</section>;
}
export function App({loader=loadSnapshot,autoRefresh=true}) {
  const [snapshot,setSnapshot]=useState(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[range,setRange]=useState(7);
  const controller=useRef(null); const mounted=useRef(false);
  const refresh=useCallback(async()=>{
    controller.current?.abort(); const request=new AbortController();controller.current=request;setBusy(true);
    try{const value=await loader(request.signal);if(!request.signal.aborted&&mounted.current){setSnapshot(value);setError('');}}
    catch(e){if(!request.signal.aborted&&mounted.current)setError(e.message??String(e));}
    finally{if(!request.signal.aborted&&mounted.current)setBusy(false);}
  },[loader]);
  useEffect(()=>{mounted.current=true;refresh();const timer=autoRefresh?setInterval(()=>{if(document.visibilityState==='visible')refresh();},30000):null;
    return()=>{mounted.current=false;controller.current?.abort();clearInterval(timer);};},[refresh,autoRefresh]);
  const data=useMemo(()=>snapshot?windowData(snapshot,range):null,[snapshot,range]);
  function download(){const blob=new Blob([JSON.stringify(snapshot,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`dsh-usage-${snapshot.today}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  return <div className="dus-root" aria-busy={busy}><header className="dus-header"><div><h2>使用统计</h2><span className="dus-pill">应用用量</span></div><div className="dus-actions"><button type="button" aria-label="导出统计" title="导出统计 JSON" disabled={!snapshot} onClick={download}><Download size={17}/></button><button type="button" aria-label="刷新统计" title="刷新统计" disabled={busy} onClick={refresh}><RefreshCcw size={17} className={busy?'dus-spinning':''}/></button></div></header>
    {error&&<div className="dus-error" role="alert"><AlertCircle size={18}/><span>{error}{snapshot?'，以下保留上次成功结果。':''}</span><button type="button" onClick={refresh}>重试</button></div>}
    {!snapshot?<div className="dus-empty" role="status"><BarChart3 size={32}/><strong>{busy?'正在汇总本机用量…':'暂未读取到统计'}</strong><span>读取 DSH 本地会话记录</span></div>:<>
      <NumberSummary summary={snapshot.summary}/>
      {snapshot.coverage.skippedSessions>0||snapshot.coverage.invalidUsage>0?<div className="dus-error" role="status">统计不完整：{snapshot.coverage.skippedSessions} 个会话未能更新（已有用量保留），{snapshot.coverage.invalidUsage} 条异常用量已跳过。</div>:null}
      {snapshot.coverage.conflictingSessions>0&&<div className="dus-error" role="status">{snapshot.coverage.conflictingSessions} 个会话的日志与已保存的用量有分歧。核对前继续显示已有用量。</div>}
      <Activity snapshot={snapshot}/>
      <div className="dus-section-head dus-range"><h3>时间范围</h3><Switch label="统计时间范围" options={[[7,'近 7 日'],[30,'近 30 日']]} value={range} onChange={setRange}/></div>
      {snapshot.summary.totalTokens===0?<div className="dus-empty"><BarChart3 size={32}/><strong>暂无用量数据</strong><span>完成对话后，记录中的 Token 用量将在这里显示。</span></div>:<><TokenBreakdown data={data}/><Trend data={data}/><ModelUsage data={data}/></>}
      <footer className="dus-footer"><span>本机记录 · {snapshot.coverage.sessions} 个会话{snapshot.coverage.retainedSessions>0?`（含 ${snapshot.coverage.retainedSessions} 个仅保留用量的会话）`:""} · {snapshot.timeZone}</span><span>更新于 {new Date(snapshot.generatedAt).toLocaleString('zh-CN',{timeZone:snapshot.timeZone,hour12:false})}</span><details><summary>统计口径</summary><p>累计与峰值按已保存的历史用量统计，包含已删除会话；峰值指单日最高值。分叉继承的历史不重复计数。最长聊天时长为单会话首末活动跨度，包含等待；连续使用按有 Token 的自然日计算，可延续到昨天。近 {range} 日包含今天，曲线和模型占比使用同一范围。</p><p>未报告用量的 {snapshot.coverage.missingUsage} 条消息不估算。删除会话不会清除已保存的用量；彻底删除日志前会先保存最终用量。升级前已删除且未保存用量的历史无法凭空补回。此统计不是服务商账单。</p></details></footer>
    </>}
  </div>;
}
