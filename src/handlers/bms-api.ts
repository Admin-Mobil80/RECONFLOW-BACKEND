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
import { InvokeCommand, LambdaClient } from "@aws-sdk/client-lambda";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { isKnownCurrency } from "../domain/currencies";
import { itemsForDocument, itemsForRecord } from "../domain/dynamo-keys";
import { DynamoSourceReader } from "../domain/dynamo-reader";
import { putItems } from "../domain/dynamo-writer";
import type { Organisation } from "../domain/types";
import { buildPdf } from "../lib/mini-pdf";
import { applyEvent, EventError, type DemoEvent } from "../tenants/adb/events";
import type { CreditNote, RefundVoucher } from "../tenants/adb/records";
import type { Supplier } from "../tenants/adb/suppliers";

const CORE_TABLE = process.env.CORE_TABLE!;
const PORTAL_USER_POOL_ID = process.env.PORTAL_USER_POOL_ID!;
const SOURCE_TABLES = JSON.parse(process.env.SOURCE_TABLES ?? "{}") as Record<string, string>;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const SEED_FUNCTION = process.env.SEED_FUNCTION!;
const s3 = new S3Client({});
const lambda = new LambdaClient({});

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
  if (!isKnownCurrency(baseCurrency)) throw new HttpError(400, "Base currency must be one of the supported currencies.");
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

// --- demonstration --------------------------------------------------------------------
//
// The representative source systems are dummies, so "new data arriving" is
// the BMS writing what those systems would have recorded. The portal assesses
// on request, so the case moves the moment the page is refreshed.

/** Only organisations whose source data uses the ADB record shapes can be driven this way. */
const DEMO_ORGANISATIONS = new Set(["adb"]);

function demoReader(organisationId: string): DynamoSourceReader {
  if (!DEMO_ORGANISATIONS.has(organisationId)) {
    throw new HttpError(400, "Demonstration events are only available for the representative organisation.");
  }
  return new DynamoSourceReader(dynamo, SOURCE_TABLES, organisationId);
}

async function listDemoCases(organisationId: string) {
  const reader = demoReader(organisationId);
  const creditNotes = await reader.list("disbursement", "credit-note");
  const cases = await Promise.all(
    creditNotes.map(async (record) => {
      const cn = record.attributes as CreditNote;
      const vouchers = await reader.byReference("creditNoteNo", cn.creditNoteNo, { sourceId: "disbursement", recordType: "refund-voucher" });
      const voucher = vouchers[0]?.attributes as RefundVoucher | undefined;
      const receipts = voucher
        ? await reader.byReference("referenceNo", voucher.voucherNo, { sourceId: "treasury", recordType: "refund-receipt" })
        : [];
      return {
        creditNoteNo: cn.creditNoteNo,
        supplierId: cn.supplierId,
        amount: cn.amount,
        currency: cn.currency,
        issuedDate: cn.issuedDate,
        voucherNo: voucher?.voucherNo,
        refundChannel: voucher?.refundChannel,
        treasuryReceipts: receipts.length,
      };
    }),
  );
  const fundSources = (await reader.list("procurement", "fund-source")).map((r) => r.attributes);
  // The vendor master in Procurement.
  const suppliers = (await reader.list("procurement", "supplier"))
    .map((r) => r.attributes as Supplier)
    .sort((a, b) => a.supplierName.localeCompare(b.supplierName));
  return { cases: cases.sort((a, b) => a.creditNoteNo.localeCompare(b.creditNoteNo)), fundSources, suppliers };
}

async function injectEvent(organisationId: string, body: Record<string, unknown>) {
  const reader = demoReader(organisationId);
  const event = body as unknown as DemoEvent;
  if (!event || typeof event.type !== "string") throw new HttpError(400, "An event type is required.");

  // New identifiers continue from the highest credit note number in the system.
  const existing = await reader.list("disbursement", "credit-note");
  const highest = existing.reduce((max, r) => Math.max(max, Number(r.recordId.split("-").pop()) || 0), 0);

  let outcome;
  try {
    outcome = await applyEvent(event, reader, new Date(), highest + 1);
  } catch (error) {
    if (error instanceof EventError) throw new HttpError(400, error.message);
    throw error;
  }

  const bySource = new Map<string, ReturnType<typeof itemsForRecord>>();
  for (const record of outcome.records) {
    bySource.set(record.sourceId, [...(bySource.get(record.sourceId) ?? []), ...itemsForRecord(record)]);
  }
  for (const doc of outcome.documents) {
    const { lines: _lines, ...metadata } = doc;
    bySource.set("documents", [...(bySource.get("documents") ?? []), ...itemsForDocument(organisationId, metadata)]);
  }
  for (const [sourceId, items] of bySource) {
    const table = SOURCE_TABLES[sourceId];
    if (!table) throw new HttpError(500, `No table for source ${sourceId}.`);
    await putItems(dynamo, table, items);
  }
  for (const doc of outcome.documents) {
    await s3.send(new PutObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: doc.s3Key, Body: buildPdf(doc.lines), ContentType: doc.contentType }));
  }
  return {
    summary: outcome.summary,
    creditNoteNo: outcome.creditNoteNo,
    recordsWritten: outcome.records.length,
    documentsWritten: outcome.documents.length,
  };
}

async function resetDemo(organisationId: string, clearDecisions: boolean) {
  demoReader(organisationId);
  const result = await lambda.send(
    new InvokeCommand({
      FunctionName: SEED_FUNCTION,
      Payload: Buffer.from(JSON.stringify({ action: "reset", clearDecisions })),
    }),
  );
  const payload = JSON.parse(Buffer.from(result.Payload ?? new Uint8Array()).toString("utf8") || "{}") as Record<string, unknown>;
  if (result.FunctionError) throw new HttpError(500, `Reset failed: ${String(payload.errorMessage ?? result.FunctionError)}`);
  return payload;
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
    const demoCases = path.match(/^\/organisations\/([^/]+)\/demo\/cases$/);
    if (demoCases && method === "GET") {
      return json(200, await listDemoCases(decodeURIComponent(demoCases[1])));
    }
    const demoEvent = path.match(/^\/organisations\/([^/]+)\/demo\/events$/);
    if (demoEvent && method === "POST") {
      let body: Record<string, unknown>;
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        throw new HttpError(400, "Malformed request.");
      }
      return json(201, await injectEvent(decodeURIComponent(demoEvent[1]), body));
    }
    const demoReset = path.match(/^\/organisations\/([^/]+)\/demo\/reset$/);
    if (demoReset && method === "POST") {
      let body: Record<string, unknown> = {};
      try {
        const raw = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
        body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        throw new HttpError(400, "Malformed request.");
      }
      return json(200, await resetDemo(decodeURIComponent(demoReset[1]), body.clearDecisions === true));
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(error);
    return json(500, { error: "Something went wrong." });
  }
}
