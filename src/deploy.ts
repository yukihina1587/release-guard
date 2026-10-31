import { spawn } from 'node:child_process';
import { GuardError } from './model.ts';

export async function deploy(command: string[], timeoutMs: number, signal: AbortSignal): Promise<void> {
  if (!command[0]) throw new GuardError('MISSING_COMMAND', '実行するデプロイコマンドを指定してください。');
  if (signal.aborted) throw new GuardError('CANCELLED', '実行が中断されました。');
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command[0]!, command.slice(1), { shell: false, detached: true, stdio: 'inherit' });
    let error: GuardError | undefined;
    let forceTimer: NodeJS.Timeout | undefined;
    const kill = (kind: NodeJS.Signals): void => {
      if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* Already exited. */ } }
    };
    const stop = (reason: GuardError): void => {
      if (error) return;
      error = reason;
      kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 1_000);
    };
    const abort = (): void => stop(new GuardError('CANCELLED', '実行が中断されました。'));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new GuardError('DEPLOY_TIMEOUT', 'デプロイが期限を超過しました。更新状況を確認してください。')), timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer); clearTimeout(forceTimer);
      signal.removeEventListener('abort', abort);
      kill('SIGKILL');
    };
    child.once('error', () => { cleanup(); reject(new GuardError('DEPLOY_START_FAILED', 'デプロイプロセスを開始できませんでした。')); });
    child.once('close', code => {
      cleanup();
      if (error) reject(error);
      else if (code !== 0) reject(new GuardError('DEPLOY_FAILED', 'デプロイコマンドが失敗しました。更新状況を確認してください。'));
      else resolve();
    });
    if (signal.aborted) abort();
  });
}
