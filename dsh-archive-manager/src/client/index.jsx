import React, {useEffect,useState,useSyncExternalStore} from 'react';
import {Archive,Trash2} from 'lucide-react';
import {api, App, DeleteDialog, useDeleteProgress} from './App.jsx';
import css from './style.css';
import {installSidebarPolicy} from './sidebar-policy.js';
export const inject=['slots','uiWorkspace','contextMenus'];

function DirectDelete({target,onClose}) {
  const [confirm,setConfirm] = useState(null);
  const [result,setResult] = useState(null);
  const [error,setError] = useState('');
  const [busy,setBusy] = useState(false);
  const [attempt,setAttempt] = useState(0);
  const {progress,commit} = useDeleteProgress(api);
  useEffect(() => {
    let mounted = true;
    api('prepare',{scope:'direct',ids:[target.sessionId]}).then(
      value => { if (mounted) setConfirm(value); },
      reason => { if (mounted) setError(reason.message); }
    );
    return () => { mounted = false; };
  },[target,attempt]);

  function retry() {
    setConfirm(null);
    setResult(null);
    setError('');
    setAttempt(value=>value+1);
  }

  async function remove() {
    setBusy(true);
    setError('');
    try {
      const response = await commit(confirm.token);
      if (response.confirmation) setConfirm(response.confirmation);
      else setResult(response);
    }
    catch (reason) { setError(reason.message); }
    finally { setBusy(false); }
  }

  return <DeleteDialog title={target.displayTitle} confirm={confirm} result={result} error={error}
    busy={busy} progress={progress} onClose={onClose} onDelete={remove} onRetry={retry}/>;
}

export function apply(ctx){
  ctx.effect(()=>installSidebarPolicy(ctx.uiWorkspace.view),'archive-manager active-only sidebar');
  ctx.effect(()=>{const style=document.createElement('style');style.dataset.plugin='dsh-archive-manager-local';style.textContent=css;document.head.append(style);return()=>style.remove();});
  ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'archive-manager-local',order:26,label:()=> '归档管理'},App));
  ctx.slots.inject('settings.section.icon',()=>ctx.slots.register({name:'settings.section.icon',id:'archive-manager-local'},({size=16})=><Archive size={size}/>));

  let target = null;
  const listeners = new Set();
  const getTarget = () => target;
  const subscribe = listener => { listeners.add(listener); return () => listeners.delete(listener); };
  const setTarget = next => { target = next; for (const listener of listeners) listener(); };
  const openDelete = session => { if (!target) setTarget(session); };
  function Overlay() {
    const current = useSyncExternalStore(subscribe,getTarget);
    return current && <DirectDelete key={current.sessionId} target={current} onClose={()=>setTarget(null)}/>;
  }
  function HeaderDelete({sessionId,useSession}) {
    const running = useSession(state => state.running);
    return <button type="button" className="dam-header-delete" aria-label="删除会话" title="删除会话"
      disabled={running} onClick={()=>openDelete({sessionId})}><Trash2 size={16}/></button>;
  }
  ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'archive-manager-local.delete'},Overlay));
  ctx.slots.inject('conversation.session.header.utilities',()=>ctx.slots.register({
    name:'conversation.session.header.utilities',id:'archive-manager-local.delete',order:500
  },HeaderDelete));
  ctx.effect(()=>ctx.contextMenus.register({id:'session.archive-manager-local.delete',target:'session',order:650,
    resolve: session => [{id:'archive-manager-delete',label:'删除会话…',afterContent:true,
      run:()=>openDelete(session)}]
  }),'archive-manager direct delete');
}
