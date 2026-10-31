import type { Finding, Observation, Snapshot, Behavior } from './model.ts';

export function matchPattern(pattern: string, path: string, questionMark = false): boolean {
  const escaped = [...pattern].map(c => c === '*' ? '.*' : c === '?' && questionMark ? '.' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  return new RegExp(`^${escaped}$`).test(path);
}
export function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  const type = headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  if (type && ['text/html', 'text/css', 'application/javascript', 'text/javascript', 'application/json', 'application/octet-stream', 'application/x-javascript'].includes(type)) result['content-type'] = type;
  if (headers.age && /^\d{1,12}$/.test(headers.age)) result.age = headers.age;
  if (headers['x-cache'] && /^(Hit|Miss|RefreshHit|Error|LimitExceeded|CapacityExceeded) from cloudfront$/.test(headers['x-cache'])) result['x-cache'] = headers['x-cache'];
  if (headers['x-amz-cf-pop'] && /^[A-Z]{3}\d{1,3}-[A-Z]\d{1,3}$/.test(headers['x-amz-cf-pop'])) result['x-amz-cf-pop'] = headers['x-amz-cf-pop'];
  const cache = headers['cache-control']?.split(',').map(x => x.trim().toLowerCase()).filter(x => /^(public|private|no-cache|no-store|immutable|must-revalidate|proxy-revalidate|max-age=\d{1,12}|s-maxage=\d{1,12}|stale-while-revalidate=\d{1,12}|stale-if-error=\d{1,12})$/.test(x));
  if (cache?.length) result['cache-control'] = cache.join(', ');
  return result;
}
export function finding(ruleId: string, fact: string, observation?: Observation): Finding {
  return { ruleId, severity: 'error', journeyId: observation?.journeyId, phase: observation?.phase, fact, evidenceIds: observation ? [observation.id] : [], hypotheses: [], suggestedChecks: [] };
}
export function behaviorFor(path: string, snapshot: Snapshot): Behavior | undefined {
  if (!path.startsWith('/') || /%|\\|\/\/|(^|\/)\.{1,2}(\/|$)/.test(path)) return undefined;
  return snapshot.behaviors.find(b => matchPattern(b.pathPattern.startsWith('/') ? b.pathPattern : `/${b.pathPattern}`, path, true));
}
export function diagnose(observations: Observation[], snapshot?: Snapshot): Finding[] {
  const findings: Finding[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    if (!['old', 'new'].includes(o.phase) || !o.asset) continue;
    let f: Finding | undefined;
    if (o.kind === 'requestfailed') f = finding('ASSET_REQUEST_FAILED', '対象アセットへの通信が完了しませんでした。', o);
    else if ((o.status ?? 0) >= 400) f = finding('ASSET_HTTP_ERROR', `対象アセットがHTTP ${o.status}を返しました。`, o);
    else if ((o.status ?? 0) >= 200 && (o.status ?? 0) < 300 && o.headers['content-type'] === 'text/html') {
      f = finding('ASSET_HTML_RESPONSE', 'JavaScriptまたはCSSの要求にHTMLが返されました。', o);
      if (snapshot?.htmlErrorResponse) {
        f.hypotheses.push('CloudFrontのカスタムエラー応答がHTMLに変換した可能性があります。');
        f.suggestedChecks.push('旧版アセットの保持とエラー応答設定を確認してください。');
      }
    }
    if (f) {
      const key = `${o.journeyId}:${o.phase}:${o.path}:${f.ruleId}`;
      if (!seen.has(key)) { findings.push(f); seen.add(key); }
    }
    const behavior = snapshot ? behaviorFor(o.path, snapshot) : undefined;
    if ((behavior?.minTTL ?? 0) > 0 && /no-cache|no-store|private/.test(o.headers['cache-control'] ?? '')) {
      const warning = finding('CACHE_MIN_TTL_OVERRIDE', 'Minimum TTLによりCache-Controlの指定より長く保持される可能性があります。', o);
      warning.severity = 'warning';
      findings.push(warning);
    }
  }
  return findings;
}
