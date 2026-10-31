import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page, Request } from 'playwright';
import { GuardError } from './model.ts';
import type { Journey, LoadedConfig, Observation, Phase, Report } from './model.ts';
import { matchPattern, sanitizeHeaders } from './diagnostics.ts';

export interface Session {
  context: BrowserContext;
  page: Page;
  phase: Phase;
  initialMark: string;
  release: string;
  earlyLazy: boolean;
  lazyRequests: number;
  serviceWorker: boolean;
  invalidated: boolean;
  lost: boolean;
  expectedClose: boolean;
  journey: Journey;
  observationStart: number;
}
export class BrowserRunner {
  readonly loaded: LoadedConfig;
  readonly report: Report;
  readonly signal: AbortSignal;
  browser?: Browser;
  sessions: Session[] = [];
  overflow = false;
  collectedBytes = 0;
  constructor(loaded: LoadedConfig, report: Report, signal: AbortSignal) {
    this.loaded = loaded; this.report = report; this.signal = signal;
  }
  async start(): Promise<void> {
    const env: Record<string, string> = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DISPLAY', 'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH']) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    try { this.browser = await chromium.launch({ env, timeout: 30_000 }); }
    catch { throw new GuardError('BROWSER_START_FAILED', 'Chromiumを起動できません。browser:installとOSの依存関係を確認してください。'); }
    if (this.signal.aborted) { await this.close(); this.check(); }
  }
  check(): void {
    if (this.signal.aborted) throw new GuardError('CANCELLED', '実行が中断されました。');
    if (this.overflow) throw new GuardError('OBSERVATION_LIMIT', '観測上限に達したため検証は不成立です。');
    if (this.browser && !this.browser.isConnected()) throw new GuardError('BROWSER_LOST', 'ブラウザが終了したため検証は不成立です。');
  }
  async open(journey: Journey, phase: Phase, budgetMs?: number): Promise<Session> {
    this.check();
    const { config } = this.loaded;
    const context = await this.browser!.newContext({ storageState: config.auth?.storageStateFile, serviceWorkers: 'allow' });
    context.setDefaultTimeout(Math.max(1, Math.min(config.timeouts.actionSeconds * 1000, budgetMs ?? Infinity)));
    await context.addInitScript(() => {
      Object.defineProperty(globalThis, '__releaseGuardDocument', { value: crypto.randomUUID(), configurable: false, writable: false });
    });
    const page = await context.newPage();
    const session: Session = { context, page, phase, initialMark: '', release: '', earlyLazy: false, lazyRequests: 0, serviceWorker: false, invalidated: false, lost: false, expectedClose: false, journey, observationStart: this.report.observations.length };
    this.sessions.push(session);
    context.on('serviceworker', () => { session.serviceWorker = true; });
    page.on('close', () => { if (!session.expectedClose) session.lost = true; });
    page.on('crash', () => { session.lost = true; });
    page.on('domcontentloaded', () => { if (session.initialMark) session.invalidated = true; });
    page.on('request', request => {
      if (this.isLazy(request.url(), journey)) {
        session.lazyRequests++;
        if (session.phase === 'armed') session.earlyLazy = true;
      }
    });
    page.on('response', response => this.observe(session, response.request(), 'response', response.status(), response.headers()));
    page.on('requestfailed', request => this.observe(session, request, 'requestfailed'));
    try {
      await page.goto(new URL(journey.startPath, config.target.baseUrl).href, { waitUntil: 'domcontentloaded' });
      if (phase !== 'publication') await page.getByTestId(journey.ready.testId).waitFor({ state: 'visible' });
      const identity = page.locator(config.releaseIdentity.selector);
      session.release = await identity.count() === 1 ? await identity.getAttribute(config.releaseIdentity.attribute) ?? '' : '';
      session.initialMark = await this.mark(session);
      await this.assertSupported(session);
      return session;
    } catch (error) {
      this.check();
      if (session.lost || page.isClosed()) throw new GuardError('PAGE_LOST', 'ページが終了したため検証は不成立です。');
      if (phase === 'publication' && !(error instanceof GuardError)) {
        await this.closeSession(session);
        throw new GuardError('PUBLICATION_UNAVAILABLE', '新版の公開をまだ確認できません。');
      }
      if (error instanceof GuardError) throw error;
      throw new GuardError('BASELINE_FAILED', '更新前の初期画面を確認できませんでした。');
    }
  }
  isLazy(url: string, journey: Journey): boolean {
    const parsed = new URL(url);
    return this.loaded.config.target.assetOrigins.includes(parsed.origin) && matchPattern(journey.lazyAssetPattern, parsed.pathname);
  }
  classify(request: Request): { path: string; asset: boolean; inManifest: boolean; lazy: boolean } {
    const url = new URL(request.url());
    const allowed = this.loaded.config.target.assetOrigins.includes(url.origin);
    const known = allowed && this.loaded.assetPaths.has(url.pathname);
    const lazy = allowed && this.loaded.config.journeys.some(j => matchPattern(j.lazyAssetPattern, url.pathname));
    const asset = allowed && ['script', 'stylesheet'].includes(request.resourceType());
    const knownPage = url.origin === this.loaded.config.target.baseUrl && this.loaded.config.journeys.some(j => j.startPath === url.pathname);
    // Do not retain arbitrary dynamic paths or query strings.
    const safeAsset = asset && lazy && /^\/[A-Za-z0-9_./-]{1,512}$/.test(url.pathname);
    return { path: known || knownPage || safeAsset ? url.pathname : '[redacted]', asset, inManifest: known, lazy };
  }
  observe(session: Session, request: Request, kind: Observation['kind'], status?: number, headers: Record<string, string> = {}): void {
    if (this.overflow || session.expectedClose) return;
    const classification = this.classify(request);
    const observation: Observation = {
      id: `response-${this.report.observations.length + 1}`, time: new Date().toISOString(), phase: session.phase,
      journeyId: session.journey.id, ...classification, lazy: this.isLazy(request.url(), session.journey),
      kind, resourceType: request.resourceType(), status, headers: sanitizeHeaders(headers),
    };
    const size = Buffer.byteLength(JSON.stringify(observation));
    if (this.report.observations.length >= 10_000 || this.collectedBytes + size > 50_000_000) { this.overflow = true; return; }
    this.report.observations.push(observation);
    this.collectedBytes += size;
  }
  async mark(session: Session): Promise<string> {
    return await session.page.evaluate(() => (globalThis as unknown as { __releaseGuardDocument: string }).__releaseGuardDocument);
  }
  async assertSupported(session: Session): Promise<void> {
    this.check();
    if (session.lost || session.page.isClosed()) throw new GuardError('PAGE_LOST', 'ページが終了したため検証は不成立です。');
    const sw = await session.page.evaluate(async () => 'serviceWorker' in navigator && ((await navigator.serviceWorker.getRegistrations()).length > 0 || navigator.serviceWorker.controller !== null));
    if (sw || session.serviceWorker) throw new GuardError('SERVICE_WORKER_UNSUPPORTED', 'Service Workerを使用するシナリオは未対応です。');
  }
  async armed(session: Session): Promise<void> {
    await this.assertSupported(session);
    if (session.earlyLazy) throw new GuardError('LAZY_ASSET_PREFETCHED', '保持タブで対象アセットが先読みされ、検証が成立しません。');
    if (session.invalidated || await this.mark(session) !== session.initialMark) throw new GuardError('OLD_STATE_LOST', 'デプロイ中に旧版の文書が置き換わりました。');
  }
  async perform(session: Session): Promise<boolean> {
    try { await session.page.getByTestId(session.journey.ready.testId).waitFor({ state: 'visible' }); }
    catch { await this.assertSupported(session); return false; }
    for (const step of session.journey.steps) {
      this.check();
      const locator = session.page.getByTestId(step.testId);
      try {
        if (step.action === 'click') await locator.click();
        else {
          await locator.waitFor({ state: 'visible' });
          if (step.action === 'expectText') {
            await session.page.waitForFunction(({ testId, text }) => [...document.querySelectorAll('[data-testid]')].some(el => el.getAttribute('data-testid') === testId && el.textContent?.trim() === text), { testId: step.testId, text: step.text });
          }
        }
      } catch {
        await this.assertSupported(session);
        return false;
      }
    }
    await this.assertSupported(session);
    return true;
  }
  async closeSession(session: Session): Promise<void> {
    session.expectedClose = true;
    await session.context.close();
    this.sessions = this.sessions.filter(s => s !== session);
  }
  async close(): Promise<void> {
    this.sessions.forEach(s => { s.expectedClose = true; });
    await this.browser?.close();
  }
}
