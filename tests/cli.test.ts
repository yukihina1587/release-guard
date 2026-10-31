import test from 'node:test';
import assert from 'node:assert/strict';
import { main } from '../src/cli.ts';
import { createFixture } from './support/fixture.ts';

test('CLI help, invalid arguments and offline validate', async () => {
  const f = await createFixture();
  const messages: string[] = [];
  const io = { stdout: (m: string) => { messages.push(m); }, stderr: (m: string) => { messages.push(m); } };
  try {
    assert.equal(await main(['--help'], {}, io), 0);
    assert.equal(await main([], {}, io), 2);
    assert.equal(await main(['--unknown=fixture-secret'], {}, io), 2);
    assert.equal(await main(['validate', '--config', f.configPath], f.env, io), 0);
    assert.equal(await main(['validate', '--config', f.configPath, '--', 'unused'], f.env, io), 2);
    assert.equal(f.deployCount(), 0);
    assert.ok(!messages.join('').includes('fixture-secret'));
  } finally { await f.close(); }
});

test('CLI run returns regression code and preserves report', async () => {
  const f = await createFixture('html');
  const messages: string[] = [];
  const io = { stdout: (m: string) => { messages.push(m); }, stderr: (m: string) => { messages.push(m); } };
  try {
    assert.equal(await main(['run', '--config', f.configPath, '--', ...f.command], f.env, io), 1);
    assert.ok(messages.join('').includes('failed'));
    assert.equal(f.deployCount(), 1);
    assert.equal(await main(['run', '--config', f.configPath], f.env, io), 2);
  } finally { await f.close(); }
});
