import { createCollector } from './collector.js';
import { acquireLedger } from './ledger.js';
import { registerPluginUpdates } from './plugin-updates.js';
import manifest from '../package.json' with { type: 'json' };
export const name = 'dsh-usage-stats-local';
export const inject = ['webServer', 'sessionPersistence', 'storageDomain'];
export const API_PATH = '/api/dsh-usage-stats-local/snapshot';

export function authorize(req) {
  if (req.method !== 'GET') return 405;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)) return 403;
  let origin;
  try { origin = new URL('http://' + req.headers.host); } catch { return 403; }
  if (!['127.0.0.1','localhost','[::1]'].includes(origin.hostname)) return 403;
  if (req.headers['x-dsh-usage-stats'] !== '1') return 403;
  if (req.headers.origin && req.headers.origin !== origin.origin) return 403;
  if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) return 403;
  return 200;
}
export async function apply(ctx) {
  const handle = await acquireLedger(ctx.storageDomain);
  const collect = createCollector(ctx.sessionPersistence, { ledger: handle.ledger });
  ctx.effect(() => {
    const refresh = () => collect().catch(error => ctx.logger?.warn('保存用量统计失败：' + String(error)));
    refresh();
    const timer = setInterval(refresh, 30000);
    timer.unref?.();
    return async () => {
      clearInterval(timer);
      await collect.close();
      await handle.release();
    };
  }, 'usage statistics: durable ledger');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: API_PATH,
    handler: (req, res) => {
      const send = (status, value) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        res.end(JSON.stringify(value));
      };
      const status = authorize(req);
      if (status !== 200) return send(status, { ok: false, error: '请求不被允许' });
      collect().then(value => send(200, value)).catch(() => send(500, { ok: false, error: '读取或保存用量统计失败，请检查 DSH 日志后重试。' }));
    }
  }), 'usage statistics: read-only snapshot');
  registerPluginUpdates(ctx, { name, version: manifest.version });
}
