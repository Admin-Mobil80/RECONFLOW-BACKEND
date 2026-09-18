/**
 * The BMS API: platform administration, reached through the BMS site's
 * CloudFront distribution at /api/*.
 *
 * Every call must carry an ID token from the BMS user pool with the root
 * role. That pool holds the platform root and nobody else, so the check is
 * belt and braces over pool membership.
 *
 *   GET  /organisations   list organisations
 *   POST /organisations   create one and its owner account in the portal pool
 */

import { AdminCreateUserCommand, CognitoIdentityProviderClient } from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import type { Organisation } from "../domain/types";

const CORE_TABLE = process.env.CORE_TABLE!;
const PORTAL_USER_POOL_ID = process.env.PORTAL_USER_POOL_ID!;

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.BMS_USER_POOL_ID!,
  clientId: process.env.BMS_CLIENT_ID!,
  tokenUse: "id",
});
const cognito = new CognitoIdentityProviderClient({});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

/** One item per organisation under this partition, so listing is one Query. */
const ORGANISATIONS_PK = "ORGANISATIONS";

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface OrganisationSummary {
  readonly organisationId: string;
  readonly name: string;
  readonly baseCurrency: string;
  readonly ownerEmail: string;
  readonly createdAt: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function json(statusCode: number, body: unknown): LambdaFunctionURLResult {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
    body: JSON.stringify(body),
  };
}

async function requireRoot(event: LambdaFunctionURLEvent): Promise<void> {
  // The token arrives in x-id-token, not Authorization: CloudFront replaces
  // Authorization with its own SigV4 signature for the function URL. The
  // Bearer form is accepted too, for direct invocation in tests.
  const bearer = event.headers.authorization ?? "";
  const token = event.headers["x-id-token"] ?? (bearer.startsWith("Bearer ") ? bearer.slice(7) : "");
  if (!token) throw new HttpError(401, "Sign in to use the BMS.");
  let claims: Record<string, unknown>;
  try {
    claims = (await verifier.verify(token)) as unknown as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "Your session has expired. Sign in again.");
  }
  if (claims["custom:role"] !== "root") throw new HttpError(403, "Only platform accounts may use the BMS.");
}

async function listOrganisations(): Promise<OrganisationSummary[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: CORE_TABLE,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": ORGANISATIONS_PK },
    }),
  );
  return (result.Items ?? []).map((item) => ({
    organisationId: item.organisationId as string,
    name: item.name as string,
    baseCurrency: item.baseCurrency as string,
    ownerEmail: item.ownerEmail as string,
    createdAt: item.createdAt as string,
  }));
}

async function createOrganisation(body: Record<string, unknown>): Promise<OrganisationSummary> {
  const text = (key: string) => String(body[key] ?? "").trim();
  const organisationId = text("organisationId").toLowerCase();
  const name = text("name");
  const baseCurrency = text("baseCurrency").toUpperCase();
  const ownerEmail = text("ownerEmail").toLowerCase();
  const ownerName = text("ownerName");

  if (!SLUG_RE.test(organisationId)) throw new HttpError(400, "Identifier must be 2–32 lowercase letters, digits or hyphens, starting with a letter.");
  if (!name || name.length > 120) throw new HttpError(400, "Name is required (up to 120 characters).");
  if (!/^[A-Z]{3}$/.test(baseCurrency)) throw new HttpError(400, "Base currency must be a three-letter ISO code.");
  if (!EMAIL_RE.test(ownerEmail) || ownerEmail.length > 320) throw new HttpError(400, "Owner email looks invalid.");
  if (!ownerName || ownerName.length > 120) throw new HttpError(400, "Owner name is required (up to 120 characters).");

  const createdAt = new Date().toISOString();
  const profile: Organisation & { ownerEmail: string; createdAt: string } = {
    organisationId,
    name,
    baseCurrency,
    interfaces: [],
    ownerEmail,
    createdAt,
  };

  // The profile is the source of truth and refuses to overwrite an existing
  // organisation; the listing item is written only once that succeeds.
  try {
    await dynamo.send(
      new PutCommand({
        TableName: CORE_TABLE,
        Item: { PK: `ORG#${organisationId}`, SK: "PROFILE", ...profile },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
      throw new HttpError(409, `An organisation with identifier "${organisationId}" already exists.`);
    }
    throw error;
  }
  await dynamo.send(
    new PutCommand({
      TableName: CORE_TABLE,
      Item: { PK: ORGANISATIONS_PK, SK: `ORG#${organisationId}`, organisationId, name, baseCurrency, ownerEmail, createdAt },
    }),
  );

  // The owner lives in the portal pool. No welcome message: it would carry a
  // temporary password, and there are no passwords - their first email from
  // ReconFlow is a sign-in code.
  try {
    await cognito.send(
      new AdminCreateUserCommand({
        UserPoolId: PORTAL_USER_POOL_ID,
        Username: ownerEmail,
        MessageAction: "SUPPRESS",
        UserAttributes: [
          { Name: "email", Value: ownerEmail },
          { Name: "email_verified", Value: "true" },
          { Name: "name", Value: ownerName },
          { Name: "custom:org", Value: organisationId },
          { Name: "custom:role", Value: "owner" },
        ],
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === "UsernameExistsException") {
      throw new HttpError(409, `${ownerEmail} already has a portal account; an email can belong to one organisation only.`);
    }
    throw error;
  }

  return { organisationId, name, baseCurrency, ownerEmail, createdAt };
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  try {
    await requireRoot(event);

    const method = event.requestContext.http.method;
    const path = event.rawPath.replace(/^\/api/, "").replace(/\/+$/, "") || "/";

    if (path === "/organisations" && method === "GET") {
      return json(200, { organisations: await listOrganisations() });
    }
    if (path === "/organisations" && method === "POST") {
      let body: Record<string, unknown>;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, "Malformed request.");
      }
      return json(201, { organisation: await createOrganisation(body) });
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(error);
    return json(500, { error: "Something went wrong." });
  }
}
