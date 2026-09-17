# ReconFlow — Backend

AWS infrastructure for ReconFlow, authored in AWS CDK (TypeScript). The
application's serverless services will live here too.

Part of the [WingTheIdea](https://github.com/Admin-Mobil80) group.

## Hard rules

1. **Every AWS resource is created by a CloudFormation template synthesized
   from this CDK app** — no exceptions. No console click-ops, no `aws s3 mb`
   style CLI creation, no Terraform, no Serverless Framework, no hand-written
   CloudFormation.
2. **This repo has no deploy pipeline.** It is committed like any other code;
   `cdk deploy` is run by hand.
3. The frontends (PORTAL, BMS) deploy only through their own GitHub Actions
   workflows, which copy built files into an existing bucket — they never
   create AWS resources.

The AWS CLI is for reading state and for `cdk deploy`.

## Account

Region `ap-south-1` in account `231427841372`, which is **shared** with
cloudmeter, expense.ai, flaunt and mmdm. There is no account boundary between
products, so:

- ReconFlow resources are named `reconflow-*` and tagged `project=reconflow`;
- never delete or modify a resource without first confirming it is ReconFlow's;
- always pass `--profile wingtheidea` — `~/.aws/credentials` holds a static
  `[default]` key pair, so an omitted profile silently runs as a different
  identity with no visible signal.

```bash
aws sso login --profile wingtheidea
```

Already true in this account, verified rather than assumed: CDK is bootstrapped
in `ap-south-1` (`CDKToolkit`, version 32, qualifier `hnb659fds`), the
`wingtheidea.com` hosted zone exists (`Z008500039SSWYWL7HKJI`), and the GitHub
Actions OIDC provider exists — created by another product, so this app
**imports** it and never declares one. See `lib/account.ts`.

## Stacks

| Stack | Region | Contents |
| --- | --- | --- |
| `wingtheidea-webapps` | ap-south-1 | The shared bucket every WingTheIdea web app is served from, plus its CloudFront read policy |
| `reconflow-certificates` | us-east-1 | ACM certificates for the ReconFlow hostnames (CloudFront accepts certificates only from us-east-1) |
| `reconflow-portal` | ap-south-1 | CloudFront + Route 53 for `reconflow.wingtheidea.com`, and RECONFLOW-PORTAL's deploy role |
| `reconflow-bms` | ap-south-1 | CloudFront + Route 53 for `bms.reconflow.wingtheidea.com`, and RECONFLOW-BMS's deploy role |

### Hosting layout

```
webapps.wingtheidea.com/
  RECONFLOW/
    PORTAL/   ->  https://reconflow.wingtheidea.com
    BMS/      ->  https://bms.reconflow.wingtheidea.com
```

One bucket, one folder per app, one CloudFront distribution per app with
`originPath` pointing at its folder. Each app's deploy role can read, write and
list **only its own prefix**, so a runaway `s3 sync --delete` cannot reach a
sibling app.

The bucket is named `webapps.wingtheidea.com`, not
`webapps.wingtheidea.com`: a bucket name containing dots cannot be reached over
HTTPS in virtual-hosted style — S3's wildcard certificate
`*.s3.<region>.amazonaws.com` matches a single label — which breaks CloudFront's
TLS connection to the origin. The public hostnames come from CloudFront and
Route 53.

The shared bucket grants CloudFront read access at the account level rather than
per distribution, because the distributions live in the app stacks; a
per-distribution policy would make the shared stack depend on every app stack
that depends on it. App stacks therefore import the bucket by name, and CDK
correctly warns that it will not manage an imported bucket's policy — that
warning is acknowledged in `cdk.json`.

## Usage

```bash
npm ci
npm test                      # tsc --noEmit
npx cdk synth                 # no credentials needed; account and region are pinned
AWS_PROFILE=wingtheidea npx cdk diff
AWS_PROFILE=wingtheidea npx cdk deploy --all
```

Deploy order is handled by CDK: the shared bucket first, then certificates
(`cdk deploy` waits while ACM validates them through DNS — normally a few
minutes), then the two app stacks.

## Wiring a frontend repo after deploy

Each app stack outputs the values that repo's `deploy.yml` reads as **repo
variables** (Settings → Secrets and variables → Actions → Variables):

| Output | Repo variable |
| --- | --- |
| `S3Bucket` | `S3_BUCKET` |
| `S3Prefix` | `S3_PREFIX` |
| `AwsDeployRoleArn` | `AWS_DEPLOY_ROLE_ARN` |
| `CloudfrontDistributionId` | `CLOUDFRONT_DISTRIBUTION_ID` |

`AWS_REGION` defaults to `ap-south-1` and `BUILD_DIR` to `dist` (Vite), so
neither needs setting. Read the outputs back at any time with:

```bash
aws cloudformation describe-stacks --stack-name reconflow-portal \
  --profile wingtheidea --region ap-south-1 \
  --query 'Stacks[0].Outputs' --output table
```

## Application services — not built yet

ReconFlow's backend will be serverless, built from these services (each one a
CloudFormation resource in this app, like everything else):

- **Lambda** on the `nodejs24.x` runtime
- **AppSync** as the primary API
- **Cognito** for authentication
- **API Gateway** where REST is needed alongside AppSync
- **EventBridge** and **SQS** for events and queues
- **SES** for mail
- **DynamoDB** for data
- **S3** for object storage

Also outstanding: CloudFront access logging (needs a log bucket), and tightening
each deploy role's `sub` claim from `repo:<owner>/<repo>:*` to a branch or a
GitHub environment.
