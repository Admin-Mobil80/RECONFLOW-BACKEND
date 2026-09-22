import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import {
  DEMO_ACCOUNT_EMAILS,
  DEMO_ACCOUNTS,
  DEMO_SIGN_IN_CODE,
  MAIL_FROM_ADDRESS,
  MAIL_FROM_NAME,
  PREFIX,
  SES_IDENTITY_DOMAIN,
  SES_REGION,
} from './account';

/**
 * Who a user is to ReconFlow.
 *
 *   root           the platform itself — signs into the BMS, creates organisations
 *   owner          an organisation's first account, created from the BMS
 *   administrator  manages the organisation's interfaces and users in the portal
 *   reviewer       decides cases
 */
export type UserRole = 'root' | 'owner' | 'administrator' | 'reviewer';

export interface AuthStackProps extends cdk.StackProps {
  /** The single account that exists in the BMS pool from the first deploy. */
  readonly bmsRoot: { readonly email: string; readonly name: string };
  /**
   * Synthesise only the portal user pool. Used once, to `cdk import` a pool
   * that a rolled-back deploy left behind (it is RETAIN + deletion-protected):
   * a CloudFormation import changeset may not create anything, so the rest
   * has to follow in a normal deploy afterwards.
   */
  readonly importOnly?: boolean;
}

/**
 * Sign-in for every ReconFlow surface: passwordless, email + six-digit code.
 *
 * Two user pools, not one. The portal's holds organisation accounts; the
 * BMS's holds the platform root and nobody else. Which surface an account may
 * sign into is therefore enforced by pool membership — a bug in role handling
 * cannot turn a customer's account into one the BMS recognises, and the
 * platform root cannot sign into a customer's portal. Both pools run the same
 * custom auth triggers.
 *
 * No password is ever set or accepted. Cognito cannot be told to have no
 * passwords at the pool level, so passwordlessness is enforced beneath it:
 * every client's only sign-in flow is CUSTOM_AUTH, no user is issued a
 * password (creation suppresses the temporary one), and account recovery is
 * off so none can be set. Self sign-up is disabled everywhere.
 */
export class AuthStack extends cdk.Stack {
  public readonly portalUserPool: cognito.UserPool;
  /** Absent only in import-only mode. */
  public readonly portalClient?: cognito.UserPoolClient;
  public readonly bmsUserPool?: cognito.UserPool;
  public readonly bmsClient?: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Cognito's built-in email one-time code is eight digits and not
    // configurable. The house standard is six, so sign-in runs Cognito's
    // custom auth flow: these three triggers mint a six-digit code, email it
    // as ReconFlow, and verify the answer. They are pool-agnostic and serve
    // both pools.
    const trigger = (name: string, entry: string, environment?: Record<string, string>) =>
      new NodejsFunction(this, name, {
        functionName: `${PREFIX}-auth-${entry}`,
        entry: path.join(__dirname, `../src/handlers/auth-${entry}.ts`),
        runtime: lambda.Runtime.NODEJS_24_X,
        timeout: cdk.Duration.seconds(10),
        memorySize: 256,
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_MONTH,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
        }),
        bundling: { target: 'node24', externalModules: ['@aws-sdk/*'] },
        environment,
      });

    const defineAuthChallenge = trigger('DefineChallenge', 'define-challenge');
    const createAuthChallenge = trigger('CreateChallenge', 'create-challenge', {
      SES_REGION,
      FROM_ADDRESS: MAIL_FROM_ADDRESS,
      FROM_NAME: MAIL_FROM_NAME,
      PRODUCT_NAME: MAIL_FROM_NAME,
      // Fixed code, no email. Empty list = the feature is off entirely.
      DEMO_ACCOUNT_EMAILS: DEMO_ACCOUNT_EMAILS.join(','),
      DEMO_SIGN_IN_CODE: DEMO_ACCOUNT_EMAILS.length ? DEMO_SIGN_IN_CODE : '',
    });
    const verifyAuthChallengeResponse = trigger('VerifyChallenge', 'verify-challenge');

    // Send only as the configured address; the account has other identities.
    createAuthChallenge.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail'],
        resources: [`arn:aws:ses:${SES_REGION}:${this.account}:identity/${SES_IDENTITY_DOMAIN}`],
        conditions: { StringEquals: { 'ses:FromAddress': MAIL_FROM_ADDRESS } },
      }),
    );

    const poolDefaults: Omit<cognito.UserPoolProps, 'userPoolName'> = {
      // Custom auth triggers work on the Lite tier; nothing here needs more.
      featurePlan: cognito.FeaturePlan.LITE,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      lambdaTriggers: { defineAuthChallenge, createAuthChallenge, verifyAuthChallengeResponse },
      // Stated explicitly so an earlier EMAIL_OTP setting is cleared: Lite
      // refuses a pool with passwordless sign-in still enabled. Password is
      // the only factor Cognito lets a pool declare on its own, and no client
      // here offers a password flow.
      signInPolicy: { allowedFirstAuthFactors: { password: true } },
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
      // Nothing to recover: there are no passwords.
      accountRecovery: cognito.AccountRecovery.NONE,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    };

    // Construct id 'UserPool' is load-bearing: it is the logical id of the
    // pool that was imported, and the portal bundle carries its client id.
    this.portalUserPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-users`,
      ...poolDefaults,
    });

    new cdk.CfnOutput(this, 'PortalUserPoolId', {
      value: this.portalUserPool.userPoolId,
      description: 'Organisation accounts. Default in the portal; VITE_COGNITO_USER_POOL_ID overrides',
    });

    if (props.importOnly) return;

    this.bmsUserPool = new cognito.UserPool(this, 'BmsUserPool', {
      userPoolName: `${PREFIX}-bms-users`,
      ...poolDefaults,
    });

    // One client per surface, in that surface's pool. CUSTOM_AUTH is the only
    // sign-in flow: it runs the triggers above. No SRP, no USER_PASSWORD_AUTH.
    const clientFor = (pool: cognito.UserPool, id: string, name: string) =>
      pool.addClient(id, {
        userPoolClientName: `${PREFIX}-${name}`,
        authFlows: { custom: true },
        generateSecret: false,
        // Off on purpose: an unknown address fails at once with "user does
        // not exist" rather than pretending to send a code. Riyad's explicit
        // preference - a clear message over hiding whether an account exists.
        preventUserExistenceErrors: false,
        idTokenValidity: cdk.Duration.hours(8),
        accessTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
        readAttributes: new cognito.ClientAttributes()
          .withStandardAttributes({ email: true, emailVerified: true, fullname: true })
          .withCustomAttributes('org', 'role'),
        // No writeAttributes: Cognito rejects a client that cannot write the
        // pool's required attributes, and nobody self-registers here anyway.
      });
    this.portalClient = clientFor(this.portalUserPool, 'PortalClient', 'portal');
    this.bmsClient = clientFor(this.bmsUserPool, 'BmsClient', 'bms');

    // The platform root is the BMS pool's entire membership until organisations
    // are created from the BMS. No welcome message: it would carry a temporary
    // password, and there are no passwords. The first email they see is a
    // sign-in code.
    new cognito.CfnUserPoolUser(this, 'BmsRootUser', {
      userPoolId: this.bmsUserPool.userPoolId,
      username: props.bmsRoot.email,
      messageAction: 'SUPPRESS',
      userAttributes: [
        { name: 'email', value: props.bmsRoot.email },
        { name: 'email_verified', value: 'true' },
        { name: 'name', value: props.bmsRoot.name },
        { name: 'custom:org', value: 'wingtheidea' },
        { name: 'custom:role', value: 'root' satisfies UserRole },
      ],
    });

    // Demonstration accounts, declared in lib/account.ts. They live in the
    // pools like any other account - the only thing special about them is
    // that the create-challenge trigger gives them a fixed code and sends no
    // email. Emptying DEMO_ACCOUNTS and deploying removes them.
    for (const account of DEMO_ACCOUNTS) {
      const pool = account.surface === 'bms' ? this.bmsUserPool : this.portalUserPool;
      const organisationId = 'organisationId' in account ? account.organisationId : 'wingtheidea';
      new cognito.CfnUserPoolUser(this, `DemoUser${account.surface === 'bms' ? 'Bms' : 'Portal'}`, {
        userPoolId: pool.userPoolId,
        username: account.email,
        messageAction: 'SUPPRESS',
        userAttributes: [
          { name: 'email', value: account.email },
          { name: 'email_verified', value: 'true' },
          { name: 'name', value: account.name },
          { name: 'custom:org', value: organisationId },
          { name: 'custom:role', value: account.role satisfies UserRole },
        ],
      });
    }

    new cdk.CfnOutput(this, 'PortalClientId', {
      value: this.portalClient.userPoolClientId,
      description: 'Default in the portal; VITE_COGNITO_CLIENT_ID overrides',
    });
    new cdk.CfnOutput(this, 'BmsUserPoolId', {
      value: this.bmsUserPool.userPoolId,
      description: 'Platform accounts only. Set as VITE_COGNITO_USER_POOL_ID in RECONFLOW-BMS',
    });
    new cdk.CfnOutput(this, 'BmsClientId', {
      value: this.bmsClient.userPoolClientId,
      description: 'Set as VITE_COGNITO_CLIENT_ID in RECONFLOW-BMS',
    });
    new cdk.CfnOutput(this, 'Region', { value: this.region });
  }
}
