import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { run } from '../src/runner.ts';
import { createFixture } from './support/fixture.ts';

for (const [mode, code, rule] of [
  ['keep', 0, undefined],
  ['missing', 1, 'ASSET_HTTP_ERROR'],
  ['html', 1, 'ASSET_HTML_RESPONSE'],
] as const) {
  test(`live old document across deployment: ${mode}`, async () => {
    const fixture = await createFixture(mode);
    try {
      const result = await run(fixture.configPath, fixture.command, { env: fixture.env });
      assert.equal(result.exitCode, code);
      assert.equal(result.report.execution.status, 'completed');
      assert.equal(result.report.coverage.newDocument, 'validated');
      assert.equal(fixture.deployCount(), 1);
      if (rule) assert.ok(result.report.findings.some(f => f.ruleId === rule));
      else assert.equal(result.report.verdict, 'passed');
      const json = await readFile(`${result.outputDirectory}/report.json`, 'utf8');
      assert.ok(!json.includes('fixture-secret'));
      assert.ok(json.includes('old'));
      assert.ok((await readFile(`${result.outputDirectory}/report.html`, 'utf8')).includes('Release Guard'));
    } finally { await fixture.close(); }
  });
}

for (const [mode, code, error, rule] of [
  ['baseline', 2, 'BASELINE_FAILED', undefined],
  ['prefetch', 2, 'LAZY_ASSET_PREFETCHED', undefined],
  ['same', 2, 'RELEASE_IDENTITY_INVALID', undefined],
  ['stale', 1, undefined, 'EXPECTED_RELEASE_NOT_VISIBLE'],
  ['reload', 1, undefined, 'OLD_DOCUMENT_REPLACED'],
  ['worker', 2, 'SERVICE_WORKER_UNSUPPORTED', undefined],
  ['network', 1, undefined, 'ASSET_REQUEST_FAILED'],
  ['deploy-fail', 2, 'DEPLOY_FAILED', undefined],
  ['mismatch', 1, undefined, 'EXPECTED_ASSET_MISMATCH'],
  ['new-broken', 1, undefined, 'JOURNEY_ASSERTION_FAILED'],
  ['spa-navigation', 0, undefined, undefined],
] as const) {
  test(`release boundary: ${mode}`, async () => {
    const f = await createFixture(mode);
    try {
      const r = await run(f.configPath, f.command, { env: f.env, pollIntervalMs: 50 });
      assert.equal(r.exitCode, code, JSON.stringify(r.report.execution));
      if (error) assert.equal(r.report.execution.errorCode, error);
      if (rule) assert.ok(r.report.findings.some(x => x.ruleId === rule), JSON.stringify(r.report.findings));
      if (['baseline', 'prefetch', 'same', 'worker'].includes(mode)) assert.equal(f.deployCount(), 0);
    } finally { await f.close(); }
  });
}

test('cancellation is inconclusive and does not deploy', async () => {
  const f = await createFixture();
  try {
    const c = new AbortController(); c.abort();
    const r = await run(f.configPath, f.command, { env: f.env, signal: c.signal });
    assert.equal(r.exitCode, 130);
    assert.equal(r.report.verdict, 'inconclusive');
    assert.equal(f.deployCount(), 0);
  } finally { await f.close(); }
});

test('expectText uses the configured text', async () => {
  const f = await createFixture();
  try {
    f.config.journeys[0]!.steps[1] = { action: 'expectText', testId: 'orders-page', text: 'Orders' };
    await f.saveConfig();
    const result = await run(f.configPath, f.command, { env: f.env });
    assert.equal(result.exitCode, 0, JSON.stringify(result.report.execution));
  } finally { await f.close(); }
});

test('total timeout cancels browser work before deployment', async () => {
  const f = await createFixture();
  try {
    f.config.timeouts.totalSeconds = 0.05;
    await f.saveConfig();
    const result = await run(f.configPath, f.command, { env: f.env });
    assert.equal(result.exitCode, 2);
    assert.equal(result.report.execution.errorCode, 'TOTAL_TIMEOUT');
    assert.equal(f.deployCount(), 0);
  } finally { await f.close(); }
});
