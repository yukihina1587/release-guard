import { resolve, join } from 'node:path';
import { run } from '../src/runner.ts';
import { createFixture } from '../tests/support/fixture.ts';

// The fixture uses Vite-compatible manifests, with no cloud resources.
for (const mode of ['keep', 'missing', 'html'] as const) {
  const fixture = await createFixture(mode);
  try {
    fixture.config.report.directory = resolve('demo-results', mode);
    await fixture.saveConfig();
    const result = await run(fixture.configPath, fixture.command, { env: fixture.env });
    process.stdout.write(`${mode}: ${result.report.verdict} (exit ${result.exitCode})\n${join(result.outputDirectory, 'report.html')}\n`);
    const expected = mode === 'keep' ? 0 : 1;
    if (result.exitCode !== expected) process.exitCode = 1;
  } finally { await fixture.close(); }
}
