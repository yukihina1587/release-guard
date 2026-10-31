import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnose, matchPattern, sanitizeHeaders } from '../src/diagnostics.ts';
import { deploy } from '../src/deploy.ts';
import { renderHtml, escapeHtml } from '../src/report.ts';
import { safeError, GuardError } from '../src/model.ts';
import type { Observation } from '../src/model.ts';

const observation: Observation = { id: 'r1', time: '', phase: 'old', journeyId: 'orders', path: '/assets/Orders-A.js', kind: 'response', resourceType: 'script', asset: true, lazy: true, inManifest: false, status: 200, headers: { 'content-type': 'text/html' } };
test('HTML with 200 is an asset error without claiming the origin deleted it', () => {
  const [finding] = diagnose([observation]);
  assert.equal(finding?.ruleId, 'ASSET_HTML_RESPONSE');
  assert.deepEqual(finding?.evidenceIds, ['r1']);
  assert.equal(finding?.hypotheses.length, 0);
});
test('baseline and publication observations do not become release failures', () => {
  assert.deepEqual(diagnose([{ ...observation, phase: 'baseline' }, { ...observation, phase: 'publication' }]), []);
});

test('HTML redirect responses are not confused with final JavaScript responses', () => {
  assert.deepEqual(diagnose([{ ...observation, status: 302 }]), []);
});
test('header values are allowlisted and normalized', () => {
  const headers = sanitizeHeaders({ 'set-cookie': 'fixture-secret', authorization: 'fixture-secret', age: '45', 'content-type': 'text/html; private=fixture-secret', 'cache-control': 'max-age=60, private, x-secret=fixture-secret', 'x-cache': 'Hit from cloudfront', 'x-amz-cf-pop': 'NRT20-C1' });
  assert.ok(!JSON.stringify(headers).includes('fixture-secret'));
  assert.equal(headers.age, '45');
  assert.equal(headers['content-type'], 'text/html');
});
test('glob patterns are anchored and regex symbols are literal', () => {
  assert.ok(matchPattern('/assets/Orders-*.js', '/assets/Orders-A.js'));
  assert.ok(!matchPattern('/assets/Orders-*.js', '/other/Orders-A.js'));
  assert.ok(!matchPattern('/x.js', '/xXjs'));
});
test('deployment uses argv without shell expansion', async () => {
  await deploy([process.execPath, '-e', 'if(process.argv[1] !== "$(echo bad)") process.exit(5)', '$(echo bad)'], 2_000, new AbortController().signal);
});
test('failed deployment rejects and is not retried', async () => {
  await assert.rejects(deploy([process.execPath, '-e', 'process.exit(9)'], 2_000, new AbortController().signal), { code: 'DEPLOY_FAILED' });
});
test('deployment timeout terminates the process', async () => {
  await assert.rejects(deploy([process.execPath, '-e', 'setInterval(()=>{},1000)'], 100, new AbortController().signal), { code: 'DEPLOY_TIMEOUT' });
});

test('unknown exceptions never disclose their message', () => {
  assert.ok(!safeError(new Error('fixture-secret')).message.includes('fixture-secret'));
  assert.equal(safeError(new GuardError('TEST', 'safe')).code, 'TEST');
  assert.equal(escapeHtml('<script>"&\''), '&lt;script&gt;&quot;&amp;&#39;');
});

test('deployment requires a command and honors cancellation', async () => {
  await assert.rejects(deploy([], 100, new AbortController().signal), { code: 'MISSING_COMMAND' });
  const c = new AbortController(); c.abort();
  await assert.rejects(deploy([process.execPath], 100, c.signal), { code: 'CANCELLED' });
  await assert.rejects(deploy(['/nonexistent-release-guard-command'], 100, new AbortController().signal), { code: 'DEPLOY_START_FAILED' });
  const live = new AbortController();
  const pending = deploy([process.execPath, '-e', 'setInterval(()=>{},1000)'], 5000, live.signal);
  setTimeout(() => live.abort(), 50);
  await assert.rejects(pending, { code: 'CANCELLED' });
});
