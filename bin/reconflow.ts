#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ACCOUNT, PREFIX, REGION } from '../lib/account';
import { StaticSiteStack } from '../lib/static-site-stack';

const app = new cdk.App();

const env: cdk.Environment = { account: ACCOUNT, region: REGION };

// The account is shared with other products, so tags are how ReconFlow's
// resources stay identifiable. Applied app-wide.
cdk.Tags.of(app).add('project', PREFIX);
cdk.Tags.of(app).add('managed-by', 'cdk');
cdk.Tags.of(app).add('repo', 'Admin-Mobil80/RECONFLOW-BACKEND');

new StaticSiteStack(app, 'reconflow-portal', {
  env,
  stackName: `${PREFIX}-portal`,
  description: 'ReconFlow PORTAL — private S3 + CloudFront (OAC) and its GitHub Actions deploy role',
  appName: 'portal',
  githubRepo: 'Admin-Mobil80/RECONFLOW-PORTAL',
});

new StaticSiteStack(app, 'reconflow-bms', {
  env,
  stackName: `${PREFIX}-bms`,
  description: 'ReconFlow BMS — private S3 + CloudFront (OAC) and its GitHub Actions deploy role',
  appName: 'bms',
  githubRepo: 'Admin-Mobil80/RECONFLOW-BMS',
});
