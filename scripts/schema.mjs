import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { schema } from '../src/schema.ts';
const file = new URL('../schemas/release-guard.schema.json', import.meta.url);
const content = JSON.stringify(schema, null, 2) + '\n';
if (process.argv.includes('--check')) {
  if (await readFile(file, 'utf8') !== content) throw new Error('公開JSON Schemaが実装と一致しません。npm run schema を実行してください。');
} else {
  await mkdir(new URL('../schemas/', import.meta.url), { recursive: true });
  await writeFile(file, content);
}
