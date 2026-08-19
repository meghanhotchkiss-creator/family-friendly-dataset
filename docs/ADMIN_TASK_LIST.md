# Scout Fox — Administrator Task List

**Owner:** Meghan Hotchkiss · **Maintainer:** Arsalan (`arsalanaijaz1@gmail.com`)
**Opened:** 19 August 2026 · **Review cadence:** weekly

Status key: ⬜ not started · 🟦 in progress · ✅ done · ⛔ blocked

This is the administrative and operational list — accounts, access, deployment, hygiene. Product and engineering work lives in `SCOUTFOX_API_INVENTORY.md` §5.

---

## A. Security — this week

| # | Task | Owner | Status | Why it cannot wait |
| --- | --- | --- | --- | --- |
| A1 | Choose a password manager and create the shared vault | Meghan | ⬜ | `CREDENTIAL_REGISTER.md` has nowhere to point until this exists |
| A2 | Turn on MFA for the Netlify account (`info@scoutfoxgo.com`) | Meghan | ⬜ | Confirmed **off**. Single owner, Google SSO, no recovery path |
| A3 | Confirm MFA on GitHub, Vercel, and Google Workspace | Meghan | ⬜ | Unverified on all three |
| A4 | Rotate `FAMILY_API_KEY` and `JWT_SECRET` | Arsalan | ⬜ | Both fall back to literals published in a public repo |
| A5 | Rotate/retire the three demo tier keys | Arsalan | ⬜ | `demo_business_key` grants top tier to anyone who reads the repo |
| A6 | Review and merge PR #38 | Meghan reviews, Arsalan merges | ⬜ | Fixes A4/A5 plus SQL injection and key leakage. Written and waiting |
| A7 | Delete the placeholder `OPENAI_API_KEY` line from `AutomationBot` | Arsalan | ⬜ | Invites a real key into a tracked file |
| A8 | Review Sylex Studio's access (Vercel team + GitHub fork) | Meghan | ⬜ | An outside contractor can promote to production. Confirm this is still intended |
| A9 | Identify who holds the three domains and where the registrar login lives | Meghan | ⬜ | Not recorded anywhere. A lost domain is unrecoverable |

---

## B. Deployment and publishing

| # | Task | Owner | Status | Note |
| --- | --- | --- | --- | --- |
| B1 | Decide: does anything belong on **Netlify**, or is Vercel the only host? | Meghan | ⬜ | Today this repo deploys to Vercel only. The one Netlify site is a different project from a different repo |
| B2 | Promote the API inventory to production, or leave it on the branch | Meghan | ⬜ | Currently a READY Vercel **preview** on `claude/scout-fox-api-inventory-yvg1lm`; production is still `main` @ `702b82d` |
| B3 | Attach `scout-fox-go` to a GitHub repo | Arsalan | ⬜ | No Git source — the code exists only on the machine that deployed it |
| B4 | Attach `scout-fox-pro` to a GitHub repo | Arsalan | ⬜ | Same risk. One deploy ever, 14 Aug 2026 |
| B5 | Close or fix PR #34 (`SupportSylex` patch-8) | Arsalan | ⬜ | Seven failed Vercel builds trace to this one branch |
| B6 | Resolve the GitHub Pages / Vercel overlap on `docs/` | Arsalan | ⬜ | `.nojekyll` suggests Pages; Vercel also serves the folder |
| B7 | Open the Google Cloud account and deploy the API to Cloud Run | Arsalan | ⬜ | The API is not deployed anywhere — every client points at `localhost:8000` |
| B8 | Replace the `via.placeholder.com` logo on the live homepage | Meghan | ⬜ | Production currently renders a third-party placeholder image |

---

## C. Domains and identity

| # | Task | Owner | Status | Note |
| --- | --- | --- | --- | --- |
| C1 | Pick the primary domain of the three | Meghan | ⬜ | `scoutfoxtravel.com`, `scoutfoxplanning.com`, `scoutfoxgo.com` are all in use with no stated relationship |
| C2 | Fix the beta page's domain mismatch | Arsalan | ⬜ | A `scoutfoxtravel.com` page asks testers to email `@scoutfoxgo.com` — reads as phishing |
| C3 | Redirect the non-primary domains | Arsalan | ⬜ | After C1 |
| C4 | Consolidate onto one business identity | Meghan | ⬜ | Netlify is under `info@scoutfoxgo.com`; GitHub and Vercel under `meghan.hotchkiss@gmail.com` |
| C5 | Record domain expiry dates and set renewal reminders | Meghan | ⬜ | Not tracked anywhere |

---

## D. Accounts to open

| # | Account | Owner | Status | Blocking |
| --- | --- | --- | --- | --- |
| D1 | Google Cloud (Cloud Run + BigQuery) | Arsalan | ⬜ | **Yes** — nowhere to run the API |
| D2 | Stripe | Meghan | ⬜ | **Yes** — no revenue without it |
| D3 | Affiliate programme (pick 1–2) | Meghan | ⬜ | **Yes** — the booking link is currently fictional |
| D4 | NPS API key (free) | Arsalan | ⬜ | No — but it is the cheapest first content source |
| D5 | Slack app | Arsalan | ⬜ | No |
| D6 | Discord developer app | Arsalan | ⬜ | No |
| D7 | Docker Hub | Arsalan | ⬜ | No |
| D8 | OpenAI | Arsalan | ⬜ | No — prototype only |

---

## E. Repository hygiene

| # | Task | Owner | Status | Note |
| --- | --- | --- | --- | --- |
| E1 | Close the ~15 duplicate open PRs | Arsalan | ⬜ | Five register the same routers; two make the same `DATA_URL` edit; three add the same closing tags |
| E2 | Triage the 6 outside-fork `vercel.json` PRs | Arsalan | ⬜ | Unreviewed config changes against a live deploy |
| E3 | Move the CI YAML into `.github/workflows/ci.yml` | Arsalan | ⬜ | It lives inside a text file, so no CI runs at all |
| E4 | Split `AutomationBot` and `Uberliketasks` into real files | Arsalan | ⬜ | Extension-less text files holding YAML, Python, and SQL |
| E5 | Add `.env` to `.gitignore` and commit `.env.example` | Arsalan | ⬜ | Prevents the next secret leak |
| E6 | Decide whether the repo should stay public | Meghan | ⬜ | It is public today, which is why A4/A5 are urgent |

---

## F. Monitoring — nothing is watched today

| # | Task | Owner | Status | Note |
| --- | --- | --- | --- | --- |
| F1 | Uptime monitoring on both live domains | Arsalan | ⬜ | Free tier of UptimeRobot or Better Stack is enough |
| F2 | Deploy-failure notifications from Vercel and Netlify | Arsalan | ⬜ | Seven builds failed without anyone being alerted |
| F3 | Error tracking on the API | Arsalan | ⬜ | After D1 |
| F4 | Analytics on the live site | Meghan | ⬜ | No usage visibility at all |
| F5 | Calendar reminders for domain and SSL expiry | Meghan | ⬜ | After C5 |

---

## G. Done

| Date | Task | By |
| --- | --- | --- |
| 19 Aug 2026 | Full API inventory and build plan written and pushed | Claude Code |
| 19 Aug 2026 | Systems, credential, and admin registers created | Claude Code |
| 19 Aug 2026 | Netlify publish status verified against the live account — nothing from this repo is on Netlify | Claude Code |

---

## Weekly review — five questions

1. Did anything get deployed to production, and was it intended?
2. Did any build fail, and did anyone notice without being told?
3. Was a new credential created? Is it in the register with an owner?
4. Did anyone gain or lose access to an account?
5. Which of the A-list items are still open, and why?
