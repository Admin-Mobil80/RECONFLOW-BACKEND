/**
 * Cognito "verify auth challenge response" trigger: does the answer match the
 * code the create trigger minted? Compared in constant time so a wrong guess
 * takes exactly as long as a right one.
 */

import { timingSafeEqual } from "node:crypto";
import type { VerifyAuthChallengeResponseTriggerEvent } from "aws-lambda";

export async function handler(
  event: VerifyAuthChallengeResponseTriggerEvent,
): Promise<VerifyAuthChallengeResponseTriggerEvent> {
  const expected = event.request.privateChallengeParameters?.code ?? "";
  const answer = (event.request.challengeAnswer ?? "").trim();

  event.response.answerCorrect =
    expected.length > 0 &&
    answer.length === expected.length &&
    timingSafeEqual(Buffer.from(answer), Buffer.from(expected));
  return event;
}
