export interface Step {
  action: 'click' | 'expectVisible' | 'expectText';
  testId: string;
  text?: string;
}
export interface Journey {
  id: string;
  startPath: string;
  ready: { testId: string };
  lazyAssetPattern: string;
  continuity: 'preserve-document';
  steps: Step[];
}
export interface Config {
  schemaVersion: 1;
  target: { baseUrl: string; assetOrigins: string[] };
  releaseIdentity: { selector: string; attribute: string; expectedFromEnv: string };
  build: { adapter: 'vite'; directory: string; manifest: string; publicBase: string };
  cloudfront: { mode: 'disabled' | 'optional' | 'required'; distributionIdFromEnv?: string };
  timeouts: { deploymentSeconds: number; publicationSeconds: number; actionSeconds: number; totalSeconds: number };
  journeys: Journey[];
  report: { directory: string };
  auth?: { storageStateFile: string };
}
export interface LoadedConfig {
  config: Config;
  expectedRelease: string;
  distributionId?: string;
  assetPaths: Set<string>;
  baseDirectory: string;
}
export type Phase = 'baseline' | 'armed' | 'old' | 'publication' | 'new';
export interface Observation {
  id: string;
  time: string;
  phase: Phase;
  journeyId: string;
  path: string;
  kind: 'response' | 'requestfailed';
  resourceType: string;
  asset: boolean;
  lazy: boolean;
  inManifest: boolean;
  status?: number;
  headers: Record<string, string>;
}
export interface Finding {
  ruleId: string;
  severity: 'error' | 'warning';
  journeyId?: string;
  phase?: Phase;
  fact: string;
  evidenceIds: string[];
  hypotheses: string[];
  suggestedChecks: string[];
}
export interface JourneyResult {
  id: string;
  old: 'pending' | 'passed' | 'failed' | 'inconclusive';
  new: 'pending' | 'passed' | 'failed' | 'inconclusive';
}
export interface Behavior {
  pathPattern: string;
  minTTL?: number;
  edgeFunction: boolean;
}
export interface Snapshot {
  time: string;
  etag?: string;
  behaviors: Behavior[];
  htmlErrorResponse: boolean;
}
export interface Report {
  schemaVersion: 1;
  runId: string;
  startedAt: string;
  finishedAt?: string;
  execution: { status: 'completed' | 'error' | 'cancelled'; stage: string; deploymentStarted: boolean; errorCode?: string; message?: string };
  verdict: 'passed' | 'failed' | 'inconclusive';
  coverage: { oldDocument: string; newDocument: string; cloudfront: string; locations: number; limitations: string[] };
  journeys: JourneyResult[];
  observations: Observation[];
  findings: Finding[];
  snapshots: Snapshot[];
}
export class GuardError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
export function safeError(error: unknown): GuardError {
  return error instanceof GuardError ? error : new GuardError('INTERNAL_ERROR', '処理を完了できませんでした。認証・対象環境・実行環境を確認してください。');
}
