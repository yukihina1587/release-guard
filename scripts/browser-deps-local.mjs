import { mkdir, readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

if (process.platform !== 'linux' || process.arch !== 'x64' || !(await readFile('/etc/os-release', 'utf8')).includes('VERSION_ID="24.04"')) {
  throw new Error('この補助スクリプトはUbuntu 24.04 x64専用です。通常はplaywright install-deps chromiumを使用してください。');
}
const root = fileURLToPath(new URL('../.browser-deps/', import.meta.url));
await mkdir(root, { recursive: true });
execFileSync('apt-get', ['download', 'libnspr4', 'libnss3'], { cwd: root, stdio: 'inherit' });
for (const file of await readdir(root)) {
  if (/^lib(nspr4|nss3)_.*_amd64\.deb$/.test(file)) execFileSync('dpkg-deb', ['-x', file, root], { cwd: root, stdio: 'inherit' });
}
process.stdout.write('共有ライブラリを.browser-depsへ展開しました。OSのパッケージ設定は変更していません。\n');
