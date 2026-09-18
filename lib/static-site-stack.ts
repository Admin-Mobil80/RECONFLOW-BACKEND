import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
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
  /** Present on the public site only: serves the Contact Us form at /api/contact. */
  readonly contactForm?: ContactFormProps;
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

    if (props.contactForm) this.addContactForm(distribution, props.contactForm);

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
   * Contact Us handler, served from this distribution at /api/* so the form
   * posts same-origin. The function URL requires IAM auth; only CloudFront's
   * Origin Access Control can sign for it, so the URL is useless on its own.
   */
  private addContactForm(distribution: cloudfront.Distribution, config: ContactFormProps): void {
    const fn = new NodejsFunction(this, 'ContactFunction', {
      entry: path.join(__dirname, '../src/handlers/contact-form.ts'),
      runtime: lambda.Runtime.NODEJS_24_X,
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
      logGroup: new logs.LogGroup(this, 'ContactFunctionLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      bundling: { target: 'node24', externalModules: ['@aws-sdk/*'] },
      environment: {
        SES_REGION: config.sesRegion,
        FROM_ADDRESS: config.fromAddress,
        FROM_NAME: config.fromName,
        TO_ADDRESS: config.toAddress,
        PRODUCT_NAME: config.fromName,
      },
    });

    // Send only as the configured address. Without the FromAddress condition
    // the function could send as any verified identity in this shared account.
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${config.sesRegion}:${this.account}:identity/${config.sesIdentityDomain}`],
        conditions: { StringEquals: { 'ses:FromAddress': config.fromAddress } },
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
}
