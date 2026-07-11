// send-alerts.js
// Runs right after fetch-quotes.js writes a fresh data.json. Checks two
// conditions, both configurable in alert-config.json:
//   1. Big movers: any ticker whose day change exceeds ±dailyMovePercent.
//   2. New 52-week lows: a ticker's price has hit a lower 52-week low than
//      any low we've already alerted on for it — not just "still near an
//      old low", which would spam an email every day a stock stays down.
//
// Writes alert-summary.md — empty if nothing triggered, populated if
// something did. The workflow checks whether that file is non-empty to
// decide whether to actually send an email; this script never sends mail
// itself, it just decides content and lets a dedicated mail-sending
// GitHub Action handle delivery.
//
// alert-state.json tracks the lowest 52-week-low value already alerted
// per ticker, so a stock lingering at the same bottom doesn't re-trigger
// every single day — only a genuinely new, lower low does.

const fs = require('fs');

const DATA_PATH = 'data.json';
const TICKERS_PATH = 'tickers.json';
const CONFIG_PATH = 'alert-config.json';
const STATE_PATH = 'alert-state.json';
const SUMMARY_PATH = 'alert-summary.md';

function loadJson(path, fallback) {
  if (!fs.existsSync(path)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`Could not parse ${path}, using fallback.`);
    return fallback;
  }
}

function main() {
  const data = loadJson(DATA_PATH, null);
  if (!data || !data.quotes) {
    console.error('No data.json found — nothing to check.');
    fs.writeFileSync(SUMMARY_PATH, '');
    return;
  }

  const roster = loadJson(TICKERS_PATH, []);
  const nameByTicker = Object.fromEntries(roster.map(r => [r.ticker, r.name]));

  const config = loadJson(CONFIG_PATH, { dailyMovePercent: 5, alertOnNew52WeekLow: true });
  const state = loadJson(STATE_PATH, {});

  const bigMovers = [];
  const newLows = [];
  const EPSILON = 0.01; // cents-level tolerance for float comparison

  for (const [ticker, q] of Object.entries(data.quotes)) {
    if (q.error) continue;

    // Big movers
    if (q.changePercent != null && Math.abs(q.changePercent) >= config.dailyMovePercent) {
      bigMovers.push({ ticker, name: nameByTicker[ticker] || ticker, changePercent: q.changePercent, price: q.price });
    }

    // New 52-week lows
    if (config.alertOnNew52WeekLow && q.price != null && q.week52Low != null) {
      const isAtLow = q.price <= q.week52Low + EPSILON;
      const priorAlertedLow = state[ticker] && state[ticker].alertedLow != null ? state[ticker].alertedLow : null;
      const isNewLowerLow = priorAlertedLow == null || q.week52Low < priorAlertedLow - EPSILON;

      if (isAtLow && isNewLowerLow) {
        newLows.push({ ticker, name: nameByTicker[ticker] || ticker, price: q.price, week52Low: q.week52Low });
        state[ticker] = { alertedLow: q.week52Low, alertedDate: data.generatedAt };
      }
    }
  }

  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));

  if (bigMovers.length === 0 && newLows.length === 0) {
    console.log('No alert conditions triggered.');
    fs.writeFileSync(SUMMARY_PATH, '');
    return;
  }

  bigMovers.sort((a, b) => Math.abs(b.changePercent) - Math.abs(a.changePercent));

  const lines = [];
  lines.push(`# Dashboard Alert — ${new Date(data.generatedAt).toLocaleString()}`);
  lines.push('');

  if (bigMovers.length > 0) {
    lines.push(`## Big Movers (±${config.dailyMovePercent}%+ today)`);
    lines.push('');
    for (const m of bigMovers) {
      const sign = m.changePercent >= 0 ? '+' : '';
      lines.push(`- **${m.ticker}** (${m.name}): ${sign}${m.changePercent.toFixed(2)}% — $${m.price.toFixed(2)}`);
    }
    lines.push('');
  }

  if (newLows.length > 0) {
    lines.push('## New 52-Week Lows');
    lines.push('');
    for (const n of newLows) {
      lines.push(`- **${n.ticker}** (${n.name}): now $${n.price.toFixed(2)}, new 52-week low`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('Not financial advice — this is a factual threshold alert, not a recommendation to act.');
  lines.push('');
  lines.push('View the full dashboard for context before making any decisions.');

  fs.writeFileSync(SUMMARY_PATH, lines.join('\n') + '\n');
  console.log(`Alert triggered: ${bigMovers.length} big mover(s), ${newLows.length} new low(s).`);
}

main();
