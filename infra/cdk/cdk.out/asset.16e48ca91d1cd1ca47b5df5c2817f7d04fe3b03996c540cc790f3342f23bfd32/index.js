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

// lambda/processor.ts
var processor_exports = {};
__export(processor_exports, {
  handler: () => handler
});
module.exports = __toCommonJS(processor_exports);
var import_client_dynamodb = require("@aws-sdk/client-dynamodb");
var import_client_s3 = require("@aws-sdk/client-s3");
var import_util_dynamodb = require("@aws-sdk/util-dynamodb");

// lambda/lib/config.ts
var RETENTION_YEARS_DEFAULT = 7;
function parseEnvInt(key, fallback) {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}

// lambda/processor.ts
var dynamo = new import_client_dynamodb.DynamoDBClient({});
var s3 = new import_client_s3.S3Client({});
var retentionYears = parseEnvInt("RETENTION_YEARS", RETENTION_YEARS_DEFAULT);
async function handler(event) {
  const tableName = process.env.AUDIT_TABLE;
  const bucketName = process.env.AUDIT_BUCKET;
  if (!tableName || !bucketName) {
    throw new Error("AUDIT_TABLE or AUDIT_BUCKET not set");
  }
  for (const record of event.Records) {
    const body = JSON.parse(record.body);
    delete body._ingested_at;
    const tenantId = String(body.tenant_id ?? "");
    const eventId = String(body.event_id ?? "");
    const timestamp = String(body.timestamp ?? (/* @__PURE__ */ new Date()).toISOString());
    const sk = `${timestamp}#${eventId}`;
    try {
      await dynamo.send(new import_client_dynamodb.PutItemCommand({
        TableName: tableName,
        Item: (0, import_util_dynamodb.marshall)({ ...body, sk }, { removeUndefinedValues: true }),
        ConditionExpression: "attribute_not_exists(sk)"
      }));
    } catch (e) {
      if (!(e instanceof import_client_dynamodb.ConditionalCheckFailedException)) throw e;
    }
    const retainUntil = /* @__PURE__ */ new Date();
    retainUntil.setFullYear(retainUntil.getFullYear() + retentionYears);
    await s3.send(new import_client_s3.PutObjectCommand({
      Bucket: bucketName,
      Key: `${tenantId}/${eventId}.json`,
      Body: JSON.stringify(body),
      ContentType: "application/json",
      ObjectLockMode: "COMPLIANCE",
      ObjectLockRetainUntilDate: retainUntil
    }));
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  handler
});
