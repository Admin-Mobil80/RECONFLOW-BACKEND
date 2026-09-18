/**
 * Cognito "create auth challenge" trigger: mints a six-digit code, emails it,
 * and hands the code to Cognito as a private challenge parameter for the
 * verify trigger to compare against. The code never reaches the client.
 *
 * Every InitiateAuth starts a fresh session and therefore a fresh code, which
 * is what "send a new code" in the UI relies on. Cognito's session validity
 * (three minutes by default) is the code's lifetime.
 */

import { randomInt } from "node:crypto";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { CreateAuthChallengeTriggerEvent } from "aws-lambda";

const ses = new SESv2Client({ region: process.env.SES_REGION });
const FROM_HEADER = `${process.env.FROM_NAME} <${process.env.FROM_ADDRESS}>`;
const PRODUCT = process.env.PRODUCT_NAME ?? "ReconFlow";
const CODE_TTL_MINUTES = 3;

function maskEmail(email: string): string {
  const [local, domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain.slice(0, 1)}***`;
}

export async function handler(event: CreateAuthChallengeTriggerEvent): Promise<CreateAuthChallengeTriggerEvent> {
  const email = event.request.userAttributes.email;

  // Unknown address: Cognito still calls us so the response timing looks the
  // same. Set a code nobody can guess and send nothing.
  if (event.request.userNotFound || !email) {
    event.response.privateChallengeParameters = { code: "no-user" };
    event.response.publicChallengeParameters = { destination: "***" };
    event.response.challengeMetadata = "EMAIL_CODE";
    return event;
  }

  // A wrong answer makes Cognito ask for another challenge in the same
  // session, and this trigger runs again. Re-issue the code already sent
  // rather than minting and emailing a new one on every failed attempt; it is
  // carried between rounds in the challenge metadata, which never reaches
  // the client.
  const previous = event.request.session?.at(-1)?.challengeMetadata;
  const reused = previous?.match(/^CODE-(\d{6})$/)?.[1];
  const code = reused ?? String(randomInt(0, 1_000_000)).padStart(6, "0");

  if (reused) {
    event.response.privateChallengeParameters = { code };
    event.response.publicChallengeParameters = { destination: maskEmail(email) };
    event.response.challengeMetadata = `CODE-${code}`;
    return event;
  }

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_HEADER,
      Destination: { ToAddresses: [email] },
      Content: {
        Simple: {
          Subject: { Data: `Your ${PRODUCT} sign-in code` },
          Body: {
            Text: {
              Data: [
                `Your ${PRODUCT} sign-in code is:`,
                "",
                `    ${code}`,
                "",
                `It expires in ${CODE_TTL_MINUTES} minutes and works once.`,
                "",
                "If you did not try to sign in, you can ignore this email; nobody can use the code without access to this inbox.",
              ].join("\n"),
            },
          },
        },
      },
    }),
  );

  event.response.privateChallengeParameters = { code };
  event.response.publicChallengeParameters = { destination: maskEmail(email) };
  event.response.challengeMetadata = `CODE-${code}`;
  return event;
}
