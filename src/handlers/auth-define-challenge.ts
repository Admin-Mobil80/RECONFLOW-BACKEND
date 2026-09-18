/**
 * Cognito "define auth challenge" trigger: the state machine for passwordless
 * sign-in. One custom challenge — the emailed code — then tokens, with a hard
 * stop after three wrong answers.
 */

import type { DefineAuthChallengeTriggerEvent } from "aws-lambda";

const MAX_ATTEMPTS = 3;

export async function handler(event: DefineAuthChallengeTriggerEvent): Promise<DefineAuthChallengeTriggerEvent> {
  const session = event.request.session ?? [];
  const last = session[session.length - 1];
  const failures = session.filter((s) => s.challengeName === "CUSTOM_CHALLENGE" && !s.challengeResult).length;

  if (event.request.userNotFound) {
    // Never reveal that an address is unknown: fail the same way a wrong code does.
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult) {
    event.response.issueTokens = true;
    event.response.failAuthentication = false;
  } else if (failures >= MAX_ATTEMPTS) {
    event.response.issueTokens = false;
    event.response.failAuthentication = true;
  } else {
    event.response.issueTokens = false;
    event.response.failAuthentication = false;
    event.response.challengeName = "CUSTOM_CHALLENGE";
  }
  return event;
}
