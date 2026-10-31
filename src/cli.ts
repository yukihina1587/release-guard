#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from './runner.ts';
import { loadConfig } from './config.ts';
import { safeError } from './model.ts';

interface Output { stdout: (message: string) => void; stderr: (message: string) => void }
export async function main(args: string[], env: NodeJS.ProcessEnv = process.env, output: Output = { stdout: m => { process.stdout.write(m); }, stderr: m => { process.stderr.write(m); } }): Promise<number> {
const separator = args.indexOf('--');
const ownArgs = separator < 0 ? args : args.slice(0, separator);
const command = separator < 0 ? [] : args.slice(separator + 1);
const controller = new AbortController();
let signalCode = 0;
const int = (): void => { signalCode = 130; controller.abort(); };
const term = (): void => { signalCode = 143; controller.abort(); };
process.once('SIGINT', int); process.once('SIGTERM', term);
try {
  const { values, positionals } = parseArgs({ args: ownArgs, allowPositionals: true, options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) {
    output.stdout('release-guard validate --config <file>\nrelease-guard run --config <file> -- <command> [args...]\n');
    return 0;
  } else if (!values.config || positionals.length !== 1 || !['validate', 'run'].includes(positionals[0]!) || (positionals[0] === 'validate' && command.length)) {
    output.stderr('validate または run と --config を指定してください。--help で使用法を確認できます。\n');
    return 2;
  } else if (positionals[0] === 'validate') {
    await loadConfig(values.config, env);
    output.stdout('設定とビルド成果物を確認しました。\n');
    return signalCode;
  } else {
    const result = await run(values.config, command, { signal: controller.signal, env });
    output.stdout(`Release Guard: ${result.report.verdict}\nレポート: ${result.outputDirectory}\n`);
    if (result.report.execution.message) output.stderr(`${result.report.execution.message}\n`);
    return signalCode || result.exitCode;
  }
} catch (error) {
  output.stderr(`${safeError(error).message}\n`);
  return signalCode || 2;
} finally {
  process.removeListener('SIGINT', int); process.removeListener('SIGTERM', term);
}
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = await main(process.argv.slice(2));
