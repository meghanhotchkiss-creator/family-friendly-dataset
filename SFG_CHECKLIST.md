# Scout Fox — Build Status Checklist

Fresh audit of the whole repository, 2026-08-20.

> ## Read this first — the two branches each hold what the other is missing
>
> Both branches have now been audited and their test suites run.
>
> | | `main` (`ebe709b`) | `claude/seed-data-setup-b7zaeu` (+26) |
> |---|---|---|
> | Security hardening | **Yes** | **No — reverted** |
> | Routers mounted | No | **Yes** |
> | Real data | No | **Yes** |
> | Tests | 29 Python, pass | 209 TS, pass; **Python security tests absent** |
>
> The branch forked from `702b82d`, one commit **before** `5eecd7d "Fix
> credential exposure, SQL injection, and dataset loading"`. It therefore never
> received those fixes, and it rewrites the same files. **Merging it as-is
> republishes working credentials.** See P0-0.
>
> Neither branch is shippable alone, and a merge in either direction loses
> something that matters. That is the central problem in this repository.

---

## Status by area

| Area | State | Notes |
| --- | --- | --- |
| `/recommend` (API key) | **Works** | Returns seed rows, filters by state and setting, caps `limit`. |
| `/recommend_jwt`, `/recommend_firebase` | **Works, untested** | No test exercises either auth path end to end. |
| Security fixes from PRs #35–#38 | **Works** | 29 regression tests pass; no credentials remain in source. |
| Recommender (`ai_recommender.py`) | **Built, unreachable** | Solid module with hard-constraint filtering. Nothing imports it in the running app. |
| Points / rewards / leaderboard | **Built, unreachable** | Router exists and is unit-tested; never mounted. |
| Payments / Stripe | **Built, unreachable** | Router exists; never mounted; no webhook, so payment never grants anything. |
| React widgets | **Broken** | Call `/points/*` and `/payments/*`, which do not exist. Hardcoded placeholder URL and key. |
| Mobile app | **Broken as shipped** | Points at `localhost`, embeds an API key in the client bundle. |
| Slack / Discord bots | **Partly broken** | Crash on any API error response; ignore two thirds of what the parser extracts. |
| Streamlit dashboard | **Works** | Simple and honest; state list is hardcoded to 8 US states. |
| Landing page (`index.html`) | **Broken visually** | Dead placeholder logo, four nav links that go nowhere, no link to the beta page. |
| Beta page (`beta/index.html`) | **Built, not collecting** | Careful, accessible page — but submissions open a mailto, so nothing is captured. |
| `docs/` explorer | **Placeholder** | Hardcoded list of three suggestions on a `setTimeout`. No API call. |
| Real activity data | **Exists, unmerged** | 120 real venues + real open-data ingestion on `claude/seed-data-setup-b7zaeu`. `main` has only 134 fictional rows. |
| CI | **Does not exist** | No `.github/` in this repo. `AutomationBot` is prose about a different project. |
| Database | **Does not exist** | `Uberliketasks` is loose DDL, never applied or referenced by any code. |

---

## P0 — blocks anything shipping

### P0-0. Merging the working branch would revert four security fixes

Verified by reading `api/` on `claude/seed-data-setup-b7zaeu` directly:

| Fixed on `main` | On the branch |
| --- | --- |
| `FAMILY_API_KEY` required, no default | `os.getenv("FAMILY_API_KEY", "supersecretkey")` |
| `JWT_SECRET` required, no default | `os.getenv("JWT_SECRET", "jwtsecret")` — anyone can forge a token |
| `hmac.compare_digest` | `if api_key != API_KEY` — timing leak |
| Demo keys off unless `ALLOW_DEMO_KEYS=true` | `{**FALLBACK_USER_TIERS, ...}` — `demo_business_key` always live |
| Leaderboard returns a salted hash | `"api_key": key` — **hands every caller every user's raw key** |
| Dataset path kept server-side | `detail=f"Dataset not found at {DATA_URL}"` — path disclosed to callers |

SQL parameterisation is the one fix the branch does have; the BigQuery path uses
`ScalarQueryParameter` correctly.

The 399 lines of regression tests that pin these behaviours
(`tests/test_security.py`, `tests/test_recommender.py`) do not exist on the
branch — not deleted, simply never inherited. So nothing on that branch fails
when the vulnerabilities come back.

- [ ] Do not fast-forward or squash-merge this branch onto `main`.
- [ ] Rebase the branch onto `ebe709b` and resolve `api/` in favour of `main`'s
      hardened versions, keeping the branch's architectural wins (P0-1, P1-2,
      P2-8, all fixed there).
- [ ] Port `tests/test_security.py` and `tests/test_recommender.py` onto the
      branch **first**, so the rebase has something that fails when it goes wrong.
- [ ] Then re-run both suites: `pytest tests/ -q` and `npm test`.

### P0-1. Half the API is written but never mounted  [fixed on the branch]

`api/server.py` never imports `points`, `payments`, or `ai_recommender`. The
running app exposes exactly three routes:

    /recommend  /recommend_jwt  /recommend_firebase

So `/points/points_balance`, `/points/leaderboard`, `/points/book_activity`,
`/payments/create-checkout-session` and all semantic search **return 404 in
production today**. Three separate client surfaces already call those URLs
(`widgets/ScoutFoxWidget.js:14-41`, `widgets/FamilyModule.js:12-35`,
`widgets/LeaderboardWidget.js:12-18`), so every widget in the repo is dead.

The test suite does not catch this: `tests/test_security.py:143` imports the
`points` module and calls its functions directly, never through the app. The
feature is green in CI and absent in production.

- [ ] Mount the routers: `app.include_router(points.router, prefix="/points")`
      and `app.include_router(payments.router, prefix="/payments")` — the
      prefixes the widgets already assume.
- [ ] Add a test that asserts against `app.routes`, so an unmounted router
      fails the build rather than shipping.
- [ ] Decide whether `ai_recommender` gets an endpoint (see P1-1) or is deleted.

Note: PRs #19, #20, #24 and #25 each propose this same fix. Pick one, close the
other three.

### P0-2. The Docker image cannot run the app  [fixed on the branch]

`api/Dockerfile:5` copies `server.py` only. Not `auth_tiers.py`, `points.py`,
`payments.py`, `ai_recommender.py`, or `embeddings.py`. The moment P0-1 lands,
the container fails at import with `ModuleNotFoundError`.

- [ ] `COPY api/ /app/` instead of a single file.
- [ ] Build the image in CI and start it, so this is caught by a build, not a deploy.

### P0-3. Real data exists, but only on an unmerged branch  [superseded]

**The original finding here was wrong.** It said
`data/processed/family_friendly_dataset.csv` "does not exist anywhere in this
repository or its history." It exists on `claude/seed-data-setup-b7zaeu` and
carries 120 real venues — California Academy of Sciences, the Exploratorium and
so on — with category, price tier, age range, duration, rating and tags.

That branch also fetches genuine upstream open data through the sanctioned
package-registry channel (`world-countries` on npm, `ourairports-data`),
verified against known coordinates (LHR, NRT, SYD, JNB, ORD), with licences
recorded in `data/upstream/PROVENANCE.md`.

So data sourcing is not an unstarted problem. It is a **merge and deploy**
problem.

- [ ] Get `claude/seed-data-setup-b7zaeu` reviewed and merged, or explicitly
      decide it is a spike and say so.
- [ ] `scout/BLOCKED.md` on that branch is the real "what is not built" list —
      live provider data is blocked on egress policy, not on code. Read it
      before planning any further data work.
- [ ] Still genuinely missing: places data carrying age and duration fields, and
      live weather. Neither has a package form.
- [ ] Keep `is_seed_data` filtering in place so fiction can never reach a family.

### P0-4. Payment grants nothing

`api/payments.py` creates a Stripe checkout session and returns the URL. There
is no webhook handler, no `checkout.session.completed` listener, and no code
path anywhere that moves a user from `free` to `pro`. Tiers come from the
`API_KEY_TIERS` environment variable (`api/auth_tiers.py:30`), which only an
operator can edit.

A customer can pay and receive nothing. `points.py:30-34` correctly refuses to
let a client self-report `upgrade_pro`, which is right — but nothing else grants
it either.

- [ ] Do not take payments until a webhook grants the tier it sold.
- [ ] Move tier storage out of an env var into something the webhook can write.
- [ ] Verify the Stripe signature on the webhook.
- [ ] Replace the `yourapp.com` success/cancel defaults (`api/payments.py:20-21`).

### P0-5. The product is not on `main`, and nothing is deployed to production

Two facts found by querying Vercel directly (team `Scout Fox Travel`):

- All 20 most recent deployments have **`target: null`** — every one is a
  preview build. There is no production deployment. Whatever
  `scoutfoxtravel.com` currently serves, it is not coming from these builds.
- There are **three Vercel projects**: `scout-fox-travel`, `scout-fox-go` and
  `scout-fox-pro`. The latter two were created within the last week. Combined
  with the two domains in P2-2, that is now three properties and no stated
  relationship between them.

Meanwhile 26 commits of the actual platform sit unmerged on
`claude/seed-data-setup-b7zaeu`, and the open PR list still contains four
duplicate proposals to fix a `main` that the branch has moved past.

- [ ] Decide what `main` is for. Right now it is neither the shipped thing nor
      the developed thing.
- [ ] Promote a deployment to production, or take the domain down until there is
      one. A live domain serving a broken placeholder is worse than a holding page.
- [ ] Say what `scout-fox-go` and `scout-fox-pro` are, or delete them.

### P0-6. `node_modules` is committed on the working branch

`claude/seed-data-setup-b7zaeu` has **250 files under `node_modules/`** checked
in, and its `.gitignore` does not exclude the directory. That is most of the
542,245-line diff against `main`.

- [ ] Add `node_modules/` to `.gitignore` and remove it from the branch before
      the merge, not after. This gets much harder once it is in `main`'s history.

---

## P1 — needed before a beta anyone would keep using

### P1-1. The recommender does nothing for a user

`api/ai_recommender.py` is the best-built module here — hard constraints applied
before ranking, backends that declare whether they are semantic, honest failure
when data is missing. No user can reach any of it. `/recommend` is a
`state == ?state` string filter.

Worse, `/recommend` requires `state`, so there is no browse, no city search, no
free-text query at all.

- [ ] Add `GET /search?q=...` over `semantic_search`, passing `max_price`,
      `setting` and `suits_age` through as constraints.
- [ ] Never ship with `EMBEDDING_BACKEND=hashing` — it matches words, not
      meaning, and `data/seed/README.md` already warns against exactly this.
      Assert the backend is semantic at startup in production.
- [ ] Surface `_match.backend` in responses so a lexical result is never mistaken
      for a semantic one.

### P1-2. The dataset is re-read from disk on every request

`api/server.py:59` calls `pd.read_csv(DATA_URL)` inside `load_dataset()`, which
`get_data()` calls per request. With `FAMILY_DATASET_URL` set to an
`https://` URL — which `data/README.md` explicitly supports — that is a full
network download per API call.

- [ ] Cache the frame at startup, with an explicit reload path.
- [ ] Add a `/health` endpoint (there is none; `/health` returns 404) that
      reports row count and dataset source.

### P1-3. CSV and BigQuery backends disagree

`api/server.py:137` compares `indoor_or_outdoor` case-insensitively.
`api/server.py:127` compares it with `=` in SQL, which is case-sensitive. The
same request returns different results depending on `USE_BIGQUERY`.

- [ ] `LOWER(indoor_or_outdoor) = LOWER(@indoor)` to match CSV behaviour.
- [ ] Run the API test suite against both backends.

### P1-4. Bots crash on any API error

`bots/slack_bot.py:24` and `bots/discord_bot.py:22` do
`[r['name'] for r in results]` on whatever the API returned. On a 401 the body
is `{"detail": "Invalid API Key"}`; iterating a dict yields the string
`"detail"`, and `"detail"['name']` raises
`TypeError: string indices must be integers`. Reproduced. Any auth failure,
rate limit or 500 crashes the handler instead of telling the user anything.

- [ ] Check `response.status_code` before parsing, and reply with a message.
- [ ] Both bots default `FAMILY_API_KEY` to `"mysecretkey"` — the value printed
      in `README.md`. Require the variable; do not default a credential.

### P1-5. The NLU parser silently lies about location

`bots/nlu_parser.py:45` returns `state or "CA"`. A family in Ohio who does not
name their state gets California results with no indication that a guess was
made. The parser also extracts `price` and `category`, and both bots discard
them (`slack_bot.py:15`, `discord_bot.py:14`), so "free indoor museum in Texas"
is handled as "indoor, TX".

- [ ] Return `None` and ask, rather than defaulting to CA.
- [ ] Either pass `price`/`category` to the API or stop extracting them.
- [ ] The 8-state lookup table cannot express `Greater London` or `Ontario`,
      which are both in the seed data on purpose.

### P1-6. Beta signups are not being captured

`beta/index.html:368` ships `endpoint: ''`, so every submission falls back to
`window.location.href = 'mailto:...'`. That requires a configured mail client,
silently does nothing on many mobile browsers, and leaves no record on your
side. The page is also `noindex` (`beta/index.html:8`) and nothing on
`index.html` links to it — so today it is unreachable and non-collecting.

The page itself is good work: real validation, `aria-live` status, and it
refuses to fake success. It just is not plugged into anything.

- [ ] Point `endpoint` at a real collector before sending anyone there.
- [ ] Link the beta page from the landing page.
- [ ] Remove `noindex` when you actually want signups.
- [ ] Have somewhere for a signup to land — there is no user store.

### P1-7. Non-ASCII API key returns 500, not 401

`api/server.py:69` and `api/auth_tiers.py:61` call `hmac.compare_digest` on
`str`, which raises `TypeError: comparing strings with non-ASCII characters is
not supported`. Reproduced directly. An unauthenticated caller can produce 500s
and stack traces at will.

- [ ] Encode both sides to bytes before comparing.
- [ ] Add a test with a non-ASCII key asserting 401.

---

## P2 — quality, credibility, hygiene

### P2-1. The landing page is visibly broken

- [ ] `index.html:53` loads a logo from `via.placeholder.com`, a service that no
      longer serves images. The homepage of `scoutfoxtravel.com` shows a broken
      image icon.
- [ ] All four nav links are `href="#"` (`index.html:57-60`).
- [ ] The page has one `<h1>` and nothing else — no description of what Scout Fox
      is, no call to action, no route to the beta.

### P2-2. Two different domains

`CNAME` is `scoutfoxtravel.com`. `beta/index.html:369` gives
`info@scoutfoxgo.com`. `api/points.py:89` defaults affiliate links to
`partner.scoutfoxtravel.com`.

- [ ] Pick one and use it everywhere.

### P2-3. Client-side credentials

- [ ] `mobile/App.js:10` hardcodes `API_KEY = 'mysecretkey'`. Any key in a mobile
      bundle is extractable; this is not fixable by moving it to a config file.
      It needs per-user auth, with the API key held server-side.
- [ ] All three widgets hardcode `demo_pro_key` and
      `https://family-api-xxxxxx.a.run.app`. Neither is a real value.
- [ ] `mobile/App.js:9` points at `localhost`, so the app cannot work on a phone.

### P2-4. No CI in this repository

There is no `.github/` directory. The 29 tests only run when someone runs them.
`AutomationBot` is an 8KB text file of YAML and Python for an unrelated
"automation-bot" project — it is not wired to anything, contains
`OPENAI_API_KEY = "replace-with-your-key"`, and builds a `db_query(sql)` that
executes caller-supplied SQL.

- [ ] Add a real workflow running `pytest` on push and PR.
- [ ] Delete `AutomationBot` or move it to its own repository. As a loose file in
      the project root it reads as project code and is not.

### P2-5. Twenty stale pull requests

Open PRs include four that all register the routers (#19, #20, #24, #25), two
for the same one-line `DATA_URL` change (#18, #26), two lazy-load PRs long since
superseded by merged work (#16, #27), and seven `vercel.json` edits from an
outside fork, `SupportSylex` (#28–#34).

- [ ] Close the superseded ones.
- [ ] Review the outside-fork `vercel.json` PRs carefully before merging any —
      deploy configuration from an external contributor deserves scrutiny.
- [ ] #39 (dataset resolution) is recent and worth a decision either way.

### P2-6. Loose files with no owner

- [ ] `Uberliketasks` is Postgres DDL for `Families`, `Trips`, `Feedback`,
      `GlobalPatterns` — no migration tool, no connection code, no reference from
      any module. Either make it the real schema or delete it.
- [ ] `docs/app.js:6` fakes a load with `setTimeout` and prints three hardcoded
      suggestions. It is a mock in a deployed directory.
- [ ] `api/requirements.txt` pins nothing. `sentence-transformers` and
      `faiss-cpu` pull in torch — a large image for a service that currently
      imports neither.

### P2-7. Test coverage gaps

29 tests pass, all of them regression tests for already-fixed security defects.
Not covered:

- [ ] That routers are actually mounted (the P0-1 blind spot).
- [ ] `/recommend_jwt` and `/recommend_firebase` end to end.
- [ ] `payments.py` at all.
- [ ] The bots and the NLU parser at all.
- [ ] `MAX_RESULT_LIMIT` enforcement.

### P2-8. Missing operational basics

- [ ] No `/health` — confirmed 404. Most platforms want one.
- [ ] No CORS middleware, so any browser client (the widgets, `docs/`) is blocked
      by the browser before it ever reaches the 404 from P0-1.
- [ ] No rate limiting on any endpoint.
- [ ] No `.env.example`, despite eighteen environment variables now being read
      or consulted across the API.
- [ ] No `LICENSE`.

---

## The Scout platform, audited

Run on `claude/seed-data-setup-b7zaeu` at `3b257eb`:

    npm test        # 209 tests, 209 pass, 0 fail (8.2s)
    npm run typecheck   # tsc --noEmit, clean

~16,800 lines of TypeScript across `scout/` and ~5,600 lines of tests, with
**zero runtime dependencies** — TypeScript and `@types/node` are the only
devDependencies. Covered areas: SourceMesh ingestion, connectors, entity
resolution, geocoding, geography, licensing, offline transport, radar,
reliability, rewards, seeding, SQL shape, travel foundation, auth, and an
integration suite.

This is the strongest work in the repository, and it is worth saying so plainly:
it passes its own tests, typechecks clean, is honest about what it cannot reach
(`scout/BLOCKED.md`), and records licences and provenance for the data it
ingests.

What it still lacks:

- [ ] No CI — no `.github/` on this branch either, so 209 tests run only by hand.
- [ ] No CORS on the Python API, so browser clients are still blocked (P2-8).
- [ ] `mobile/App.js` and all three widgets still hardcode credentials (P2-3).
- [ ] `node_modules/` committed and un-ignored (P0-6).
- [ ] The Python security tests are absent (P0-0).

## Why the live site could not be checked

`scoutfoxtravel.com` is unreachable from this environment, and it is worth
recording precisely why, because it is not a permissions problem:

- The session's egress proxy answers **403 to CONNECT** for that host. That is
  this account's network allowlist, not the site rejecting anything. The proxy's
  own documentation says policy denials are to be reported, not routed around.
- Account access and network access are different things. The Vercel API is
  reachable through its authenticated connector, and everything below came from
  it. Rendering an arbitrary web page is not.

What the Vercel API did establish:

- The `scout-fox-travel` project has **`live: false`** and no production
  deployment — all 20 recent deployments are previews (`target: null`).
- Its attached domains are only `*.vercel.app`. **`scoutfoxtravel.com` is not
  attached to this project at all.** Since the repo carries a `CNAME` and
  `docs/.nojekyll` — both GitHub Pages conventions — the domain is most likely
  served by GitHub Pages from `main`, entirely separately from Vercel.
- SSO protection is `all_except_custom_domains`, so every `*.vercel.app` URL
  requires a Vercel login and cannot be read unauthenticated.

- [ ] Confirm where `scoutfoxtravel.com` actually points. Two deploy mechanisms
      (GitHub Pages via `CNAME`, Vercel via `vercel.json`) are configured in one
      repo and only one of them can be serving the domain.
- [ ] If it is GitHub Pages from `main`, the live site is the broken placeholder
      described in P2-1, and none of the Scout work is reachable by anyone.

## Suggested order

1. **P0-0** — the merge is the whole ballgame. Port the security tests onto the
   branch, rebase onto `ebe709b`, resolve `api/` in favour of `main`. Do this
   before anything else touches those files.
2. **P0-6** — strip `node_modules` in the same pass, before it reaches `main`.
3. **P0-5** + the deployment question — find out what `scoutfoxtravel.com` is
   actually serving, then promote a real production deployment or take the
   domain down.
4. **P0-3** — merge the data work rather than restarting it; read
   `scout/BLOCKED.md` before planning further data work.
5. **P2-4 (CI)** — 238 tests across two suites now run only by hand. After a
   merge this delicate, that is the thing that stops it silently coming apart.
6. **P1-3, P1-7, P2-8** — correctness, CORS and health on whatever API survives.
7. **P1-6 + P2-1 + P2-2** — do this before pointing anyone at the domain.
8. **P0-4** — required before charging, not before beta.
9. **P1-4, P1-5, P2-3** — bots and client credentials.
10. **P2** — the rest.

## The one-line summary

The work is better than the repository makes it look: a real data platform on
real open data, 209 passing tests, typechecking clean. It is sitting on a branch
that forked one commit before the security fixes and would undo them on the way
in — including a leaderboard that hands every caller every user's API key.
Nothing is deployed to production, and the domain is probably not even pointed
at any of it.
