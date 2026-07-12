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

**Email alerts** (`send-alerts.js`, runs as part of `update-quotes.yml`)
Right after each price refresh, checks every ticker against two
configurable conditions in `alert-config.json`:
- **Big movers** — day change of ±`dailyMovePercent` or more (default 5%).
- **New 52-week lows** — but only a *genuinely new, lower* low, tracked in
  `alert-state.json`. A stock sitting at the same bottom for a week
  doesn't re-trigger every day — only a fresh lower low does.

If nothing triggers, no email is sent — quiet days stay quiet. If
something does, one email goes out via Gmail's free SMTP relay (500/day
free, no new service to sign up for), listing everything that triggered
with a "not financial advice" note. Setup needs three more repo secrets —
see below.

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

4. **Set up email alerts (optional but recommended)**
   You'll need a Gmail account and an **App Password** (a 16-character
   code separate from your real password, scoped just to this use):
   - Turn on 2-Step Verification if you haven't: myaccount.google.com/security
   - Go to myaccount.google.com/apppasswords, create one (name it
     "Dashboard Alerts" or similar), and copy the 16-character code
   - Add three more repo secrets (same place as step 3):
     - `MAIL_USERNAME` — your full Gmail address
     - `MAIL_PASSWORD` — the app password you just generated (not your
       regular Gmail password)
     - `MAIL_TO` — where alerts should be sent (can be the same address)
   - If you'd rather skip alerts entirely, that's fine — leave these
     three secrets unset. The email-send step will then fail (since it
     has no valid SMTP credentials), but `continue-on-error: true` is set
     on that step specifically, so it shows as a yellow warning rather
     than failing the whole workflow, and your price data still updates
     normally either way.

5. **Enable GitHub Pages**
   Repo → Settings → Pages → Deploy from branch → `main` / `/ (root)`
   Your dashboard will be live at `https://<you>.github.io/<repo>/`

6. **Run both Actions once manually** to populate data immediately instead
   of waiting for the schedule: Repo → Actions → run "Update stock data"
   and "Scout ETF holdings for roster suggestions".

No extra secret is needed for the ETF scout — it uses the repo's built-in
`GITHUB_TOKEN` to open issues.

## Tuning or disabling alerts

Edit `alert-config.json`:
- `dailyMovePercent` — how big a single-day move needs to be to alert
  (default `5`, meaning ±5%)
- `alertOnNew52WeekLow` — set to `false` to turn off 52-week-low alerts
  entirely and only get big-mover alerts

To disable alerts altogether without removing the code, just don't set
the `MAIL_USERNAME`/`MAIL_PASSWORD`/`MAIL_TO` secrets. The check step
still runs (harmless, a few seconds) and, on a day something triggers,
the email-send step will show a yellow "failed but continued" mark in the
Action's log — that's expected and won't block anything else.

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

## Privacy: minimizing personal data exposure on a public repo

This repo is public (required for free GitHub Pages), which means the
**code, roster, and workflow history are visible to anyone**. That part
can't be avoided without a paid GitHub plan for private Pages — you
already weighed that tradeoff earlier and chose free/public. What follows
is about minimizing exactly *what* gets exposed within that constraint,
not making the content itself private.

**1. Your git commit identity (the biggest real gap)**
Automated commits (price updates, ETF scout) already use a bot identity
(`github-actions[bot]`) — those are fine. But commits *you* push manually
via `update.ps1` use whatever name/email your local git is configured
with — often your real name and personal email, silently baked into
public commit history forever.

Fix: set a repo-local git identity that doesn't use your real email.
GitHub gives you a free stand-in address for exactly this — find yours at
Settings → Emails → look for "Keep my email addresses private", which
shows an address like `123456+yourusername@users.noreply.github.com`.
Then, from inside the repo folder:
```powershell
git config user.name "xOdinsonx"
git config user.email "123456+xOdinsonx@users.noreply.github.com"
```
No `--global` flag — this only changes identity for this repo, not others
you may want your real identity on. This only affects *future* commits;
anything already pushed with your real email is already in the public
history. Scrubbing that retroactively means rewriting git history
(tools like `git filter-repo`), which is more invasive and rewrites every
commit hash — only worth doing if your real email is already exposed and
that bothers you. Worth checking: run `git log --format='%ae'` and see
what's actually in there today.

**2. Use a dedicated email for alerts, not your primary address**
`MAIL_USERNAME`/`MAIL_PASSWORD` (the Gmail App Password) can send email as
you if ever compromised. GitHub secrets are encrypted and never exposed in
logs or code regardless of repo visibility — but as defense in depth,
consider creating a free throwaway Gmail account just for this project's
alerts instead of using your main personal address. If it's ever
compromised, the blast radius is "someone can send email from a
dashboard-alerts-only inbox," not your real account.

**3. Secrets are already safe — this is a reassurance, not an action item**
`FINNHUB_API_KEY`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_TO` are GitHub
encrypted secrets. They're never written into any file in this repo,
never appear in `git log`, and GitHub automatically masks their values as
`***` in Action logs even when a third-party action prints them. Public
repo status doesn't change any of this — secrets stay secret.

**4. Reduced discoverability (`robots.txt` + `noindex`)**
Both now included — they ask well-behaved search engines and crawlers not
to index the live dashboard site. This doesn't hide it (anyone with the
direct URL, or who finds the GitHub repo itself, can still see it), but it
meaningfully cuts down on it showing up in search results tied to your
name or username.

**5. Optional, lower-priority: third-party font/script loading**
`index.html` currently loads fonts from Google Fonts and libraries (jsPDF,
autoTable) from a Cloudflare CDN. Every page load sends the visitor's IP
to those third parties — standard for the vast majority of the web, and
low-stakes for a dashboard mainly visited by you, but not zero. If you
want to eliminate it entirely, the fonts and JS libraries could be
downloaded once and self-hosted alongside `index.html` instead of loaded
from a CDN — more setup, no ongoing cost, and it would mean manually
updating those files if you ever want a newer library version. Not done
by default since it adds real maintenance overhead for a marginal gain;
say the word if you'd rather have it.

**6. Recap: repo-level hardening from earlier**
Worth re-confirming these are all still set (Settings → various), since
they reduce the odds of any of the above ever mattering:
- Collaborators: just you
- Actions → General → "Require approval for all outside collaborators"
  for fork pull requests
- Actions → General → default workflow permissions set to read-only
- Security → Code security → Secret scanning + push protection enabled
- Branches → protection rule on `main` restricting force-push/deletion
- 2FA enabled on your GitHub account itself

## Notes
- GitHub Actions on a public repo is free with no run-time limits for
  scheduled jobs like these. On a private repo you get 2,000 free
  minutes/month — both jobs together use well under a minute per run.
- If a price-refresh run fails (e.g. Finnhub rate limit or outage), the
  dashboard keeps showing the last successful `data.json` and flags it as
  stale after 48 hours.
- If the scout finds nothing new, it doesn't open an issue — you'll only be
  notified when there's actually something to review.
