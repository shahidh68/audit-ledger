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

// lambda/read.ts
var read_exports = {};
__export(read_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(read_exports);

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

// lambda/lib/auditRepository.ts
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_client_s3 = require("@aws-sdk/client-s3");
var import_util_dynamodb = require("@aws-sdk/util-dynamodb");
var dynamo = new import_client_dynamodb.DynamoDBClient({});
var s3 = new import_client_s3.S3Client({});
async function listTenantEvents(tableName, tenantId, from, to) {
  const keyCondition = from && to ? "tenant_id = :tid AND sk BETWEEN :from AND :to" : "tenant_id = :tid";
  const expressionValues = {
    ":tid": { S: tenantId }
  };
  if (from && to) {
    expressionValues[":from"] = { S: `${from}#` };
    expressionValues[":to"] = { S: `${to}~` };
  }
  const result = await dynamo.send(new import_client_dynamodb.QueryCommand({
    TableName: tableName,
    KeyConditionExpression: keyCondition,
    ExpressionAttributeValues: expressionValues,
    ScanIndexForward: false
    // newest first
  }));
  return (result.Items ?? []).map((i) => (0, import_util_dynamodb.unmarshall)(i));
}
async function scanAllEvents(tableName, from, to) {
  const result = await dynamo.send(new import_client_dynamodb.ScanCommand({
    TableName: tableName,
    ...from && to && {
      FilterExpression: "#ts >= :from AND #ts <= :to",
      ExpressionAttributeNames: { "#ts": "timestamp" },
      ExpressionAttributeValues: {
        ":from": { S: from },
        ":to": { S: to }
      }
    }
  }));
  return (result.Items ?? []).map((i) => (0, import_util_dynamodb.unmarshall)(i));
}
async function findEventById(tableName, eventId) {
  const result = await dynamo.send(new import_client_dynamodb.QueryCommand({
    TableName: tableName,
    IndexName: "event_id-index",
    KeyConditionExpression: "event_id = :eid",
    ExpressionAttributeValues: { ":eid": { S: eventId } }
  }));
  return result.Items?.length ? (0, import_util_dynamodb.unmarshall)(result.Items[0]) : null;
}
async function fetchArchivedRecord(bucketName, tenantId, eventId) {
  try {
    const s3Result = await s3.send(new import_client_s3.GetObjectCommand({
      Bucket: bucketName,
      Key: `${tenantId}/${eventId}.json`
    }));
    const body = await s3Result.Body?.transformToString();
    const record = body ? JSON.parse(body) : null;
    return { record, note: "" };
  } catch (e) {
    const note = e instanceof import_client_s3.NoSuchKey ? "S3 archive record not found \u2014 may still be processing." : "Could not retrieve S3 archive for comparison.";
    return { record: null, note };
  }
}

// lambda/read.ts
var readKeyCache = createKeyCache("READ_KEY_SECRET_ARN");
async function handler(event) {
  const tableName = process.env.AUDIT_TABLE;
  const bucketName = process.env.AUDIT_BUCKET;
  if (!tableName || !bucketName) return json(500, { error: "Server misconfiguration" });
  const presentedKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"];
  if (!presentedKey) return json(401, { error: "Missing read API key" });
  let callerTenantId;
  try {
    callerTenantId = await readKeyCache.resolveTenantId(presentedKey);
  } catch (e) {
    console.error("Failed to load read keys", e);
    return json(500, { error: "Server misconfiguration" });
  }
  if (!callerTenantId) return json(401, { error: "Invalid read API key" });
  const isAdmin = callerTenantId === "*";
  const eventId = event.pathParameters?.eventId;
  const isHistory = Boolean(eventId) && /\/history\/?$/.test(event.path ?? "");
  try {
    if (isHistory && eventId) {
      return await handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName);
    }
    return await handleList(event, callerTenantId, isAdmin, tableName);
  } catch (e) {
    console.error("Query failed", e);
    return json(500, { error: "Query failed", detail: String(e) });
  }
}
async function handleList(event, callerTenantId, isAdmin, tableName) {
  const from = event.queryStringParameters?.from;
  const to = event.queryStringParameters?.to;
  const rawItems = isAdmin ? await scanAllEvents(tableName, from, to) : await listTenantEvents(tableName, callerTenantId, from, to);
  const items = rawItems.map(({ sk: _sk, ...rest }) => rest).sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  return json(200, {
    items,
    tenant_id: isAdmin ? void 0 : callerTenantId,
    count: items.length
  });
}
async function handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName) {
  const rawRecord = await findEventById(tableName, eventId);
  if (!rawRecord) return json(404, { error: "Event not found" });
  if (!isAdmin && rawRecord.tenant_id !== callerTenantId) {
    return json(404, { error: "Event not found" });
  }
  const tenantId = String(rawRecord.tenant_id);
  const { sk: _sk, ...dbRecord } = rawRecord;
  const { record: s3Record, note: archiveNote } = await fetchArchivedRecord(bucketName, tenantId, eventId);
  let integrityVerified = false;
  let integrityNote = archiveNote;
  if (s3Record) {
    const sortKeys = (o) => {
      if (typeof o !== "object" || o === null || Array.isArray(o)) return o;
      return Object.fromEntries(
        Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])
      );
    };
    integrityVerified = JSON.stringify(sortKeys(dbRecord)) === JSON.stringify(sortKeys(s3Record));
    integrityNote = integrityVerified ? "Record matches immutable S3 archive. No tampering detected." : "WARNING: Record does not match S3 archive. Possible tampering \u2014 investigate immediately.";
  }
  return json(200, {
    event_id: eventId,
    integrity_verified: integrityVerified,
    integrity_note: integrityNote,
    current_record: dbRecord,
    archived_record: s3Record
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
