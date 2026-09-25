/**
 * The activity log: an append-only record of everything anyone does to the
 * system, across every surface and every organisation.
 *
 * Kept deliberately separate from the records it describes. A user's own item
 * carries who created it, but deleting that user takes the evidence with it;
 * an entry here survives the thing it is about. Nothing ever updates or
 * deletes an entry - that is the whole point of it.
 *
 * Layout: one partition per calendar month (`AUDIT#2026-09`), sorted by
 * timestamp. Reading "the most recent activity" walks months backwards from
 * now, which keeps any single partition small without needing an index.
 */

import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";

export type AuditAction =
  | "sign-in"
  | "organisation.created"
  | "user.added"
  | "user.suspended"
  | "user.restored"
  | "decision.recorded"
  | "demo.event"
  | "demo.reset";

export interface AuditEntry {
  readonly at: string;
  readonly action: AuditAction;
  /** Who did it. An email, or "system" when no person was involved. */
  readonly actor: string;
  /** Which surface it happened on. */
  readonly surface: "portal" | "bms";
  /** The organisation it concerns, or "platform" for platform-level activity. */
  readonly scope: string;
  /** One line a person can read without knowing the data model. */
  readonly summary: string;
  /** The thing acted upon, when there is one - a case id, an email, an org id. */
  readonly subject?: string;
}

function partitionFor(iso: string): string {
  return `AUDIT#${iso.slice(0, 7)}`;
}

/**
 * Appends an entry. Never throws: an audit write that fails must not fail the
 * action it describes, or a full log becomes a way to block the system. A
 * failure is logged for the operator instead.
 */
export async function recordActivity(
  dynamo: DynamoDBDocumentClient,
  tableName: string,
  entry: Omit<AuditEntry, "at"> & { readonly at?: string },
): Promise<void> {
  const at = entry.at ?? new Date().toISOString();
  try {
    await dynamo.send(
      new PutCommand({
        TableName: tableName,
        Item: { PK: partitionFor(at), SK: `${at}#${randomUUID()}`, ...entry, at },
      }),
    );
  } catch (error) {
    console.error("audit write failed", { action: entry.action, actor: entry.actor, error });
  }
}

/** Month partitions from now backwards, newest first. */
function recentMonths(count: number): string[] {
  const months: string[] = [];
  const cursor = new Date();
  for (let i = 0; i < count; i += 1) {
    months.push(`AUDIT#${cursor.toISOString().slice(0, 7)}`);
    cursor.setUTCMonth(cursor.getUTCMonth() - 1);
  }
  return months;
}

/**
 * The most recent activity, newest first. Walks month partitions backwards and
 * stops as soon as it has enough, so a quiet system costs one query.
 */
export async function readActivity(
  dynamo: DynamoDBDocumentClient,
  tableName: string,
  limit = 200,
  monthsToSearch = 12,
): Promise<AuditEntry[]> {
  const entries: AuditEntry[] = [];
  for (const partition of recentMonths(monthsToSearch)) {
    if (entries.length >= limit) break;
    const result = await dynamo.send(
      new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": partition },
        // Descending: the sort key starts with the timestamp.
        ScanIndexForward: false,
        Limit: limit - entries.length,
      }),
    );
    for (const item of result.Items ?? []) {
      const { PK: _pk, SK: _sk, ...entry } = item;
      entries.push(entry as unknown as AuditEntry);
    }
  }
  return entries.slice(0, limit);
}
