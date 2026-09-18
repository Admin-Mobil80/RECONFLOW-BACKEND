#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import {
  ACCOUNT,
  CERTIFICATE_REGION,
  ENQUIRIES_TO_ADDRESS,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  PREFIX,
  REGION,
  SES_IDENTITY_DOMAIN,
  SES_REGION,
} from '../lib/account';
import { AuthStack } from '../lib/auth-stack';
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

// One-off: `cdk import` of a pool a rolled-back deploy left behind. An import
// changeset on a new stack may not carry stack tags or a CloudFormation
// execution role, so in this mode the stack is synthesised with neither; the
// ordinary deploy that follows puts both back.
const importOnly = process.env.RECONFLOW_IMPORT_ONLY === '1';

const auth = new AuthStack(app, 'reconflow-auth', {
  env,
  stackName: `${PREFIX}-auth`,
  synthesizer: importOnly ? new cdk.CliCredentialsStackSynthesizer() : undefined,
  description: 'ReconFlow sign-in: portal and BMS Cognito user pools with passwordless six-digit email codes sent through SES',
  // The platform root: signs into the BMS and creates organisations, each
  // with an owner. Every other account is provisioned from there.
  bmsRoot: { email: 'riyad@mobil80.com', name: 'Riyad Rasheed' },
  importOnly,
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
  // The public site carries the Contact Us form; the BMS is internal and does not.
  contactForm: {
    toAddress: ENQUIRIES_TO_ADDRESS,
    fromAddress: MAIL_FROM_ADDRESS,
    fromName: MAIL_FROM_NAME,
    sesRegion: SES_REGION,
    sesIdentityDomain: SES_IDENTITY_DOMAIN,
  },
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
const taggedStacks = importOnly ? [data, certificates, portal, bms] : [data, auth, certificates, portal, bms];
for (const stack of taggedStacks) {
  cdk.Tags.of(stack).add('project', PREFIX);
}
for (const stack of taggedStacks) {
  cdk.Tags.of(stack).add('managed-by', 'cdk');
  cdk.Tags.of(stack).add('repo', 'Admin-Mobil80/RECONFLOW-BACKEND');
}
