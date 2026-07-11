// suggest-tickers.js
// Downloads holdings from two public data-center-themed ETFs — Global X's
// DTCR and Pacer's SRVR — and diffs each against tickers.json to surface:
//   1. New candidates: tickers a fund now holds that aren't in our roster.
//   2. Review-for-removal: tickers we previously added *because* a given
//      fund held them (source:"dtcr" or source:"srvr" in tickers.json)
//      that have since dropped out of that fund's holdings.
//
// This never edits tickers.json automatically — it only writes
// suggestions.md / suggestions.json for a human to review. To act on a
// suggestion, edit tickers.json yourself and commit.
//
// Each source is isolated: if one fund's feed changes format or goes
// down, the other source's results still get reported rather than the
// whole run failing. suggestions.md will say so explicitly if a source
// errored out.
//
// Coverage note: DTCR reflects data-center REITs, memory/AI chips and
// digital infrastructure. SRVR reflects data-center REITs, power
// generation and connectivity infrastructure. Neither surfaces
// hyperscalers or GPU-cloud operators — those categories in tickers.json
// are intentionally "manual" and not diffed here.

const fs = require('fs');

const ROSTER_PATH = 'tickers.json';
const OUT_MD = 'suggestions.md';
const OUT_JSON = 'suggestions.json';

const NON_HOLDING_NAME_PATTERN = /cash|payable|receivable|net other assets|^(korean won|taiwan dollar|us dollar|euro|hong kong dollar|australian dollar)$/i;

// Minimal CSV parser that handles quoted fields containing commas
// (e.g. "1,406,635.00"). Good enough for these simple, fixed file formats.
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

// US-listed tickers in these files are plain symbols like "EQIX", "MU".
// Foreign listings come through as "000660 KS", "NXT AU", "2330 TT" etc.
// — those aren't usable here since Finnhub's free tier is US-market
// focused, so they're filtered out of candidates rather than surfaced.
function isUsListed(ticker) {
  return /^[A-Z.]{1,6}$/.test(ticker.trim());
}

// ---------------------------------------------------------------------
// DTCR (Global X Data Center & Digital Infrastructure ETF)
// Fixed daily-dated filename, fixed column order — format confirmed
// against a real downloaded file.
// ---------------------------------------------------------------------
function dtcrCsvUrlFor(date) {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `https://assets.globalxetfs.com/funds/holdings/dtcr_full-holdings_${yyyy}${mm}${dd}.csv`;
}

async function fetchDtcr() {
  const today = new Date();
  for (let i = 0; i < 10; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const url = dtcrCsvUrlFor(d);
    const res = await fetch(url);
    if (res.ok) {
      const text = await res.text();
      return { text, url, date: d.toISOString().slice(0, 10) };
    }
  }
  throw new Error('Could not find a recent DTCR holdings CSV in the last 10 days.');
}

function parseDtcr(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  const headerIdx = lines.findIndex(l => l.startsWith('% of Net Assets'));
  if (headerIdx === -1) throw new Error('DTCR CSV format changed — expected header row not found.');

  const holdings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    if (fields.length < 3) continue; // trailing disclaimer line etc.
    const [weightStr, ticker, name] = fields;
    if (!ticker || !name) continue;
    if (NON_HOLDING_NAME_PATTERN.test(name.trim())) continue;

    const weight = parseFloat(weightStr);
    holdings.push({
      ticker: ticker.trim(),
      name: name.trim(),
      weight: isNaN(weight) ? null : weight,
      usListed: isUsListed(ticker),
    });
  }
  return holdings;
}

// ---------------------------------------------------------------------
// SRVR (Pacer Data & Infrastructure Real Estate ETF)
// Static URL (no date in filename), but the exact column layout hasn't
// been verified against a live download — this parser detects columns
// by header name instead of assuming a fixed position, and throws a
// descriptive error (rather than silently misreading data) if it can't
// find what it needs. Check the Action's log on the first real run.
// ---------------------------------------------------------------------
const SRVR_URL = 'https://www.paceretfs.com/usbank/live/fsb0.pacer.x330.SRVR_Holdings.csv';

const SRVR_COLUMN_ALIASES = {
  ticker: ['ticker', 'symbol'],
  name: ['security name', 'security', 'name', 'holding', 'description'],
  weight: ['weight', '% of net assets', 'weightings (%)', 'portfolio weight (%)', 'weight (%)'],
};

function findColumnIndex(headerRow, aliases) {
  const normalized = headerRow.map(h => h.trim().toLowerCase());
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

async function fetchSrvr() {
  const res = await fetch(SRVR_URL);
  if (!res.ok) throw new Error(`SRVR holdings fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  return { text, url: SRVR_URL, date: new Date().toISOString().slice(0, 10) };
}

function parseSrvr(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);

  // Scan the first several lines for one that looks like a header row
  // (contains a ticker-like column and a weight-like column), since
  // Pacer's export may have title/date rows above the real header like
  // Global X's does.
  let headerIdx = -1;
  let cols = null;
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const fields = parseCsvLine(lines[i]);
    const tIdx = findColumnIndex(fields, SRVR_COLUMN_ALIASES.ticker);
    const wIdx = findColumnIndex(fields, SRVR_COLUMN_ALIASES.weight);
    if (tIdx !== -1 && wIdx !== -1) {
      headerIdx = i;
      cols = {
        ticker: tIdx,
        weight: wIdx,
        name: findColumnIndex(fields, SRVR_COLUMN_ALIASES.name),
      };
      break;
    }
  }

  if (headerIdx === -1) {
    const preview = lines.slice(0, 3).join(' | ');
    throw new Error(`SRVR CSV format not recognized — could not find Ticker/Weight columns. First lines: ${preview}`);
  }

  const holdings = [];
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i]);
    const ticker = (fields[cols.ticker] || '').trim();
    const name = cols.name !== -1 ? (fields[cols.name] || '').trim() : ticker;
    const weightStr = fields[cols.weight] || '';
    if (!ticker) continue;
    if (NON_HOLDING_NAME_PATTERN.test(name) || NON_HOLDING_NAME_PATTERN.test(ticker)) continue;

    const weight = parseFloat(String(weightStr).replace('%', ''));
    holdings.push({
      ticker,
      name: name || ticker,
      weight: isNaN(weight) ? null : weight,
      usListed: isUsListed(ticker),
    });
  }

  if (holdings.length === 0) {
    throw new Error('SRVR CSV parsed but yielded zero holdings — format likely mismatched.');
  }
  return holdings;
}

// ---------------------------------------------------------------------
// Shared diff + report logic
// ---------------------------------------------------------------------
const SOURCES = [
  {
    key: 'dtcr',
    label: 'DTCR — Global X Data Center & Digital Infrastructure ETF',
    coverageNote: "Tracks data-center REITs, memory/AI chips and digital infrastructure. Won't surface hyperscalers, power/utility, or GPU-cloud names.",
    fetch: fetchDtcr,
    parse: parseDtcr,
  },
  {
    key: 'srvr',
    label: 'SRVR — Pacer Data & Infrastructure Real Estate ETF',
    coverageNote: "Tracks data-center REITs, power generation and connectivity infrastructure. Won't surface hyperscalers or GPU-cloud names.",
    fetch: fetchSrvr,
    parse: parseSrvr,
  },
];

async function runSource(source, roster, rosterTickers) {
  const sourcedTickers = new Set(roster.filter(r => r.source === source.key).map(r => r.ticker));

  const { text, url, date } = await source.fetch();
  const holdings = source.parse(text);
  const holdingTickers = new Set(holdings.map(h => h.ticker));

  const newCandidates = holdings
    .filter(h => h.usListed && !rosterTickers.has(h.ticker))
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));

  const droppedOut = [...sourcedTickers].filter(t => !holdingTickers.has(t));

  return {
    key: source.key,
    label: source.label,
    coverageNote: source.coverageNote,
    ok: true,
    sourceUrl: url,
    holdingsAsOf: date,
    newCandidates,
    droppedOut,
  };
}

function renderSourceSection(result) {
  const lines = [];
  lines.push(`## ${result.label}`);
  lines.push('');

  if (!result.ok) {
    lines.push(`⚠️ This source failed this run and was skipped: ${result.error}`);
    lines.push('');
    return lines;
  }

  lines.push(`Source: [${result.sourceUrl}](${result.sourceUrl}) — holdings as of ${result.holdingsAsOf}`);
  lines.push('');
  lines.push(result.coverageNote);
  lines.push('');

  if (result.newCandidates.length === 0) {
    lines.push('**New candidates:** none — this fund holds nothing outside the current roster right now.');
  } else {
    lines.push('**New candidates:**');
    lines.push('');
    lines.push('| Ticker | Name | Weight |');
    lines.push('|---|---|---|');
    for (const h of result.newCandidates) {
      lines.push(`| ${h.ticker} | ${h.name} | ${h.weight != null ? h.weight.toFixed(2) + '%' : '—'} |`);
    }
  }

  lines.push('');
  if (result.droppedOut.length === 0) {
    lines.push(`**Review for removal:** none — every ${result.key}-sourced ticker in the roster is still held by this fund.`);
  } else {
    lines.push(`**Review for removal:** these roster tickers were originally added because this fund held them, and no longer appear in its holdings:`);
    lines.push('');
    for (const t of result.droppedOut) lines.push(`- ${t}`);
  }
  lines.push('');
  return lines;
}

async function main() {
  const roster = JSON.parse(fs.readFileSync(ROSTER_PATH, 'utf8'));
  const rosterTickers = new Set(roster.map(r => r.ticker));

  const results = [];
  for (const source of SOURCES) {
    try {
      const result = await runSource(source, roster, rosterTickers);
      results.push(result);
      console.log(`${source.key}: ${result.newCandidates.length} new candidate(s), ${result.droppedOut.length} dropped out`);
    } catch (err) {
      console.error(`${source.key} failed: ${err.message}`);
      results.push({ key: source.key, label: source.label, ok: false, error: err.message });
    }
  }

  const output = {
    checkedAt: new Date().toISOString(),
    sources: results,
  };
  fs.writeFileSync(OUT_JSON, JSON.stringify(output, null, 2));

  const md = [`# ETF Holdings Scout — ${new Date().toISOString().slice(0, 10)}`, ''];
  for (const result of results) {
    md.push(...renderSourceSection(result));
  }
  md.push('_Nothing here is applied automatically. To act on a suggestion, edit `tickers.json` and commit._');
  fs.writeFileSync(OUT_MD, md.join('\n') + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
