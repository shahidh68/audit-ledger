"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// lambda/ingest.ts
var ingest_exports = {};
__export(ingest_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(ingest_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_client_sqs = require("@aws-sdk/client-sqs");

// lambda/lib/secretsCache.ts
var import_client_secrets_manager = require("@aws-sdk/client-secrets-manager");
var secrets = new import_client_secrets_manager.SecretsManagerClient({});
function createKeyCache(secretArnEnvVar) {
  let cached = null;
  async function load() {
    if (cached) return cached;
    const secretArn = process.env[secretArnEnvVar];
    if (!secretArn) throw new Error(`${secretArnEnvVar} not set`);
    const result = await secrets.send(new import_client_secrets_manager.GetSecretValueCommand({ SecretId: secretArn }));
    const map = /* @__PURE__ */ new Map();
    try {
      const parsed = JSON.parse(result.SecretString ?? "{}");
      for (const [k, v] of Object.entries(parsed)) {
        if (k && v) map.set(k.trim(), v.trim());
      }
    } catch {
      console.error(`Failed to parse key map from Secrets Manager (${secretArnEnvVar})`);
    }
    cached = map;
    return map;
  }
  function invalidate() {
    cached = null;
  }
  async function resolveTenantId(apiKey) {
    let map = await load();
    let tenantId = map.get(apiKey);
    if (!tenantId) {
      invalidate();
      try {
        map = await load();
        tenantId = map.get(apiKey);
      } catch {
      }
    }
    return tenantId ?? null;
  }
  return { resolveTenantId, invalidate };
}

// lambda/lib/config.ts
var RATE_LIMIT_DEFAULT = 100;
var RATE_LIMIT_WINDOW_MS = 6e4;
var RATE_LIMIT_TTL_S = 120;
function parseEnvInt(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// lambda/lib/validation.ts
var UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SHA256 = /^[0-9a-f]{64}$/i;
function validateIngestionPayload(payload) {
  const {
    event_id,
    timestamp,
    model_version,
    system_prompt_hash,
    input_data_hash,
    ai_decision_output,
    human_in_loop
  } = payload;
  if (typeof event_id !== "string" || !UUID4.test(event_id)) {
    return "event_id must be UUID v4";
  }
  if (typeof timestamp !== "string" || !timestamp.length) {
    return "timestamp must be ISO 8601 string";
  }
  if (typeof model_version !== "string" || !model_version.length) {
    return "model_version required";
  }
  if (typeof system_prompt_hash !== "string" || !SHA256.test(system_prompt_hash)) {
    return "system_prompt_hash must be SHA-256 hex";
  }
  if (typeof input_data_hash !== "string" || !SHA256.test(input_data_hash)) {
    return "input_data_hash must be SHA-256 hex";
  }
  if (typeof ai_decision_output !== "object" || ai_decision_output === null || Array.isArray(ai_decision_output)) {
    return "ai_decision_output must be a JSON object";
  }
  if (typeof human_in_loop !== "boolean") {
    return "human_in_loop must be boolean";
  }
  return null;
}

// lambda/lib/response.ts
function json(statusCode, body, extraHeaders) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    },
    body: JSON.stringify(body)
  };
}

// lambda/ingest.ts
var sqs = new import_client_sqs.SQSClient({});
var dynamo = new import_client_dynamodb.DynamoDBClient({});
var tenantKeyCache = createKeyCache("TENANT_KEY_SECRET_ARN");
var RATE_LIMIT = parseEnvInt("RATE_LIMIT_PER_MINUTE", RATE_LIMIT_DEFAULT);
async function checkRateLimit(tenantId) {
  const tableName = process.env.RATE_LIMIT_TABLE;
  if (!tableName) return { allowed: true, count: 0 };
  const windowStart = Math.floor(Date.now() / RATE_LIMIT_WINDOW_MS);
  const pk = `${tenantId}#${windowStart}`;
  const ttl = Math.floor(Date.now() / 1e3) + RATE_LIMIT_TTL_S;
  const result = await dynamo.send(
    new import_client_dynamodb.UpdateItemCommand({
      TableName: tableName,
      Key: { pk: { S: pk } },
      UpdateExpression: "ADD #count :one SET #ttl = if_not_exists(#ttl, :ttl)",
      ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
      ExpressionAttributeValues: {
        ":one": { N: "1" },
        ":ttl": { N: String(ttl) }
      },
      ReturnValues: "ALL_NEW"
    })
  );
  const count = parseInt(result.Attributes?.count?.N ?? "1", 10);
  return { allowed: count <= RATE_LIMIT, count };
}
async function handler(event) {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) {
    console.error("QUEUE_URL missing");
    return json(500, { error: "Server misconfiguration" });
  }
  const apiKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"] ?? event.headers["x-apikey"];
  if (!apiKey) return json(401, { error: "Missing API key" });
  let tenantId;
  try {
    tenantId = await tenantKeyCache.resolveTenantId(apiKey);
  } catch (e) {
    console.error("Failed to load tenant keys", e);
    return json(500, { error: "Server misconfiguration" });
  }
  if (!tenantId) return json(401, { error: "Invalid API key" });
  const { allowed, count } = await checkRateLimit(tenantId);
  if (!allowed) {
    console.warn({ tenantId, count, limit: RATE_LIMIT, message: "Rate limit exceeded" });
    return json(
      429,
      { error: "Rate limit exceeded", limit_per_minute: RATE_LIMIT },
      { "Retry-After": "60", "X-RateLimit-Limit": String(RATE_LIMIT), "X-RateLimit-Remaining": "0" }
    );
  }
  let payload;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
  const validationError = validateIngestionPayload(payload);
  if (validationError) return json(400, { error: validationError });
  const { event_id } = payload;
  const { tenant_api_key: _drop, ...safePayload } = payload;
  const messageBody = JSON.stringify({
    ...safePayload,
    tenant_id: tenantId,
    _ingested_at: (/* @__PURE__ */ new Date()).toISOString()
  });
  try {
    await sqs.send(new import_client_sqs.SendMessageCommand({ QueueUrl: queueUrl, MessageBody: messageBody }));
  } catch (e) {
    console.error("SQS send failed", e);
    return json(502, { error: "Failed to enqueue audit event" });
  }
  return json(
    202,
    { message: "Accepted", event_id },
    {
      "X-RateLimit-Limit": String(RATE_LIMIT),
      "X-RateLimit-Remaining": String(Math.max(0, RATE_LIMIT - count))
    }
  );
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
