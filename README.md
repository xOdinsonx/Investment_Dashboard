# Data Center Stocks Dashboard — Self-Hosted

[![Update stock data](https://github.com/xOdinsonx/Investment_Dashboard/actions/workflows/update-quotes.yml/badge.svg)](https://github.com/xOdinsonx/Investment_Dashboard/actions/workflows/update-quotes.yml)
[![Scout ETF holdings](https://github.com/xOdinsonx/Investment_Dashboard/actions/workflows/scout-etf-holdings.yml/badge.svg)](https://github.com/xOdinsonx/Investment_Dashboard/actions/workflows/scout-etf-holdings.yml)

A static dashboard for data-center-related stocks, refreshed on a schedule
by GitHub Actions (no server to run, no API key exposed to visitors) — plus
a weekly job that scouts a real ETF's holdings and opens a GitHub issue
suggesting roster changes for you to approve.

These badges reflect the real-time status of the last run of each workflow
— green "passing" means the last run succeeded, red "failing" means it
didn't. GitHub generates these automatically for public repos; clicking a
badge takes you straight to that workflow's run history.

## How it works

**`tickers.json`** is the single source of truth for your roster — ticker,
name, category, one-line blurb, and where it came from (`"dtcr"` or
`"manual"`). Everything else reads from this file.

**Price refresh** (`fetch-quotes.js` + `update-quotes.yml`)
Calls the [Finnhub](https://finnhub.io) API (free tier) for every ticker in
`tickers.json` and writes the results to `data.json`, including 52-week
high/low, trailing P/E, dividend yield, 10-day average volume, analyst
recommendation trends, analyst price targets, recent news headlines, and
insider sentiment. It also appends today's closing price to `history.json`
— Finnhub moved its own historical candle endpoint to paid tiers, so this
is how the dashboard builds historical data for $0: it just starts
accumulating from whenever you first run the job. There's no backfilled
past data, but the sparkline on each card grows a data point every day
going forward. This is now 7 API calls per ticker, so a full run takes
roughly 3.5 minutes — still comfortably inside Finnhub's free rate limit,
just slower than it used to be. `index.html` reads `tickers.json` +
`data.json` + `history.json` on load — no server component, no exposed key.

**Exports**
The "↓ PDF Report" and "↓ CSV" buttons in the toolbar export whatever is
*currently visible* — respecting your active category filter, search, and
"Pinned Only" toggle. The PDF is a real formatted table (via
jspdf-autotable), not a screenshot, so it's sharper and smaller than an
image-based export. Both run entirely in your browser — nothing is
uploaded anywhere.

**ETF holdings scout** (`suggest-tickers.js` + `scout-etf-holdings.yml`)
Downloads holdings from **two** public data-center-themed ETFs — **DTCR**
(Global X Data Center & Digital Infrastructure ETF) and **SRVR** (Pacer
Data & Infrastructure Real Estate ETF) — and diffs each against
`tickers.json`:
- **New candidates** — tickers a fund now holds that aren't in your roster.
- **Review for removal** — tickers you'd previously added *because* that
  fund held them (`"source": "dtcr"` or `"source": "srvr"`) that have
  since dropped out.

The two sources are checked independently — if one fund's feed changes
format or goes down, the other's results still get reported rather than
the whole run failing silently.

⚠️ **Honest caveat on SRVR:** DTCR's CSV format was verified against a
real downloaded file, but SRVR's wasn't — I couldn't fetch a live preview
of Pacer's file when building this. The SRVR parser detects columns by
header name (Ticker/Symbol, Weight/% of Net Assets, etc.) rather than
assuming a fixed layout, and throws a descriptive error with a preview of
the actual file if it doesn't recognize the format — check the "Scout ETF
holdings" Action's log after its first real run to confirm it worked. If
it didn't, the error message will show you what the real file looks like,
which is enough to fix the column-alias list in `suggest-tickers.js`.

This never edits `tickers.json` automatically. When either source finds
something (or fails), it opens a GitHub issue (labeled `roster-review`)
covering both sources in one report. You decide what to add — then edit
`tickers.json` yourself and commit; the next price-refresh run will pick
up the new ticker automatically.

Coverage note: DTCR tracks data-center REITs, memory/AI chips and digital
infrastructure. SRVR tracks data-center REITs, power generation and
connectivity infrastructure. Neither surfaces hyperscalers or GPU-cloud
operators — those categories in `tickers.json` are intentionally
`"source": "manual"` and aren't diffed by either.

## Setup (10 minutes)

1. **Get a free Finnhub API key**
   Sign up at https://finnhub.io/register — no credit card needed.

2. **Create a GitHub repo and push these files**
   ```
   git init
   git add .
   git commit -m "Initial dashboard"
   git branch -M main
   git remote add origin https://github.com/<you>/<repo>.git
   git push -u origin main
   ```

3. **Add your API key as a repo secret**
   Repo → Settings → Secrets and variables → Actions → New repository secret
   - Name: `FINNHUB_API_KEY`
   - Value: (your key from step 1)

4. **Enable GitHub Pages**
   Repo → Settings → Pages → Deploy from branch → `main` / `/ (root)`
   Your dashboard will be live at `https://<you>.github.io/<repo>/`

5. **Run both Actions once manually** to populate data immediately instead
   of waiting for the schedule: Repo → Actions → run "Update stock data"
   and "Scout ETF holdings for roster suggestions".

No extra secret is needed for the ETF scout — it uses the repo's built-in
`GITHUB_TOKEN` to open issues.

## Changing the price-refresh schedule

Edit the `cron:` line in `.github/workflows/update-quotes.yml`. Cron times
are in UTC.

| Cadence | Cron expression |
|---|---|
| Once a day | `0 13 * * *` |
| Every other day (Mon/Wed/Fri) | `0 13 * * 1,3,5` |
| Twice a day | `0 13,21 * * *` |
| Weekdays only | `0 13 * * 1-5` |

Any of these use a tiny fraction of Finnhub's free 60-calls/minute tier
(~50 calls per run), so cost stays $0 regardless of cadence.

## Changing the ETF-scout schedule

ETFs typically rebalance quarterly, so weekly (the default, Mondays) is
already generous. Edit the `cron:` line in
`.github/workflows/scout-etf-holdings.yml` if you want it less often, e.g.
`0 14 1 * *` for monthly.

## Adding/removing tickers

Edit `tickers.json` directly — add or remove an entry with `ticker`,
`name`, `category`, `blurb`, and `source` (`"dtcr"` if you got it from an
ETF suggestion, `"manual"` otherwise). The dashboard and both scripts pick
it up on their next run automatically; no other file needs to change.

## Extending the scout to more ETFs

`suggest-tickers.js` now checks DTCR and SRVR via a shared `SOURCES` array
at the bottom of the file. To add a third fund, write a `fetchX()` +
`parseX()` pair following the same shape as the DTCR or SRVR ones, then
add an entry to `SOURCES` — the diff logic, report rendering, and issue
creation all work generically off that list already.

## On "is this a good buy"

The dashboard deliberately doesn't include a buy/sell signal or a "fair
value" price. What it does show — 52-week range position, day change, P/E —
is the same raw context most investors start from; what you do with it is
a judgment call this tool won't make for you. If you want more structured
research, Finnhub's free tier also exposes analyst recommendation trends
and price-target consensus (`/stock/recommendation`, `/stock/price-target`)
if you want to wire those in as additional factual data points later.

## Notes
- GitHub Actions on a public repo is free with no run-time limits for
  scheduled jobs like these. On a private repo you get 2,000 free
  minutes/month — both jobs together use well under a minute per run.
- If a price-refresh run fails (e.g. Finnhub rate limit or outage), the
  dashboard keeps showing the last successful `data.json` and flags it as
  stale after 48 hours.
- If the scout finds nothing new, it doesn't open an issue — you'll only be
  notified when there's actually something to review.
