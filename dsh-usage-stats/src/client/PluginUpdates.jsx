import React, { useEffect, useState } from 'react';
import css from './plugin-updates.css';

const messages = {
  unavailable: '退出后更新适用于 Windows 版 DSH 中通过 npm 安装并启用的插件。',
  current: '当前已是最新正式版。',
  checking: '正在检查更新…',
  queued: '发现 v{version}。完全退出 DSH 后会自动安装。',
  restart: '已安装 v{version}，请重启 DSH 使更新生效。',
  ineligible: 'v{version} 暂不符合自动更新条件。',
  'check-error': '检查更新失败，请稍后重试。',
  'install-error': '上次退出时安装失败，待更新项已保留。'
};

function UpdateControls({ pkg }) {
  const [state, setState] = useState(null);
  const [action, setAction] = useState(null);
  const [error, setError] = useState('');

  async function request(route, signal) {
    const response = await fetch(`/api/${pkg.name}/updates/${route}`, {
      method: route === 'status' ? 'GET' : 'POST',
      headers: { 'x-dsh-local-plugin-update': '1' },
      signal
    });
    if (!response.ok) throw new Error('暂时无法访问插件更新，请稍后重试。');
    return response.json();
  }

  useEffect(() => {
    if (!pkg.enabled) return;
    const controller = new AbortController();
    async function refresh() {
      try {
        const result = await request('status', controller.signal);
        if (!controller.signal.aborted) { setState(result); setError(''); }
      } catch (reason) {
        if (!controller.signal.aborted) setError(reason.message);
      }
    }
    refresh();
    const timer = state?.auto || action === 'check' ? setInterval(refresh, 5000) : undefined;
    return () => { controller.abort(); clearInterval(timer); };
  }, [pkg.name, pkg.enabled, state?.auto, action]);

  async function run(route) {
    setAction(route);
    setError('');
    try { setState(await request(route)); }
    catch (reason) { setError(reason.message); }
    finally { setAction(null); }
  }

  const phase = !pkg.enabled || state?.available === false ? 'unavailable'
    : action === 'check' ? 'checking' : state?.phase;
  const message = error || messages[phase]?.replace('{version}', state?.target ?? pkg.version);
  const checkBusy = ['checking', 'restart'].includes(phase);
  return <section className="dsh-local-plugin-updates" aria-label="插件更新">
    <h3>插件更新</h3>
    {pkg.enabled && state?.available && <div className="dsh-local-update-controls">
      <button type="button" disabled={Boolean(action) || checkBusy} onClick={() => run('check')}>
        检查并安排更新
      </button>
      <label>
        <input type="checkbox" checked={state?.auto === true} disabled={!state || Boolean(action)}
          onChange={event => run(event.target.checked ? 'enable' : 'disable')} />
        自动更新
      </label>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}

export function registerUpdateControls(ctx, name) {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
    name: 'plugins.detail.section',
    id: `${name}.updates`
  }, ({ subject }) => subject.kind === 'bundle' && subject.pkg.name === name
    ? <UpdateControls key={name} pkg={subject.pkg} /> : null));
}
