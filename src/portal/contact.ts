/**
 * Contact Us on the public site: validates the form and emails the enquiry.
 * Public - no sign-in - and served by the portal API at POST /api/contact.
 *
 * Sends through SES in SES_REGION, which is where the wingtheidea.com identity
 * is verified and not necessarily where the function runs.
 */

import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";

const ses = new SESv2Client({ region: process.env.SES_REGION });

const FROM_ADDRESS = process.env.FROM_ADDRESS!;
const FROM_HEADER = `${process.env.FROM_NAME} <${FROM_ADDRESS}>`;
const TO_ADDRESS = process.env.TO_ADDRESS!;
const PRODUCT = process.env.PRODUCT_NAME ?? "ReconFlow";

const LIMITS = { name: 200, email: 320, phone: 50, useCase: 5000 } as const;
const MIN_USE_CASE = 20;
// Permissive on purpose: the only real proof an address works is delivery.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function json(statusCode: number, body: unknown): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

export function parseBody(event: LambdaFunctionURLEvent): Record<string, unknown> | undefined {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

interface Submission {
  readonly name: string;
  readonly email: string;
  readonly phone: string;
  readonly useCase: string;
}

function validate(data: Record<string, unknown>): { submission?: Submission; errors: string[] } {
  const text = (key: string) => String(data[key] ?? "").trim();
  const name = text("name");
  const email = text("email");
  const phone = text("phone");
  const useCase = text("useCase");

  const errors: string[] = [];
  if (!name) errors.push("Name is required.");
  else if (name.length > LIMITS.name) errors.push("Name is too long.");

  if (!email) errors.push("Email is required.");
  else if (email.length > LIMITS.email || !EMAIL_RE.test(email)) errors.push("Email address looks invalid.");

  if (phone.length > LIMITS.phone) errors.push("Phone number is too long.");

  if (!useCase) errors.push("Please describe your use case.");
  else if (useCase.length < MIN_USE_CASE) errors.push("Please tell us a little more about your use case.");
  else if (useCase.length > LIMITS.useCase) errors.push("The description is too long.");

  return errors.length ? { errors } : { submission: { name, email, phone, useCase }, errors };
}

export async function handleContact(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  if (event.requestContext.http.method !== "POST") {
    return json(405, { ok: false, errors: ["Method not allowed."] });
  }
  const data = parseBody(event);
  if (!data) return json(400, { ok: false, errors: ["Malformed request."] });

  // Honeypot: a person never fills a field they cannot see. Report success so
  // a bot learns nothing about why nothing happened.
  if (String(data.website ?? "").trim()) return json(200, { ok: true });

  const { submission, errors } = validate(data);
  if (!submission) return json(400, { ok: false, errors });

  const lines = [
    `New ${PRODUCT} enquiry`,
    "",
    `Name:   ${submission.name}`,
    `Email:  ${submission.email}`,
    `Phone:  ${submission.phone || "(not given)"}`,
    `Sent:   ${new Date().toISOString()}`,
    "",
    "Use case:",
    submission.useCase,
    "",
    `-- Sent by the ${PRODUCT} website contact form. Reply goes to the enquirer.`,
  ];

  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: FROM_HEADER,
      Destination: { ToAddresses: [TO_ADDRESS] },
      ReplyToAddresses: [submission.email],
      Content: {
        Simple: {
          Subject: { Data: `${PRODUCT} enquiry from ${submission.name}` },
          Body: { Text: { Data: lines.join("\n") } },
        },
      },
    }),
  );

  return json(200, { ok: true });
}
