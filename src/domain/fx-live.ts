import type { FxRate, FxRateSource } from "./assessment";
import type { CurrencyCode } from "./types";

/**
 * Live rates from frankfurter.app (ECB reference rates, no key), cached per
 * container for an hour. If the fetch fails, or a currency is not in the ECB
 * set, the fallback table answers so an assessment never stalls on FX; the
 * snapshot records which provider each rate came from.
 */
const CACHE_TTL_MS = 60 * 60 * 1000;

interface CacheEntry {
  readonly asOf: string;
  readonly fetchedAt: number;
  readonly perBase: Readonly<Record<string, number>>;
}

const cache = new Map<CurrencyCode, CacheEntry>();

export class LiveFxRates implements FxRateSource {
  constructor(private readonly fallbackPerBase: Readonly<Record<string, Readonly<Record<string, number>>>> = FALLBACK) {}

  async rates(base: CurrencyCode, currencies: readonly CurrencyCode[]): Promise<readonly FxRate[]> {
    const wanted = [...new Set(currencies.filter((c) => c !== base))];
    if (wanted.length === 0) return [];

    let live = cache.get(base);
    if (!live || Date.now() - live.fetchedAt > CACHE_TTL_MS) {
      live = await fetchFrankfurter(base, wanted);
      if (live) cache.set(base, live);
    }

    const fallback = this.fallbackPerBase[base] ?? {};
    const out: FxRate[] = [];
    for (const currency of wanted) {
      const liveRate = live?.perBase[currency];
      if (liveRate) {
        out.push({ currency, rateToBase: 1 / liveRate, asOf: live!.asOf, provider: "frankfurter (ECB)" });
      } else if (fallback[currency]) {
        out.push({ currency, rateToBase: 1 / fallback[currency], asOf: FALLBACK_AS_OF, provider: "fallback table" });
      }
    }
    return out;
  }
}

async function fetchFrankfurter(base: string, symbols: readonly string[]): Promise<CacheEntry | undefined> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    // The canonical endpoint. api.frankfurter.app now answers with a 301 to
    // this one, and that extra hop inside the timeout on a cold start was
    // enough to push assessments onto the fallback table.
    const url = `https://api.frankfurter.dev/v1/latest?base=${encodeURIComponent(base)}&symbols=${encodeURIComponent(symbols.join(","))}`;
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return undefined;
    const body = (await response.json()) as { date?: string; rates?: Record<string, number> };
    if (!body.rates) return undefined;
    return { asOf: `${body.date ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`, fetchedAt: Date.now(), perBase: body.rates };
  } catch {
    return undefined;
  }
}

/**
 * Indicative rates, 1 base = N units, used only when the live source cannot
 * answer. Keep the ECB currencies close to the live rates: a cross-currency
 * amount is checked against a 3% tolerance, so a stale fallback makes the
 * same case pass or fail depending on whether the live fetch succeeded.
 * ECB currencies refreshed from the ECB reference rates of 2026-09-25.
 */
const FALLBACK_AS_OF = "2026-09-25T00:00:00Z";
export const FALLBACK: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  USD: { EUR: 0.87696, GBP: 0.75458, JPY: 157.59, CNY: 6.7132, INR: 95.82, PHP: 62.478, IDR: 17914, THB: 33.345, MYR: 4.074, VND: 25000, KRW: 1355.05, SGD: 1.2771, HKD: 7.844, AUD: 1.4224, NZD: 1.7634, PKR: 278, BDT: 118, LKR: 300, NPR: 133, KHR: 4100, MMK: 2100, LAK: 21500, MNT: 3400, KZT: 470, UZS: 12600, AED: 3.67, SAR: 3.75, CHF: 0.82829, CAD: 1.4143 },
};
