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

  // An unknown address is deliberately NOT special-cased here: it gets a
  // challenge like anyone else (the create trigger sends nothing and sets a
  // code that cannot be guessed), so an attacker cannot tell a real account
  // from a made-up one by how sign-in responds.
  if (last?.challengeName === "CUSTOM_CHALLENGE" && last.challengeResult) {
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
