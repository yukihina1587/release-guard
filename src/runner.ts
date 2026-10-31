import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from './config.ts';
import { BrowserRunner } from './browser.ts';
import type { Session } from './browser.ts';
import { deploy } from './deploy.ts';
import { diagnose, finding } from './diagnostics.ts';
import { writeReport } from './report.ts';
import { awsPort, snapshot } from './cloudfront.ts';
import type { CloudFrontPort } from './cloudfront.ts';
import { GuardError, safeError } from './model.ts';
import type { LoadedConfig, Report } from './model.ts';

export interface RunOptions { signal?: AbortSignal; env?: NodeJS.ProcessEnv; cloudFront?: CloudFrontPort; pollIntervalMs?: number }
export interface RunResult { exitCode: number; report: Report; outputDirectory: string }
export async function run(configPath: string, command: string[], options: RunOptions = {}): Promise<RunResult> {
  const report: Report = {
    schemaVersion: 1, runId: randomUUID(), startedAt: new Date().toISOString(),
    execution: { status: 'completed', stage: 'validate', deploymentStarted: false }, verdict: 'inconclusive',
    coverage: { oldDocument: 'not_validated', newDocument: 'not_validated', cloudfront: 'not_requested', locations: 1,
      limitations: ['1実行拠点で観測した範囲です。全POP・将来のキャッシュミス・更新中の全時間帯は検証していません。', '事前確認によってエッジキャッシュが温まる場合があります。'] },
    journeys: [], observations: [], findings: [], snapshots: [],
  };
  const controller = new AbortController();
  const externalAbort = (): void => controller.abort(new GuardError('CANCELLED', '実行が中断されました。'));
  options.signal?.addEventListener('abort', externalAbort, { once: true });
  if (options.signal?.aborted) externalAbort();
  let timer: NodeJS.Timeout | undefined;
  let browser: BrowserRunner | undefined;
  let port: CloudFrontPort | undefined;
  let loaded: LoadedConfig | undefined;
  let outputRoot = resolve(dirname(configPath), 'release-guard-results');
  let exitCode = 2;
  const check = (): void => { if (controller.signal.aborted) throw controller.signal.reason; browser?.check(); };
  const abortBrowser = (): void => { void browser?.close().catch(() => {}); };
  controller.signal.addEventListener('abort', abortBrowser, { once: true });
  const capture = async (): Promise<void> => {
    if (!port || !loaded) return;
    try {
      report.snapshots.push(await snapshot(loaded, port, controller.signal));
      if (report.coverage.cloudfront !== 'unavailable') report.coverage.cloudfront = 'available';
    } catch (error) {
      check();
      report.coverage.cloudfront = 'unavailable';
      if (loaded.config.cloudfront.mode === 'required') throw error;
    }
  };
  try {
    loaded = await loadConfig(configPath, options.env);
    outputRoot = loaded.config.report.directory;
    if (!command[0]) throw new GuardError('MISSING_COMMAND', 'デプロイコマンドを指定してください。');
    timer = setTimeout(() => controller.abort(new GuardError('TOTAL_TIMEOUT', '全体の実行期限を超過しました。')), loaded.config.timeouts.totalSeconds * 1000);
    check();
    if (loaded.config.cloudfront.mode !== 'disabled') port = options.cloudFront ?? awsPort();
    await capture();
    report.execution.stage = 'browser';
    browser = new BrowserRunner(loaded, report, controller.signal);
    await browser.start();
    const held: Session[] = [];
    report.journeys = loaded.config.journeys.map(j => ({ id: j.id, old: 'pending', new: 'pending' }));
    report.execution.stage = 'baseline';
    let oldRelease: string | undefined;
    for (const journey of loaded.config.journeys) {
      const baseline = await browser.open(journey, 'baseline');
      if (!baseline.release || baseline.release === loaded.expectedRelease || (oldRelease && oldRelease !== baseline.release)) throw new GuardError('RELEASE_IDENTITY_INVALID', '旧版の識別子が不明・不一致、または期待する新版と同じです。');
      oldRelease = baseline.release;
      if (!await browser.perform(baseline) || !baseline.lazyRequests) throw new GuardError('BASELINE_FAILED', '更新前の操作または遅延ロード確認が成功しませんでした。');
      if (diagnose(report.observations.slice(baseline.observationStart).map(o => ({ ...o, phase: 'old' }))).some(f => f.severity === 'error')) throw new GuardError('BASELINE_FAILED', '更新前に対象アセットの配信失敗を観測しました。');
      await browser.closeSession(baseline);
      const session = await browser.open(journey, 'armed');
      if (session.release !== oldRelease) throw new GuardError('RELEASE_CHANGED', '事前確認中に配信ビルドが変わりました。');
      await browser.armed(session);
      held.push(session);
    }
    report.execution.stage = 'armed';
    for (const session of held) await browser.armed(session);
    check();
    report.execution.stage = 'deploying';
    report.execution.deploymentStarted = true;
    await deploy(command, loaded.config.timeouts.deploymentSeconds * 1000, controller.signal);
    const publicationDeadline = performance.now() + loaded.config.timeouts.publicationSeconds * 1000;
    report.execution.stage = 'old';
    for (const session of held) {
      await browser.armed(session);
      session.phase = 'old';
      const beforeRequests = session.lazyRequests;
      const passed = await browser.perform(session);
      const replaced = session.invalidated || await browser.mark(session) !== session.initialMark;
      if (session.lazyRequests === beforeRequests && passed && !replaced) throw new GuardError('LAZY_REQUEST_NOT_OBSERVED', '旧版操作で対象の遅延ロードを観測できませんでした。');
      if (!passed || replaced) {
        const f = finding(replaced ? 'OLD_DOCUMENT_REPLACED' : 'JOURNEY_ASSERTION_FAILED', replaced ? '旧版の文書が再読み込みされました。' : '旧版の期待する画面が表示されませんでした。');
        f.journeyId = session.journey.id; f.phase = 'old'; report.findings.push(f);
      }
      report.journeys.find(j => j.id === session.journey.id)!.old = passed && !replaced ? 'passed' : 'failed';
      await browser.closeSession(session);
    }
    report.coverage.oldDocument = 'validated';
    report.execution.stage = 'publication';
    for (const journey of loaded.config.journeys) {
      let current: Session | undefined;
      for (let attempt = 0; attempt < 20 && performance.now() < publicationDeadline; attempt++) {
        check();
        try { current = await browser.open(journey, 'publication', publicationDeadline - performance.now()); }
        catch (error) {
          if (!(error instanceof GuardError) || error.code !== 'PUBLICATION_UNAVAILABLE') throw error;
          const remaining = publicationDeadline - performance.now();
          if (remaining > 0) await delay(Math.min(options.pollIntervalMs ?? 10_000, remaining), undefined, { signal: controller.signal });
          continue;
        }
        if (performance.now() <= publicationDeadline && current.release === loaded.expectedRelease) break;
        await browser.closeSession(current); current = undefined;
        const remaining = publicationDeadline - performance.now();
        if (remaining > 0) await delay(Math.min(options.pollIntervalMs ?? 10_000, remaining), undefined, { signal: controller.signal });
      }
      const result = report.journeys.find(j => j.id === journey.id)!;
      if (!current) {
        const f = finding('EXPECTED_RELEASE_NOT_VISIBLE', '期限までに期待する新版を確認できませんでした。');
        f.journeyId = journey.id; f.phase = 'new'; report.findings.push(f); result.new = 'failed';
        continue;
      }
      // The successful publication page becomes the fresh visitor; preserve its initial asset evidence.
      for (const o of report.observations.slice(current.observationStart)) if (o.phase === 'publication' && o.journeyId === journey.id) o.phase = 'new';
      current.phase = 'new';
      current.context.setDefaultTimeout(loaded.config.timeouts.actionSeconds * 1000);
      report.execution.stage = 'new';
      const passed = await browser.perform(current);
      if (!passed) {
        const f = finding('JOURNEY_ASSERTION_FAILED', '新版の期待する画面が表示されませんでした。');
        f.journeyId = journey.id; f.phase = 'new'; report.findings.push(f);
      }
      const mismatch = report.observations.slice(current.observationStart).find(o => o.asset && o.lazy && !o.inManifest);
      if (mismatch) report.findings.push(finding('EXPECTED_ASSET_MISMATCH', '新版の対象アセットがmanifestに含まれていません。', mismatch));
      result.new = passed ? 'passed' : 'failed';
      await browser.closeSession(current);
    }
    report.coverage.newDocument = 'validated';
    report.execution.stage = 'diagnose';
    await capture();
    check();
  } catch (error) {
    const safe = safeError(controller.signal.aborted ? controller.signal.reason : error);
    report.execution.status = safe.code === 'CANCELLED' ? 'cancelled' : 'error';
    report.execution.errorCode = safe.code;
    report.execution.message = safe.message;
  } finally {
    clearTimeout(timer);
    controller.signal.removeEventListener('abort', abortBrowser);
    options.signal?.removeEventListener('abort', externalAbort);
    await browser?.close().catch(() => {});
    port?.close();
  }
  // A pre-deploy snapshot alone cannot describe the configuration serving the new release.
  const diagnosticSnapshot = report.snapshots.length === 2 ? report.snapshots.at(-1) : undefined;
  report.findings.push(...diagnose(report.observations, diagnosticSnapshot));
  for (const j of report.journeys) {
    for (const phase of ['old', 'new'] as const) {
      if (j[phase] === 'pending') j[phase] = 'inconclusive';
      if (report.findings.some(f => f.severity === 'error' && f.journeyId === j.id && f.phase === phase)) j[phase] = 'failed';
    }
  }
  if (report.execution.status === 'completed') {
    report.verdict = report.findings.some(f => f.severity === 'error') ? 'failed' : 'passed';
    exitCode = report.verdict === 'failed' ? 1 : 0;
  } else if (report.execution.status === 'cancelled') exitCode = 130;
  report.finishedAt = new Date().toISOString();
  report.execution.stage = report.execution.status === 'completed' ? 'report' : report.execution.stage;
  const outputDirectory = await writeReport(outputRoot, report);
  return { exitCode, report, outputDirectory };
}
