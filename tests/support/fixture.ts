import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Config } from '../../src/model.ts';

export type Mode = 'keep' | 'missing' | 'html' | 'baseline' | 'prefetch' | 'same' | 'stale' | 'reload' | 'worker' | 'network' | 'deploy-fail' | 'mismatch' | 'new-broken' | 'spa-navigation';
export async function createFixture(mode: Mode = 'keep') {
  const directory = await mkdtemp(join(tmpdir(), 'release-guard-test-'));
  await mkdir(join(directory, 'dist', '.vite'), { recursive: true });
  await mkdir(join(directory, 'dist', 'assets'));
  for (const file of ['Entry-B.js', 'Orders-B.js']) await writeFile(join(directory, 'dist', 'assets', file), '// fixture');
  await writeFile(join(directory, 'dist', '.vite', 'manifest.json'), JSON.stringify({
    'index.html': { file: 'assets/Entry-B.js', isEntry: true, dynamicImports: ['src/Orders.ts'] },
    'src/Orders.ts': { file: 'assets/Orders-B.js', isDynamicEntry: true },
  }));
  let version = mode === 'same' ? 'B' : 'A';
  let deployments = 0;
  const deployPath = `/__deploy/${randomUUID()}`;
  const server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    if (path === deployPath && req.method === 'POST') {
      deployments++;
      if (mode !== 'stale') version = 'B';
      res.end('ok'); return;
    }
    res.setHeader('cache-control', 'no-store');
    res.setHeader('set-cookie', 'test=fixture-secret; HttpOnly');
    res.setHeader('x-cache', 'Miss from cloudfront');
    res.setHeader('x-amz-cf-pop', 'NRT20-C1');
    if (path === '/') {
      res.setHeader('content-type', 'text/html');
      const ready = mode === 'new-broken' && version === 'B' ? 'broken' : 'home-ready';
      res.end(`<!doctype html><meta name="release-guard-build" content="${version}"><h1 data-testid="${ready}">Release ${version}</h1><button data-testid="orders-link">注文一覧</button><div id="target"></div><script type="module" src="/assets/Entry-${version}.js"></script>`);
    } else if (path.startsWith('/assets/Entry-')) {
      const v = path.includes('-A.') ? 'A' : 'B';
      res.setHeader('content-type', 'text/javascript');
      const desired = mode === 'mismatch' && v === 'B' ? 'A' : v;
      res.end(`
        ${mode === 'worker' ? "await navigator.serviceWorker.register('/worker.js'); await navigator.serviceWorker.ready;" : ''}
        ${mode === 'prefetch' ? `await import('/assets/Orders-${desired}.js');` : ''}
        document.querySelector('button').addEventListener('click', async () => {
          ${mode === 'spa-navigation' ? "history.pushState({}, '', '/orders');" : ''}
          ${mode === 'reload' && v === 'A' ? "const r = await fetch('/version'); if(await r.text() === 'B') { location.reload(); return; }" : ''}
          try {
            const m = await import('/assets/Orders-${desired}.js?token=fixture-secret');
            document.querySelector('#target').innerHTML = m.content;
          } catch { document.querySelector('#target').textContent = 'load failed'; }
        });`);
    } else if (path.startsWith('/assets/Orders-')) {
      if ((mode === 'baseline' || (version === 'B' && path.includes('-A.'))) && ['missing', 'html', 'baseline', 'network'].includes(mode)) {
        if (mode === 'network') { req.socket.destroy(); return; }
        res.statusCode = mode === 'html' ? 200 : 404;
        res.setHeader('content-type', 'text/html'); res.end('<html>fallback</html>');
      } else {
        res.setHeader('content-type', 'text/javascript');
        res.end('export const content = \'<h2 data-testid="orders-page">Orders</h2>\';');
      }
    } else if (path === '/version') res.end(version);
    else if (path === '/worker.js') { res.setHeader('content-type', 'text/javascript'); res.end("self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));"); }
    else { res.statusCode = 404; res.end('missing'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const config: Config = {
    schemaVersion: 1, target: { baseUrl, assetOrigins: [baseUrl] },
    releaseIdentity: { selector: 'meta[name="release-guard-build"]', attribute: 'content', expectedFromEnv: 'RG_TEST_RELEASE' },
    build: { adapter: 'vite', directory: './dist', manifest: './dist/.vite/manifest.json', publicBase: '/' },
    cloudfront: { mode: 'disabled' },
    timeouts: { deploymentSeconds: 5, publicationSeconds: mode === 'stale' ? 0.7 : 10, actionSeconds: 0.7, totalSeconds: 30 },
    journeys: [{ id: 'orders', startPath: '/', ready: { testId: 'home-ready' }, lazyAssetPattern: '/assets/Orders-*.js', continuity: 'preserve-document', steps: [{ action: 'click', testId: 'orders-link' }, { action: 'expectVisible', testId: 'orders-page' }] }],
    report: { directory: './results' },
  };
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const command = mode === 'deploy-fail' ? [process.execPath, '-e', 'process.exit(9)'] : [process.execPath, '-e', 'const r=await fetch(process.argv[1],{method:"POST"}); if(!r.ok)process.exit(1)', `${baseUrl}${deployPath}`];
  return {
    directory, configPath, config, command, baseUrl,
    env: { ...process.env, RG_TEST_RELEASE: 'B' },
    deployCount: () => deployments,
    async saveConfig(): Promise<void> { await writeFile(configPath, JSON.stringify(config)); },
    async close(): Promise<void> { await new Promise<void>(resolve => server.close(() => resolve())); await rm(directory, { recursive: true, force: true }); },
  };
}
