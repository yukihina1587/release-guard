import { readFile, realpath, stat } from 'node:fs/promises';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { Ajv } from 'ajv';
import { schema } from './schema.ts';
import { GuardError } from './model.ts';
import type { Config, LoadedConfig } from './model.ts';

const validate = new Ajv({ allErrors: false }).compile<Config>(schema);
function invalid(): never { throw new GuardError('INVALID_CONFIG', '設定・必須環境変数・ビルド成果物を確認してください。'); }
export async function readJson(path: string, limit = 2_000_000): Promise<unknown> {
  try {
    if ((await stat(path)).size > limit) invalid();
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch { return invalid(); }
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part !== '..' && !part.startsWith('../') && !isAbsolute(part);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(x => typeof x === 'string')) return invalid();
  return value;
}
function origin(value: string): URL {
  let u: URL;
  try { u = new URL(value); } catch { return invalid(); }
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/') invalid();
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname))) invalid();
  return u;
}
export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<LoadedConfig> {
  const value = await readJson(path);
  if (!validate(value)) invalid();
  const config = structuredClone(value);
  const baseDirectory = dirname(resolve(path));
  const baseUrl = origin(config.target.baseUrl);
  config.target.baseUrl = baseUrl.origin;
  config.target.assetOrigins = config.target.assetOrigins.map(x => origin(x).origin);
  const expectedRelease = env[config.releaseIdentity.expectedFromEnv];
  if (!expectedRelease || expectedRelease.length > 512) invalid();
  const ids = new Set<string>();
  for (const j of config.journeys) {
    if (ids.has(j.id)) invalid();
    ids.add(j.id);
    if (!j.startPath.startsWith('/') || j.startPath.startsWith('//') || j.startPath.includes('\\')) invalid();
    if (new URL(j.startPath, baseUrl).origin !== baseUrl.origin || /[?#]/.test(j.startPath)) invalid();
    if (!j.lazyAssetPattern.startsWith('/') || /[?#\\]/.test(j.lazyAssetPattern)) invalid();
  }
  if (!config.build.publicBase.startsWith('/') || config.build.publicBase.startsWith('//') || /[?#\\]|\.\./.test(config.build.publicBase)) invalid();
  if (!config.build.publicBase.endsWith('/')) invalid();
  const distributionId = config.cloudfront.distributionIdFromEnv ? env[config.cloudfront.distributionIdFromEnv] : undefined;
  if (config.cloudfront.mode !== 'disabled' && (!distributionId || !/^[A-Z0-9]{1,32}$/.test(distributionId))) invalid();
  try {
    config.build.directory = await realpath(resolve(baseDirectory, config.build.directory));
    config.build.manifest = await realpath(resolve(baseDirectory, config.build.manifest));
    if (!inside(config.build.directory, config.build.manifest)) invalid();
    if (config.auth) config.auth.storageStateFile = await realpath(resolve(baseDirectory, config.auth.storageStateFile));
  } catch { invalid(); }
  if (config.auth) record(await readJson(config.auth.storageStateFile));
  config.report.directory = resolve(baseDirectory, config.report.directory);
  const manifest = record(await readJson(config.build.manifest));
  if (!Object.keys(manifest).length) invalid();
  const assetPaths = new Set<string>();
  for (const chunk of Object.values(manifest)) {
    const c = record(chunk);
    if (typeof c.file !== 'string') invalid();
    for (const key of [...strings(c.imports), ...strings(c.dynamicImports)]) if (!Object.hasOwn(manifest, key)) invalid();
    for (const file of [c.file, ...strings(c.css), ...strings(c.assets)]) {
      if (!file || isAbsolute(file) || /[?#\\]|(^|\/)\.\.(\/|$)/.test(file)) invalid();
      try {
        const full = await realpath(resolve(config.build.directory, file));
        if (!inside(config.build.directory, full) || !(await stat(full)).isFile()) invalid();
      } catch { invalid(); }
      assetPaths.add(new URL(config.build.publicBase + file, baseUrl).pathname);
    }
  }
  return { config, expectedRelease, distributionId, assetPaths, baseDirectory };
}
