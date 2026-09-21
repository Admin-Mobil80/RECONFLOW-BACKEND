import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import {
  GITHUB_OIDC_PROVIDER_ARN,
  HOSTED_ZONE_ID,
  PREFIX,
  WEBAPPS_BUCKET_NAME,
  ZONE_NAME,
} from './account';

export interface StaticSiteStackProps extends cdk.StackProps {
  /** Short app name, lowercase — used in resource names (`portal`, `bms`). */
  readonly appName: string;
  /** `owner/repo` of the GitHub repository allowed to deploy this site. */
  readonly githubRepo: string;
  /** Public hostname, e.g. `reconflow.wingtheidea.com`. */
  readonly domainName: string;
  /** Folder in the shared bucket, no leading or trailing slash: `RECONFLOW/PORTAL`. */
  readonly sitePrefix: string;
  /** Certificate for `domainName`, from the us-east-1 certificates stack. */
  readonly certificate: acm.ICertificate;
  /** Present on the portal only: the portal API at /api/*, including the public Contact Us form. */
  readonly portalApi?: PortalApiProps;
  /** Present on the BMS only: serves platform administration at /api/*. Mutually exclusive with portalApi. */
  readonly adminApi?: AdminApiProps;
}

export interface PortalApiProps {
  readonly contact: ContactFormProps;
  readonly coreTable: dynamodb.ITable;
  readonly documentsBucket: s3.IBucket;
  /** sourceId -> table, read-only for the API. */
  readonly sourceTables: Readonly<Record<string, dynamodb.ITable>>;
  /** Whose tokens the API accepts. */
  readonly portalUserPool: cognito.IUserPool;
  readonly portalClientId: string;
  readonly openAiSecret: secretsmanager.ISecret;
}

export interface AdminApiProps {
  /** Sender for the notifications this API sends when an account is created. */
  readonly contact: ContactFormProps;
  /** The permanent platform root, which cannot be disabled from the BMS. */
  readonly bmsRootEmail: string;
  readonly coreTable: dynamodb.ITable;
  /** Where organisation owners are created. */
  readonly portalUserPool: cognito.IUserPool;
  /** Whose tokens the API accepts. */
  readonly bmsUserPool: cognito.IUserPool;
  readonly bmsClientId: string;
  /** The representative source systems the demonstration writes into. */
  readonly sourceTables: Readonly<Record<string, dynamodb.ITable>>;
  readonly documentsBucket: s3.IBucket;
  /** Invoked with { action: "reset" } to put the demonstration back to its start. */
  readonly seedFunction: lambda.IFunction;
}

export interface ContactFormProps {
  readonly toAddress: string;
  readonly fromAddress: string;
  readonly fromName: string;
  /** Region of the verified SES identity — not necessarily this stack's region. */
  readonly sesRegion: string;
  readonly sesIdentityDomain: string;
}

/**
 * One web app: a CloudFront distribution serving a folder of the shared
 * hosting bucket at its own hostname, plus the GitHub Actions deploy role for
 * exactly one repo and one folder.
 */
export class StaticSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StaticSiteStackProps) {
    super(scope, id, props);

    const { appName, githubRepo, domainName, sitePrefix, certificate } = props;

    // Imported by name, NOT taken as a construct from the hosting stack. An
    // owned bucket would make withOriginAccessControl() write a policy
    // statement naming this distribution back into the hosting stack, which
    // depends on nothing — that is a dependency cycle. The hosting stack
    // already grants CloudFront read access for this account, so an imported
    // bucket (whose policy CDK will not touch) is what this needs.
    const bucket = s3.Bucket.fromBucketAttributes(this, 'WebappsBucket', {
      bucketName: WEBAPPS_BUCKET_NAME,
      region: this.region,
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: `${PREFIX}-${appName} (${domainName})`,
      domainNames: [domainName],
      certificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // PRICE_CLASS_100 excludes India; this audience is served from ap-south-1.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        // originPath makes this distribution see only its own folder: a request
        // for /assets/x.js is fetched as /<sitePrefix>/assets/x.js.
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket, {
          originPath: `/${sitePrefix}`,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
          responseHeadersPolicyName: `${PREFIX}-${appName}-security-headers`,
          securityHeadersBehavior: {
            contentTypeOptions: { override: true },
            frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
            referrerPolicy: {
              referrerPolicy: cloudfront.HeadersReferrerPolicy.STRICT_ORIGIN_WHEN_CROSS_ORIGIN,
              override: true,
            },
            strictTransportSecurity: {
              accessControlMaxAge: cdk.Duration.days(365),
              includeSubdomains: true,
              override: true,
            },
          },
        }),
        compress: true,
      },
      // Client-side routing: unknown paths are app routes, not missing files.
      // A private bucket answers 403 (not 404) for a key that does not exist.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
    });

    if (props.portalApi) this.addPortalApi(distribution, props.portalApi, domainName);
    if (props.adminApi) this.addAdminApi(distribution, props.adminApi, domainName);

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: HOSTED_ZONE_ID,
      zoneName: ZONE_NAME,
    });
    const aliasTarget = route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution));

    new route53.ARecord(this, 'AliasRecord', { zone, recordName: domainName, target: aliasTarget });
    new route53.AaaaRecord(this, 'AliasRecordV6', { zone, recordName: domainName, target: aliasTarget });

    const [githubOwner, githubRepoName] = githubRepo.split('/');
    if (!githubOwner || !githubRepoName) {
      throw new Error(`githubRepo must be "owner/repo", got "${githubRepo}"`);
    }

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      GITHUB_OIDC_PROVIDER_ARN,
    );

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `${PREFIX}-${appName}-github-deploy`,
      description: `GitHub Actions deploy role for ${githubRepo} (${domainName})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // Two forms, because this GitHub organisation uses a CUSTOMISED OIDC
        // subject claim. The standard subject is
        //   repo:<owner>/<repo>:ref:refs/heads/main
        // but tokens from this org arrive with numeric ids attached:
        //   repo:<owner>@<owner_id>/<repo>@<repo_id>:ref:refs/heads/main
        // Allowing only the standard form fails with "Not authorized to perform
        // sts:AssumeRoleWithWebIdentity". The ids are wildcarded so the role
        // survives the claim template being changed back, exactly as the
        // cloudmeter and flaunt roles in this account do.
        //
        // Scoped to one repo, any ref. Tighten to `:ref:refs/heads/main` once
        // nothing else needs to deploy, or to `:environment:production` if a
        // GitHub environment gates it.
        StringLike: {
          'token.actions.githubusercontent.com:sub': [
            `repo:${githubRepo}:*`,
            `repo:${githubOwner}@*/${githubRepoName}@*:*`,
          ],
        },
      }),
    });

    // The bucket is shared with every other web app, so the role is confined to
    // this app's folder. The s3:prefix condition matters as much as the object
    // ARNs: without it the role could LIST a sibling app's folder, and
    // `aws s3 sync --delete` acts on what it lists.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListOwnFolderOnly',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
        conditions: { StringLike: { 's3:prefix': [`${sitePrefix}/*`, sitePrefix] } },
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOwnFolderOnly',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [bucket.arnForObjects(`${sitePrefix}/*`)],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateOwnDistributionOnly',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    // Output names match the GitHub repo variables the deploy workflow reads.
    new cdk.CfnOutput(this, 'S3Bucket', {
      value: bucket.bucketName,
      description: `Set as repo variable S3_BUCKET in ${githubRepo}`,
    });
    new cdk.CfnOutput(this, 'S3Prefix', {
      value: sitePrefix,
      description: `Set as repo variable S3_PREFIX in ${githubRepo}`,
    });
    new cdk.CfnOutput(this, 'AwsDeployRoleArn', {
      value: deployRole.roleArn,
      description: `Set as repo variable AWS_DEPLOY_ROLE_ARN in ${githubRepo}`,
    });
    new cdk.CfnOutput(this, 'CloudfrontDistributionId', {
      value: distribution.distributionId,
      description: `Set as repo variable CLOUDFRONT_DISTRIBUTION_ID in ${githubRepo}`,
    });
    new cdk.CfnOutput(this, 'SiteUrl', {
      value: `https://${domainName}`,
      description: 'Public URL (Route 53 alias to this distribution)',
    });
  }

  /**
   * The portal API, served from this distribution at /api/* so the browser
   * calls same-origin: the public Contact Us form, and the signed-in case
   * screens. The function URL requires IAM auth; only CloudFront's Origin
   * Access Control can sign for it, so the URL is useless on its own.
   *
   * Reads the source tables and the documents bucket; writes only decisions
   * into the core table. Nothing here can touch a source system.
   */
  private addPortalApi(distribution: cloudfront.Distribution, config: PortalApiProps, domainName: string): void {
    const sourceTables: Record<string, string> = {};
    for (const [sourceId, table] of Object.entries(config.sourceTables)) sourceTables[sourceId] = table.tableName;

    // Construct id 'ContactFunction' is kept so the deployed function is
    // updated in place rather than replaced.
    const fn = new NodejsFunction(this, 'ContactFunction', {
      entry: path.join(__dirname, '../src/handlers/portal-api.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'ContactFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      // aws-jwt-verify is bundled; the SDK ships with the runtime.
      bundling: { target: 'node24', externalModules: ['@aws-sdk/*'] },
      environment: {
        SES_REGION: config.contact.sesRegion,
        FROM_ADDRESS: config.contact.fromAddress,
        FROM_NAME: config.contact.fromName,
        TO_ADDRESS: config.contact.toAddress,
        PRODUCT_NAME: config.contact.fromName,
        SITE_URL: `https://${domainName}`,
        CORE_TABLE: config.coreTable.tableName,
        DOCUMENTS_BUCKET: config.documentsBucket.bucketName,
        SOURCE_TABLES: JSON.stringify(sourceTables),
        PORTAL_USER_POOL_ID: config.portalUserPool.userPoolId,
        PORTAL_CLIENT_ID: config.portalClientId,
        OPENAI_SECRET_ARN: config.openAiSecret.secretArn,
        OPENAI_MODEL: 'gpt-4o-mini',
      },
    });

    // Send only as the configured address. Without the FromAddress condition
    // the function could send as any verified identity in this shared account.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${config.contact.sesRegion}:${this.account}:identity/${config.contact.sesIdentityDomain}`],
        conditions: { StringEquals: { 'ses:FromAddress': config.contact.fromAddress } },
      }),
    );
    config.coreTable.grantReadWriteData(fn);
    for (const table of Object.values(config.sourceTables)) table.grantReadData(fn);
    config.documentsBucket.grantRead(fn);
    config.openAiSecret.grantRead(fn);
    // Owners and administrators create, disable and enable their
    // organisation's users - in the portal pool only.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminGetUser'],
        resources: [config.portalUserPool.userPoolArn],
      }),
    );

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    distribution.addBehavior('/api/*', origins.FunctionUrlOrigin.withOriginAccessControl(url), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Forward the body and headers, but not Host: the function URL's own
      // hostname is what its TLS certificate expects.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });
  }

  /**
   * Platform administration for the BMS, at /api/* on its distribution. The
   * function verifies the caller's ID token against the BMS user pool and
   * creates organisation owners in the portal's pool.
   */
  private addAdminApi(distribution: cloudfront.Distribution, config: AdminApiProps, domainName: string): void {
    const fn = new NodejsFunction(this, 'AdminApiFunction', {
      entry: path.join(__dirname, '../src/handlers/bms-api.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'AdminApiFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      // aws-jwt-verify is not in the runtime, so it is bundled; the SDK is.
      bundling: { target: 'node24', externalModules: ['@aws-sdk/*'] },
      environment: {
        SES_REGION: config.contact.sesRegion,
        FROM_ADDRESS: config.contact.fromAddress,
        FROM_NAME: config.contact.fromName,
        PRODUCT_NAME: config.contact.fromName,
        SITE_URL: `https://${domainName}`,
        CORE_TABLE: config.coreTable.tableName,
        PORTAL_USER_POOL_ID: config.portalUserPool.userPoolId,
        BMS_USER_POOL_ID: config.bmsUserPool.userPoolId,
        BMS_CLIENT_ID: config.bmsClientId,
        BMS_ROOT_EMAIL: config.bmsRootEmail,
        SOURCE_TABLES: JSON.stringify(
          Object.fromEntries(Object.entries(config.sourceTables).map(([id, table]) => [id, table.tableName])),
        ),
        DOCUMENTS_BUCKET: config.documentsBucket.bucketName,
        SEED_FUNCTION: config.seedFunction.functionName,
      },
    });

    config.coreTable.grantReadWriteData(fn);
    // The demonstration writes into the representative source systems and
    // their document repository, and can ask the seed to reset them.
    for (const table of Object.values(config.sourceTables)) table.grantReadWriteData(fn);
    config.documentsBucket.grantPut(fn);
    config.seedFunction.grantInvoke(fn);
    // Create owners in the portal pool; create and suspend platform staff in
    // the BMS pool. Neither pool's users can be deleted from here.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:AdminCreateUser', 'cognito-idp:AdminGetUser'],
        resources: [config.portalUserPool.userPoolArn],
      }),
    );
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'cognito-idp:AdminCreateUser',
          'cognito-idp:AdminDisableUser',
          'cognito-idp:AdminEnableUser',
          'cognito-idp:AdminGetUser',
        ],
        resources: [config.bmsUserPool.userPoolArn],
      }),
    );
    // Send only as the configured address, as the portal API does.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${config.contact.sesRegion}:${this.account}:identity/${config.contact.sesIdentityDomain}`],
        conditions: { StringEquals: { 'ses:FromAddress': config.contact.fromAddress } },
      }),
    );

    const url = fn.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.AWS_IAM });

    distribution.addBehavior('/api/*', origins.FunctionUrlOrigin.withOriginAccessControl(url), {
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
    });
  }
}
