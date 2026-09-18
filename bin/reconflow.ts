#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, CERTIFICATE_REGION, PREFIX, REGION } from '../lib/account';
import { CertificatesStack } from '../lib/certificates-stack';
import { DataStack } from '../lib/data-stack';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();

const env: cdk.Environment = { account: ACCOUNT, region: REGION };

const data = new DataStack(app, 'reconflow-data', {
  env,
  stackName: `${PREFIX}-data`,
  description: 'ReconFlow core table, documents bucket, and the representative source databases seeded for the proof of concept',
});

const PORTAL_DOMAIN = 'reconflow.wingtheidea.com';
const BMS_DOMAIN = 'bms.reconflow.wingtheidea.com';

// NOTE: the shared bucket webapps.wingtheidea.com is NOT declared here. It
// already exists and is owned by the CloudFormation stack WingTheIdeaSite
// (source: WingTheIdea/LANDINGPAGE/infra). A bucket has exactly one policy, so
// declaring it — or a second AWS::S3::BucketPolicy for it — from this app would
// fight with that stack. These stacks import it by name; the owning stack
// grants CloudFront read.

// CloudFront only accepts certificates from us-east-1.
const certificates = new CertificatesStack(app, 'reconflow-certificates', {
  env: { account: ACCOUNT, region: CERTIFICATE_REGION },
  stackName: `${PREFIX}-certificates`,
  description: 'ACM certificates for the ReconFlow hostnames (us-east-1, required by CloudFront)',
  crossRegionReferences: true,
  domains: [
    { id: 'PortalCertificate', domainName: PORTAL_DOMAIN },
    { id: 'BmsCertificate', domainName: BMS_DOMAIN },
  ],
});

const portal = new StaticSiteStack(app, 'reconflow-portal', {
  env,
  stackName: `${PREFIX}-portal`,
  description: `ReconFlow PORTAL — CloudFront + Route 53 for ${PORTAL_DOMAIN}, and its GitHub Actions deploy role`,
  crossRegionReferences: true,
  appName: 'portal',
  githubRepo: 'Admin-Mobil80/RECONFLOW-PORTAL',
  domainName: PORTAL_DOMAIN,
  sitePrefix: 'RECONFLOW/PORTAL',
  certificate: certificates.certificates[PORTAL_DOMAIN],
});

const bms = new StaticSiteStack(app, 'reconflow-bms', {
  env,
  stackName: `${PREFIX}-bms`,
  description: `ReconFlow BMS — CloudFront + Route 53 for ${BMS_DOMAIN}, and its GitHub Actions deploy role`,
  crossRegionReferences: true,
  appName: 'bms',
  githubRepo: 'Admin-Mobil80/RECONFLOW-BMS',
  domainName: BMS_DOMAIN,
  sitePrefix: 'RECONFLOW/BMS',
  certificate: certificates.certificates[BMS_DOMAIN],
});

// The account is shared with four other products, so tags are how ReconFlow's
// resources stay identifiable.
for (const stack of [data, certificates, portal, bms]) {
  cdk.Tags.of(stack).add('project', PREFIX);
}
for (const stack of [data, certificates, portal, bms]) {
  cdk.Tags.of(stack).add('managed-by', 'cdk');
  cdk.Tags.of(stack).add('repo', 'Admin-Mobil80/RECONFLOW-BACKEND');
}
