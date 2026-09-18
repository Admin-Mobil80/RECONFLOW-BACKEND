import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
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
  /**
   * Synthesise only the user pool. Used once, to `cdk import` a pool that a
   * rolled-back deploy left behind (it is RETAIN + deletion-protected): a
   * CloudFormation import changeset may not create anything, so the clients
   * and users have to follow in a normal deploy afterwards.
   */
  readonly importOnly?: boolean;
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
  /** Absent only in import-only mode. */
  public readonly portalClient?: cognito.UserPoolClient;
  public readonly bmsClient?: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);

    // Cognito's built-in email one-time code is eight digits and not
    // configurable. The house standard is six, so sign-in runs Cognito's
    // custom auth flow instead: these three triggers mint a six-digit code,
    // email it as ReconFlow, and verify the answer. Same passwordless
    // experience, our code length, our wording.
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

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `${PREFIX}-users`,
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
      // Cognito cannot be told to have no passwords at the pool level, so
      // passwordlessness is enforced everywhere below it: the clients' only
      // sign-in flow is CUSTOM_AUTH, no user is ever issued a password
      // (creation suppresses the temporary one), and account recovery is off
      // so none can be set.
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
    });

    new cdk.CfnOutput(this, 'UserPoolId', {
      value: this.userPool.userPoolId,
      description: 'Set as repo variable VITE_COGNITO_USER_POOL_ID in the frontends',
    });
    new cdk.CfnOutput(this, 'Region', { value: this.region });

    if (props.importOnly) return;

    // One client per surface, identical in shape, so each can be rotated or
    // restricted on its own. CUSTOM_AUTH is the only sign-in flow: it runs the
    // triggers above. No SRP, no USER_PASSWORD_AUTH.
    const clientFor = (id: string, name: string) =>
      this.userPool.addClient(id, {
        userPoolClientName: `${PREFIX}-${name}`,
        authFlows: { custom: true },
        generateSecret: false,
        preventUserExistenceErrors: true,
        idTokenValidity: cdk.Duration.hours(8),
        accessTokenValidity: cdk.Duration.hours(1),
        refreshTokenValidity: cdk.Duration.days(30),
        readAttributes: new cognito.ClientAttributes()
          .withStandardAttributes({ email: true, emailVerified: true, fullname: true })
          .withCustomAttributes('org', 'role'),
        // No writeAttributes: Cognito rejects a client that cannot write the
        // pool's required attributes, and nobody self-registers here anyway.
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

    new cdk.CfnOutput(this, 'PortalClientId', {
      value: this.portalClient.userPoolClientId,
      description: 'Set as repo variable VITE_COGNITO_CLIENT_ID in RECONFLOW-PORTAL',
    });
    new cdk.CfnOutput(this, 'BmsClientId', {
      value: this.bmsClient.userPoolClientId,
      description: 'Set as repo variable VITE_COGNITO_CLIENT_ID in RECONFLOW-BMS',
    });
  }
}
