import { CloudFrontClient, GetDistributionConfigCommand, GetCachePolicyCommand } from '@aws-sdk/client-cloudfront';
import type { GetDistributionConfigCommandOutput, GetCachePolicyCommandOutput } from '@aws-sdk/client-cloudfront';
import type { LoadedConfig, Snapshot } from './model.ts';
import { GuardError } from './model.ts';

export interface CloudFrontPort {
  distribution(id: string, signal: AbortSignal): Promise<GetDistributionConfigCommandOutput>;
  policy(id: string, signal: AbortSignal): Promise<GetCachePolicyCommandOutput>;
  close(): void;
}
export function awsPort(): CloudFrontPort {
  const client = new CloudFrontClient({ region: 'us-east-1', maxAttempts: 2 });
  return {
    distribution: (id, signal) => client.send(new GetDistributionConfigCommand({ Id: id }), { abortSignal: signal }),
    policy: (id, signal) => client.send(new GetCachePolicyCommand({ Id: id }), { abortSignal: signal }),
    close: () => client.destroy(),
  };
}
export async function snapshot(loaded: LoadedConfig, port: CloudFrontPort, signal: AbortSignal): Promise<Snapshot> {
  try {
    const response = await port.distribution(loaded.distributionId!, signal);
    const config = response.DistributionConfig;
    if (!config?.DefaultCacheBehavior) throw new Error('Missing configuration');
    const policies = new Map<string, number | undefined>();
    const behaviors = [];
    for (const b of [...config.CacheBehaviors?.Items ?? [], config.DefaultCacheBehavior]) {
      if (b.CachePolicyId && !policies.has(b.CachePolicyId)) {
        const p = await port.policy(b.CachePolicyId, signal);
        policies.set(b.CachePolicyId, p.CachePolicy?.CachePolicyConfig?.MinTTL);
      }
      behaviors.push({
        pathPattern: 'PathPattern' in b ? b.PathPattern as string : '*',
        minTTL: b.CachePolicyId ? policies.get(b.CachePolicyId) : b.MinTTL,
        edgeFunction: (b.FunctionAssociations?.Quantity ?? 0) + (b.LambdaFunctionAssociations?.Quantity ?? 0) > 0,
      });
    }
    return { time: new Date().toISOString(), etag: response.ETag, behaviors, htmlErrorResponse: config.CustomErrorResponses?.Items?.some(e => e.ResponseCode === '200' && !!e.ResponsePagePath?.endsWith('.html')) ?? false };
  } catch {
    throw new GuardError('CLOUDFRONT_UNAVAILABLE', 'CloudFront設定を参照できません。権限とディストリビューションを確認してください。');
  }
}
