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
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_client_s3 = require("@aws-sdk/client-s3");
var import_client_secrets_manager = require("@aws-sdk/client-secrets-manager");
var import_util_dynamodb = require("@aws-sdk/util-dynamodb");
var dynamo = new import_client_dynamodb.DynamoDBClient({});
var s3 = new import_client_s3.S3Client({});
var secrets = new import_client_secrets_manager.SecretsManagerClient({});
var cachedReadKeyMap = null;
async function getReadKeyMap() {
  if (cachedReadKeyMap) return cachedReadKeyMap;
  const secretArn = process.env.READ_KEY_SECRET_ARN;
  if (!secretArn) throw new Error("READ_KEY_SECRET_ARN not set");
  const result = await secrets.send(new import_client_secrets_manager.GetSecretValueCommand({ SecretId: secretArn }));
  const raw = result.SecretString ?? "{}";
  const map = /* @__PURE__ */ new Map();
  try {
    const parsed = JSON.parse(raw);
    for (const [k, v] of Object.entries(parsed)) {
      if (k && v) map.set(k.trim(), v.trim());
    }
  } catch {
    console.error("Failed to parse read key map from Secrets Manager");
  }
  cachedReadKeyMap = map;
  return map;
}
function invalidateReadKeyCache() {
  cachedReadKeyMap = null;
}
function json(statusCode, body) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify(body)
  };
}
async function handler(event) {
  const tableName = process.env.AUDIT_TABLE;
  const bucketName = process.env.AUDIT_BUCKET;
  if (!tableName || !bucketName) {
    return json(500, { error: "Server misconfiguration" });
  }
  const presentedKey = event.headers["x-api-key"] ?? event.headers["X-Api-Key"];
  if (!presentedKey) return json(401, { error: "Missing read API key" });
  let readKeyMap;
  try {
    readKeyMap = await getReadKeyMap();
  } catch (e) {
    console.error("Failed to load read keys", e);
    return json(500, { error: "Server misconfiguration" });
  }
  let callerTenantId = readKeyMap.get(presentedKey);
  if (!callerTenantId) {
    invalidateReadKeyCache();
    try {
      readKeyMap = await getReadKeyMap();
      callerTenantId = readKeyMap.get(presentedKey);
    } catch {
    }
  }
  if (!callerTenantId) return json(401, { error: "Invalid read API key" });
  const isAdmin = callerTenantId === "*";
  const path = event.path ?? "";
  const eventId = event.pathParameters?.eventId;
  const isHistory = Boolean(eventId) && /\/history\/?$/.test(path);
  try {
    if (isHistory && eventId) {
      return await handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName);
    }
    return await handleList(event, callerTenantId, isAdmin, tableName);
  } catch (e) {
    console.error(e);
    return json(500, { error: "Query failed", detail: String(e) });
  }
}
async function handleList(event, callerTenantId, isAdmin, tableName) {
  const from = event.queryStringParameters?.from;
  const to = event.queryStringParameters?.to;
  let items = [];
  if (isAdmin) {
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
    items = (result.Items ?? []).map((i) => (0, import_util_dynamodb.unmarshall)(i));
  } else {
    const keyCondition = from && to ? "tenant_id = :tid AND sk BETWEEN :from AND :to" : "tenant_id = :tid";
    const expressionValues = {
      ":tid": { S: callerTenantId }
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
    items = (result.Items ?? []).map((i) => (0, import_util_dynamodb.unmarshall)(i));
  }
  items.forEach((item) => delete item.sk);
  items.sort((a, b) => String(b.timestamp ?? "").localeCompare(String(a.timestamp ?? "")));
  return json(200, {
    items,
    tenant_id: isAdmin ? void 0 : callerTenantId,
    count: items.length
  });
}
async function handleHistory(eventId, callerTenantId, isAdmin, tableName, bucketName) {
  const queryResult = await dynamo.send(new import_client_dynamodb.QueryCommand({
    TableName: tableName,
    IndexName: "event_id-index",
    KeyConditionExpression: "event_id = :eid",
    ExpressionAttributeValues: { ":eid": { S: eventId } }
  }));
  if (!queryResult.Items?.length) {
    return json(404, { error: "Event not found" });
  }
  const dbRecord = (0, import_util_dynamodb.unmarshall)(queryResult.Items[0]);
  if (!isAdmin && dbRecord.tenant_id !== callerTenantId) {
    return json(404, { error: "Event not found" });
  }
  const tenantId = String(dbRecord.tenant_id);
  delete dbRecord.sk;
  let s3Record = null;
  let integrityVerified = false;
  let integrityNote = "";
  try {
    const s3Result = await s3.send(new import_client_s3.GetObjectCommand({
      Bucket: bucketName,
      Key: `${tenantId}/${eventId}.json`
    }));
    const body = await s3Result.Body?.transformToString();
    s3Record = body ? JSON.parse(body) : null;
  } catch (e) {
    if (e instanceof import_client_s3.NoSuchKey) {
      integrityNote = "S3 archive record not found \u2014 may still be processing.";
    } else {
      integrityNote = "Could not retrieve S3 archive for comparison.";
    }
  }
  if (s3Record) {
    const sortKeys = (o) => {
      if (typeof o !== "object" || o === null || Array.isArray(o)) return o;
      return Object.fromEntries(
        Object.keys(o).sort().map((k) => [k, sortKeys(o[k])])
      );
    };
    const dbJson = JSON.stringify(sortKeys(dbRecord));
    const s3Json = JSON.stringify(sortKeys(s3Record));
    integrityVerified = dbJson === s3Json;
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
