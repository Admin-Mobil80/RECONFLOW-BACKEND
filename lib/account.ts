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

/** Every resource name starts with this. It is the only separation between products. */
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
