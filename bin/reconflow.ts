#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, CERTIFICATE_REGION, PREFIX, REGION } from '../lib/account';
import { CertificatesStack } from '../lib/certificates-stack';
import { StaticSiteStack } from '../lib/static-site-stack';
import { WebappsHostingStack } from '../lib/webapps-hosting-stack';

const app = new cdk.App();

const env: cdk.Environment = { account: ACCOUNT, region: REGION };

const PORTAL_DOMAIN = 'reconflow.wingtheidea.com';
const BMS_DOMAIN = 'bms.reconflow.wingtheidea.com';

// Shared across every WingTheIdea web app, so it is tagged for the group
// rather than for ReconFlow.
const hosting = new WebappsHostingStack(app, 'wingtheidea-webapps', {
  env,
  stackName: 'wingtheidea-webapps',
  description: 'Shared S3 bucket serving every WingTheIdea web app, one folder per app',
});
cdk.Tags.of(hosting).add('project', 'wingtheidea');

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

// The bucket is imported by name rather than referenced, so the ordering has
// to be declared: the folders must exist to be served.
portal.addDependency(hosting);
bms.addDependency(hosting);

// The account is shared with four other products, so tags are how ReconFlow's
// resources stay identifiable.
for (const stack of [certificates, portal, bms]) {
  cdk.Tags.of(stack).add('project', PREFIX);
}
for (const stack of [hosting, certificates, portal, bms]) {
  cdk.Tags.of(stack).add('managed-by', 'cdk');
  cdk.Tags.of(stack).add('repo', 'Admin-Mobil80/RECONFLOW-BACKEND');
}
