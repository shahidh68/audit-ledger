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
var import_client_secrets_manager = require("@aws-sdk/client-secrets-manager");
var import_client_sqs = require("@aws-sdk/client-sqs");
var UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
var SHA256 = /^[0-9a-f]{64}$/i;
var sqs = new import_client_sqs.SQSClient({});
var dynamo = new import_client_dynamodb.DynamoDBClient({});
var secrets = new import_client_secrets_manager.SecretsManagerClient({});
var cachedTenantKeyMap = null;
async function getTenantKeyMap() {
  if (cachedTenantKeyMap) return cachedTenantKeyMap;
  const secretArn = process.env.TENANT_KEY_SECRET_ARN;
  if (!secretArn) throw new Error("TENANT_KEY_SECRET_ARN not set");
  const result = await secrets.send(new import_client_secrets_manager.GetSecretValueCommand({ SecretId: secretArn }));
  const raw = result.SecretString ?? "{}";
  const map = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) map.set(k.trim(), v.trim());
    }
  } catch {
    console.error("Failed to parse tenant key map from Secrets Manager");
  }
  cachedTenantKeyMap = map;
  return map;
}
function invalidateKeyCache() {
  cachedTenantKeyMap = null;
}
async function checkRateLimit(tenantId) {
  const tableName = process.env.RATE_LIMIT_TABLE;
  const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "100", 10);
  if (!tableName) return { allowed: true, count: 0 };
  const windowStart = Math.floor(Date.now() / 6e4);
  const pk = `${tenantId}#${windowStart}`;
  const ttl = Math.floor(Date.now() / 1e3) + 120;
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
  return { allowed: count <= limit, count };
}
function json(statusCode, body, extra) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      ...extra
    },
    body: JSON.stringify(body)
  };
}
async function handler(event) {
  const queueUrl = process.env.QUEUE_URL;
  if (!queueUrl) {
    console.error("QUEUE_URL missing");
    return json(500, { error: "Server misconfiguration" });
  }
  const apiKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"] ?? event.headers["x-apikey"];
  if (!apiKey) {
    return json(401, { error: "Missing API key" });
  }
  let tenantKeyMap;
  try {
    tenantKeyMap = await getTenantKeyMap();
  } catch (e) {
    console.error("Failed to load tenant keys", e);
    return json(500, { error: "Server misconfiguration" });
  }
  let tenantId = tenantKeyMap.get(apiKey);
  if (!tenantId) {
    invalidateKeyCache();
    try {
      tenantKeyMap = await getTenantKeyMap();
      tenantId = tenantKeyMap.get(apiKey);
    } catch {
    }
  }
  if (!tenantId) {
    return json(401, { error: "Invalid API key" });
  }
  const { allowed, count } = await checkRateLimit(tenantId);
  const limit = parseInt(process.env.RATE_LIMIT_PER_MINUTE ?? "100", 10);
  if (!allowed) {
    console.warn({ tenantId, count, limit, message: "Rate limit exceeded" });
    return json(
      429,
      { error: "Rate limit exceeded", limit_per_minute: limit },
      { "Retry-After": "60", "X-RateLimit-Limit": String(limit), "X-RateLimit-Remaining": "0" }
    );
  }
  let payload;
  try {
    payload = JSON.parse(event.body ?? "{}");
  } catch {
    return json(400, { error: "Invalid JSON body" });
  }
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
    return json(400, { error: "event_id must be UUID v4" });
  }
  if (typeof timestamp !== "string" || !timestamp.length) {
    return json(400, { error: "timestamp must be ISO 8601 string" });
  }
  if (typeof model_version !== "string" || !model_version.length) {
    return json(400, { error: "model_version required" });
  }
  if (typeof system_prompt_hash !== "string" || !SHA256.test(system_prompt_hash)) {
    return json(400, { error: "system_prompt_hash must be SHA-256 hex" });
  }
  if (typeof input_data_hash !== "string" || !SHA256.test(input_data_hash)) {
    return json(400, { error: "input_data_hash must be SHA-256 hex" });
  }
  if (typeof ai_decision_output !== "object" || ai_decision_output === null || Array.isArray(ai_decision_output)) {
    return json(400, { error: "ai_decision_output must be a JSON object" });
  }
  if (typeof human_in_loop !== "boolean") {
    return json(400, { error: "human_in_loop must be boolean" });
  }
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
  return {
    statusCode: 202,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "X-RateLimit-Limit": String(limit),
      "X-RateLimit-Remaining": String(Math.max(0, limit - count))
    },
    body: JSON.stringify({ message: "Accepted", event_id })
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
