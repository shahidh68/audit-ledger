import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secrets = new SecretsManagerClient({});

export interface KeyCache {
  /**
   * Resolve an API key to its tenant ID.
   * Returns null if the key is not in the map.
   * Throws only if Secrets Manager itself is unreachable on the first load.
   * A single retry after cache-invalidation is performed transparently to
   * handle key rotation without redeployment.
   */
  resolveTenantId(apiKey: string): Promise<string | null>;
  invalidate(): void;
}

/**
 * Creates a module-scoped key cache backed by a Secrets Manager secret.
 * The secret must be a JSON object mapping API key → tenant ID.
 *
 * @param secretArnEnvVar  Name of the environment variable holding the secret ARN.
 */
export function createKeyCache(secretArnEnvVar: string): KeyCache {
  let cached: Map<string, string> | null = null;

  async function load(): Promise<Map<string, string>> {
    if (cached) return cached;

    const secretArn = process.env[secretArnEnvVar];
    if (!secretArn) throw new Error(`${secretArnEnvVar} not set`);

    const result = await secrets.send(new GetSecretValueCommand({ SecretId: secretArn }));
    const map = new Map<string, string>();

    try {
      const parsed = JSON.parse(result.SecretString ?? '{}') as Record<string, string>;
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v) map.set(k.trim(), v.trim());
      }
    } catch {
      console.error(`Failed to parse key map from Secrets Manager (${secretArnEnvVar})`);
    }

    cached = map;
    return map;
  }

  function invalidate(): void {
    cached = null;
  }

  async function resolveTenantId(apiKey: string): Promise<string | null> {
    let map = await load(); // throws on Secrets Manager failure — caller returns 500
    let tenantId = map.get(apiKey);

    if (!tenantId) {
      // Invalidate and retry once to handle key rotation without redeployment.
      // If the retry itself fails, treat as key-not-found (return null → 401)
      // rather than surfacing a 500, since the first load already succeeded.
      invalidate();
      try {
        map = await load();
        tenantId = map.get(apiKey);
      } catch {
        /* intentional: first load succeeded; retry failure → key not found */
      }
    }

    return tenantId ?? null;
  }

  return { resolveTenantId, invalidate };
}
