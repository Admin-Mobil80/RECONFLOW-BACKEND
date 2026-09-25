/**
 * Cognito "verify auth challenge response" trigger: does the answer match the
 * code the create trigger minted? Compared in constant time so a wrong guess
 * takes exactly as long as a right one.
 *
 * A correct answer is also the moment a sign-in happens, so it is the only
 * place that can record one. The write never blocks the sign-in.
 */

import { timingSafeEqual } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { VerifyAuthChallengeResponseTriggerEvent } from "aws-lambda";
import { recordActivity } from "../domain/audit";

const CORE_TABLE = process.env.CORE_TABLE;
const dynamo = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

export async function handler(
  event: VerifyAuthChallengeResponseTriggerEvent,
): Promise<VerifyAuthChallengeResponseTriggerEvent> {
  const expected = event.request.privateChallengeParameters?.code ?? "";
  const answer = (event.request.challengeAnswer ?? "").trim();

  const correct =
    expected.length > 0 &&
    answer.length === expected.length &&
    timingSafeEqual(Buffer.from(answer), Buffer.from(expected));
  event.response.answerCorrect = correct;

  if (correct && CORE_TABLE) {
    const email = event.request.userAttributes.email ?? event.userName;
    const name = event.request.userAttributes.name;
    const organisation = event.request.userAttributes["custom:org"] ?? "";
    const role = event.request.userAttributes["custom:role"] ?? "";
    // The BMS pool is the platform's; every other pool is an organisation's.
    const surface = role === "root" || organisation === "wingtheidea" ? "bms" : "portal";
    await recordActivity(dynamo, CORE_TABLE, {
      action: "sign-in",
      actor: email,
      surface,
      scope: surface === "bms" ? "platform" : organisation,
      subject: email,
      summary: `${name ?? email} signed in to the ${surface === "bms" ? "BMS" : "portal"}`,
    });
  }
  return event;
}
