import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { WEBAPPS_BUCKET_NAME } from './account';

/**
 * The one bucket every WingTheIdea web app is served from, organised by folder
 * (`<IDEA>/<APP>/`). Group-level, not ReconFlow-owned — it happens to be
 * defined in ReconFlow's CDK app because ReconFlow is the first idea to need it.
 *
 * It deliberately owns no distributions. Each app's stack creates its own
 * CloudFront distribution against a prefix of this bucket, so apps stay
 * independent; a per-distribution bucket policy would force every app stack
 * back through this one and create a dependency cycle.
 */
export class WebappsHostingStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    const bucket = new s3.Bucket(this, 'WebappsBucket', {
      bucketName: WEBAPPS_BUCKET_NAME,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      minimumTLSVersion: 1.2,
      // Shared by every app: losing it would take all of them down at once.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Read access for CloudFront Origin Access Control. Scoped to distributions
    // owned by this account, because the individual distribution ARNs live in
    // the app stacks that consume this bucket and cannot be referenced here
    // without a cycle. Write access is never granted here — each app's deploy
    // role grants itself write on its own prefix only.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowCloudFrontOriginAccessControlRead',
        principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
      }),
    );

    new cdk.CfnOutput(this, 'WebappsBucketName', {
      value: bucket.bucketName,
      description: 'Shared hosting bucket — set as repo variable S3_BUCKET in every web app repo',
    });
  }
}
