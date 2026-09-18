/**
 * The portal API, reached through the portal's CloudFront distribution at
 * /api/*.
 *
 *   POST /api/contact                  public: the website's Contact Us form
 *   GET  /api/me                       who am I, and my organisation
 *   GET  /api/cases                    every case for my organisation, assessed
 *   GET  /api/cases/{id}               one case: assessment, evidence, documents, decisions, summary
 *   POST /api/cases/{id}/decisions     record a human decision
 *
 * Everything but /contact needs an ID token from the portal user pool, sent
 * as x-id-token (CloudFront overwrites Authorization for function URLs). The
 * token's organisation scopes every read: a reader is built for that
 * organisation and nothing else.
 *
 * Cases are assessed on request from the source tables. Nothing is written
 * back to any source system; the only writes are decisions, in ReconFlow's
 * own table.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from "aws-lambda";
import { assessWithEvidence, convertToBase, type Assessment, type CaseTypeModule } from "../domain/assessment";
import { DynamoSourceReader } from "../domain/dynamo-reader";
import { LiveFxRates } from "../domain/fx-live";
import { narrate } from "../domain/narrator";
import type { Money, Organisation } from "../domain/types";
import { handleContact, json, parseBody } from "../portal/contact";
import type { Contract, CreditNote } from "../tenants/adb/records";
import { supplierRefund } from "../tenants/adb/case-types/supplier-refund";

const CORE_TABLE = process.env.CORE_TABLE!;
const DOCUMENTS_BUCKET = process.env.DOCUMENTS_BUCKET!;
const SOURCE_TABLES = JSON.parse(process.env.SOURCE_TABLES ?? "{}") as Record<string, string>;

const verifier = CognitoJwtVerifier.create({
  userPoolId: process.env.PORTAL_USER_POOL_ID!,
  clientId: process.env.PORTAL_CLIENT_ID!,
  tokenUse: "id",
});
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});
const s3 = new S3Client({});
const fx = new LiveFxRates();

/** The proof of concept has one case type. A tenant setting will choose later. */
const CASE_TYPE: CaseTypeModule = supplierRefund;

const DECISION_ACTIONS = {
  accept: "Accepted the recommendation",
  override: "Overrode the classification",
  "not-ready": "Marked not ready",
  "request-information": "Requested information",
  escalate: "Escalated",
} as const;
type DecisionAction = keyof typeof DECISION_ACTIONS;

interface Caller {
  readonly email: string;
  readonly name?: string;
  readonly organisationId: string;
  readonly role: string;
}

interface Decision {
  readonly caseId: string;
  readonly action: DecisionAction;
  readonly actionLabel: string;
  readonly classification?: string;
  readonly note: string;
  readonly decidedBy: string;
  readonly decidedByName?: string;
  readonly at: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// --- auth -------------------------------------------------------------------------

async function requireUser(event: LambdaFunctionURLEvent): Promise<Caller> {
  const bearer = event.headers.authorization ?? "";
  const token = event.headers["x-id-token"] ?? (bearer.startsWith("Bearer ") ? bearer.slice(7) : "");
  if (!token) throw new HttpError(401, "Sign in to continue.");
  let claims: Record<string, unknown>;
  try {
    claims = (await verifier.verify(token)) as unknown as Record<string, unknown>;
  } catch {
    throw new HttpError(401, "Your session has expired. Sign in again.");
  }
  const organisationId = String(claims["custom:org"] ?? "");
  if (!organisationId) throw new HttpError(403, "This account belongs to no organisation.");
  return {
    email: String(claims.email ?? ""),
    name: claims.name ? String(claims.name) : undefined,
    organisationId,
    role: String(claims["custom:role"] ?? "reviewer"),
  };
}

async function organisationOf(caller: Caller): Promise<Organisation> {
  const result = await dynamo.send(
    new GetCommand({ TableName: CORE_TABLE, Key: { PK: `ORG#${caller.organisationId}`, SK: "PROFILE" } }),
  );
  if (!result.Item) throw new HttpError(403, "Your organisation has not been set up yet.");
  return result.Item as unknown as Organisation;
}

// --- decisions ----------------------------------------------------------------------

function decisionPk(organisationId: string, caseId: string): string {
  return `CASE#${organisationId}#${caseId}`;
}

async function decisionsFor(organisationId: string, caseId: string): Promise<Decision[]> {
  const result = await dynamo.send(
    new QueryCommand({
      TableName: CORE_TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": decisionPk(organisationId, caseId), ":sk": "DECISION#" },
      ScanIndexForward: false,
    }),
  );
  return (result.Items ?? []).map((item) => {
    const { PK: _pk, SK: _sk, ...decision } = item;
    return decision as unknown as Decision;
  });
}

/** A human decision moves the case past the engine's own stage. */
function withDecision(assessment: Assessment, decisions: readonly Decision[]): Assessment {
  const latest = decisions[0];
  if (!latest) return assessment;
  const stage =
    latest.action === "accept" || latest.action === "override" || latest.action === "not-ready"
      ? { stage: "decided", stageLabel: "Decided" }
      : latest.action === "escalate"
        ? { stage: "escalated", stageLabel: "Escalated" }
        : { stage: "awaiting-information", stageLabel: "Awaiting information" };
  return {
    ...assessment,
    lifecycle: { ...assessment.lifecycle, ...stage, enteredAt: latest.at, businessDaysInStage: 0, stale: false, escalation: undefined },
  };
}

// --- cases --------------------------------------------------------------------------

function readerFor(caller: Caller): DynamoSourceReader {
  return new DynamoSourceReader(dynamo, SOURCE_TABLES, caller.organisationId);
}

interface CaseSummary {
  readonly caseId: string;
  readonly supplier: string;
  readonly reason: string;
  readonly amount: Money;
  readonly amountInBase?: Money;
  readonly issuedDate: string;
  readonly readiness: Assessment["readiness"]["verdict"];
  readonly classification: Assessment["classification"]["classification"];
  readonly classificationLabel: string;
  readonly confidence: number;
  readonly exceptions: number;
  readonly blockingExceptions: number;
  readonly stage: string;
  readonly stageLabel: string;
  readonly stale: boolean;
  readonly businessDaysInStage: number;
  readonly latestDecision?: Decision;
}

async function listCases(caller: Caller): Promise<CaseSummary[]> {
  const organisation = await organisationOf(caller);
  const reader = readerFor(caller);
  const anchors = await reader.list(CASE_TYPE.anchor.sourceId, CASE_TYPE.anchor.recordType);
  const now = new Date();

  const summaries = await Promise.all(
    anchors.map(async (anchor) => {
      const { assessment, evidence } = await assessWithEvidence(CASE_TYPE, anchor, reader, fx, organisation.baseCurrency, now);
      const decisions = await decisionsFor(caller.organisationId, assessment.caseId);
      const final = withDecision(assessment, decisions);
      const creditNote = anchor.attributes as CreditNote;
      const contract = evidence.items.find((i) => i.role === "contract")?.record.attributes as Contract | undefined;
      const amount: Money = { amount: creditNote.amount, currency: creditNote.currency };
      return {
        caseId: final.caseId,
        supplier: contract?.supplierName ?? creditNote.supplierId,
        reason: creditNote.reason,
        amount,
        amountInBase: convertToBase(amount, final.fx),
        issuedDate: creditNote.issuedDate,
        readiness: final.readiness.verdict,
        classification: final.classification.classification,
        classificationLabel: final.classification.label,
        confidence: final.classification.confidence,
        exceptions: final.exceptions.length,
        blockingExceptions: final.exceptions.filter((e) => e.severity === "blocking").length,
        stage: final.lifecycle.stage,
        stageLabel: final.lifecycle.stageLabel,
        stale: final.lifecycle.stale,
        businessDaysInStage: final.lifecycle.businessDaysInStage,
        latestDecision: decisions[0],
      } satisfies CaseSummary;
    }),
  );
  return summaries.sort((a, b) => b.issuedDate.localeCompare(a.issuedDate));
}

async function caseDetail(caller: Caller, caseId: string) {
  const organisation = await organisationOf(caller);
  const reader = readerFor(caller);
  const anchor = await reader.get(CASE_TYPE.anchor.sourceId, CASE_TYPE.anchor.recordType, caseId);
  if (!anchor) throw new HttpError(404, `No case ${caseId} in your organisation.`);

  const { assessment, evidence } = await assessWithEvidence(CASE_TYPE, anchor, reader, fx, organisation.baseCurrency, new Date());
  const [decisions, narrative, documents] = await Promise.all([
    decisionsFor(caller.organisationId, caseId),
    narrate(caseId, assessment.summaryFacts),
    Promise.all(
      evidence.documents.map(async (doc) => ({
        ...doc,
        // Short-lived link straight to the object; the bucket itself stays private.
        url: await getSignedUrl(s3, new GetObjectCommand({ Bucket: DOCUMENTS_BUCKET, Key: doc.s3Key }), { expiresIn: 900 }),
      })),
    ),
  ]);

  return {
    assessment: withDecision(assessment, decisions),
    evidence: {
      items: evidence.items.map((item) => ({
        role: item.role,
        sourceId: item.record.sourceId,
        recordType: item.record.recordType,
        recordId: item.record.recordId,
        updatedAt: item.record.updatedAt,
        attributes: item.record.attributes,
      })),
      documents,
    },
    decisions,
    narrative,
    decisionActions: DECISION_ACTIONS,
    classifications: CASE_TYPE.classifications,
  };
}

async function recordDecision(caller: Caller, caseId: string, body: Record<string, unknown>): Promise<Decision> {
  const reader = readerFor(caller);
  const anchor = await reader.get(CASE_TYPE.anchor.sourceId, CASE_TYPE.anchor.recordType, caseId);
  if (!anchor) throw new HttpError(404, `No case ${caseId} in your organisation.`);

  const action = String(body.action ?? "") as DecisionAction;
  if (!(action in DECISION_ACTIONS)) throw new HttpError(400, "Unknown decision.");
  const note = String(body.note ?? "").trim();
  if (note.length > 2000) throw new HttpError(400, "The note is too long.");
  const classification = body.classification ? String(body.classification) : undefined;
  if (action === "override") {
    if (!classification || !(classification in CASE_TYPE.classifications)) {
      throw new HttpError(400, "An override must name the classification to use.");
    }
  }
  if ((action === "request-information" || action === "escalate" || action === "not-ready") && !note) {
    throw new HttpError(400, "Say what is needed - the note is required for this decision.");
  }

  const at = new Date().toISOString();
  const decision: Decision = {
    caseId,
    action,
    actionLabel: DECISION_ACTIONS[action],
    classification: action === "override" ? classification : undefined,
    note,
    decidedBy: caller.email,
    decidedByName: caller.name,
    at,
  };
  await dynamo.send(
    new PutCommand({
      TableName: CORE_TABLE,
      Item: { PK: decisionPk(caller.organisationId, caseId), SK: `DECISION#${at}`, ...decision },
    }),
  );
  return decision;
}

// --- routing ------------------------------------------------------------------------

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath.replace(/^\/api/, "").replace(/\/+$/, "") || "/";

  if (path === "/contact") return handleContact(event);

  try {
    const caller = await requireUser(event);

    if (path === "/me" && method === "GET") {
      const organisation = await organisationOf(caller);
      return json(200, { user: caller, organisation });
    }
    if (path === "/cases" && method === "GET") {
      return json(200, { cases: await listCases(caller) });
    }
    const one = path.match(/^\/cases\/([^/]+)$/);
    if (one && method === "GET") {
      return json(200, await caseDetail(caller, decodeURIComponent(one[1])));
    }
    const decide = path.match(/^\/cases\/([^/]+)\/decisions$/);
    if (decide && method === "POST") {
      const body = parseBody(event);
      if (!body) throw new HttpError(400, "Malformed request.");
      return json(201, { decision: await recordDecision(caller, decodeURIComponent(decide[1]), body) });
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    if (error instanceof HttpError) return json(error.status, { error: error.message });
    console.error(error);
    return json(500, { error: "Something went wrong." });
  }
}
