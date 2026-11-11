import React, {useState,useEffect,useRef,useMemo} from 'react';
import { createPortal } from 'react-dom';
import {Archive,Trash2,RotateCcw,RefreshCw,Search,Check,X,Folder,AlertCircle} from 'lucide-react';
export async function api(action,body,{signal}={}){
 const response=await fetch('/api/dsh-archive-manager-local/'+action,{signal,method:body?'POST':'GET',headers:{'x-dsh-archive-manager':'1',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
 const data=await response.json();if(!response.ok)throw Error(data.error||'操作失败，请重试');return data;
}
const formatDate=value=>value?new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'时间未知';
const fileKind={log:'会话日志',copy:'聊天副本',cache:'会话缓存'};
const resultText = result => `已清理 ${result.deleted.length} 个会话 · 跳过 ${result.skipped.length} 个 · 未完成 ${result.failed.length} 个`;
const rootStatus = {available:'可访问',missing:'目录不存在',invalid:'路径异常',unreadable:'无法读取'};
const progressText = {queued:'正在等待当前操作完成',verifying:'正在复核会话和文件',deleting:'正在清理会话文件',finalizing:'正在同步搜索索引并复核结果'};

function resultDetails(result, items = []) {
 const titles = new Map(items.map(row=>[row.id,row.title]));
 return [...result.skipped,...result.failed].map(row=>({...row,title:titles.get(row.id)??row.id}));
}

export function useDeleteProgress(request) {
 const [progress,setProgress] = useState(null);
 const active = useRef(null);
 useEffect(()=>()=>active.current?.abort(),[]);
 async function commit(token) {
  const controller = new AbortController();
  const { signal } = controller;
  active.current = controller;
  let timer;
  async function poll() {
   if(signal.aborted)return;
   try {
    const value = await request('progress?token='+encodeURIComponent(token),undefined,{signal});
    if(!signal.aborted)setProgress(value);
   } catch {} finally {
    if(!signal.aborted)timer=setTimeout(poll,500);
   }
  }
  timer=setTimeout(poll,200);
  try {return await request('commit',{token,confirmed:true});}
  finally {
   clearTimeout(timer);
   if(!signal.aborted)setProgress(null);
   controller.abort();
   if(active.current===controller)active.current=null;
  }
 }
 return {progress,commit};
}

function UncheckedFiles({files}) {
 if (!files?.length) return null;
 return <details className="dam-scope"><summary>{files.length} 个备份文件无法核对归属，将保留</summary>{files.map(file=><small key={file}>{file}</small>)}</details>;
}

function BackupRoots({roots}) {
 if(!roots?.length)return null;
 const unavailable=roots.filter(root=>root.status!=='available').length;
 return <details className="dam-scope dam-backups" open={unavailable>0||undefined}>
  <summary>登记的备份目录 · {roots.length} 个{unavailable>0&&` · ${unavailable} 个不可用，暂停清理`}</summary>
  {roots.map(root=><small key={root.path}>{rootStatus[root.status]} · {root.path}</small>)}
 </details>;
}

export function DeleteDialog({confirm, title, busy, error, result, progress, onClose, onDelete, onRetry}) {
 const cancelButton = useRef(null), dialog = useRef(null);
 const heading = React.useId();
 const confirmedIds = new Set(confirm?.items.map(row=>row.id));
 const parentRetained = confirm?.items.some(row=>row.parentSession && !confirmedIds.has(row.parentSession));
 const includesChildren = confirm?.items.some(row=>row.parentSession && confirmedIds.has(row.parentSession));
 useEffect(()=>{cancelButton.current?.focus();},[confirm,result]);
 useEffect(()=>{if(busy)dialog.current?.focus();},[busy]);
 return createPortal(<div className="dam-root dam-overlay"><div className="dam-backdrop"><section ref={dialog} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={heading} className="dam-dialog" onKeyDown={event=>{
  if(event.key==='Escape'&&!busy){event.preventDefault();onClose();}
  if(event.key==='Tab'){
   const controls=[...event.currentTarget.querySelectorAll('button:not(:disabled),summary')].filter(control=>control.getClientRects().length);
   if(!controls.length){event.preventDefault();return;}
   if(document.activeElement===event.currentTarget){event.preventDefault();controls[event.shiftKey?controls.length-1:0].focus();return;}
   if(event.shiftKey&&document.activeElement===controls[0]){event.preventDefault();controls.at(-1).focus();}
   else if(!event.shiftKey&&document.activeElement===controls.at(-1)){event.preventDefault();controls[0].focus();}
  }
 }}>
  <div className="dam-dialog-icon"><Trash2 size={24}/></div>
  <h3 id={heading}>{result?'删除结果':confirm?`删除 ${confirm.count} 个会话？`:title?`删除 ${title}`:'删除会话'}</h3>
  {error&&<p className="dam-danger" role="alert">{error}</p>}
  {result&&<div role="status"><p>{resultText(result)}</p>{resultDetails(result,confirm?.items).map(row=><p key={row.id} title={row.id}>{row.title}：{row.reason}</p>)}</div>}
  {busy&&progress&&progressText[progress.phase]&&<div className="dam-progress" role="status">
   <span>{progressText[progress.phase]} · 已处理 {progress.processed}/{progress.total}</span>
   <progress aria-label="批量清理进度" value={progress.processed} max={progress.total}/>
  </div>}
  {!confirm&&!result&&!error&&<p role="status">正在核对会话和文件…</p>}
  {confirm&&!result&&<>
   {confirm.reviewRequired&&<p className="dam-hint" role="status">会话保存后，待清理范围有变化。请核对下方更新后的清单，再确认删除。</p>}
   <p>将清理下列会话的聊天日志、副本和缓存（约 {(confirm.bytes/1024/1024).toFixed(2)} MB）。此操作不能恢复，历史用量会保留。</p>
   <div className="dam-confirm-items">{confirm.items.map(row=><div key={row.id}><strong>{row.title}</strong><small>{row.parentSession?'子智能体 · ':''}{row.id}</small><details><summary>{row.files.length} 个待清理文件</summary>{row.files.map(file=><small key={file.path}>{fileKind[file.kind]??'文件'}：{file.path}</small>)}</details></div>)}</div>
   {includesChildren&&<p className="dam-hint">本次清理包含列表中父会话的关联子智能体。</p>}
   {parentRetained&&<p className="dam-hint">父会话里已收到的子智能体消息和历史引用会保留。</p>}
   <details className="dam-scope"><summary>检查范围</summary>{confirm.checkedRoots.map(root=><small key={root}>{root}</small>)}<p>同时检查对应的会话缓存。检查范围以外的备份、云端副本及共享附件会保留。</p></details>
   <BackupRoots roots={confirm.backupRoots}/>
   <UncheckedFiles files={confirm.uncheckedFiles}/>
   <p className="dam-hint">仅处理本次确认的文件。子智能体列表或文件发生变化时，请重新确认。</p>
   {confirm.blocked?.length>0&&<details className="dam-scope"><summary>另有 {confirm.blocked.length} 个会话未纳入</summary>
    {confirm.blocked.map(row=><small key={row.id} title={row.id}>{row.title??row.id}：{row.reason}</small>)}
   </details>}
  </>}
  <div className="dam-dialog-actions"><button ref={cancelButton} disabled={busy} onClick={onClose}>{result||(!confirm&&error)?'关闭':'取消'}</button>
   {onRetry&&(error||result?.failed.length>0||result?.skipped.length>0)&&<button disabled={busy} onClick={onRetry}>{result?'继续清理':'重新核对'}</button>}
   {confirm&&!result&&<button className="dam-delete" disabled={busy} onClick={onDelete}>{busy?'正在清理…':`确认删除 ${confirm.count} 个`}</button>}
  </div>
 </section></div></div>, document.body);
}

export function App({request=api}){
 const [data,setData]=useState(null),[search,setSearch]=useState(''),[selected,setSelected]=useState(new Set()),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(null),[confirm,setConfirm]=useState(null);
 const [subagents,setSubagents]=useState(false);
 const alive=useRef(true),locked=useRef(false),deleteTrigger=useRef(null);
 const {progress,commit}=useDeleteProgress(request);
 async function refresh(showSubagents=subagents){const next=await request(showSubagents?'list?subagents=1':'list');if(alive.current){setData(next);setSelected(old=>new Set([...old].filter(id=>next.items.some(r=>r.id===id))));}}
 useEffect(()=>{alive.current=true;refresh().catch(e=>setError(e.message));return()=>{alive.current=false;};},[]);
 const rows=data?.items??[];
 const filter=search.trim().toLowerCase();
 const visible=useMemo(()=>rows.filter(row=>(row.title+' '+row.workspace+' '+row.id).toLowerCase().includes(filter)),[rows,filter]);
 const chosen=visible.filter(r=>selected.has(r.id));
 const hiddenSelected=selected.size-chosen.length;
 async function run(fn){if(locked.current)return;locked.current=true;setBusy(true);setError('');try{await fn();}catch(e){if(alive.current)setError(e.message);}finally{locked.current=false;if(alive.current)setBusy(false);}}
 function toggle(id){setSelected(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});}
 function closeConfirm(){setConfirm(null);setError('');requestAnimationFrame(()=>deleteTrigger.current?.focus());}
 async function prepare(items,event){deleteTrigger.current=event.currentTarget;await run(async()=>{const result=await request('prepare',{ids:items.map(r=>r.id),scope:subagents?'subagent':'archive'});setConfirm(result);});}
 async function remove(){
  await run(async()=>{
   const result=await commit(confirm.token);
   if(result.confirmation){setConfirm(result.confirmation);return;}
   closeConfirm();setSelected(new Set());setNotice({text:resultText(result),details:resultDetails(result,confirm.items)});await refresh();
  });
 }
 async function unarchive(ids){await run(async()=>{const result=await request('restore',{ids,fromDeleted:false});setSelected(new Set());setNotice({text:`已取消归档 ${result.restored.length} 个 · 未完成 ${result.failed.length} 个`,details:result.failed});await refresh();});}
 return <div className="dam-root"><div className="dam-page" inert={confirm?'':undefined}>
  <header><div><h2>归档管理</h2><p>集中整理会话，删除后保留历史用量</p></div><button className="dam-icon" aria-label="刷新归档" disabled={busy} onClick={()=>run(refresh)}><RefreshCw size={18}/></button></header>
  <div className="dam-search"><Search size={17}/><input aria-label="搜索会话" placeholder="搜索标题、项目或会话 ID" value={search} disabled={busy} onChange={e=>setSearch(e.target.value)}/>{search&&<button aria-label="清除搜索" onClick={()=>setSearch('')}><X size={14}/></button>}</div>
  <div className="dam-toolbar"><span>{chosen.length?`已选 ${chosen.length} 个`:`${visible.length} 个会话`}{hiddenSelected>0&&` · 筛选外另有 ${hiddenSelected} 个已选`}</span><div>
   {chosen.length>0&&chosen.every(r=>r.canUnarchive)&&<button disabled={busy} onClick={()=>unarchive(chosen.map(r=>r.id))}><RotateCcw size={14}/>取消归档</button>}
   <button aria-pressed={subagents} disabled={busy} onClick={()=>run(async()=>{await refresh(!subagents);setSubagents(!subagents);setSelected(new Set());setNotice(null);})}>子智能体</button>
   <button className="dam-danger" disabled={busy||!chosen.length} onClick={event=>prepare(chosen,event)}>删除所选</button>{!subagents&&<button className="dam-danger" disabled={busy||!visible.length} onClick={event=>prepare(visible,event)}>{filter?`删除搜索结果 ${visible.length} 个…`:`删除归档列表 ${visible.length} 个…`}</button>}
  </div></div>
  {error&&<div role="alert" className="dam-alert"><AlertCircle size={16}/><span>{error}</span><button disabled={busy} onClick={()=>run(refresh)}>重试刷新</button></div>}
  {data?.scanError&&<div role="status" className="dam-alert"><AlertCircle size={16}/><span>{data.scanError}</span></div>}
  <UncheckedFiles files={data?.uncheckedFiles}/>
  <BackupRoots roots={data?.backupRoots}/>
  {notice&&<div role="status" className="dam-notice">{notice.details.length?<AlertCircle size={16}/>:<Check size={16}/>}<div>{notice.text}{notice.details.length>0&&<details><summary>查看未完成会话</summary>{notice.details.map(r=><p key={r.id} title={r.id}>{r.title??r.id}：{r.reason}</p>)}</details>}</div></div>}
  {!data&&!error?<div className="dam-empty">正在读取会话…</div>:visible.length===0?<div className="dam-empty"><Archive size={34}/><h3>{search?'没有匹配的会话':subagents?'暂无子智能体会话':'暂无归档会话'}</h3></div>:<div className="dam-list">
   <label className="dam-select-all"><input type="checkbox" aria-label="选择当前筛选的全部会话" disabled={busy} checked={visible.length>0&&visible.every(r=>selected.has(r.id))} onChange={e=>setSelected(old=>{const next=new Set(old);visible.forEach(r=>e.target.checked?next.add(r.id):next.delete(r.id));return next;})}/>选择当前筛选结果<span>{visible.length} 个</span></label>
   {visible.map(row=><article className="dam-row" key={row.id}><input type="checkbox" aria-label={`选择 ${row.title}`} disabled={busy} checked={selected.has(row.id)} onChange={()=>toggle(row.id)}/><div className="dam-row-main"><strong title={row.title}>{row.title}</strong><span className="dam-project" title={row.workspace}><Folder size={13}/>{row.workspace}</span><small title={row.id}>{row.cleanupPending?'待清理 · ':''}{formatDate(row.createdAt??row.deletedAt)}{row.parentSession&&` · 父会话 ${row.parentSession}`}</small></div>{row.cleanupPending&&<button disabled={busy} onClick={event=>prepare([row],event)}>继续清理</button>}{row.canUnarchive&&<button className="dam-icon" disabled={busy} aria-label={`取消归档：${row.title}`} title="取消归档" onClick={()=>unarchive([row.id])}><RotateCcw size={16}/></button>}</article>)}
  </div>}
  <footer>删除会清理本机日志、已发现的聊天副本及会话缓存，不能恢复。历史用量、项目文件与共享附件保留；具体文件和检查范围会在确认时列出。</footer>
 </div>
 {confirm&&<DeleteDialog confirm={confirm} busy={busy} error={error} progress={progress} onClose={closeConfirm} onDelete={remove}/>}
 </div>;
}
