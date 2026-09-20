import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as cr from "aws-cdk-lib/custom-resources";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import { PREFIX } from "./account";
import { ADB_ORGANISATION_ID, ADB_SOURCES, type AdbSourceId } from "../src/tenants/adb/records";

/**
 * Bump to re-run the seed on the next deploy. Anything else about the seed —
 * a new scenario, a changed amount — is invisible to CloudFormation without
 * this, because the custom resource only re-runs when its properties change.
 */
const SEED_VERSION = "2026-09-20.1";

/**
 * ReconFlow's own data plus the representative source databases for the
 * proof of concept.
 *
 * Source tables are one per interface, deliberately separate, so that
 * "evidence ingestion across databases" in the demo is literally that. They
 * hold fabricated data and are destroyed with the stack. The core table and
 * the documents bucket are ReconFlow's and are retained.
 */
export class DataStack extends cdk.Stack {
  public readonly coreTable: dynamodb.Table;
  public readonly sourceTables: Record<AdbSourceId, dynamodb.Table>;
  public readonly documentsBucket: s3.Bucket;
  /**
   * Holds the OpenAI platform key. Created with a placeholder - the real value
   * is never in this repo or a template. Set it once with:
   *   aws secretsmanager put-secret-value --secret-id reconflow/openai-api-key \
   *     --secret-string 'sk-...' --profile wingtheidea --region ap-south-1
   * Until then the narrator falls back to a deterministic summary.
   */
  public readonly openAiSecret: secretsmanager.Secret;
  /** Also invoked directly by the BMS with { action: "reset" } to restart the demonstration. */
  public readonly seedFunction: NodejsFunction;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    this.openAiSecret = new secretsmanager.Secret(this, "OpenAiApiKey", {
      secretName: `${PREFIX}/openai-api-key`,
      description: "OpenAI platform key used by ReconFlow to narrate case summaries. Placeholder until set.",
      generateSecretString: { passwordLength: 16, excludePunctuation: true },
    });

    this.coreTable = new dynamodb.Table(this, "CoreTable", {
      tableName: `${PREFIX}-core`,
      partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const sourceTables = {} as Record<AdbSourceId, dynamodb.Table>;
    for (const sourceId of Object.keys(ADB_SOURCES) as AdbSourceId[]) {
      sourceTables[sourceId] = new dynamodb.Table(this, `Source-${sourceId}`, {
        tableName: `${PREFIX}-source-${sourceId}`,
        partitionKey: { name: "PK", type: dynamodb.AttributeType.STRING },
        sortKey: { name: "SK", type: dynamodb.AttributeType.STRING },
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        // Representative data only: re-seedable, so nothing to protect.
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }
    this.sourceTables = sourceTables;

    this.documentsBucket = new s3.Bucket(this, "DocumentsBucket", {
      bucketName: `${PREFIX}-documents-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // --- seed ---------------------------------------------------------------

    const tableNames: Record<string, string> = {};
    for (const [sourceId, table] of Object.entries(sourceTables)) tableNames[sourceId] = table.tableName;

    const seedFunction = new NodejsFunction(this, "SeedFunction", {
      functionName: `${PREFIX}-seed-representative-data`,
      entry: path.join(__dirname, "../src/handlers/seed-representative-data.ts"),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, "SeedFunctionLogs", {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: {
        target: "node24",
        // The runtime ships the SDK; bundling it would only slow cold starts.
        externalModules: ["@aws-sdk/*"],
      },
      // For direct invocation ({ action: "reset" }) from the BMS; the custom
      // resource passes the same values as properties.
      environment: {
        SEED_VERSION,
        ORGANISATION_ID: ADB_ORGANISATION_ID,
        CORE_TABLE: this.coreTable.tableName,
        TABLE_NAMES: JSON.stringify(tableNames),
        DOCUMENTS_BUCKET: this.documentsBucket.bucketName,
      },
    });
    this.seedFunction = seedFunction;

    // Read as well as write everywhere: a reset scans an organisation's items
    // out of each source table before reloading, and the seed removes
    // organisation items earlier versions wrote to the core table.
    this.coreTable.grantReadWriteData(seedFunction);
    for (const table of Object.values(sourceTables)) table.grantReadWriteData(seedFunction);
    this.documentsBucket.grantPut(seedFunction);

    const provider = new cr.Provider(this, "SeedProvider", {
      onEventHandler: seedFunction,
      logGroup: new logs.LogGroup(this, "SeedProviderLogs", {
        retention: logs.RetentionDays.ONE_WEEK,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
    });

    const seed = new cdk.CustomResource(this, "RepresentativeData", {
      serviceToken: provider.serviceToken,
      resourceType: "Custom::ReconFlowRepresentativeData",
      properties: {
        SeedVersion: SEED_VERSION,
        OrganisationId: ADB_ORGANISATION_ID,
        CoreTable: this.coreTable.tableName,
        TableNames: tableNames,
        DocumentsBucket: this.documentsBucket.bucketName,
      },
    });

    // --- outputs ------------------------------------------------------------

    new cdk.CfnOutput(this, "CoreTableName", { value: this.coreTable.tableName });
    new cdk.CfnOutput(this, "DocumentsBucketName", { value: this.documentsBucket.bucketName });
    for (const [sourceId, table] of Object.entries(sourceTables)) {
      new cdk.CfnOutput(this, `SourceTable-${sourceId}`, { value: table.tableName });
    }
    new cdk.CfnOutput(this, "SeededScenarios", { value: seed.getAttString("Scenarios") });
    new cdk.CfnOutput(this, "SeededRecords", { value: seed.getAttString("Records") });
    new cdk.CfnOutput(this, "SeededDocuments", { value: seed.getAttString("Documents") });
  }
}
