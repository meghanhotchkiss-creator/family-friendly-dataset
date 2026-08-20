# Scout Fox — Credential Register

**Last verified:** 19 August 2026 · **Owner:** Meghan Hotchkiss · **Maintainer:** Arsalan

---

## Read this before adding anything

> **No passwords, API keys, tokens, or secret values belong in this file, or anywhere else in this repository.**
> This repo is **public**. Anything committed here is readable by the world, and stays readable in git history even after it is deleted.

This register tracks *facts about* credentials — what exists, who holds it, where the real value is stored, whether MFA is on, when it was last rotated. It never holds the value itself.

**Where the real values go:**

| Kind of secret | Correct home |
| --- | --- |
| Account logins (Netlify, Vercel, Stripe, Google) | A shared password manager — 1Password, Bitwarden, or Google Password Manager with a shared group |
| Deployment env vars | Vercel project → Settings → Environment Variables; Netlify → Site configuration → Environment variables |
| Production API secrets | Google Secret Manager once the API is deployed |
| Local development | An untracked `.env` file (add `.env` to `.gitignore`); commit only `.env.example` with blank values |

**A password manager has not been chosen yet.** That is task A1 on the admin list — until it exists, this register has nowhere to point, and credentials are being passed around informally.

---

## 1. Account logins

| # | System | Account identity | MFA | Shared with | Where the password lives | Action |
| --- | --- | --- | --- | --- | --- | --- |
| L1 | **Netlify** | `info@scoutfoxgo.com` (Meghan Suslak), Google SSO | 🔴 **Off** | Meghan only | Google account | **Turn MFA on.** Single owner, no recovery path if the Google account is lost |
| L2 | **Vercel** | Team “Scout Fox Travel”; owner `meghan.hotchkiss@gmail.com` | ❓ Unverified | Meghan, Arsalan, Sylex Studio | Not recorded | Confirm MFA; review the Sylex Studio membership |
| L3 | **GitHub** | `meghanhotchkiss-creator` | ❓ Unverified | Meghan | Not recorded | Confirm MFA. This account owns a public repo that has been shipping secrets |
| L4 | **GitHub org** | `ScoutFoxGo` | ❓ Unverified | Unknown | Not recorded | Confirm who the org owners are |
| L5 | **Google Workspace** | `info@scoutfoxgo.com` | ❓ Unverified | Meghan | Google | This is the root of the Netlify login — protect it first |
| L6 | **Domain registrar** | Unknown — registrar not identified | ❓ | Unknown | Not recorded | **Identify who holds the three domains.** Losing a domain is unrecoverable |

> Two separate personal identities are in play: `meghan.hotchkiss@gmail.com` (GitHub, Vercel) and `info@scoutfoxgo.com` (Netlify, Google). Consolidating onto the business identity would remove a whole class of "who can even log in" problems.

---

## 2. Secrets the code expects

Every variable the codebase reads. **Status is about the credential, not the code.**

| # | Variable | System | Status | Note |
| --- | --- | --- | --- | --- |
| S1 | `FAMILY_API_KEY` | Own API | 🔴 **Compromised** | Falls back to the literal `supersecretkey`, published in this repo |
| S2 | `JWT_SECRET` | Own API | 🔴 **Compromised** | Falls back to the literal `jwtsecret`. Anyone can mint valid tokens |
| S3 | `API_KEY_TIERS` | Own API | 🔴 **Compromised** | Replaced the hardcoded `demo_free_key` / `demo_pro_key` / `demo_business_key`, all three published |
| S4 | `PUBLIC_ID_SALT` | Own API | ⚪ Not created | Needed so the leaderboard stops echoing raw API keys |
| S5 | `STRIPE_SECRET_KEY` | Stripe | ⚪ Not created | Account not confirmed |
| S6 | `STRIPE_PRICE_ID` | Stripe | ⚪ Not created | Not a secret, but required |
| S7 | `STRIPE_WEBHOOK_SECRET` | Stripe | ⚪ Not created | Without it, paid upgrades cannot be verified |
| S8 | `FIREBASE_PROJECT_ID` | Firebase | ⚪ Not created | — |
| S9 | `DATABASE_URL` | Postgres | ⚪ Not created | No database exists yet |
| S10 | `SLACK_BOT_TOKEN` | Slack | ⚪ Not created | App not created |
| S11 | `SLACK_APP_TOKEN` | Slack | ⚪ Not created | App not created |
| S12 | `DISCORD_BOT_TOKEN` | Discord | ⚪ Not created | App not created |
| S13 | `OPENAI_API_KEY` | OpenAI | 🟡 Placeholder in source | The file contains `"replace-with-your-key"` — delete the line before someone pastes a real key into it |
| S14 | `DOCKER_USER` / `DOCKER_PASS` | Docker Hub | ⚪ Not created | CI referencing them does not run |
| S15 | `NPS_API_KEY` | NPS | ⚪ Not created | Free key, first content source |
| S16 | `GOOGLE_PLACES_API_KEY` | Google | ⚪ Not created | Billed — restrict by referrer and set a quota cap |
| S17 | `YELP_API_KEY` | Yelp | ⚪ Not created | — |
| S18 | `OPENWEATHER_API_KEY` | OpenWeather | 🔴 **Issued, then exposed** | Free-tier key issued 19 Aug 2026 and pasted into a chat transcript. Set it in the deployment environment, and regenerate it from the OpenWeather account page — see the rotation note below |
| S19 | `EVENTBRITE_TOKEN` | Eventbrite | ⚪ Not created | — |
| S20 | `AFFILIATE_REF` | Affiliate partner | ⚪ Not created | No programme joined |
| S21 | GCP service account | Google Cloud | ⚪ Not created | Needed for BigQuery and Cloud Run |

**Legend:** 🔴 published/compromised, must be rotated · 🟡 needs cleanup · ⚪ does not exist yet

---

## 3. Rotation log

Nothing has been rotated. Fill a row in every time a credential is replaced.

| Date | Credential | Reason | Rotated by | Old value invalidated? |
| --- | --- | --- | --- | --- |
| _pending_ | `OPENWEATHER_API_KEY` | Key was pasted into a chat transcript rather than entered into a secret store | — | **No — still to do** |

**OpenWeather, 19 Aug 2026.** A free-tier key was issued and shared in
conversation. It was never committed to this repository — verified against the
working tree and the full history — but a credential that has travelled through
a chat log should be treated as disclosed. Regenerate it on the OpenWeather
account page and set the new value only in the deployment environment. The
free tier carries no billing exposure, so this is housekeeping rather than an
incident; do it before the tier is ever upgraded.

**Rotate S1, S2, and S3 first.** They are live in a public repository. Rotation means: generate a new value, set it in the deployment environment, confirm the service works, then make sure the old value no longer authenticates anywhere. Deleting the line from the code is not rotation — the value stays in git history forever.

---

## 4. Standing rules

1. Never commit a real secret. If one is committed, treat it as public immediately and rotate it — do not just delete the line.
2. Every secret has one named owner in this register.
3. Browser-visible keys (the widgets' `X-API-Key`) are public by definition. They must be free-tier and rate-limited, never business-tier.
4. MFA on every account that can deploy, bill, or move a domain.
5. When someone leaves, their access is removed the same day, and anything they held is rotated.
6. Review this register monthly.
