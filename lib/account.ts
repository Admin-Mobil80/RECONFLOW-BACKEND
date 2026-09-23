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

/**
 * Outbound mail. The wingtheidea.com SES identity is verified in us-east-1
 * ONLY — SES identities are regional, and there is none in ap-south-1 — so
 * every sender pins its SES client to this region regardless of where the
 * function runs. The account has production access there.
 */
export const SES_REGION = 'us-east-1';
export const SES_IDENTITY_DOMAIN = 'wingtheidea.com';
export const MAIL_FROM_ADDRESS = 'no-reply@wingtheidea.com';
/** Inboxes show the display name, so mail reads as from "ReconFlow", not a no-reply mailbox. */
export const MAIL_FROM_NAME = 'ReconFlow';
/** Where enquiries from the public site are delivered. */
export const ENQUIRIES_TO_ADDRESS = 'riyad@mobil80.com';

/**
 * Demonstration accounts: they sign in with a FIXED code and are sent no
 * email, so credentials can be handed to a prospect for review.
 *
 * Read this before adding one. Anybody who knows the address can sign in as
 * that account, from anywhere, forever — it is a published credential, not a
 * weak one. Only ever point a demonstration account at an organisation whose
 * data is representative, and remove it before that organisation holds
 * anything real.
 *
 * To withdraw every demonstration account: empty this list and deploy. The
 * accounts stop working immediately, and CloudFormation removes them from
 * the pools on the same deploy.
 */
export const DEMO_SIGN_IN_CODE = '000000';

export interface DemoAccount {
  readonly email: string;
  readonly name: string;
  readonly surface: 'portal' | 'bms';
  /** Portal accounts only — a BMS account belongs to the platform, not an organisation. */
  readonly organisationId?: string;
  readonly role: 'owner' | 'administrator' | 'reviewer';
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: 'abc@xyz.com', name: 'ADB Demonstration', surface: 'portal', organisationId: 'adb', role: 'owner' },
];

/**
 * Addresses that sign in with the fixed code and are never emailed — by the
 * auth trigger, and by every notification the APIs send. Listed explicitly
 * rather than derived from DEMO_ACCOUNTS, because a demonstration address can
 * also be a root or owner account, which is created elsewhere.
 *
 * xyz.com is not a domain we own. Mail to it would bounce, and bounces on an
 * account with SES production access cost sender reputation, so nothing is
 * ever sent to an address in this list.
 */
export const DEMO_ACCOUNT_EMAILS = ['abc@xyz.com'];

/** Pre-existing public hosted zone for wingtheidea.com. */
export const ZONE_NAME = 'wingtheidea.com';
export const HOSTED_ZONE_ID = 'Z008500039SSWYWL7HKJI';

/**
 * Shared hosting bucket for every WingTheIdea web app, laid out by folder:
 *
 *   webapps.wingtheidea.com/
 *     RECONFLOW/
 *       PORTAL/   -> reconflow.wingtheidea.com
 *       BMS/      -> bms.reconflow.wingtheidea.com
 *
 * `webapps.<domain>` is the house pattern across this account —
 * webapps.skilterco.com, webapps.bugtrakr.com, webapps.slotzapp.com and a
 * dozen more all serve this way. The dots in the name are deliberate and
 * work: CloudFront reaches the S3 REST endpoint with OAC, and those
 * distributions are Deployed and serving 200. Do not "fix" this to a dot-free
 * name.
 */
export const WEBAPPS_BUCKET_NAME = 'webapps.wingtheidea.com';
