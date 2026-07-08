// fetch-quotes.js
// Pulls a quote + company profile (for market cap) for each ticker in
// tickers.json from Finnhub's free API and writes the results to data.json.
// Designed to run in CI (GitHub Actions), not in the browser — the API key
// never reaches the client.
//
// Free tier limits (Finnhub, as of 2026): 60 calls/minute. This script makes
// 2 calls per ticker (quote + profile), so ~50 calls for 25 tickers —
// comfortably inside the limit even run several times a day.

const fs = require('fs');

const API_KEY = process.env.FINNHUB_API_KEY;
if (!API_KEY) {
  console.error('Missing FINNHUB_API_KEY environment variable.');
  process.exit(1);
}

const roster = JSON.parse(fs.readFileSync('tickers.json', 'utf8'));
const TICKERS = roster.map(r => r.ticker);

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchTicker(symbol) {
  const quoteUrl = `https://finnhub.io/api/v1/quote?symbol=${symbol}&token=${API_KEY}`;
  const profileUrl = `https://finnhub.io/api/v1/stock/profile2?symbol=${symbol}&token=${API_KEY}`;

  const quote = await fetchJson(quoteUrl);
  await sleep(1100); // stay well under 60 calls/min
  const profile = await fetchJson(profileUrl);
  await sleep(1100);

  return {
    price: quote.c ?? null,           // current price
    changePercent: quote.dp ?? null,  // day change %
    prevClose: quote.pc ?? null,
    marketCap: profile.marketCapitalization ?? null, // in millions USD
    name: profile.name ?? null,
  };
}

async function main() {
  const quotes = {};
  for (const symbol of TICKERS) {
    try {
      console.log(`Fetching ${symbol}...`);
      quotes[symbol] = await fetchTicker(symbol);
    } catch (err) {
      console.error(`Failed to fetch ${symbol}:`, err.message);
      quotes[symbol] = { error: true };
    }
  }

  const output = {
    generatedAt: new Date().toISOString(),
    quotes,
  };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('Wrote data.json');
}

main();
