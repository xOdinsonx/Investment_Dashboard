// fetch-quotes.js
// Pulls a quote + company profile + basic financials + analyst recommendation
// trends + analyst price targets + recent news + insider sentiment for each
// ticker in tickers.json from Finnhub's free API and writes the results to
// data.json. Also appends today's close to history.json, building a free
// historical record over time (Finnhub moved its own historical candle
// endpoint to paid tiers, so this is how the dashboard gets historical data
// for $0 — it just starts accumulating from whenever you first run this).
//
// Designed to run in CI (GitHub Actions), not in the browser — the API key
// never reaches the client.
//
// Free tier limits (Finnhub, as of 2026): 60 calls/minute. This script makes
// 7 calls per ticker (quote + profile + metric + recommendation + price
// target + news + insider sentiment), so ~180 calls for 26 tickers — spread
// out with a 1.1s pause between calls, so it stays well under the limit but
// takes ~3.5 minutes to run. Every call past the core quote/profile is
// wrapped so that if Finnhub has restricted it to paid tiers, that ticker
// just loses that one field rather than failing the whole run.

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
  const metricUrl = `https://finnhub.io/api/v1/stock/metric?symbol=${symbol}&metric=all&token=${API_KEY}`;
  const recommendationUrl = `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${API_KEY}`;
  const priceTargetUrl = `https://finnhub.io/api/v1/stock/price-target?symbol=${symbol}&token=${API_KEY}`;

  const quote = await fetchJson(quoteUrl);
  await sleep(1100); // stay well under 60 calls/min
  const profile = await fetchJson(profileUrl);
  await sleep(1100);

  // Basic financials (52wk high/low, P/E) — wrapped separately since this
  // endpoint occasionally lacks data for smaller/newer tickers; don't let
  // that fail the whole ticker.
  let metric = {};
  try {
    const metricRes = await fetchJson(metricUrl);
    metric = metricRes.metric || {};
  } catch (err) {
    console.error(`  (metric fetch failed for ${symbol}: ${err.message})`);
  }
  await sleep(1100);

  // Analyst recommendation trends. Finnhub has occasionally moved endpoints
  // like this to paid tiers — if it 403s, we just skip it for this ticker
  // rather than failing the whole run.
  let recommendation = null;
  try {
    const recRes = await fetchJson(recommendationUrl);
    if (Array.isArray(recRes) && recRes.length > 0) {
      // Finnhub returns entries newest-first.
      const latest = recRes[0];
      recommendation = {
        period: latest.period,
        strongBuy: latest.strongBuy,
        buy: latest.buy,
        hold: latest.hold,
        sell: latest.sell,
        strongSell: latest.strongSell,
      };
    }
  } catch (err) {
    console.error(`  (recommendation fetch failed for ${symbol}: ${err.message})`);
  }
  await sleep(1100);

  // Analyst price target consensus. Same graceful-fallback treatment.
  let priceTarget = null;
  try {
    const ptRes = await fetchJson(priceTargetUrl);
    if (ptRes && (ptRes.targetMean != null || ptRes.targetMedian != null)) {
      priceTarget = {
        high: ptRes.targetHigh ?? null,
        low: ptRes.targetLow ?? null,
        mean: ptRes.targetMean ?? null,
        median: ptRes.targetMedian ?? null,
        lastUpdated: ptRes.lastUpdated ?? null,
      };
    }
  } catch (err) {
    console.error(`  (price target fetch failed for ${symbol}: ${err.message})`);
  }
  await sleep(1100);

  // Recent company news headlines (last 7 days, top 3). Displayed as
  // headline text + link + source/date only — no article body is fetched
  // or stored, just the same metadata any news aggregator shows.
  let news = [];
  try {
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fmt = (d) => d.toISOString().slice(0, 10);
    const newsUrl = `https://finnhub.io/api/v1/company-news?symbol=${symbol}&from=${fmt(weekAgo)}&to=${fmt(today)}&token=${API_KEY}`;
    const newsRes = await fetchJson(newsUrl);
    if (Array.isArray(newsRes)) {
      news = newsRes.slice(0, 3).map(n => ({
        headline: n.headline,
        url: n.url,
        source: n.source,
        datetime: n.datetime, // unix seconds
      }));
    }
  } catch (err) {
    console.error(`  (news fetch failed for ${symbol}: ${err.message})`);
  }
  await sleep(1100);

  // Insider sentiment (aggregated monthly share purchase ratio). Positive
  // mspr = net insider buying, negative = net selling. Third-party/factual,
  // same treatment as analyst data — displayed as-is, not as our opinion.
  let insiderSentiment = null;
  try {
    const now = new Date();
    const monthsAgo = new Date(now.getFullYear(), now.getMonth() - 3, 1);
    const fmtMonth = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const insiderUrl = `https://finnhub.io/api/v1/stock/insider-sentiment?symbol=${symbol}&from=${fmtMonth(monthsAgo)}-01&to=${fmtMonth(now)}-01&token=${API_KEY}`;
    const insiderRes = await fetchJson(insiderUrl);
    if (insiderRes && Array.isArray(insiderRes.data) && insiderRes.data.length > 0) {
      // Most recent month's entry.
      const latest = insiderRes.data[insiderRes.data.length - 1];
      insiderSentiment = {
        year: latest.year,
        month: latest.month,
        mspr: latest.mspr ?? null,       // monthly share purchase ratio
        change: latest.change ?? null,   // net change in shares
      };
    }
  } catch (err) {
    console.error(`  (insider sentiment fetch failed for ${symbol}: ${err.message})`);
  }
  await sleep(1100);

  return {
    price: quote.c ?? null,           // current price
    changePercent: quote.dp ?? null,  // day change %
    prevClose: quote.pc ?? null,
    marketCap: profile.marketCapitalization ?? null, // in millions USD
    name: profile.name ?? null,
    week52High: metric['52WeekHigh'] ?? null,
    week52Low: metric['52WeekLow'] ?? null,
    peTTM: metric['peTTM'] ?? metric['peBasicExclExtraTTM'] ?? null,
    dividendYield: metric['dividendYieldIndicatedAnnual'] ?? metric['currentDividendYieldTTM'] ?? null,
    avgVolume10D: metric['10DayAverageTradingVolume'] ?? null,
    recommendation,
    priceTarget,
    news,
    insiderSentiment,
  };
}

function appendHistory(quotes, generatedAt) {
  const historyPath = 'history.json';
  let history = {};
  if (fs.existsSync(historyPath)) {
    try {
      history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
    } catch (err) {
      console.error('Could not parse existing history.json, starting fresh.');
      history = {};
    }
  }

  const today = generatedAt.slice(0, 10); // YYYY-MM-DD

  for (const symbol of TICKERS) {
    const q = quotes[symbol];
    if (!q || q.price == null) continue;
    if (!history[symbol]) history[symbol] = [];

    // Avoid duplicate entries if the job runs more than once on the same day.
    const last = history[symbol][history[symbol].length - 1];
    if (last && last.date === today) {
      last.price = q.price;
    } else {
      history[symbol].push({ date: today, price: q.price });
    }

    // Cap history length so the file doesn't grow unbounded — ~2 years of
    // daily entries is plenty for a comparison chart.
    if (history[symbol].length > 730) {
      history[symbol] = history[symbol].slice(-730);
    }
  }

  fs.writeFileSync(historyPath, JSON.stringify(history));
  console.log('Updated history.json');
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

  const generatedAt = new Date().toISOString();
  const output = { generatedAt, quotes };

  fs.writeFileSync('data.json', JSON.stringify(output, null, 2));
  console.log('Wrote data.json');

  appendHistory(quotes, generatedAt);
}

main();

