/**
 * Emails ReconFlow sends about accounts, as opposed to the sign-in codes the
 * Cognito triggers send. Same sender and same SES region as the contact form:
 * the wingtheidea.com identity is verified there, not where this function runs.
 *
 * Nothing here is allowed to fail an account change. The account already
 * exists by the time we send; a bounced or throttled notification is worth
 * reporting to the administrator, not worth undoing their work.
 */

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";

const ses = new SESv2Client({ region: process.env.SES_REGION });

const FROM_HEADER = `${process.env.FROM_NAME} <${process.env.FROM_ADDRESS}>`;
const PRODUCT = process.env.PRODUCT_NAME ?? "ReconFlow";
const SITE_URL = process.env.SITE_URL ?? "";

const ROLE_SUMMARY: Record<string, string> = {
  owner: "Owner — full access, including users and interfaces.",
  administrator: "Administrator — you can review cases, and manage users and interfaces.",
  reviewer: "Reviewer — you can review cases and record decisions.",
};

export interface AddedUser {
  readonly email: string;
  readonly name: string;
  readonly role: string;
}

async function send(to: string, subject: string, lines: readonly string[]): Promise<void> {
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_HEADER,
      Destination: { ToAddresses: [to] },
      Content: { Simple: { Subject: { Data: subject }, Body: { Text: { Data: lines.join("\n") } } } },
    }),
  );
}

/**
 * Tells the new person they have access and how to get in. There is no
 * password to send: the sign-in page emails them a six-digit code.
 */
export async function sendUserAddedEmails(
  user: AddedUser,
  addedBy: { readonly email: string; readonly name?: string },
  organisationName: string,
  owner: { readonly email: string; readonly name?: string } | undefined,
): Promise<void> {
  const addedByLabel = addedBy.name ? `${addedBy.name} (${addedBy.email})` : addedBy.email;

  await send(user.email, `You have access to ${PRODUCT}`, [
    `Hello ${user.name},`,
    "",
    `${addedByLabel} has given you access to ${PRODUCT} for ${organisationName}.`,
    "",
    ROLE_SUMMARY[user.role] ?? `Your role is ${user.role}.`,
    "",
    ...(SITE_URL ? [`Sign in at ${SITE_URL}/signin`, ""] : []),
    `There is no password. Enter this address - ${user.email} - and ${PRODUCT} emails`,
    "you a six-digit code to sign in with. The code is good for one sign-in.",
    "",
    `${PRODUCT} reads from the systems ${organisationName} already runs and puts the`,
    "evidence in front of you. It never writes back, and it never decides: every",
    "case waits for a person.",
    "",
    `-- ${PRODUCT}. If you were not expecting this, reply to ${addedBy.email}.`,
  ]);

  // The owner is accountable for who can see the organisation's data, so they
  // hear about it even when an administrator did the adding.
  if (owner && owner.email !== addedBy.email && owner.email !== user.email) {
    await send(owner.email, `${user.email} was added to ${PRODUCT}`, [
      `Hello${owner.name ? ` ${owner.name}` : ""},`,
      "",
      `${addedByLabel} added a user to ${PRODUCT} for ${organisationName}:`,
      "",
      `Name:  ${user.name}`,
      `Email: ${user.email}`,
      `Role:  ${user.role}`,
      `Added: ${new Date().toISOString()}`,
      "",
      "They can sign in from now on. You can disable the account under Users",
      ...(SITE_URL ? [`at ${SITE_URL}/app/users.`] : ["in the portal."]),
      "",
      `-- ${PRODUCT}. You are receiving this as the owner of ${organisationName}.`,
    ]);
  }
}

/**
 * The same, for a platform account added from the BMS. The BMS is the
 * platform's own console, so the note says plainly what it gives access to.
 */
export async function sendPlatformUserAddedEmail(
  user: AddedUser,
  addedBy: { readonly email: string; readonly name?: string },
  rootEmail: string,
): Promise<void> {
  const addedByLabel = addedBy.name ? `${addedBy.name} (${addedBy.email})` : addedBy.email;

  await send(user.email, `You have access to the ${PRODUCT} BMS`, [
    `Hello ${user.name},`,
    "",
    `${addedByLabel} has given you a platform administrator account for the`,
    `${PRODUCT} BMS. From it you can create customer organisations and their`,
    "owner accounts, and run the demonstration controls.",
    "",
    ...(SITE_URL ? [`Sign in at ${SITE_URL}`, ""] : []),
    `There is no password. Enter this address - ${user.email} - and ${PRODUCT} emails`,
    "you a six-digit code to sign in with.",
    "",
    "This account administers the platform, not any one customer. Treat it",
    "accordingly.",
    "",
    `-- ${PRODUCT}. If you were not expecting this, reply to ${addedBy.email}.`,
  ]);

  if (rootEmail && rootEmail !== addedBy.email && rootEmail !== user.email) {
    await send(rootEmail, `${user.email} was added to the ${PRODUCT} BMS`, [
      `${addedByLabel} added a platform administrator:`,
      "",
      `Name:  ${user.name}`,
      `Email: ${user.email}`,
      `Added: ${new Date().toISOString()}`,
      "",
      "You can suspend the account under Users in the BMS.",
      "",
      `-- ${PRODUCT}. You are receiving this as the platform root.`,
    ]);
  }
}
