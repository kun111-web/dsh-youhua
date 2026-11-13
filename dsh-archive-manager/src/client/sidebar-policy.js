// DSH exposes the viewing actions on UiWorkspaceService.
// Lock the existing store to its normal (unarchived) mode, including a
// previously persisted 'only' filter and archive-toast shortcuts.
export function installSidebarPolicy(view) {
  if(typeof view?.setArchivedFilter!=='function')throw new Error('不兼容的 DSH 侧边栏接口');
  const original=view.setArchivedFilter;
  const activeOnly=()=>original.call(view,'default');
  view.setArchivedFilter=activeOnly;
  activeOnly();
  return ()=>{if(view.setArchivedFilter===activeOnly)view.setArchivedFilter=original;};
}
