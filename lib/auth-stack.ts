import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import { Construct } from 'constructs';
import { MAIL_FROM_ADDRESS, MAIL_FROM_NAME, PREFIX, SES_IDENTITY_DOMAIN, SES_REGION } from './account';

/**
 * Who a user is to ReconFlow.
 *
 *   root           the platform itself — signs into the BMS, creates organisations
 *   owner          an organisation's first account, created from the BMS
 *   administrator  manages the organisation's interfaces and users in the portal
 *   reviewer       decides cases
 *
 * A root user's organisationId is the platform's own id, not a customer's.
 */
export type UserRole = 'root' | 'owner' | 'administrator' | 'reviewer';

export interface InitialUser {
  readonly email: string;
  readonly name: string;
  readonly organisationId: string;
  readonly role: UserRole;
}

export interface AuthStackProps extends cdk.StackProps {
  /**
   * Users that exist from the first deploy, as CloudFormation resources.
   * Everyone else is provisioned from the BMS. There is no self sign-up.
   */
  readonly initialUsers: readonly InitialUser[];
}

/**
 * Sign-in for every ReconFlow surface: passwordless, email + one-time code.
 *
 * No password is ever set or accepted — `allowedFirstAuthFactors.password`
 * is off, so the only way in is the code Cognito emails through SES as
 * "ReconFlow <no-reply@wingtheidea.com>". Which organisation a user belongs
 * to, and whether they administer it, travel as custom attributes in the
 * ID token; the portal reads them from there and never asks a backend.
 */
export class AuthStack extends cdk.Stack {
  public readonly userPool: cognito.UserPool;
  public readonly portalClient: cognito.UserPoolClient;
  public readonly bmsClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-users`,
      // Passwordless sign-in needs the Essentials tier or above.
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      // Cognito refuses to remove password as a first factor at the pool
      // level, so passwordlessness is enforced everywhere below it instead:
      // the client's only flow is USER_AUTH, the sign-in UI only ever asks for
      // EMAIL_OTP, no user is ever issued a password (creation suppresses the
      // temporary one), and account recovery is off so none can be set.
      signInPolicy: {
        allowedFirstAuthFactors: { password: true, emailOtp: true },
      },
      standardAttributes: {
        email: { required: true, mutable: true },
        fullname: { required: false, mutable: true },
      },
      customAttributes: {
        org: new cognito.StringAttribute({ mutable: true, minLen: 1, maxLen: 64 }),
        role: new cognito.StringAttribute({ mutable: true, minLen: 1, maxLen: 32 }),
      },
      // The wingtheidea.com identity is verified in SES_REGION only; Cognito
      // accepts that cross-region identity for a pool in ap-south-1.
      email: cognito.UserPoolEmail.withSES({
        fromEmail: MAIL_FROM_ADDRESS,
        fromName: MAIL_FROM_NAME,
        sesRegion: SES_REGION,
        sesVerifiedDomain: SES_IDENTITY_DOMAIN,
      }),
      userVerification: {
        emailSubject: 'Your ReconFlow sign-in code',
        emailBody: 'Your ReconFlow sign-in code is {####}. It expires shortly. If you did not request it, ignore this email.',
        emailStyle: cognito.VerificationEmailStyle.CODE,
      },
      // Nothing to recover: there are no passwords.
      accountRecovery: cognito.AccountRecovery.NONE,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // One client per surface, identical in shape, so each can be rotated or
    // restricted on its own. Both use USER_AUTH: the choice-based flow that
    // carries EMAIL_OTP.
    const clientFor = (id: string, name: string) =>
      this.userPool.addClient(id, {
        userPoolClientName: `${PREFIX}-${name}`,
        authFlows: { user: true },
        generateSecret: false,
        preventUserExistenceErrors: true,
        idTokenValidity: cdk.Duration.hours(8),
        accessTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
        readAttributes: new cognito.ClientAttributes()
          .withStandardAttributes({ email: true, emailVerified: true, fullname: true })
          .withCustomAttributes('org', 'role'),
        writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ fullname: true }),
      });
    this.portalClient = clientFor('PortalClient', 'portal');
    this.bmsClient = clientFor('BmsClient', 'bms');

    for (const user of props.initialUsers) {
      new cognito.CfnUserPoolUser(this, `User-${user.email.replace(/[^a-z0-9]/gi, '-')}`, {
        userPoolId: this.userPool.userPoolId,
        username: user.email,
        // No welcome message: it would carry a temporary password, and there
        // are no passwords. The first email a user sees is a sign-in code.
        messageAction: 'SUPPRESS',
        userAttributes: [
          { name: 'email', value: user.email },
          { name: 'email_verified', value: 'true' },
          { name: 'name', value: user.name },
          { name: 'custom:org', value: user.organisationId },
          { name: 'custom:role', value: user.role },
        ],
      });
    }

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Set as repo variable VITE_COGNITO_USER_POOL_ID in the frontends',
    });
    new cdk.CfnOutput(this, 'PortalClientId', {
      value: this.portalClient.userPoolClientId,
      description: 'Set as repo variable VITE_COGNITO_CLIENT_ID in RECONFLOW-PORTAL',
    });
    new cdk.CfnOutput(this, 'BmsClientId', {
      value: this.bmsClient.userPoolClientId,
      description: 'Set as repo variable VITE_COGNITO_CLIENT_ID in RECONFLOW-BMS',
    });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
  }
}
