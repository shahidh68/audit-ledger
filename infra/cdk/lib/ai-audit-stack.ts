import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { BucketDeployment, Source } from 'aws-cdk-lib/aws-s3-deployment';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as eb from 'aws-cdk-lib/aws-events';
import * as ebTargets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sns_subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export class AiAuditLedgerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Rate limit: max requests per tenant per minute (default 100)
    const rateLimitPerMinute = parseInt(
      (this.node.tryGetContext('rateLimitPerMinute') as string | undefined) ?? '100',
      10,
    );

    // Retention: how many years records are locked in S3 (default 7, EU AI Act minimum)
    const retentionYears = parseInt(
      (this.node.tryGetContext('retentionYears') as string | undefined) ?? '7',
      10,
    );

    // Alert email: if provided, CloudWatch will send an email when records fail to save
    const alertEmail = this.node.tryGetContext('alertEmail') as string | undefined;

    // SES sender email: the verified address used to send tenant notifications.
    // The sending domain must be verified in SES before deploying.
    // Pass at deploy time: --context sesSenderEmail=noreply@yourdomain.com
    const sesSenderEmail = (this.node.tryGetContext('sesSenderEmail') as string | undefined) ?? '';

    // ── Secrets Manager ───────────────────────────────────────────────────────
    //
    // Both secrets hold a JSON map that operators populate manually in the AWS
    // Console (or via CLI) after the first deploy:
    //
    //   TenantKeyMapSecret  →  {"<write-key>": "<tenant_id>", ...}
    //   ReadKeyMapSecret    →  {"<read-key>":  "<tenant_id>",
    //                           "<admin-key>": "*"}
    //
    // The Lambdas re-read on every invocation, so updates take effect immediately
    // without redeploying.
    //
    // Why a stable generateSecretString placeholder rather than --context flags?
    // The previous design seeded the secret via `cdk deploy --context ...`. If the
    // operator forgot the flag on a redeploy, CDK's Secret construct silently fell
    // back to its default GenerateSecretString — and CloudFormation then rotated
    // the secret value, wiping all configured keys. The placeholder below keeps
    // the CloudFormation template byte-identical across deploys, so the live
    // secret value is preserved no matter how often the stack is updated.
    const PLACEHOLDER_SECRET_GEN: secretsmanager.SecretStringGenerator = {
      secretStringTemplate: JSON.stringify({ _placeholder: 'populate-via-console' }),
      generateStringKey: '_unused',
      excludePunctuation: true,
      passwordLength: 16,
    };

    const tenantKeySecret = new secretsmanager.Secret(this, 'TenantKeyMapSecret', {
      description: 'JSON map of ingest API key → tenant_id for AI Audit Ledger. ' +
                   'Populate via AWS Console after first deploy.',
      generateSecretString: PLACEHOLDER_SECRET_GEN,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const readKeySecret = new secretsmanager.Secret(this, 'ReadKeyMapSecret', {
      description: 'JSON map of read API key → tenant_id ("*" = admin) for AI Audit Ledger. ' +
                   'Populate via AWS Console after first deploy.',
      generateSecretString: PLACEHOLDER_SECRET_GEN,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Rate limiting table ───────────────────────────────────────────────────
    // pk = "{tenantId}#{minuteWindow}", count = atomic counter, ttl = auto-expire
    const rateLimitTable = new dynamodb.Table(this, 'RateLimitTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Audit records table ───────────────────────────────────────────────────
    // pk = tenant_id, sk = timestamp#event_id (sorts chronologically within tenant)
    // GSI on event_id for direct lookups
    const auditTable = new dynamodb.Table(this, 'AuditTable', {
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    auditTable.addGlobalSecondaryIndex({
      indexName: 'event_id-index',
      partitionKey: { name: 'event_id', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ── S3 audit archive (Object Lock — WORM storage) ─────────────────────────
    // Records written here cannot be modified or deleted for the retention period.
    // This is the tamper-evidence guarantee: S3 Object Lock in COMPLIANCE mode is
    // a recognised standard for regulatory record-keeping (SEC 17a-4, FINRA, HIPAA).
    const auditBucket = new s3.Bucket(this, 'AuditBucket', {
      objectLockEnabled: true,
      versioned: true, // required for Object Lock
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── SQS queues ────────────────────────────────────────────────────────────
    const dlq = new sqs.Queue(this, 'IngestDLQ', {
      retentionPeriod: cdk.Duration.days(14),
    });

    const queue = new sqs.Queue(this, 'IngestQueue', {
      visibilityTimeout: cdk.Duration.seconds(120),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // ── DLQ alarm ─────────────────────────────────────────────────────────────
    // Fires when any message lands in the dead-letter queue, meaning a record
    // failed to save to DynamoDB or S3 after 5 retries. This should never happen
    // in normal operation — treat it as urgent.
    const dlqAlarm = new cloudwatch.Alarm(this, 'DlqAlarm', {
      alarmName: 'AiAuditLedger-DLQ-MessageVisible',
      alarmDescription:
        'One or more audit events failed to save after 5 retries. Check CloudWatch Logs for ProcessorFn.',
      metric: dlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    // DLQ alert topic — receives both the CloudWatch alarm AND the per-message
    // structured failure details from the DLQ consumer Lambda below.
    const dlqAlertTopic = new sns.Topic(this, 'DlqAlertTopic', {
      displayName: 'AI Audit Ledger DLQ Alert',
    });
    if (alertEmail) {
      dlqAlertTopic.addSubscription(new sns_subscriptions.EmailSubscription(alertEmail));
      dlqAlarm.addAlarmAction(new cw_actions.SnsAction(dlqAlertTopic));
    }

    // ── Tenant contacts table ─────────────────────────────────────────────────
    // Stores per-tenant notification config: email and/or webhook_url.
    // Managed at runtime via PUT /admin/tenants/{tenantId}/contact — no redeploy needed.
    const tenantContactsTable = new dynamodb.Table(this, 'TenantContactsTable', {
      partitionKey: { name: 'tenant_id', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const lambdaDir = join(__dirname, '..', 'lambda');

    // ── DLQ Consumer Lambda ───────────────────────────────────────────────────
    // Triggered by every message that lands in the DLQ after 5 failed retries.
    // Publishes a structured SNS alert containing event_id, tenant_id, retry
    // count, timestamps, payload preview, and a diagnosis hint — so the operator
    // knows exactly what failed without having to dig through CloudWatch manually.
    const dlqConsumerFn = new NodejsFunction(this, 'DlqConsumerFn', {
      runtime:    lambda.Runtime.NODEJS_20_X,
      entry:      join(lambdaDir, 'dlqConsumer.ts'),
      handler:    'handler',
      timeout:    cdk.Duration.seconds(30),
      memorySize: 128,
      logGroup: new logs.LogGroup(this, 'DlqConsumerFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        SNS_TOPIC_ARN:         dlqAlertTopic.topicArn,
        TENANT_CONTACTS_TABLE: tenantContactsTable.tableName,
        SES_SENDER_EMAIL:      sesSenderEmail,
      },
    });
    dlqConsumerFn.addEventSource(new SqsEventSource(dlq, { batchSize: 10 }));
    dlq.grantConsumeMessages(dlqConsumerFn);
    dlqAlertTopic.grantPublish(dlqConsumerFn);
    tenantContactsTable.grantReadData(dlqConsumerFn);
    dlqConsumerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ses:SendEmail'],
      resources: ['*'],
    }));

    // ── Ingest Lambda ─────────────────────────────────────────────────────────
    const ingestFn = new NodejsFunction(this, 'IngestFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'ingest.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'IngestFnLogGroup', { retention: logs.RetentionDays.ONE_WEEK }),
      environment: {
        QUEUE_URL: queue.queueUrl,
        TENANT_KEY_SECRET_ARN: tenantKeySecret.secretArn,
        RATE_LIMIT_TABLE: rateLimitTable.tableName,
        RATE_LIMIT_PER_MINUTE: String(rateLimitPerMinute),
        AUDIT_TABLE: auditTable.tableName,
      },
    });
    queue.grantSendMessages(ingestFn);
    tenantKeySecret.grantRead(ingestFn);
    rateLimitTable.grantReadWriteData(ingestFn);
    auditTable.grantReadData(ingestFn); // duplicate event_id check via GSI

    // ── Processor Lambda ──────────────────────────────────────────────────────
    const processorFn = new NodejsFunction(this, 'ProcessorFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'processor.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'ProcessorFnLogGroup', { retention: logs.RetentionDays.ONE_WEEK }),
      environment: {
        AUDIT_TABLE: auditTable.tableName,
        AUDIT_BUCKET: auditBucket.bucketName,
        RETENTION_YEARS: String(retentionYears),
      },
    });
    queue.grantConsumeMessages(processorFn);
    processorFn.addEventSource(new SqsEventSource(queue, { batchSize: 10 }));
    auditTable.grantWriteData(processorFn);
    auditBucket.grantPut(processorFn);

    // ── Read Lambda ───────────────────────────────────────────────────────────
    const readFn = new NodejsFunction(this, 'ReadFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      entry: join(lambdaDir, 'read.ts'),
      handler: 'handler',
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'ReadFnLogGroup', { retention: logs.RetentionDays.ONE_WEEK }),
      environment: {
        AUDIT_TABLE: auditTable.tableName,
        AUDIT_BUCKET: auditBucket.bucketName,
        READ_KEY_SECRET_ARN: readKeySecret.secretArn,
        CORS_ALLOW_ORIGIN: this.node.tryGetContext('corsOrigin') ?? '',
      },
    });
    auditTable.grantReadData(readFn);
    auditBucket.grantRead(readFn);
    readKeySecret.grantRead(readFn);

    // ── Status Lambda ─────────────────────────────────────────────────────────
    // Lets customers check whether a specific event_id was successfully saved.
    // Accepts both ingest keys (tenant-scoped) and read keys (admin or tenant).
    const statusFn = new NodejsFunction(this, 'StatusFn', {
      runtime:    lambda.Runtime.NODEJS_20_X,
      entry:      join(lambdaDir, 'status.ts'),
      handler:    'handler',
      timeout:    cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'StatusFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        AUDIT_TABLE:           auditTable.tableName,
        TENANT_KEY_SECRET_ARN: tenantKeySecret.secretArn,
        READ_KEY_SECRET_ARN:   readKeySecret.secretArn,
        CORS_ALLOW_ORIGIN:     this.node.tryGetContext('corsOrigin') ?? '',
      },
    });
    auditTable.grantReadData(statusFn);
    tenantKeySecret.grantRead(statusFn);
    readKeySecret.grantRead(statusFn);

    // ── Restore approval table ────────────────────────────────────────────────
    // Stores single-use tokens generated by the reconciler when mismatches are
    // detected. Each token maps to one event and expires after 48 hours via TTL.
    const restoreApprovalTable = new dynamodb.Table(this, 'RestoreApprovalTable', {
      partitionKey: { name: 'token', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // ── Reconciler state table ────────────────────────────────────────────────
    // Stores a single item: { pk: "lastRunAt", value: "<ISO timestamp>" }
    // RETAIN so a cdk destroy doesn't reset the watermark and cause a gap.
    const reconcilerStateTable = new dynamodb.Table(this, 'ReconcilerStateTable', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      billingMode:  dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ── Reconciler SNS topic (operator) ──────────────────────────────────────
    // All mismatches in a run are bundled into one alert (avoids inbox flooding).
    // Additional subscribers (Slack, PagerDuty) can be added here without code changes.
    const mismatchTopic = new sns.Topic(this, 'AuditMismatchTopic', {
      displayName: 'AI Audit Ledger — tamper mismatch alerts',
    });

    if (alertEmail) {
      mismatchTopic.addSubscription(new sns_subscriptions.EmailSubscription(alertEmail));
    }

    // ── Reconciler Lambda ─────────────────────────────────────────────────────
    const reconcilerFn = new NodejsFunction(this, 'ReconcilerFn', {
      runtime:    lambda.Runtime.NODEJS_20_X,
      entry:      join(lambdaDir, 'reconciler.mjs'),
      handler:    'handler',
      timeout:    cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'ReconcilerFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        AUDIT_TABLE:             auditTable.tableName,
        AUDIT_BUCKET:            auditBucket.bucketName,
        RECONCILER_STATE_TABLE:  reconcilerStateTable.tableName,
        SNS_TOPIC_ARN:           mismatchTopic.topicArn,
        TENANT_CONTACTS_TABLE:   tenantContactsTable.tableName,
        SES_SENDER_EMAIL:        sesSenderEmail,
        RESTORE_APPROVAL_TABLE:  restoreApprovalTable.tableName,
        // API_BASE_URL is added after the API is created (see below).
      },
    });

    // Read-only on audit data — reconciler never modifies audit records.
    auditTable.grantReadData(reconcilerFn);
    auditBucket.grantRead(reconcilerFn);
    // Read + write the watermark only.
    reconcilerStateTable.grantReadWriteData(reconcilerFn);
    mismatchTopic.grantPublish(reconcilerFn);
    tenantContactsTable.grantReadData(reconcilerFn);
    reconcilerFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ses:SendEmail'],
      resources: ['*'],
    }));
    // Write restore approval tokens.
    restoreApprovalTable.grantWriteData(reconcilerFn);

    // ── EventBridge rule — every hour ─────────────────────────────────────────
    // 2 retry attempts so a transient cold-start failure doesn't silently skip
    // a reconciliation window.
    const reconcilerRule = new eb.Rule(this, 'ReconcilerSchedule', {
      schedule:    eb.Schedule.rate(cdk.Duration.hours(1)),
      description: 'Triggers the AI Audit Ledger reconciliation Lambda hourly',
    });

    reconcilerRule.addTarget(new ebTargets.LambdaFunction(reconcilerFn, {
      retryAttempts: 2,
    }));

    // ── Restore Lambda ────────────────────────────────────────────────────────
    // Handles one-click restore links from mismatch alert emails.
    // Claims the approval token atomically, fetches the S3 copy, and overwrites
    // the tampered DynamoDB record. Returns an HTML response for the browser.
    const restoreFn = new NodejsFunction(this, 'RestoreFn', {
      runtime:    lambda.Runtime.NODEJS_20_X,
      entry:      join(lambdaDir, 'restore.ts'),
      handler:    'handler',
      timeout:    cdk.Duration.seconds(30),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'RestoreFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        RESTORE_APPROVAL_TABLE: restoreApprovalTable.tableName,
        AUDIT_TABLE:            auditTable.tableName,
        AUDIT_BUCKET:           auditBucket.bucketName,
        SNS_TOPIC_ARN:          mismatchTopic.topicArn,
        TENANT_CONTACTS_TABLE:  tenantContactsTable.tableName,
        SES_SENDER_EMAIL:       sesSenderEmail,
      },
    });
    restoreApprovalTable.grantReadWriteData(restoreFn);
    auditTable.grantWriteData(restoreFn);
    auditBucket.grantRead(restoreFn);
    mismatchTopic.grantPublish(restoreFn);
    tenantContactsTable.grantReadData(restoreFn);
    restoreFn.addToRolePolicy(new iam.PolicyStatement({
      actions:   ['ses:SendEmail'],
      resources: ['*'],
    }));

    // ── Admin Contacts Lambda ─────────────────────────────────────────────────
    // GET/PUT/DELETE /admin/tenants/{tenantId}/contact
    // Admin-only endpoint for managing per-tenant email and webhook config.
    // This is how an email address or webhook URL gets into the product.
    const adminContactsFn = new NodejsFunction(this, 'AdminContactsFn', {
      runtime:    lambda.Runtime.NODEJS_20_X,
      entry:      join(lambdaDir, 'adminContacts.ts'),
      handler:    'handler',
      timeout:    cdk.Duration.seconds(10),
      memorySize: 128,
      logGroup: new logs.LogGroup(this, 'AdminContactsFnLogGroup', {
        retention: logs.RetentionDays.ONE_WEEK,
      }),
      environment: {
        TENANT_CONTACTS_TABLE: tenantContactsTable.tableName,
        READ_KEY_SECRET_ARN:   readKeySecret.secretArn,
      },
    });
    tenantContactsTable.grantReadWriteData(adminContactsFn);
    readKeySecret.grantRead(adminContactsFn);

    // ── API Gateway with throttling ───────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'AuditApi', {
      restApiName: 'AiAuditLedger',
      description: 'AI Audit Ledger ingestion + read API',
      defaultCorsPreflightOptions: {
        // Preflight origins: pass --context corsOrigin=https://yourdomain.com to lock
        // down to a specific origin. Defaults to ALL_ORIGINS — safe because the actual
        // CORS enforcement is in the Lambda response header (CORS_ALLOW_ORIGIN env var,
        // set to the CloudFront domain below), which the browser checks after preflight.
        allowOrigins: this.node.tryGetContext('corsOrigin')
          ? [this.node.tryGetContext('corsOrigin') as string]
          : apigateway.Cors.ALL_ORIGINS,
        allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowHeaders: ['Content-Type', 'X-Api-Key', 'Authorization'],
      },
      deployOptions: {
        stageName: 'prod',
        throttlingBurstLimit: 200,
        throttlingRateLimit: 100,
        loggingLevel: apigateway.MethodLoggingLevel.ERROR,
        metricsEnabled: true,
      },
    });

    const audit = api.root.addResource('audit');
    const events = audit.addResource('events');
    events.addMethod('POST', new apigateway.LambdaIntegration(ingestFn), {
      methodResponses: [{ statusCode: '202' }],
    });

    const logsResource = audit.addResource('logs');
    logsResource.addMethod('GET', new apigateway.LambdaIntegration(readFn));

    const eventById = events.addResource('{eventId}');
    const history = eventById.addResource('history');
    history.addMethod('GET', new apigateway.LambdaIntegration(readFn));

    const statusResource = eventById.addResource('status');
    statusResource.addMethod('GET', new apigateway.LambdaIntegration(statusFn));

    const restoreResource = audit.addResource('restore');
    const restoreByToken  = restoreResource.addResource('{token}');
    restoreByToken.addMethod('GET', new apigateway.LambdaIntegration(restoreFn));

    const adminResource      = api.root.addResource('admin');
    const tenantsResource    = adminResource.addResource('tenants');
    tenantsResource.addMethod('GET', new apigateway.LambdaIntegration(adminContactsFn));
    const tenantByIdResource = tenantsResource.addResource('{tenantId}');
    const contactResource    = tenantByIdResource.addResource('contact');
    contactResource.addMethod('GET',    new apigateway.LambdaIntegration(adminContactsFn));
    contactResource.addMethod('PUT',    new apigateway.LambdaIntegration(adminContactsFn));
    contactResource.addMethod('DELETE', new apigateway.LambdaIntegration(adminContactsFn));

    // Wire the API base URL into the reconciler now that the API exists.
    // CDK resolves this as a CloudFormation reference at deploy time.
    reconcilerFn.addEnvironment('API_BASE_URL', api.url);

    // ── Dashboard hosting (S3 + CloudFront) ──────────────────────────────────
    // The dashboard HTML is served over HTTPS via CloudFront.
    // Customers open the URL, enter their read key, and connect — no file needed.
    const dashboardBucket = new s3.Bucket(this, 'DashboardBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const dashboardDistribution = new cloudfront.Distribution(this, 'DashboardDistribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(dashboardBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // always serve latest version
      },
      defaultRootObject: 'index.html',
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
        },
      ],
    });

    // Upload the dashboard folder to S3 and invalidate CloudFront on every deploy
    new BucketDeployment(this, 'DashboardDeployment', {
      sources: [Source.asset(join(__dirname, '..', '..', '..', 'dashboard'))],
      destinationBucket: dashboardBucket,
      distribution: dashboardDistribution,
      distributionPaths: ['/*'],
    });

    // Wire the real dashboard origin into the Lambda response headers.
    // CDK resolves the CloudFront token at deploy time — no manual context flag needed.
    const dashboardOrigin = `https://${dashboardDistribution.distributionDomainName}`;
    readFn.addEnvironment('CORS_ALLOW_ORIGIN', dashboardOrigin);
    statusFn.addEnvironment('CORS_ALLOW_ORIGIN', dashboardOrigin);
    adminContactsFn.addEnvironment('CORS_ALLOW_ORIGIN', dashboardOrigin);

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiBaseUrl', { value: api.url });
    new cdk.CfnOutput(this, 'IngestUrl', {
      value: `${api.url}audit/events`,
      description: 'POST ingestion endpoint',
    });
    new cdk.CfnOutput(this, 'ReadUrl', {
      value: `${api.url}audit/logs`,
      description: 'GET logs endpoint',
    });
    new cdk.CfnOutput(this, 'TenantKeySecretArn', {
      value: tenantKeySecret.secretArn,
      description: 'Secrets Manager ARN for tenant key map — add/remove customers here',
    });
    new cdk.CfnOutput(this, 'ReadKeySecretArn', {
      value: readKeySecret.secretArn,
      description: 'Secrets Manager ARN for read key map — manage dashboard access here',
    });
    new cdk.CfnOutput(this, 'AuditBucketName', {
      value: auditBucket.bucketName,
      description: 'S3 bucket with Object Lock — tamper-evident archive',
    });
    new cdk.CfnOutput(this, 'AuditTableName', { value: auditTable.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'RateLimitTableName', { value: rateLimitTable.tableName });
    new cdk.CfnOutput(this, 'DashboardUrl', {
      value: `https://${dashboardDistribution.distributionDomainName}`,
      description: 'Hosted dashboard URL — share this with customers',
    });
    new cdk.CfnOutput(this, 'DlqAlarmName', {
      value: dlqAlarm.alarmName,
      description: 'CloudWatch alarm — fires if any audit record fails to save',
    });
    new cdk.CfnOutput(this, 'DlqUrl', {
      value: dlq.queueUrl,
      description: 'Dead-letter queue URL — messages here can be replayed once the root cause is fixed',
    });
    new cdk.CfnOutput(this, 'DlqAlertTopicArn', {
      value: dlqAlertTopic.topicArn,
      description: 'SNS topic for DLQ failure alerts — add subscribers here',
    });
    new cdk.CfnOutput(this, 'MismatchTopicArn', {
      value: mismatchTopic.topicArn,
      description: 'SNS topic ARN for tamper mismatch alerts — add subscribers here',
    });
    new cdk.CfnOutput(this, 'TenantContactsTableName', {
      value: tenantContactsTable.tableName,
      description: 'DynamoDB table for per-tenant email/webhook config — managed via PUT /admin/tenants/{tenantId}/contact',
    });
  }
}
