/**
 * Test configuration — fill in your values before running.
 * Find these in AWS Console → CloudFormation → AiAuditLedgerStack → Outputs
 */

export const config = {
  // The full ingest URL including /audit/events
  // Example: https://xxxxxxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/events
  INGEST_URL: 'https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/audit/events',

  // The full read URL including /audit/logs
  // Example: https://xxxxxxxx.execute-api.eu-west-1.amazonaws.com/prod/audit/logs
  READ_URL: 'https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/audit/logs',

  // The base API URL without a trailing slash
  // Example: https://xxxxxxxx.execute-api.eu-west-1.amazonaws.com/prod
  API_BASE_URL: 'https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod/',

  // A valid tenant API key from your Secrets Manager TenantKeyMap
  TENANT_KEY: 'P+u7J*7=LKpk)qf4Z#busL_nx_gca6p~~gPEHJMe',

  // A valid read API key from your Secrets Manager ReadKeyMap
  READ_KEY: '%+n}=YVC:3+y@pfT_~ZxZ?B4Y1*=',
};
