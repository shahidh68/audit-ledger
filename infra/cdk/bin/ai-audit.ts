#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { AiAuditLedgerStack } from '../lib/ai-audit-stack';

const app = new cdk.App();

new AiAuditLedgerStack(app, 'AiAuditLedgerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'eu-west-1',
  },
  description: 'AI Audit Ledger — API Gateway, SQS, QLDB, Lambdas (EU AI Act Article 12)',
});

app.synth();
