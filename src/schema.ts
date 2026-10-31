const string = { type: 'string', minLength: 1, maxLength: 2048 };
const id = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,80}$' };
const seconds = { type: 'number', minimum: 0.05, maximum: 86400 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)): Record<string, unknown> =>
  ({ type: 'object', properties, required, additionalProperties: false });
export const schema = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...object({
    schemaVersion: { const: 1 },
    target: object({ baseUrl: string, assetOrigins: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: string } }),
    releaseIdentity: object({ selector: string, attribute: id, expectedFromEnv: id }),
    build: object({ adapter: { const: 'vite' }, directory: string, manifest: string, publicBase: string }),
    cloudfront: object({ mode: { enum: ['disabled', 'optional', 'required'] }, distributionIdFromEnv: id }, ['mode']),
    timeouts: object({ deploymentSeconds: seconds, publicationSeconds: seconds, actionSeconds: seconds, totalSeconds: seconds }),
    auth: object({ storageStateFile: string }),
    journeys: {
      type: 'array', minItems: 1, maxItems: 3,
      items: object({
        id, startPath: string, ready: object({ testId: id }), lazyAssetPattern: string,
        continuity: { const: 'preserve-document' },
        steps: { type: 'array', minItems: 1, maxItems: 20, items: {
          oneOf: [
            object({ action: { enum: ['click', 'expectVisible'] }, testId: id }),
            object({ action: { const: 'expectText' }, testId: id, text: string }),
          ],
        } },
      }),
    },
    report: object({ directory: string }),
  }, ['schemaVersion', 'target', 'releaseIdentity', 'build', 'cloudfront', 'timeouts', 'journeys', 'report']),
};
