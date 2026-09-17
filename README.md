# ReconFlow — Backend

AWS infrastructure for ReconFlow, authored in AWS CDK (TypeScript). Application
services will land here too.

Part of the [WingTheIdea](https://github.com/Admin-Mobil80) group.

## Hard rule

**Every ReconFlow AWS resource is created by CloudFormation synthesized from
this CDK app.** No console click-ops, no `aws s3 mb`-style CLI creation, no
Terraform, no Serverless Framework, no hand-written CloudFormation. The AWS CLI
is for reading state and for `cdk deploy`.

## Account

Region `ap-south-1` in account `231427841372`, which is **shared** with
cloudmeter, expense.ai, flaunt and mmdm. There is no account boundary between
products, so:

- every resource name starts with `reconflow-`, and all stacks are tagged
  `project=reconflow`;
- never delete or modify a resource without first confirming it is ReconFlow's;
- always pass `--profile wingtheidea` — `~/.aws/credentials` holds a static
  `[default]` key pair, so an omitted profile silently runs as a different
  identity with no visible signal.

```bash
aws sso login --profile wingtheidea
```

Already verified in this account (no action needed): CDK is bootstrapped in
`ap-south-1` (`CDKToolkit`, bootstrap version 32, default qualifier
`hnb659fds`), and the GitHub Actions OIDC provider already exists — created by
another product and **imported** by this app, never declared. See
`lib/account.ts`.

## Stacks

| Stack | Contents |
| --- | --- |
| `reconflow-portal` | Private S3 bucket + CloudFront (OAC) for RECONFLOW-PORTAL, and that repo's GitHub Actions deploy role |
| `reconflow-bms` | The same for RECONFLOW-BMS |

One stack per frontend, so the two deploy and roll back independently and each
repo's role can reach only its own bucket and distribution. Buckets use
`RemovalPolicy.RETAIN`.

## Usage

```bash
npm ci
npm test                      # tsc --noEmit
npx cdk synth                 # no credentials needed; account/region are pinned
AWS_PROFILE=wingtheidea npx cdk diff
AWS_PROFILE=wingtheidea npx cdk deploy reconflow-portal
```

## Wiring a frontend repo after deploy

Each stack outputs the values the frontend's `deploy.yml` reads as **repo
variables** (Settings → Secrets and variables → Actions → Variables):

| Output | Repo variable |
| --- | --- |
| `S3Bucket` | `S3_BUCKET` |
| `AwsDeployRoleArn` | `AWS_DEPLOY_ROLE_ARN` |
| `CloudfrontDistributionId` | `CLOUDFRONT_DISTRIBUTION_ID` |

`AWS_REGION` defaults to `ap-south-1` and `BUILD_DIR` to `dist` (Vite), so
neither needs setting. Read the outputs back at any time with:

```bash
aws cloudformation describe-stacks --stack-name reconflow-portal \
  --profile wingtheidea --region ap-south-1 \
  --query 'Stacks[0].Outputs' --output table
```

## Not built yet

- ReconFlow's own backend resources (API, data stores, auth).
- Custom subdomains: `Distribution` takes `domainNames` + an ACM certificate,
  and that certificate must live in `us-east-1` regardless of this app's region.
- CloudFront access logging (needs a log bucket).
