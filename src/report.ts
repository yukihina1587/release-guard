import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { Report } from './model.ts';

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
export function renderHtml(report: Report): string {
  const e = escapeHtml;
  const rows = report.journeys.map(j => `<tr><td>${e(j.id)}</td><td>${e(j.old)}</td><td>${e(j.new)}</td></tr>`).join('');
  const findings = report.findings.map(f => `<article><h3>${e(f.ruleId)}</h3><p>${e(f.fact)}</p><p>${e(f.journeyId ?? '')} / ${e(f.phase ?? '')}</p><p>証拠: ${e(f.evidenceIds.join(', '))}</p><p>${e(f.hypotheses.join(' '))}</p><p>${e(f.suggestedChecks.join(' '))}</p></article>`).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Release Guard</title><style>body{font:16px system-ui;background:#f5f7fa;color:#172033;max-width:1000px;margin:40px auto;padding:20px}article,section{background:white;border:1px solid #dbe1eb;border-radius:8px;padding:20px;margin:16px 0}table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:12px;border-bottom:1px solid #ddd}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}.verdict{font-size:28px;font-weight:bold}</style><h1>Release Guard</h1><p class="verdict">${e(report.verdict)}</p><p>${e(report.execution.message ?? '')}</p><section><h2>旧版と新版の比較</h2><table><tr><th>シナリオ</th><th>旧版</th><th>新版</th></tr>${rows}</table></section><section><h2>検証範囲</h2><pre>${e(JSON.stringify(report.coverage, null, 2))}</pre></section><h2>検出結果</h2>${findings || '<p>不具合の検出はありません。検証範囲を確認してください。</p>'}<details><summary>通信の証拠</summary><pre>${e(JSON.stringify(report.observations, null, 2))}</pre></details></html>`;
}
export async function writeReport(directory: string, report: Report): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const output = join(directory, report.runId);
  await mkdir(output, { mode: 0o700 });
  for (const [name, content] of [['report.json', JSON.stringify(report, null, 2)], ['report.html', renderHtml(report)]]) {
    const target = join(output, name!);
    await writeFile(`${target}.tmp`, content!, { mode: 0o600, flag: 'wx' });
    await rename(`${target}.tmp`, target);
  }
  return output;
}
