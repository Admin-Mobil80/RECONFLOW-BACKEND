import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { GITHUB_OIDC_PROVIDER_ARN, PREFIX } from './account';

export interface StaticSiteStackProps extends cdk.StackProps {
  /** Short app name, lowercase — becomes part of every resource name (`portal`, `bms`). */
  readonly appName: string;
  /** `owner/repo` of the GitHub repository allowed to deploy this site. */
  readonly githubRepo: string;
}

/**
 * One ReconFlow frontend: a private S3 bucket served through CloudFront with
 * Origin Access Control, plus the GitHub Actions deploy role for exactly one
 * repo.
 *
 * One stack per frontend, so PORTAL and BMS deploy, roll back and fail
 * independently, and each repo's role can reach only its own bucket and
 * distribution.
 */
export class StaticSiteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StaticSiteStackProps) {
    super(scope, id, props);

    const { appName, githubRepo } = props;

    // Bucket names are globally unique, so the account id is part of the name.
    const bucket = new s3.Bucket(this, 'SiteBucket', {
      bucketName: `${PREFIX}-${appName}-site-${this.account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      // RETAIN: in a shared account an accidental `cdk destroy` must not be
      // able to take the site's contents with it.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const securityHeaders = new cloudfront.ResponseHeadersPolicy(this, 'SecurityHeaders', {
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
    });

    const distribution = new cloudfront.Distribution(this, 'SiteDistribution', {
      comment: `${PREFIX}-${appName}`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // PRICE_CLASS_100 excludes India; this audience is served from ap-south-1.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      defaultBehavior: {
        // withOriginAccessControl keeps the bucket private and writes the
        // bucket policy that lets only this distribution read it.
        origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: securityHeaders,
        compress: true,
      },
      // Client-side routing: unknown paths are app routes, not missing files.
      // S3 answers 403 (not 404) for a key that does not exist in a private bucket.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: cdk.Duration.minutes(5) },
      ],
    });

    const githubProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GithubOidcProvider',
      GITHUB_OIDC_PROVIDER_ARN,
    );

    const deployRole = new iam.Role(this, 'GithubDeployRole', {
      roleName: `${PREFIX}-${appName}-github-deploy`,
      description: `GitHub Actions deploy role for ${githubRepo} (ReconFlow ${appName})`,
      maxSessionDuration: cdk.Duration.hours(1),
      assumedBy: new iam.WebIdentityPrincipal(githubProvider.openIdConnectProviderArn, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        },
        // Scoped to one repo, any ref. Tighten to
        // `repo:${githubRepo}:ref:refs/heads/main` once nothing else needs to
        // deploy, or to `:environment:production` if a GitHub environment gates it.
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${githubRepo}:*`,
        },
      }),
    });

    // Written out explicitly rather than via bucket.grantReadWrite(), so the
    // role's reach in a shared admin account is readable at a glance.
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'ListSiteBucket',
        actions: ['s3:ListBucket'],
        resources: [bucket.bucketArn],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'WriteSiteObjects',
        actions: ['s3:GetObject', 's3:PutObject', 's3:DeleteObject'],
        resources: [bucket.arnForObjects('*')],
      }),
    );
    deployRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvalidateSiteCache',
        actions: ['cloudfront:CreateInvalidation', 'cloudfront:GetInvalidation'],
        resources: [`arn:aws:cloudfront::${this.account}:distribution/${distribution.distributionId}`],
      }),
    );

    // Output names match the GitHub repo variables the deploy workflow reads.
    new cdk.CfnOutput(this, 'S3Bucket', {
      value: bucket.bucketName,
      description: `Set as repo variable S3_BUCKET in ${githubRepo}`,
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
      value: `https://${distribution.distributionDomainName}`,
      description: 'CloudFront URL until a custom subdomain is attached',
    });
  }
}
