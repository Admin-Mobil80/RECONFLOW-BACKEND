/**
 * Master list of currencies an organisation may use as its base currency,
 * and that source records are expected to carry. Deliberately a closed list:
 * a base currency drives every converted figure a reviewer sees, so it is a
 * setting chosen from known values, not free text.
 *
 * The BMS holds a copy of this list for its dropdown; keep the two in step.
 */
export const CURRENCIES: ReadonlyArray<{ readonly code: string; readonly name: string }> = [
  { code: "USD", name: "US dollar" },
  { code: "EUR", name: "Euro" },
  { code: "GBP", name: "Pound sterling" },
  { code: "JPY", name: "Japanese yen" },
  { code: "CNY", name: "Chinese yuan" },
  { code: "INR", name: "Indian rupee" },
  { code: "PHP", name: "Philippine peso" },
  { code: "IDR", name: "Indonesian rupiah" },
  { code: "THB", name: "Thai baht" },
  { code: "MYR", name: "Malaysian ringgit" },
  { code: "VND", name: "Vietnamese dong" },
  { code: "KRW", name: "South Korean won" },
  { code: "SGD", name: "Singapore dollar" },
  { code: "HKD", name: "Hong Kong dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "PKR", name: "Pakistani rupee" },
  { code: "BDT", name: "Bangladeshi taka" },
  { code: "LKR", name: "Sri Lankan rupee" },
  { code: "NPR", name: "Nepalese rupee" },
  { code: "KHR", name: "Cambodian riel" },
  { code: "MMK", name: "Myanmar kyat" },
  { code: "LAK", name: "Lao kip" },
  { code: "MNT", name: "Mongolian tugrik" },
  { code: "KZT", name: "Kazakhstani tenge" },
  { code: "UZS", name: "Uzbekistani som" },
  { code: "AED", name: "UAE dirham" },
  { code: "SAR", name: "Saudi riyal" },
  { code: "CHF", name: "Swiss franc" },
  { code: "CAD", name: "Canadian dollar" },
];

export const CURRENCY_CODES: ReadonlySet<string> = new Set(CURRENCIES.map((c) => c.code));

export function isKnownCurrency(code: string): boolean {
  return CURRENCY_CODES.has(code);
}
