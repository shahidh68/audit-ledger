import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';
import { join } from 'path';
import { randomBytes } from 'crypto';

export class AiAuditLedgerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Key maps (passed via CDK context at deploy time) ──────────────────────
    // TENANT_KEY_MAP: JSON { "api-key": "tenant-id", ... }
    // READ_KEY_MAP:   JSON { "read-key": "tenant-id", "admin-key": "*" }
    const tenantKeyMapValue =
      (this.node.tryGetContext('tenantKeyMap') as string | undefined) ??
      JSON.stringify({ 'demo-tenant-key': 'demo-tenant' });

    const readKeyMapValue =
      (this.node.tryGetContext('readKeyMap') as string | undefined) ??
      JSON.stringify({ [randomBytes(24).toString('hex')]: '*' });

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

    // ── Secrets Manager ───────────────────────────────────────────────────────
    const tenantKeySecret = new secretsmanager.Secret(this, 'TenantKeyMapSecret', {
      description: 'JSON map of ingest API key → tenant_id for AI Audit Ledger',
      secretStringValue: cdk.SecretValue.unsafePlainText(tenantKeyMapValue),
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const readKeySecret = new secretsmanager.Secret(this, 'ReadKeyMapSecret', {
      description: 'JSON map of read API key → tenant_id ("*" = admin) for AI Audit Ledger',
      secretStringValue: cdk.SecretValue.unsafePlainText(readKeyMapValue),
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

    const lambdaDir = join(__dirname, '..', 'lambda');

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
      },
    });
    queue.grantSendMessages(ingestFn);
    tenantKeySecret.grantRead(ingestFn);
    rateLimitTable.grantReadWriteData(ingestFn);

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
      },
    });
    auditTable.grantReadData(readFn);
    auditBucket.grantRead(readFn);
    readKeySecret.grantRead(readFn);

    // ── API Gateway with throttling ───────────────────────────────────────────
    const api = new apigateway.RestApi(this, 'AuditApi', {
      restApiName: 'AiAuditLedger',
      description: 'AI Audit Ledger ingestion + read API',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS,
        allowMethods: apigateway.Cors.ALL_METHODS,
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
  }
}
