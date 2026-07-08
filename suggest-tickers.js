// suggest-tickers.js
// Downloads the Global X DTCR (Data Center & Digital Infrastructure ETF)
// full-holdings CSV — published daily, no API key needed — and compares it
// against tickers.json to surface:
//   1. New candidates: tickers DTCR now holds that aren't in our roster.
//   2. Review-for-removal: tickers we previously added *because* DTCR held
//      them (source:"dtcr" in tickers.json) that have since dropped out of
//      the fund's holdings.
//
// This never edits tickers.json automatically — it only writes
// suggestions.md / suggestions.json for a human to review. To act on a
// suggestion, edit tickers.json yourself and commit.
//
// Note: DTCR reflects data-center REITs, memory/AI chips and digital
// infrastructure — it won't surface hyperscalers, power/utility names, or
// GPU-cloud operators, since that's outside the fund's own mandate. Those
// categories in tickers.json are intentionally "manual" and not diffed here.

const fs = require('fs');

const ROSTER_PATH = 'tickers.json';
const OUT_MD = 'suggestions.md';
const OUT_JSON = 'suggestions.json';

function csvUrlFor(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `https://assets.globalxetfs.com/funds/holdings/dtcr_full-holdings_${yyyy}${mm}${dd}.csv`;
}

// Global X publishes a new file each trading day; try today and walk
// backward up to 10 days to land on the most recent file that exists
// (handles weekends/holidays).
async function fetchLatestCsv() {
  const today = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const url = csvUrlFor(d);
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      return { text, url, date: d.toISOString().slice(0, 10) };
    }
  }
  throw new Error('Could not find a recent DTCR holdings CSV in the last 10 days.');
}

// Minimal CSV parser that handles quoted fields containing commas
// (e.g. "1,406,635.00"). Good enough for this fixed, simple file format.
function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

const NON_HOLDING_NAMES = new Set([
  'CASH', 'KOREAN WON', 'TAIWAN DOLLAR', 'OTHER PAYABLE & RECEIVABLES',
  'US DOLLAR', 'EURO', 'HONG KONG DOLLAR', 'AUSTRALIAN DOLLAR',
]);

function parseHoldings(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  // Line 0: fund name, Line 1: "as of" date, Line 2: header row, then data.
  const headerIdx = lines.findIndex(l => l.startsWith('% of Net Assets'));
  if (headerIdx === -1) throw new Error('Unexpected CSV format — header row not found.');

  const holdings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 3) continue; // trailing disclaimer line etc.
    const [weightStr, ticker, name] = fields;
    if (!ticker || !name) continue;
    if (NON_HOLDING_NAMES.has(name.trim())) continue;

    const weight = parseFloat(weightStr);
    // US-listed tickers in this file are plain symbols like "EQIX", "MU".
    // Foreign listings come through as "000660 KS", "NXT AU", "2330 TT" etc.
    const isUsListed = /^[A-Z.]{1,6}$/.test(ticker.trim());

    holdings.push({
      ticker: ticker.trim(),
      name: name.trim(),
      weight: isNaN(weight) ? null : weight,
      usListed: isUsListed,
    });
  }
  return holdings;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
  const rosterTickers = new Set(roster.map(r => r.ticker));
  const dtcrSourcedTickers = new Set(roster.filter(r => r.source === 'dtcr').map(r => r.ticker));

  const { text, url, date } = await fetchLatestCsv();
  const holdings = parseHoldings(text);
  const holdingTickers = new Set(holdings.map(h => h.ticker));

  // 1. New candidates: in DTCR, not in our roster, US-listed (so Finnhub can
  //    actually fetch a quote for it), sorted by weight descending.
  const newCandidates = holdings
    .filter(h => h.usListed && !rosterTickers.has(h.ticker))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  // 2. Previously ETF-sourced tickers that have since dropped out of DTCR.
  const droppedOut = [...dtcrSourcedTickers].filter(t => !holdingTickers.has(t));

  const result = {
    checkedAt: new Date().toISOString(),
    sourceCsv: url,
    holdingsAsOf: date,
    newCandidates,
    droppedOut,
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(result, null, 2));

  const lines = [];
  lines.push(`# ETF Holdings Scout — DTCR — ${date}`);
  lines.push('');
  lines.push(`Source: [${url}](${url})`);
  lines.push('');
  lines.push('DTCR (Global X Data Center & Digital Infrastructure ETF) tracks data-center REITs, memory/AI chips and digital infrastructure. It won\'t surface hyperscalers, power/utility, or GPU-cloud names — those stay manually curated.');
  lines.push('');

  if (newCandidates.length === 0) {
    lines.push('## New candidates');
    lines.push('None — DTCR holds nothing outside the current roster right now.');
  } else {
    lines.push('## New candidates');
    lines.push('DTCR currently holds these tickers, not yet in `tickers.json`:');
    lines.push('');
    lines.push('| Ticker | Name | DTCR Weight |');
    lines.push('|---|---|---|');
    for (const h of newCandidates) {
      lines.push(`| ${h.ticker} | ${h.name} | ${h.weight != null ? h.weight.toFixed(2) + '%' : '—'} |`);
    }
  }

  lines.push('');
  if (droppedOut.length === 0) {
    lines.push('## Review for removal');
    lines.push('None — every DTCR-sourced ticker in the roster is still held by the fund.');
  } else {
    lines.push('## Review for removal');
    lines.push('These roster tickers were originally added because DTCR held them, and no longer appear in the fund\'s holdings:');
    lines.push('');
    for (const t of droppedOut) lines.push(`- ${t}`);
  }

  lines.push('');
  lines.push('_Nothing here is applied automatically. To act on a suggestion, edit `tickers.json` and commit._');

  fs.writeFileSync(OUT_MD, lines.join('\n') + '\n');
  console.log(`New candidates: ${newCandidates.length}, dropped out: ${droppedOut.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
