# Scout Fox — Systems Register

**Owner:** Meghan Hotchkiss · **Maintainer:** Arsalan
**Last verified:** 19 August 2026, from the live Netlify, Vercel, and GitHub accounts.
**Companion docs:** `ADMIN_TASK_LIST.md`, `CREDENTIAL_REGISTER.md`, `SCOUTFOX_API_INVENTORY.md`

---

## 1. The Netlify question, answered

> **Did the work in this repository get published to Netlify?**
> **No.** Nothing from `family-friendly-dataset` has ever been published to Netlify — not the API inventory, not the beta page, not the landing page.

There is exactly **one** Netlify site on the account, and it is a different project built from a different repository:

| Field | Value |
| --- | --- |
| Netlify site | `scoutfoxgocommandcenter` |
| Live URL | https://scoutfoxplanning.com |
| Netlify subdomain | https://main--scoutfoxgocommandcenter.netlify.app |
| Source repo | `github.com/ScoutFoxGo/scout-fox-go-command-center` — **not this repo** |
| Deployed commit | `8ba8b53` — “Brand polish: real mascot in hero, fix remaining orange color refs” |
| Last published | **23 June 2026** (deploy record last touched 25 June 2026) |
| Deploy state | `ready` |
| Deploy source | API / manual upload — not a connected Git build |
| Account | `info@scoutfoxgo.com` (Meghan Suslak), team plan `nf_team_dev`, 1 site total |
| Admin panel | https://app.netlify.com/projects/scoutfoxgocommandcenter |

**Where this repo's work actually goes: Vercel.** `vercel.json` and `CNAME` in this repo target Vercel and `scoutfoxtravel.com`. There is no `netlify.toml`, no `_redirects`, no `_headers`, and no mention of Netlify anywhere in the repository or its history.

### Publish status of the API inventory (pushed today)

| Destination | Status |
| --- | --- |
| GitHub branch `claude/scout-fox-api-inventory-yvg1lm` | ✅ Pushed, commit `734b688` |
| Vercel **preview** build | ✅ READY — `scout-fox-travel-git-claude-scout-fox-a-e1f10d-scout-fox-travel.vercel.app` (19 Aug 2026, 14:23 UTC) |
| Vercel **production** (`scoutfoxtravel.com`) | ❌ Not promoted — production is still `main` @ `702b82d` |
| Netlify | ❌ Not published, and not configured to be |
| Shared artifact page | ✅ Published (private until shared) |

To put it on production: merge the branch into `main`, which triggers a production Vercel deploy. To put it on Netlify instead, a Netlify site would have to be created and pointed at this repo — that does not exist today.

---

## 2. Hosting and deployment

### Vercel — team “Scout Fox Travel” (`team_clqmBsNlgLvdCmZJDpP0zSiH`)

| Project | Source | Production state | Last production deploy | Notes |
| --- | --- | --- | --- | --- |
| `scout-fox-travel` | GitHub `meghanhotchkiss-creator/family-friendly-dataset` (public) | ✅ READY | 19 Aug 2026 02:09 UTC — `main` @ `702b82d` | The site behind `scoutfoxtravel.com`. Created 12 Sep 2025 |
| `scout-fox-go` | No Git repo linked — CLI deploys only | ✅ READY | 19 Aug 2026 00:01 UTC | Node/turbopack app. Last deploy was a **redeploy by `arsalanaijaz1@gmail.com`**. Created 14 Aug 2026 |
| `scout-fox-pro` | No Git repo linked — CLI deploys only | ✅ READY | 14 Aug 2026 04:14 UTC | One deploy ever. Created 14 Aug 2026 |

**Two of the three Vercel projects have no Git repository attached.** Their source exists only on whoever's laptop ran `vercel deploy`. If that machine is lost, so is the project. Getting `scout-fox-go` and `scout-fox-pro` into GitHub is a tracked task.

### Failed builds worth knowing about

Seven Vercel builds have failed, **all of them from the same source**: the `SupportSylex` fork's `patch-8` branch, “Update vercel.json 2288” (PR #34). First failure 17 Sep 2025, most recent 19 Aug 2026 00:44 UTC. That PR is still open. It cannot build, and it should be closed or fixed rather than left to keep failing.

---

## 3. Domains

| Domain | Points at | Platform | Status |
| --- | --- | --- | --- |
| `scoutfoxtravel.com` | `scout-fox-travel` project | Vercel | 🟢 Live — set via `CNAME` in this repo |
| `scoutfoxplanning.com` | `scoutfoxgocommandcenter` | Netlify | 🟢 Live — last content change 23 Jun 2026 |
| `scoutfoxgo.com` | Email / account identity (`info@scoutfoxgo.com`) | — | 🟡 Used for logins and the beta form's `mailto:`, but not serving a site |

**Three domains, three different brand names, no stated relationship between them.** The beta page on `scoutfoxtravel.com` asks testers to email `info@scoutfoxgo.com`, which looks like a phishing mismatch to anyone who notices. Pick a primary domain and redirect the others.

---

## 4. Source control

| Repo | Owner | Visibility | Role |
| --- | --- | --- | --- |
| `meghanhotchkiss-creator/family-friendly-dataset` | Meghan (personal account) | **Public** | API, bots, mobile, widgets, landing + beta pages |
| `ScoutFoxGo/scout-fox-go-command-center` | ScoutFoxGo org | Public | Source of the Netlify command-center site |
| — | — | — | `scout-fox-go` and `scout-fox-pro` have **no repo at all** |

Open PRs on `family-friendly-dataset`: **21**, of which roughly 15 are duplicate one-line fixes and 6 come from the `SupportSylex` outside fork. Open issues: 0.

---

## 5. People and access

| Person | Identity | Has access to | Note |
| --- | --- | --- | --- |
| Meghan Hotchkiss | `meghan.hotchkiss@gmail.com` / `meghanhotchkiss-creator` | GitHub owner, Vercel team owner | Primary account holder |
| Meghan (Netlify) | `info@scoutfoxgo.com` (“Meghan Suslak”), Google SSO | Netlify account owner | **Separate identity from the GitHub/Vercel account** |
| Arsalan | `arsalanaijaz1@gmail.com` | Vercel team member — deployed `scout-fox-go` to production | No GitHub activity recorded in this repo |
| Sylex Studio | `support@sylexstudio.com` / `support-3308`, GitHub `SupportSylex` | **Vercel team member** — has promoted deployments to production; opens PRs from a fork | Outside contractor. Access should be reviewed |

---

## 6. Third-party systems

| System | Account | State |
| --- | --- | --- |
| Netlify | `info@scoutfoxgo.com`, dev team plan | 🟢 Active, 1 site, unrelated to this repo |
| Vercel | Team “Scout Fox Travel” | 🟢 Active, 3 projects |
| GitHub | `meghanhotchkiss-creator` + `ScoutFoxGo` org | 🟢 Active |
| Google Cloud / BigQuery | — | 🔴 Not opened — the API has nowhere to run |
| Firebase | — | 🔴 Not configured |
| Stripe | — | 🔴 Not confirmed; payment code is unmounted |
| Slack / Discord apps | — | 🔴 Not created |
| OpenAI | — | 🔴 Placeholder key only |
| Docker Hub | — | 🔴 Referenced by CI that never runs |
| Affiliate programme | — | 🔴 None; the booking link is fictional |
| Zoho CRM, Google Workspace, Canva, Zoom, Booking.com, Zapier | Connected as assistant connectors | 🟡 Available but not used by any product code |

See `SCOUTFOX_API_INVENTORY.md` for what each one is needed for.

---

## 7. Monitoring — what we would not find out about

| Event | Would we notice? |
| --- | --- |
| `scoutfoxtravel.com` goes down | ❌ No uptime monitoring |
| A Vercel production build fails | 🟡 Only if someone opens the dashboard |
| Netlify site goes down | ❌ No monitoring |
| API errors in production | ❌ No API is deployed yet; no error tracking configured |
| Someone uses a leaked demo API key | ❌ No logging, no rate limits, no alerting |
| Domain or SSL expiry | ❌ Not tracked anywhere |

Nothing here is monitored. Uptime checks and expiry reminders are the cheapest items on the task list.
