/**
 * Deployment target and pre-existing account facts.
 *
 * The account is hardcoded on purpose: it is shared with cloudmeter, expense.ai,
 * flaunt and mmdm, so an env-agnostic app that picked up whatever credentials
 * happened to be active could deploy ReconFlow resources into the wrong place —
 * or, worse, run against the static [default] IAM user instead of SSO.
 */
export const ACCOUNT = '231427841372';
export const REGION = 'ap-south-1';

/** ACM certificates for CloudFront must live here, whatever region the app uses. */
export const CERTIFICATE_REGION = 'us-east-1';

/** Every ReconFlow resource name starts with this. It is the only separation between products. */
export const PREFIX = 'reconflow';

/**
 * The GitHub Actions OIDC provider ALREADY EXISTS in this account (created
 * 2026-04-16, tagged project=mmdm). IAM allows only one provider per URL per
 * account, so this app imports it and never declares one — `new
 * iam.OpenIdConnectProvider(...)` here would fail with EntityAlreadyExists and
 * changing its thumbprints or client IDs would break another product's
 * pipelines. Verify with:
 *   aws iam list-open-id-connect-providers --profile wingtheidea
 */
export const GITHUB_OIDC_PROVIDER_ARN = `arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`;

/** Pre-existing public hosted zone for wingtheidea.com. */
export const ZONE_NAME = 'wingtheidea.com';
export const HOSTED_ZONE_ID = 'Z008500039SSWYWL7HKJI';

/**
 * Shared hosting bucket for every WingTheIdea web app, laid out by folder:
 *
 *   wingtheidea-webapps/
 *     RECONFLOW/
 *       PORTAL/   -> reconflow.wingtheidea.com
 *       BMS/      -> bms.reconflow.wingtheidea.com
 *
 * NOT named `webapps.wingtheidea.com`: a bucket name containing dots cannot be
 * reached over HTTPS in virtual-hosted style, because the S3 wildcard
 * certificate `*.s3.<region>.amazonaws.com` matches a single label only. That
 * breaks CloudFront's TLS connection to the origin. The hostname is supplied by
 * CloudFront and Route 53, so the bucket name is free to be dot-free.
 */
export const WEBAPPS_BUCKET_NAME = `wingtheidea-webapps-${ACCOUNT}`;
