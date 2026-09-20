/**
 * Turns an assessment's facts into the Control Team's case summary.
 *
 * The language model never decides anything: it receives the facts the rules
 * produced and writes them up. With no usable API key it falls back to a
 * deterministic summary built from the same facts, so the screens work
 * before the key is configured and the demo cannot be blocked by a model.
 */

import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

export interface Narrative {
  readonly summary: string;
  readonly source: "openai" | "deterministic";
  readonly model?: string;
}

const secrets = new SecretsManagerClient({});
let cachedKey: { value: string | null; fetchedAt: number } | undefined;

async function apiKey(): Promise<string | null> {
  const arn = process.env.OPENAI_SECRET_ARN;
  if (!arn) return null;
  if (cachedKey && Date.now() - cachedKey.fetchedAt < 5 * 60 * 1000) return cachedKey.value;
  try {
    const result = await secrets.send(new GetSecretValueCommand({ SecretId: arn }));
    const value = (result.SecretString ?? "").trim();
    // The secret is created with a placeholder; only a real key starts with "sk-".
    cachedKey = { value: value.startsWith("sk-") ? value : null, fetchedAt: Date.now() };
  } catch {
    cachedKey = { value: null, fetchedAt: Date.now() };
  }
  return cachedKey.value;
}

const SYSTEM_PROMPT = [
  "You write case summaries for a finance Control Team reviewing supplier refunds.",
  "You are given verified facts produced by deterministic rules. Do not add facts, do not speculate, and do not change any classification, amount or verdict.",
  "Write three or four short paragraphs of plain prose separated by a blank line - no headings, no bullet points - in British English.",
  "Cover, in this order: what the refund is (credit note, invoice, supplier, amount); where the money came from originally (the fund); whether and how the refund has come back and whether Treasury has confirmed it; the recommended classification and how confident the rules are; and what the reviewer should do next.",
  "Refer to identifiers exactly as given. Treat 'Action required' lines as the recommended next step.",
].join(" ");

export async function narrate(caseId: string, facts: readonly string[]): Promise<Narrative> {
  const key = await apiKey();
  if (!key) return { summary: deterministic(facts), source: "deterministic" };

  const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `Case ${caseId}. Facts:\n${facts.map((f) => `- ${f}`).join("\n")}` },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { summary: deterministic(facts), source: "deterministic" };
    const body = (await response.json()) as { choices?: { message?: { content?: string } }[] };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text ? { summary: text, source: "openai", model } : { summary: deterministic(facts), source: "deterministic" };
  } catch {
    return { summary: deterministic(facts), source: "deterministic" };
  }
}

/** One fact per line; the portal renders line breaks as written. */
function deterministic(facts: readonly string[]): string {
  return facts.join("\n");
}
