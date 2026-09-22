// Gemini API list prices, USD per 1M tokens, paid tier, as published on ai.google.dev/gemini-api/docs/pricing
// (read 18 Sep 2026). Output includes thinking tokens. Used for the admin's chat-cost estimate only —
// Google's invoice is the bill. GEMINI_PRICE_IN_PER_M / GEMINI_PRICE_OUT_PER_M override every model.
const LIST = {
  'gemini-3.5-flash': [{ in: 1.50, out: 9.00 }],
  'gemini-3.5-flash-lite': [{ in: 0.30, out: 2.50 }],
  'gemini-3.1-flash-lite': [{ in: 0.25, out: 1.50 }],
  // Introductory prices to 31 Dec 2026, then the listed 2027 prices.
  'gemini-3.7-flash': [{ in: 0.75, out: 3.75, to: '2026-12-31' }, { in: 1.50, out: 7.50 }],
  'gemini-3.8-flash': [{ in: 0.75, out: 3.75, to: '2026-12-31' }, { in: 1.50, out: 7.50 }]
};
const FALLBACK = 'gemini-3.5-flash';

function envOverride() {
  const i = parseFloat(process.env.GEMINI_PRICE_IN_PER_M), o = parseFloat(process.env.GEMINI_PRICE_OUT_PER_M);
  return Number.isFinite(i) && Number.isFinite(o) ? { in: i, out: o } : null;
}

// The price in force for this model on this day (YYYY-MM-DD). Unknown models are priced as 3.5 Flash.
function priceFor(model, day) {
  const o = envOverride();
  if (o) return o;
  const bands = LIST[model] || LIST[FALLBACK];
  const d = String(day || '').slice(0, 10);
  return bands.find((b) => !b.to || (d && d <= b.to)) || bands[bands.length - 1];
}

// tokensOut already includes thinking (chat.js stores output + thinking since v2.7.1).
function costUsd(model, tokensIn, tokensOut, day) {
  const p = priceFor(model, day);
  return ((Number(tokensIn) || 0) * p.in + (Number(tokensOut) || 0) * p.out) / 1e6;
}

module.exports = { priceFor, costUsd, LIST };
