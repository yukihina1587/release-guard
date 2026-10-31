import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig, readJson } from '../src/config.ts';
import { createFixture } from './support/fixture.ts';

test('valid configuration resolves asset URLs and local paths', async () => {
  const f = await createFixture();
  try {
    const c = await loadConfig(f.configPath, f.env);
    assert.ok(c.assetPaths.has('/assets/Orders-B.js'));
    assert.equal(c.expectedRelease, 'B');
    assert.equal(c.config.report.directory, join(f.directory, 'results'));
  } finally { await f.close(); }
});

for (const mutation of [
  (c: any) => { c.unknown = true; },
  (c: any) => { c.target.baseUrl = 'https://user:fixture-secret@example.com'; },
  (c: any) => { c.target.baseUrl = 'http://example.com'; },
  (c: any) => { c.target.baseUrl = 'invalid'; },
  (c: any) => { c.journeys.push(c.journeys[0]); },
  (c: any) => { c.journeys[0].startPath = '//example.org'; },
  (c: any) => { c.journeys[0].startPath = '/?token=fixture-secret'; },
  (c: any) => { c.journeys[0].lazyAssetPattern = '/x?secret'; },
  (c: any) => { c.build.publicBase = '/../'; },
  (c: any) => { c.build.publicBase = '/assets'; },
  (c: any) => { c.cloudfront = { mode: 'required' }; },
  (c: any) => { c.auth = { storageStateFile: 'missing.json' }; },
]) {
  test(`reject unsafe/invalid config: ${mutation.toString().split('{')[1]}`, async () => {
    const f = await createFixture();
    try {
      mutation(f.config); await f.saveConfig();
      await assert.rejects(loadConfig(f.configPath, f.env), { code: 'INVALID_CONFIG' });
    } finally { await f.close(); }
  });
}

for (const manifest of [
  {}, [], { entry: { file: '../outside.js' } }, { entry: { file: '/outside.js' } },
  { entry: { file: 'assets/Entry-B.js', imports: ['missing'] } },
  { entry: { file: 'assets/Entry-B.js', imports: 12 } },
  { entry: { file: 'missing.js' } }, { entry: {} },
]) {
  test(`reject invalid manifest ${JSON.stringify(manifest)}`, async () => {
    const f = await createFixture();
    try {
      await writeFile(join(f.directory, 'dist/.vite/manifest.json'), JSON.stringify(manifest));
      await assert.rejects(loadConfig(f.configPath, f.env), { code: 'INVALID_CONFIG' });
    } finally { await f.close(); }
  });
}

test('symlink escape, missing env and oversized JSON are rejected', async () => {
  const f = await createFixture();
  try {
    await assert.rejects(loadConfig(f.configPath, {}), { code: 'INVALID_CONFIG' });
    await writeFile(join(f.directory, 'outside.js'), '// outside');
    await symlink(join(f.directory, 'outside.js'), join(f.directory, 'dist', 'escape.js'));
    await writeFile(join(f.directory, 'dist/.vite/manifest.json'), JSON.stringify({ entry: { file: 'escape.js' } }));
    await assert.rejects(loadConfig(f.configPath, f.env), { code: 'INVALID_CONFIG' });
    await assert.rejects(readJson(f.configPath, 10), { code: 'INVALID_CONFIG' });
  } finally { await f.close(); }
});
