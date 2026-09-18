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
| `reconflow-data` | ap-south-1 | ReconFlow's core table and documents bucket (retained), plus the five representative source tables for the proof of concept, seeded by a CloudFormation custom resource |
| `reconflow-auth` | ap-south-1 | One Cognito user pool for every surface, passwordless: three Lambda triggers run the custom auth flow (six-digit code emailed as ReconFlow via SES, verified in constant time, three attempts). A client each for the portal and the BMS, and the platform root account |
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

`webapps.<domain>` is the established pattern across this account —
`webapps.skilterco.com`, `webapps.bugtrakr.com`, `webapps.slotzapp.com` and a
dozen others are laid out identically, each distribution pointing at a folder
with `OriginPath`. The dots in the bucket name are fine in this setup: those
distributions are Deployed and their sites return 200.

### The bucket is owned by another stack

`webapps.wingtheidea.com` is **not** declared by this app. It already exists and
belongs to the CloudFormation stack `WingTheIdeaSite`, whose source is
`WingTheIdea/LANDINGPAGE/infra` — the umbrella landing page, which serves from
the `LANDINGPAGE/` folder of the same bucket. These stacks import it by name.

A bucket has exactly one policy, so this app must not declare an
`AWS::S3::BucketPolicy` for it either: two stacks would overwrite each other's
version. That means **the owning stack has to grant CloudFront read access for
ReconFlow's distributions.** As created, its policy allows only its own
distribution, via an `AWS:SourceArn` condition. Until it is widened, the
ReconFlow distributions will get 403 from S3.

The durable fix is one edit in `WingTheIdea/LANDINGPAGE/infra`: switch that
statement's condition from `AWS:SourceArn` (one distribution) to
`AWS:SourceAccount` (any distribution in this account), so every future app
added to the bucket works without touching the policy again.

CDK warns that it will not manage an imported bucket's policy; that warning is
expected here and acknowledged in `cdk.json`.

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

## Code layout

```
bin/reconflow.ts        the app: which stacks exist, for which account
lib/                    stacks
src/domain/             generic model - knows no customer, source or case type
src/tenants/<org>/      one organisation's configuration: record shapes, seed data
src/handlers/           Lambda entrypoints (bundled by esbuild at synth time)
src/lib/                small dependency-free helpers
```

The line between `domain` and `tenants` is the product boundary. Anything
that mentions a real system, a real record shape or a real classification
belongs under a tenant; the platform reads it as configuration.

## Representative data (proof of concept)

The `reconflow-data` stack holds one DynamoDB table per source interface —
`reconflow-source-procurement`, `-disbursement`, `-treasury`, `-cashroom`,
`-documents` — deliberately separate, so cross-database evidence gathering in
the demo is literally that. Documents are real one-page PDFs in the documents
bucket.

Key layout (see `src/domain/dynamo-keys.ts`): each record is stored once under
`ORG#<org>` and once more under every reference it carries
(`ORG#<org>#REF#<name>#<value>`). "Everything that mentions voucher VCH-123" is
one Query, with no GSI and no knowledge of the schema.

The data is loaded by a CloudFormation custom resource on stack create and
whenever `SEED_VERSION` in `lib/data-stack.ts` changes — so even dummy data
arrives through CloudFormation. `npm run seed:preview` prints what would be
loaded without touching AWS. The first tenant's seed
(`src/tenants/adb/seed.ts`) is ten refund cases covering the demonstration
sequence and every exception in the requirement.

## Application services — not built yet

ReconFlow's backend will be serverless, built from these services (each one a
CloudFormation resource in this app, like everything else). The LLM is the
OpenAI platform, with the key held in Secrets Manager — never in this repo, a
template or an environment file.

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
