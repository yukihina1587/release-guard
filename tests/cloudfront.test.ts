import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/cloudfront.ts';
import type { CloudFrontPort } from '../src/cloudfront.ts';
import type { LoadedConfig, Snapshot, Observation } from '../src/model.ts';
import { loadConfig } from '../src/config.ts';
import { run } from '../src/runner.ts';
import { behaviorFor, diagnose } from '../src/diagnostics.ts';
import { createFixture } from './support/fixture.ts';

function port(): CloudFrontPort {
  return {
    async distribution() { return { $metadata: {}, ETag: 'config-v1', DistributionConfig: {
      CallerReference: 'test', Comment: '', Enabled: true,
      Origins: { Quantity: 1, Items: [{ Id: 'origin', DomainName: 'bucket.example.com', CustomHeaders: { Quantity: 1, Items: [{ HeaderName: 'secret', HeaderValue: 'fixture-secret' }] } }] },
      DefaultCacheBehavior: { TargetOriginId: 'origin', ViewerProtocolPolicy: 'redirect-to-https', CachePolicyId: 'policy' },
      CacheBehaviors: { Quantity: 1, Items: [{ PathPattern: '/assets/*', TargetOriginId: 'origin', ViewerProtocolPolicy: 'https-only', CachePolicyId: 'policy', FunctionAssociations: { Quantity: 1, Items: [] } }] },
      CustomErrorResponses: { Quantity: 1, Items: [{ ErrorCode: 404, ResponseCode: '200', ResponsePagePath: '/index.html' }] },
    } }; },
    async policy() { return { $metadata: {}, CachePolicy: { Id: 'policy', LastModifiedTime: new Date(), CachePolicyConfig: { Name: 'test', MinTTL: 5 } } }; },
    close() {},
  };
}
test('CloudFront snapshot keeps only allowed fields and deduplicates policies', async () => {
  const p = port(); let calls = 0;
  const get = p.policy; p.policy = async (id, signal) => { calls++; return get(id, signal); };
  const result = await snapshot({ distributionId: 'TEST' } as LoadedConfig, p, new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(result.behaviors[0]?.minTTL, 5);
  assert.equal(result.behaviors[0]?.edgeFunction, true);
  assert.equal(result.htmlErrorResponse, true);
  assert.ok(!JSON.stringify(result).includes('fixture-secret'));
});

test('legacy cache behavior and invalid configuration are handled', async () => {
  const p = port(); const original = p.distribution;
  p.distribution = async (id, signal) => {
    const value = await original(id, signal);
    value.DistributionConfig!.CacheBehaviors = undefined;
    value.DistributionConfig!.CustomErrorResponses = undefined;
    value.DistributionConfig!.DefaultCacheBehavior!.CachePolicyId = undefined;
    value.DistributionConfig!.DefaultCacheBehavior!.MinTTL = 0;
    return value;
  };
  const r = await snapshot({ distributionId: 'TEST' } as LoadedConfig, p, new AbortController().signal);
  assert.equal(r.behaviors[0]?.minTTL, 0);
  assert.equal(r.htmlErrorResponse, false);
  p.distribution = async () => ({ $metadata: {} });
  await assert.rejects(snapshot({ distributionId: 'TEST' } as LoadedConfig, p, new AbortController().signal), { code: 'CLOUDFRONT_UNAVAILABLE' });
});

test('CloudFront path matching is ordered and uncertain paths are not guessed', () => {
  const s: Snapshot = { time: '', behaviors: [{ pathPattern: '/assets/?.js', edgeFunction: false, minTTL: 1 }, { pathPattern: '*', edgeFunction: false, minTTL: 0 }], htmlErrorResponse: true };
  assert.equal(behaviorFor('/assets/a.js', s)?.minTTL, 1);
  assert.equal(behaviorFor('/other.js', s)?.minTTL, 0);
  assert.equal(behaviorFor('/assets/%2f.js', s), undefined);
  const o: Observation = { id: 'o', time: '', phase: 'old', journeyId: 'x', path: '/assets/a.js', kind: 'response', asset: true, lazy: true, inManifest: false, resourceType: 'script', status: 200, headers: { 'content-type': 'text/html', 'cache-control': 'no-cache' } };
  const findings = diagnose([o, o], s);
  assert.equal(findings.filter(f => f.ruleId === 'ASSET_HTML_RESPONSE').length, 1);
  assert.ok(findings[0]!.hypotheses.length);
  assert.ok(findings.some(f => f.ruleId === 'CACHE_MIN_TTL_OVERRIDE' && f.severity === 'warning'));
});

for (const mode of ['optional', 'required'] as const) {
  test(`CloudFront AccessDenied: ${mode}`, async () => {
    const f = await createFixture();
    try {
      f.config.cloudfront = { mode, distributionIdFromEnv: 'RG_DISTRIBUTION' }; await f.saveConfig();
      const p = port(); p.distribution = async () => { throw new Error('AccessDenied fixture-secret'); };
      const r = await run(f.configPath, f.command, { env: { ...f.env, RG_DISTRIBUTION: 'TEST' }, cloudFront: p });
      assert.equal(r.exitCode, mode === 'optional' ? 0 : 2);
      assert.equal(r.report.coverage.cloudfront, 'unavailable');
      assert.equal(f.deployCount(), mode === 'optional' ? 1 : 0);
      assert.ok(!JSON.stringify(r.report).includes('fixture-secret'));
    } finally { await f.close(); }
  });
}

test('required CloudFront failure after deployment preserves browser evidence', async () => {
  const f = await createFixture();
  try {
    f.config.cloudfront = { mode: 'required', distributionIdFromEnv: 'RG_DISTRIBUTION' }; await f.saveConfig();
    const p = port(); let calls = 0; const original = p.distribution;
    p.distribution = async (id, signal) => { if (calls++ > 0) throw new Error('denied'); return original(id, signal); };
    const r = await run(f.configPath, f.command, { env: { ...f.env, RG_DISTRIBUTION: 'TEST' }, cloudFront: p });
    assert.equal(r.exitCode, 2);
    assert.equal(r.report.coverage.oldDocument, 'validated');
    assert.equal(r.report.snapshots.length, 1);
    assert.ok(!r.report.findings.some(f => f.ruleId === 'CACHE_MIN_TTL_OVERRIDE'));
    assert.equal(f.deployCount(), 1);
  } finally { await f.close(); }
});
