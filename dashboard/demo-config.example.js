// Demo-mode credentials for the public dashboard.
//
// This file is the TEMPLATE. To enable demo mode:
//   1. Copy this file to `demo-config.js` (same directory).
//   2. Fill in the values below with the demo-public tenant credentials.
//   3. Deploy `demo-config.js` alongside `index.html` to your CloudFront origin.
//   4. Visitors using `?demo=1` will land directly in the dashboard.
//
// SECURITY NOTES
//   - The read_key below is downloaded by every visitor of the demo page.
//     This is acceptable ONLY if the key is scoped to a tenant that contains
//     synthetic data only.
//   - Never put a write key, admin key, or real-tenant read key in this file.
//   - The actual `demo-config.js` is gitignored — do not commit it.

window.AUDIT_LEDGER_DEMO_CONFIG = {
  // Base URL of the deployed audit-ledger API (no trailing slash).
  // Example: https://m3csva3l3h.execute-api.eu-west-1.amazonaws.com/prod
  api_url: "https://<your-api-id>.execute-api.<your-region>.amazonaws.com/prod",

  // Read API key scoped to a synthetic-data-only tenant (e.g. "demo-public").
  // Never use a production tenant's read key here.
  read_key: "<your-demo-public-tenant-read-key>",

  // Optional. The text shown in the yellow banner across the top of the page.
  // Defaults to a generic synthetic-data notice if omitted.
  banner_text: "You are viewing synthetic data on a public demo. Records are seeded examples, not real customer decisions.",
};
