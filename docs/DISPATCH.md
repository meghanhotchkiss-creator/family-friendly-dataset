# Scout Fox Dispatch — from here to live

**For:** Meghan and Arsalan · **Written:** 19 August 2026
**What this is:** the whole path from where the project stands today to a
working site, in order, with what to type and how to know each step worked.

Seven stages. Stages 1 and 2 take about half an hour and end with you seeing
real activity data on your own screen. Stage 4 is the long one and needs a
Google Cloud account.

Nothing here assumes you have done the previous stages on the same day. Each
stage says who does it, how long it takes, and what breaks if you skip it.

---

## Before you start — the one-paragraph situation

Scout Fox had an API with no data behind it. The recommendation endpoints read
a CSV that was never created, the pipeline meant to build it was left in a zip
file and never merged, and seven of the endpoints the website calls were never
switched on. That is now fixed on the branch
`claude/scout-fox-api-inventory-yvg1lm`: there are 122 real activities across
27 states, the routes are mounted, and the web page queries the API for real.
What remains is getting a free key, deploying, and pointing the site at it.

---

## Stage 1 — Get real park data flowing

**Who:** Arsalan (or Meghan — no coding needed for the key part)
**Time:** 15 minutes
**Needs:** nothing you do not already have

### 1.1 Get the National Park Service key

Go to **https://developer.nps.gov/get-started/**, enter a name and email. The
key arrives by email immediately. It is free, there is no card, and there is no
approval wait.

This is the cheapest real data Scout Fox can have: hundreds of parks,
monuments, seashores and historic sites, all family-relevant, all with official
URLs, and no restriction on how we use them.

### 1.2 Build the dataset with it

```bash
git checkout claude/scout-fox-api-inventory-yvg1lm
pip install -r api/requirements.txt

export NPS_API_KEY="the-key-from-your-email"
python scripts/build_dataset.py --source seed_curated,nps
```

### You will know it worked when

The last lines read something like:

```
    seed_curated: 122
             nps: 400+
           TOTAL: 500+

Wrote 500+ rows to data/processed/family_friendly_dataset.csv
```

### If it does not

- `unknown source` → check the spelling; `--list-sources` shows valid names.
- `nps: skipped -- NPS_API_KEY is not set` → the export did not take. Run
  `echo $NPS_API_KEY` to confirm.
- Any other NPS error → the build still writes the 122 seed rows. You are not
  blocked; carry on to Stage 2 and come back.

### Skip this and

You still have 122 real activities from the seed, which is enough to demo. You
just will not have national parks.

---

## Stage 2 — See it working on your own machine

**Who:** Arsalan
**Time:** 10 minutes
**Needs:** Stage 1, or nothing at all if you accept the seed data

### 2.1 Start the API

```bash
cd api
export FAMILY_API_KEY="local-test-key"
export JWT_SECRET="local-test-secret"
uvicorn server:app --port 8000
```

Leave it running. Open a second terminal for everything below.

### 2.2 Prove the API returns data

```bash
curl -H "X-API-Key: local-test-key" "http://localhost:8000/meta"
```

You should get back a row count and a list of states. Then:

```bash
curl -H "X-API-Key: local-test-key" \
  "http://localhost:8000/recommend?state=CA&limit=3"
```

Three California activities, with names, cities and URLs.

### 2.3 See the website

Edit `docs/index.html`, near the bottom:

```javascript
window.SCOUTFOX_CONFIG = {
  apiUrl: "http://localhost:8000",
  apiKey: "local-test-key"
};
```

Then serve it:

```bash
python -m http.server 8080 --directory docs
```

Open **http://localhost:8080**.

### You will know it worked when

The page says "122 activities across 27 states" (or more, with NPS), the state
dropdown is populated, and clicking **Find activities** fills the page with
cards. Try switching to Texas and Indoor. Try typing "aquarium" in the search
box.

### If it does not

- Page loads but says it cannot reach the API → the API terminal is not
  running, or `apiUrl` is wrong.
- "The API rejected our key" → `apiKey` in the HTML does not match
  `FAMILY_API_KEY` in the API terminal.
- Cards appear but every one says "Details not yet verified" → that is
  correct and deliberate. See Stage 7.

### Skip this and

You will be debugging in production instead of on your laptop, which is
considerably slower.

---

## Stage 3 — Close the security holes before anything goes public

**Who:** Meghan reviews, Arsalan executes
**Time:** 30 minutes
**Needs:** nothing

Do this **before** Stage 4. Once the API is on the public internet, the
credentials below are not just published — they are usable.

### 3.1 Merge PR #38

It is already written and waiting. It fixes: the API accepting a password
published in this repo, anyone being able to mint valid login tokens, a
database query that can be hijacked through the URL, the leaderboard handing
out other people's API keys, and the points system being replayable for
unlimited points.

Review it, merge it.

### 3.2 Rotate the three exposed credentials

Merging #38 stops the code using them. It does **not** make the old values
stop working — they are in git history forever. Generate new ones:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Run it three times, for `FAMILY_API_KEY`, `JWT_SECRET`, and a fresh browser
key. Put them in the deployment environment (Stage 4), never in a file in the
repo.

### 3.3 Turn on MFA for Netlify

`info@scoutfoxgo.com` has no second factor and is the only account that can
touch the live command-center site. Ten minutes in the Netlify security
settings.

### 3.4 Decide about Sylex Studio

`support@sylexstudio.com` is on the Vercel team and can promote to production.
If that engagement is over, remove the access. If it is not, leave it — just
make it a decision rather than a leftover.

### You will know it worked when

PR #38 is merged, and `docs/CREDENTIAL_REGISTER.md` has three new rows in its
rotation log with today's date.

### Skip this and

You publish an API whose master key anyone can read on GitHub.

---

## Stage 4 — Put the API on the internet

**Who:** Arsalan
**Time:** 1–2 hours, mostly waiting
**Needs:** Stage 3, and a Google Cloud account with billing enabled

This is the only stage that costs money, and at Scout Fox's traffic it will be
pennies. Cloud Run bills per request and scales to zero when nobody is using
it.

### 4.1 Create the project

In the Google Cloud console: new project, enable billing, then enable the
**Cloud Run** and **Artifact Registry** APIs.

### 4.2 The Dockerfile is already fixed

It used to copy only `server.py`, which meant the container started and then
failed on the first request -- no `points.py`, no providers, no dataset. It now
copies the whole `api/` folder plus the dataset, and is built from the
repository root:

```bash
docker build -f api/Dockerfile -t scoutfox-api .
```

Nothing to change. Noted here because the old behaviour is a confusing failure
if you hit it.

### 4.3 Deploy

```bash
gcloud run deploy scoutfox-api \
  --source . \
  --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "FAMILY_API_KEY=<new key>,JWT_SECRET=<new secret>,ALLOWED_ORIGINS=https://scoutfoxtravel.com,https://www.scoutfoxtravel.com"
```

`--allow-unauthenticated` means Cloud Run does not add its own login layer.
The API still requires `X-API-Key` — that check is ours and stays on.

### You will know it worked when

`gcloud` prints a URL ending in `.run.app`, and this returns `{"status":"ok"}`:

```bash
curl https://your-url.run.app/healthz
```

Then, with your new key:

```bash
curl -H "X-API-Key: <new key>" "https://your-url.run.app/recommend?state=CA&limit=3"
```

### If it does not

- Build fails on `requirements.txt` → `sentence-transformers` and `faiss-cpu`
  are large. They are only needed for semantic search, and `/search` falls
  back to plain matching without them. Comment them out to get deployed, add
  them back later.
- `/healthz` works but `/recommend` returns 500 → the dataset did not make it
  into the image. Check the `COPY` line in 4.2.
- 401 on every request → the key in your curl does not match the deployed
  `FAMILY_API_KEY`.

### Skip this and

Nothing else can happen. The website, the bots, the mobile app and the widgets
all need a reachable API. This is the blocking stage.

---

## Stage 5 — Point the website at the deployed API

**Who:** Arsalan
**Time:** 15 minutes
**Needs:** Stage 4

### 5.1 Update the web page

In `docs/index.html`:

```javascript
window.SCOUTFOX_CONFIG = {
  apiUrl: "https://your-url.run.app",
  apiKey: "<the browser key>"
};
```

**Use a separate, low-tier key here.** This one is visible to every visitor —
that is unavoidable for a static site. It must not be the same key you gave
Cloud Run as the master key.

### 5.2 Point the other clients

Same base URL, set as environment variables rather than edited into files:

| Client | Variable |
| --- | --- |
| Bots | `SCOUTFOX_API_URL` |
| Dashboard | `SCOUTFOX_API_URL` |
| Mobile | `EXPO_PUBLIC_SCOUTFOX_API_URL` |
| Widgets | `REACT_APP_SCOUTFOX_API_URL` |

### You will know it worked when

You open `docs/index.html` locally with no API running on your machine, and it
still loads activities — because it is talking to Cloud Run.

### If it does not

Open the browser console. A CORS error means the deployed `ALLOWED_ORIGINS`
does not include the address you are loading the page from.

---

## Stage 6 — Ship it

**Who:** Meghan decides, Arsalan merges
**Time:** 10 minutes
**Needs:** Stage 5

### 6.1 Merge the branch

Merge `claude/scout-fox-api-inventory-yvg1lm` into `main`. Vercel deploys
`main` to `scoutfoxtravel.com` automatically — no separate deploy step.

### 6.2 Two things worth fixing in the same pass

- The homepage still shows a **placeholder logo** loaded from
  `via.placeholder.com`. It literally reads "Scout Fox Logo".
- The beta page asks testers to email `info@scoutfoxgo.com` from a page on
  `scoutfoxtravel.com`. That domain mismatch reads as phishing to exactly the
  kind of careful person who signs up for betas.

### You will know it worked when

`https://scoutfoxtravel.com/docs/` loads and returns real activities.

---

## Stage 7 — Make it trustworthy

**Who:** split
**Time:** ongoing
**Needs:** Stage 6

### 7.1 Verify the seed rows

All 122 seed activities are marked `verified=false`, and the site tells
visitors so on every card. The names, states and categories are reliable; the
URLs and age ranges have not been checked one by one.

Work through them, and change `verified` to `true` in
`data/seed/curated_activities.csv` as you confirm each. Rebuild with
`python scripts/build_dataset.py`. The cards stop showing the warning as rows
are verified.

This is the single highest-value non-technical task in the project, and it
does not need Arsalan.

### 7.2 Turn on monitoring

Right now, if the site goes down, nobody finds out. Free tier of UptimeRobot
or Better Stack, pointed at `scoutfoxtravel.com` and `/healthz`. Turn on
Vercel and Netlify deploy-failure emails while you are there — seven builds
have already failed without anyone noticing.

### 7.3 Then, in priority order

1. **Rate limiting.** Paid tiers currently control which endpoints a key can
   reach, not how often. Anyone can call unlimited times.
2. **A real database.** Points balances live in memory and reset on every
   restart. Anything a customer can spend must survive a redeploy.
3. **An affiliate programme.** `book_activity` hands users a link to
   `partner.scoutfoxtravel.com`, which does not exist. Until a real programme
   is joined, that button should return no link rather than a dead one.
4. **Stripe.** Then a webhook — without one, a customer can pay and never be
   upgraded.

---

## The whole thing on one page

| Stage | Who | Time | Blocking? |
| --- | --- | --- | --- |
| 1 · NPS key, build data | Either | 15 min | No — seed works without it |
| 2 · Run it locally | Arsalan | 10 min | No, but do it anyway |
| 3 · Security | Both | 30 min | **Yes — before going public** |
| 4 · Deploy to Cloud Run | Arsalan | 1–2 hrs | **Yes — everything needs this** |
| 5 · Point clients at it | Arsalan | 15 min | Yes |
| 6 · Merge and ship | Both | 10 min | Yes |
| 7 · Verify and monitor | Split | Ongoing | No |

**The critical path is Stage 4.** Stages 1, 2 and 3 can happen today without
spending anything. Nothing reaches a real user until the API is deployed.

## Where the detail lives

| Question | Document |
| --- | --- |
| What APIs exist, and what do they need? | `docs/SCOUTFOX_API_INVENTORY.md` |
| What accounts and domains do we have? | `docs/SYSTEMS_REGISTER.md` |
| Which credentials are exposed? | `docs/CREDENTIAL_REGISTER.md` |
| What is the full admin task list? | `docs/ADMIN_TASK_LIST.md` |
| How does the dataset work? | `data/README.md` |
| How do I run any of this? | `README.md` |
