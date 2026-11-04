# Reed

When a U.S. government action is published, Reed tags it and shows which S&P 100 companies' own SEC filings describe exposure to that kind of action, quoting the passages. A published evaluation compares open models and retrieval setups on the same task.

Research and education only. Reed never recommends buying or selling, ranks companies, or predicts prices. It has no connection to any trading system.

Live at `muscoota.com/reed` once deployed. Working name.

## How it runs

| Piece | Where | What it does |
| --- | --- | --- |
| `scripts/ingest.mjs` | GitHub Actions, daily 06:00 UTC | Pulls the Risk Factors section of each company's latest 10-K and 10-Q from SEC EDGAR, cuts it into passages, embeds them with Workers AI, stores them in Vectorize. Skips filings already indexed. |
| `scripts/daily.mjs` | GitHub Actions, weekdays 14:00 UTC | Pulls new Federal Register actions, tags them with an open model, finds matching passages, writes cited notes to D1. |
| `src/worker.js` | Cloudflare Worker on `muscoota.com/reed*` | Reads D1 and serves the page, `/reed/method`, and `/reed/events.json`. |
| `scripts/eval.mjs` | GitHub Actions, run by hand | Scores models and retrieval setups on `eval/*.jsonl`. Results go to the run summary and an artifact. |

The heavy work runs in Actions rather than in the Worker because the free Workers plan allows only a few milliseconds of CPU per request, too little to parse 10-K filings.

Models and limits are in `lib/config.mjs`.

## One-time setup

1. Create a Cloudflare API token (My Profile, API Tokens, Create Custom Token) with:
   - Account: Workers Scripts Edit, D1 Edit, Vectorize Edit, Workers AI Read
   - Zone `muscoota.com`: Workers Routes Edit
2. In this repo, Settings, Secrets and variables, Actions, add `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.
3. Merge to `main`. The Deploy workflow creates the D1 database and Vectorize index if missing, applies migrations, and deploys the Worker.
4. Run the "Ingest filings" workflow by hand. It stops at `max_chunks` passages; the daily schedule finishes the rest.
5. Run "Daily events" by hand once to fill the page.

## Local

```
npm install
npm test
npx wrangler d1 migrations apply reed --local
npx wrangler dev        # http://localhost:8787/reed
```

Scripts need `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in the environment. SEC requests identify themselves with `SEC_USER_AGENT` (default in `lib/sec.mjs`).

## Evaluation set

`eval/events.jsonl` is a first draft of past government actions with the companies a careful reader would expect. It has not been checked against the filings yet; check each row before publishing results.

## Sites from orbit

A separate, run-by-hand study in `sites/`: for eight facility projects described in 10-Ks, it measures when lasting construction first shows in free Sentinel-2 imagery and compares that with the filing. It also tests whether open vision models can read the same images. Method, results, limits and the Copernicus credit rules are in [`sites/README.md`](sites/README.md). It does not touch the daily pipeline's data.
