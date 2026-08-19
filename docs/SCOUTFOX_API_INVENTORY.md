# Scout Fox AI — API Inventory & Build Plan

**Prepared for:** Meghan Hotchkiss, Arsalan
**Repo:** `meghanhotchkiss-creator/family-friendly-dataset`
**Date:** 19 August 2026
**Scope:** every API this project (a) exposes, (b) calls, (c) assumes but has not built — plus the accounts and actions each one needs.

---

## 0. Where we actually are (read this first)

Scout Fox today is **one FastAPI service, three client shells, and a lot of scaffolding that is not wired together**. The honest status:

| Thing | Status |
| --- | --- |
| Recommendation API (`/recommend`) | Code works — **but the dataset it reads does not exist in the repo** |
| Points / gamification API | Code written, **never mounted** — every endpoint is a 404 in production |
| Payments API (Stripe) | Code written, **never mounted**, no webhook, no live account confirmed |
| Web widgets (React) | Call `/points/*` and `/payments/*` — **all of them currently fail** |
| Slack + Discord bots | Complete, but hardcoded to `http://localhost:8000` |
| Mobile app (Expo) | Complete, hardcoded to `http://localhost:8000` |
| Landing + beta pages | Live on Vercel at `scoutfoxtravel.com`; beta forms fall back to `mailto:` |
| AutomationBot (OpenAI/LangChain) | A single un-deployed file with a placeholder key — prototype, not product |
| Booking / affiliate revenue | **Does not exist.** The affiliate URL in the code is invented |
| Data source APIs (Places, Yelp, events, weather) | **None integrated** |
| Open PRs | 21 open, ~15 of them duplicate one-line fixes from an old Codex run |

The single largest blocker is **#1 below: there is no data**. Everything else is downstream of that.

---

## 1. APIs we built ourselves

Service: **Family Friendly Dataset API v4.0** — FastAPI, `api/server.py`, containerised via `api/Dockerfile`, intended for Cloud Run.

### 1a. Live and mounted

| Endpoint | Method | Auth | Source | Status |
| --- | --- | --- | --- | --- |
| `/recommend` | GET | `X-API-Key` header | `api/server.py:81` | ✅ Mounted. Fails at runtime until a dataset exists. |
| `/recommend_jwt` | GET | Bearer JWT (HS256) | `api/server.py:85` | ⚠️ Mounted but **unusable** — `OAuth2PasswordBearer(tokenUrl="token")` promises a `/token` endpoint that was never written. Nothing can issue a JWT. |
| `/recommend_firebase` | GET | Firebase ID token | `api/server.py:90` | ⚠️ Mounted but inert unless `FIREBASE_PROJECT_ID` is set and Google credentials are present. |

Query params on all three: `state` (required), `indoor` (optional), `limit` (default 10).

### 1b. Written but NOT mounted — currently 404 in production

`api/points.py` and `api/payments.py` define routers that **`server.py` never includes**. There is no `include_router()` call anywhere in the codebase.

| Endpoint | Method | Intended path | Source |
| --- | --- | --- | --- |
| `earn_points` | POST | `/points/earn_points` | `api/points.py:10` |
| `book_activity` | POST | `/points/book_activity` | `api/points.py:24` |
| `points_balance` | GET | `/points/points_balance` | `api/points.py:31` |
| `points_history` | GET | `/points/points_history` | `api/points.py:35` |
| `redeem_points` | POST | `/points/redeem_points` | `api/points.py:39` |
| `leaderboard` | GET | `/points/leaderboard` | `api/points.py:47` |
| `create-checkout-session` | POST | `/payments/create-checkout-session` | `api/payments.py:10` |

**Consequence:** `widgets/ScoutFoxWidget.js`, `widgets/FamilyModule.js`, and `widgets/LeaderboardWidget.js` all call these exact paths. Every one of those calls fails today. The "Upgrade to Pro" button does nothing.

**Five separate open PRs try to fix this and none were merged:** #14, #19, #20, #24, #25.

### 1c. Written but not exposed at all

| Capability | Source | Note |
| --- | --- | --- |
| Semantic search (`semantic_search()`) | `api/ai_recommender.py` | Sentence-transformers + FAISS. No endpoint calls it. The AI in "Scout Fox AI" is this file, and it is unreachable. |
| Tiered API keys (`verify_tier()`) | `api/auth_tiers.py` | Works, but the only keys are `demo_free_key` / `demo_pro_key` / `demo_business_key`, **hardcoded in a public repo**. |
| Chat endpoint (`POST /chat`) | `AutomationBot` (single file) | Separate un-deployed prototype app. Not part of the API service. |

### 1d. Data model that exists on paper only

`Uberliketasks` defines Postgres tables — `Families`, `Trips`, `Feedback`, `GlobalPatterns`. **Nothing in the codebase connects to a database.** Points balances live in Python dictionaries and are erased on every restart or redeploy.

---

## 2. Third-party APIs currently referenced in code

| # | Service | Used for | Where | Account needed? | Credential | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | **Google BigQuery** | Optional activity data store | `api/server.py:28-30` | GCP project + billing | ADC / service account, `BQ_TABLE` | 🟡 Off by default (`USE_BIGQUERY=false`). Query was SQL-injectable; fix sits in **unmerged PR #38**. |
| 2 | **Firebase Auth** | End-user login | `api/server.py:15-21` | Firebase project | `FIREBASE_PROJECT_ID` + ADC | 🟡 Inert unless configured. |
| 3 | **Stripe** | Pro subscription checkout | `api/payments.py` | **Yes — Stripe account** | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` | 🔴 Router unmounted, no webhook, success/cancel URLs still point at `https://yourapp.com`. |
| 4 | **Slack API** (Bolt, Socket Mode) | `family` chat command | `bots/slack_bot.py` | **Yes — Slack app** | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | 🟡 Code complete, points at `localhost:8000`. |
| 5 | **Discord API** | `!family` bot command | `bots/discord_bot.py` | **Yes — Discord developer app** | `DISCORD_BOT_TOKEN` | 🟡 Code complete, points at `localhost:8000`. |
| 6 | **OpenAI API** (`gpt-4o-mini`, embeddings) | LLM + RAG in AutomationBot | `AutomationBot` | **Yes — OpenAI account** | `OPENAI_API_KEY` — currently the literal string `"replace-with-your-key"` | 🔴 Prototype only. Also pins deprecated `langchain.chat_models` imports. |
| 7 | **Docker Hub** | CI image push | `AutomationBot` CI block | **Yes** | `DOCKER_USER`, `DOCKER_PASS` secrets | 🔴 The workflow YAML lives inside a text file, **not** in `.github/workflows/` — so no CI runs at all. |
| 8 | **Vercel** | Hosting the static site | `vercel.json` | **Yes** (appears active) | — | 🟢 Serving `/`, `/beta`, `/docs`. |
| 9 | **DNS / registrar** | `scoutfoxtravel.com` | `CNAME` | **Yes** | — | 🟢 Live. |
| 10 | **GitHub Pages** | `docs/.nojekyll` present | `docs/` | — | — | 🟡 Ambiguous — the same folder is also served by Vercel. Pick one. |
| 11 | **Hugging Face model CDN** | Downloads `all-MiniLM-L6-v2` at import | `api/ai_recommender.py` | No key | — | 🟡 Unmetered external dependency on every cold start. Should be baked into the image. |
| 12 | **spaCy model download** | `en_core_web_sm` for bots | `bots/nlu_parser.py` | No key | — | 🟢 Handled gracefully if missing. |
| 13 | **Expo** | Mobile dev/build | `mobile/` | Account needed for real builds | — | 🟡 Dev only. |
| 14 | **via.placeholder.com** | Logo on the live landing page | `index.html:53` | No | — | 🔴 The production homepage renders a third-party placeholder image that says "Scout Fox Logo". |

---

## 3. Planned, assumed, or on hold — not built

| # | API | Why it matters | Current state | What it needs |
| --- | --- | --- | --- | --- |
| 1 | **Activity dataset / content source** | The whole product | `data/processed/family_friendly_dataset.csv` **is not in the repo**. Every endpoint depends on it. | Decide: licence a dataset, scrape+curate, or pull live from Places/Yelp. **Blocks everything.** |
| 2 | **Booking / affiliate API** | The entire revenue model | `book_activity` returns `https://partner.scoutfoxtravel.com/book/{id}?ref=your_affiliate_id` — **that host does not exist and the ref ID is a placeholder**. Users are handed a dead link. | Apply to a real programme: Viator, GetYourGuide, Booking.com, Expedia TAAP, Tripadvisor, Klook. Needs a business entity + tax details. |
| 3 | **Beta signup / feedback endpoint** | Collecting testers | `BETA_CONFIG.endpoint` is `''`, so forms fall back to `mailto:info@scoutfoxgo.com`. **Note the domain mismatch** — the site is `scoutfoxtravel.com`. | Stand up a POST endpoint (own API, Formspree, or Basin) and settle on one domain. |
| 4 | **Token issuance (`POST /token`)** | JWT auth is advertised but impossible | Referenced by `OAuth2PasswordBearer`, never implemented. | Write it, or drop the JWT endpoint. |
| 5 | **Persistence layer** | Points/users survive restarts | Schema exists in `Uberliketasks`; no connection code. Balances are in-memory dicts. | Provision Postgres (Cloud SQL / Neon / Supabase), add SQLAlchemy + migrations. |
| 6 | **Semantic search endpoint** | The "AI" in Scout Fox AI | Function exists, no route. | One route + the dataset from #1. |
| 7 | **Places / POI enrichment** | Hours, ratings, photos, addresses | None. | Google Places, Yelp Fusion, Foursquare. All need billed accounts and have redistribution limits — read the terms before caching. |
| 8 | **Parks & public land** | High-value family content, free | None. | NPS API (free key), Recreation.gov. |
| 9 | **Events** | Time-sensitive recommendations | None. | Eventbrite, Ticketmaster Discovery. |
| 10 | **Weather** | Indoor/outdoor decisions — a stated product feature | None. | OpenWeather or Weather.gov (free, US-only). |
| 11 | **Email / CRM** | Beta invites, retention | None in code. | Zoho CRM and Google Workspace are already connected at the account level — use one rather than adding a new vendor. |
| 12 | **Frontend data API** | `docs/app.js` | Comment reads *"Placeholder example - in future, replace with API call."* Renders three hardcoded suggestions. | Point at `/recommend`. |
| 13 | **Rate limiting / quota** | Tiers mean nothing without it | Tiers gate *access*, not *volume*. A free key can call unlimited times. | Add per-key limits before any paid launch. |
| 14 | **Analytics** | We can't see usage | None. | Plausible / GA4 / Vercel Analytics. |

---

## 4. Accounts and actions needed

### 4a. Security actions — do these first

| Action | Why | Owner |
| --- | --- | --- |
| **Rotate/retire the demo keys** | `demo_free_key`, `demo_pro_key`, `demo_business_key` are committed in public source. Anyone can call every tier. | Arsalan |
| **Remove default secrets** | `server.py` falls back to `"supersecretkey"` and `"jwtsecret"` if env vars are unset — a misconfigured deploy looks healthy while accepting a published credential. | Arsalan |
| **Merge PR #38** | Fixes the above plus BigQuery SQL injection, points-replay abuse, and API keys leaking through `/leaderboard`. It is written and open. | Meghan (review) |
| **Purge the placeholder OpenAI key line** | `OPENAI_API_KEY = "replace-with-your-key"` invites a real key being pasted into a tracked file. | Arsalan |

### 4b. Accounts to open or confirm

| Account | Needed for | Cost | Blocking? | Owner |
| --- | --- | --- | --- | --- |
| Google Cloud (Cloud Run + BigQuery) | Hosting the API, data warehouse | Pay-as-you-go | Yes — API is not deployed anywhere | TBD |
| Stripe | Subscriptions | 2.9% + 30¢ | Yes for revenue | Meghan |
| Affiliate programme (pick 1–2) | Booking commission | Free to join, needs business details | Yes for revenue | Meghan |
| Firebase | End-user auth | Free tier fine | Only if consumer login ships | TBD |
| Slack app | Slack bot | Free | No | Arsalan |
| Discord developer app | Discord bot | Free | No | Arsalan |
| OpenAI | AutomationBot | Usage-based | No — prototype | Arsalan |
| Docker Hub | CI images | Free tier | No | Arsalan |
| NPS / Recreation.gov | Park content | Free | No | TBD |
| Google Places or Yelp Fusion | POI enrichment | Billed per call | Depends on #3.1 | TBD |
| OpenWeather | Indoor/outdoor logic | Free tier | No | TBD |
| Email/CRM (use existing Zoho) | Beta invites | Already owned | No | Meghan |

### 4c. Repo hygiene

- **21 open PRs; roughly 15 are duplicates** of the same one-line Codex fixes (five PRs alone register the same routers; two do the same `DATA_URL` edit; three add closing tags to `index.html`). Close the duplicates, keep one of each.
- Six PRs from an outside fork (`SupportSylex`) all edit `vercel.json`. Review or close them — unreviewed config PRs on a live deploy are a risk.
- Move the CI YAML out of the `AutomationBot` text file into `.github/workflows/ci.yml` so it actually runs.
- `AutomationBot` and `Uberliketasks` are extension-less text files holding YAML, Python, and SQL. Split them into real files.

---

## 5. The plan

### Phase 0 — Stop the bleeding (this week)

**Goal: the API is deployed, secure, and its own frontends can reach it.**

1. Merge PR #38 (security fixes).
2. Mount the routers.
3. Add a seed dataset so the service can start.
4. Close the ~15 duplicate PRs.
5. Deploy to Cloud Run and put the real URL in a config file, not in fourteen places.

**Mount the routers** — `api/server.py`, after `app = FastAPI(...)`:

```python
from fastapi.middleware.cors import CORSMiddleware

from payments import router as payments_router
from points import router as points_router

app = FastAPI(title="Family Friendly Dataset API", version="4.0")

# The widgets are served from scoutfoxtravel.com and call this API cross-origin.
# Without CORS every browser call fails even once the routes exist.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        o.strip()
        for o in os.getenv(
            "ALLOWED_ORIGINS",
            "https://scoutfoxtravel.com,https://www.scoutfoxtravel.com",
        ).split(",")
        if o.strip()
    ],
    allow_methods=["GET", "POST"],
    allow_headers=["X-API-Key", "Content-Type", "Authorization"],
)

# Prefixes must match what the widgets already call: /points/* and /payments/*.
app.include_router(points_router, prefix="/points", tags=["points"])
app.include_router(payments_router, prefix="/payments", tags=["payments"])


@app.get("/healthz", include_in_schema=False)
def healthz():
    """Cloud Run needs a route that answers without touching the dataset."""
    return {"status": "ok"}
```

**Issue the JWTs we already claim to accept** — new `api/tokens.py`:

```python
"""Token issuance for /recommend_jwt.

The API advertises OAuth2 password flow at /token but never implemented it,
so no caller could obtain a JWT. This closes that gap.
"""
import os
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from jose import jwt

router = APIRouter()

ALGORITHM = "HS256"
TOKEN_TTL_MINUTES = int(os.getenv("TOKEN_TTL_MINUTES", "60"))


def _secret() -> str:
    secret = os.getenv("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET is not set")
    return secret


@router.post("/token")
def issue_token(form: OAuth2PasswordRequestForm = Depends()):
    # Placeholder credential check. Replace with the user store from Phase 1 —
    # this must not ship to production as-is.
    from auth_tiers import USER_TIERS

    tier = USER_TIERS.get(form.password)
    if tier is None:
        raise HTTPException(status_code=401, detail="Invalid credentials")

    expires = datetime.now(timezone.utc) + timedelta(minutes=TOKEN_TTL_MINUTES)
    payload = {"sub": form.username, "tier": tier, "exp": expires}
    return {
        "access_token": jwt.encode(payload, _secret(), algorithm=ALGORITHM),
        "token_type": "bearer",
        "expires_in": TOKEN_TTL_MINUTES * 60,
    }
```

**One config source for every frontend** — new `widgets/config.js`:

```javascript
/*
 * Single source of truth for the API base URL and key.
 *
 * The URL was previously pasted into three widgets, the mobile app, the
 * dashboard, and both bots, each with a different placeholder value. Deploying
 * meant editing seven files and missing one.
 *
 * The API key here is a browser-visible key. Treat it as public: it must be a
 * low-tier, rate-limited key, never a business-tier one.
 */
export const API_URL =
  process.env.REACT_APP_SCOUTFOX_API_URL || "http://localhost:8000";

export const API_KEY = process.env.REACT_APP_SCOUTFOX_API_KEY || "";

export const authHeaders = () => ({ "X-API-Key": API_KEY });
```

Then in each widget, replace the hardcoded constants:

```javascript
import { API_URL, authHeaders } from "./config";

const res = await axios.get(`${API_URL}/recommend?state=CA&limit=5`, {
  headers: authHeaders(),
});
```

**Seed dataset** so the service starts — `data/processed/family_friendly_dataset.csv`:

```csv
name,state,city,type,indoor_or_outdoor,min_age,max_age,price_band,url
Griffith Observatory,CA,Los Angeles,museum,indoor,4,99,free,https://griffithobservatory.org
La Brea Tar Pits,CA,Los Angeles,museum,indoor,3,99,$,https://tarpits.org
Balboa Park,CA,San Diego,park,outdoor,0,99,free,https://balboapark.org
Houston Zoo,TX,Houston,zoo,outdoor,0,99,$$,https://houstonzoo.org
Perot Museum,TX,Dallas,museum,indoor,3,99,$$,https://perotmuseum.org
```

Required columns are documented in `data/README.md` (added by PR #38): `name`, `state`, `indoor_or_outdoor`. Extra columns pass through untouched.

---

### Phase 1 — Real data and real persistence (weeks 2–4)

**Goal: the recommendations are worth having, and points survive a restart.**

Pick a content strategy. Recommendation: **NPS + Recreation.gov first** (free, high-quality, family-relevant, no redistribution fight), then Google Places for enrichment once volume justifies the bill.

**Provider adapter** — new `api/providers/base.py`, so swapping sources later is a config change, not a rewrite:

```python
"""Content provider adapters.

Each provider normalises an external API into the same row shape the dataset
uses, so /recommend does not care where a row came from.
"""
from abc import ABC, abstractmethod
from typing import Any, Dict, List


class ActivityProvider(ABC):
    """Normalises an external source into dataset rows."""

    name: str

    @abstractmethod
    def search(self, state: str, indoor: str | None, limit: int) -> List[Dict[str, Any]]:
        """Return rows with at least: name, state, indoor_or_outdoor."""


class ProviderRegistry:
    def __init__(self):
        self._providers: Dict[str, ActivityProvider] = {}

    def register(self, provider: ActivityProvider) -> None:
        self._providers[provider.name] = provider

    def search_all(self, state: str, indoor: str | None, limit: int):
        rows: List[Dict[str, Any]] = []
        for provider in self._providers.values():
            try:
                rows.extend(provider.search(state, indoor, limit))
            except Exception:
                # One provider being down must not take out the endpoint.
                import logging
                logging.getLogger(__name__).exception(
                    "Provider %s failed", provider.name
                )
        return rows[:limit]


registry = ProviderRegistry()
```

**NPS provider** — `api/providers/nps.py`:

```python
import os
import requests

from .base import ActivityProvider, registry

NPS_API = "https://developer.nps.gov/api/v1/parks"


class NPSProvider(ActivityProvider):
    """National Park Service. Free key from developer.nps.gov/get-started."""

    name = "nps"

    def search(self, state, indoor, limit):
        # NPS parks are outdoor by definition; skip when the caller wants indoor.
        if indoor == "indoor":
            return []

        api_key = os.getenv("NPS_API_KEY")
        if not api_key:
            return []

        response = requests.get(
            NPS_API,
            params={"stateCode": state, "limit": limit, "api_key": api_key},
            timeout=10,
        )
        response.raise_for_status()

        return [
            {
                "name": park["fullName"],
                "state": state.upper(),
                "type": "park",
                "indoor_or_outdoor": "outdoor",
                "price_band": "free",
                "url": park.get("url", ""),
                "source": self.name,
            }
            for park in response.json().get("data", [])
        ]


registry.register(NPSProvider())
```

**Persist the points ledger** — `api/db.py`, replacing the in-memory dicts:

```python
"""Durable storage for the points ledger.

The dict-based ledger in points.py is process-local: balances vanish on restart
and diverge across Cloud Run instances. Anything users can spend must be in a
database.
"""
import os

from sqlalchemy import create_engine, Column, Integer, String, DateTime, func
from sqlalchemy.orm import declarative_base, sessionmaker

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL is not set")

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine, autoflush=False)
Base = declarative_base()


class PointsLedger(Base):
    """Append-only. Balance is the sum of a user's rows, never an edited field,
    so a bad write can be traced and reversed rather than silently overwriting
    someone's total."""

    __tablename__ = "points_ledger"

    id = Column(Integer, primary_key=True)
    user_id = Column(String(64), index=True, nullable=False)  # hashed key, never raw
    event = Column(String(64), nullable=False)
    points = Column(Integer, nullable=False)
    activity_id = Column(String(128), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())


def balance(session, user_id: str) -> int:
    total = (
        session.query(func.coalesce(func.sum(PointsLedger.points), 0))
        .filter(PointsLedger.user_id == user_id)
        .scalar()
    )
    return int(total)
```

---

### Phase 2 — Revenue (weeks 4–6)

**Goal: money can actually arrive.**

1. Stripe account live, real `STRIPE_PRICE_ID`, real success/cancel URLs.
2. **Webhook** — without it, a customer can pay and never be upgraded.
3. Affiliate programme approved; replace the invented partner URL.

**Stripe webhook** — add to `api/payments.py`:

```python
import stripe
from fastapi import Request, HTTPException

WEBHOOK_SECRET = os.getenv("STRIPE_WEBHOOK_SECRET")


@router.post("/webhook")
async def stripe_webhook(request: Request):
    """Confirm payment server-side.

    Upgrading a tier from the browser redirect is forgeable — anyone can visit
    the success URL. Stripe's signed webhook is the only trustworthy signal
    that money moved.
    """
    payload = await request.body()
    signature = request.headers.get("stripe-signature")

    try:
        event = stripe.Webhook.construct_event(payload, signature, WEBHOOK_SECRET)
    except (ValueError, stripe.error.SignatureVerificationError) as exc:
        raise HTTPException(status_code=400, detail="Invalid webhook") from exc

    if event["type"] == "checkout.session.completed":
        session = event["data"]["object"]
        # TODO(Phase 1): promote the customer's tier in the database and award
        # the upgrade_pro points that earn_points now refuses to self-report.
        logger.info("Checkout completed for customer %s", session.get("customer"))

    return {"received": True}
```

Also set the real URLs — no more `yourapp.com`:

```bash
SUCCESS_URL=https://scoutfoxtravel.com/welcome?session_id={CHECKOUT_SESSION_ID}
CANCEL_URL=https://scoutfoxtravel.com/pricing
```

**Affiliate link** — `api/points.py` already reads env vars in PR #38. Once a programme is approved:

```bash
AFFILIATE_BASE_URL=https://www.partner-network.com/booking   # real partner base
AFFILIATE_REF=scoutfox-<our-real-id>
```

Until then, `book_activity` should **not** return a link at all rather than a dead one.

---

### Phase 3 — Connect the clients (weeks 6–8)

- Point Slack, Discord, mobile, and the Streamlit dashboard at the deployed URL via env vars (same pattern as `widgets/config.js`).
- Replace the `docs/app.js` placeholder with a real `/recommend` call.
- Replace the `via.placeholder.com` logo on the homepage with a real asset.
- Wire the beta form to a live endpoint.

**Beta signup endpoint** — new `api/beta.py`:

```python
"""Beta signup and feedback capture.

The beta page currently falls back to mailto:, which loses every submission
where the visitor has no mail client configured.
"""
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field

router = APIRouter()
logger = logging.getLogger(__name__)


class BetaSignup(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    email: EmailStr
    family: str = Field(default="", max_length=500)
    notes: str = Field(default="", max_length=2000)


@router.post("/signup", status_code=201)
def beta_signup(signup: BetaSignup):
    try:
        # TODO(Phase 1): persist to Postgres and push to Zoho CRM, which the
        # team already has, rather than adding another vendor.
        logger.info("Beta signup: %s", signup.email)
    except Exception as exc:
        logger.exception("Failed to record beta signup")
        raise HTTPException(status_code=502, detail="Could not record signup") from exc

    return {"status": "received"}
```

Then in `beta/index.html`, set the endpoint so the mailto fallback stops being the primary path:

```javascript
var BETA_CONFIG = {
  endpoint: 'https://api.scoutfoxtravel.com/beta/signup',
  email: 'info@scoutfoxgo.com'   // ← settle the domain mismatch first
};
```

---

### Phase 4 — Make the tiers mean something (weeks 8+)

- Per-key rate limiting (`slowapi` or an API gateway) — tiers gate access but not volume today.
- Analytics.
- Secret rotation policy; move to Secret Manager.
- Cache external provider responses to control per-call billing.
- Load the embedding model into the Docker image instead of downloading it on every cold start.

**Rate limiting** — `api/rate_limit.py`:

```python
"""Per-key rate limits.

Tiers currently control which endpoints a key may reach, not how often. A free
key can call an endpoint that costs us a Places lookup without limit.
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

TIER_LIMITS = {"free": "60/hour", "pro": "1000/hour", "business": "10000/hour"}


def key_for_request(request):
    return request.headers.get("X-API-Key") or get_remote_address(request)


limiter = Limiter(key_func=key_for_request)
```

---

## 6. Environment variables — the complete set

`.env.example` (commit this; never commit a filled-in `.env`):

```bash
# --- Core API (required; the service must refuse to start without them) ---
FAMILY_API_KEY=
JWT_SECRET=
API_KEY_TIERS={"":"free"}          # JSON {api_key: tier}. Replaces the demo keys.
ALLOW_DEMO_KEYS=false              # local development only
PUBLIC_ID_SALT=                    # salts hashed user IDs on the leaderboard

# --- Data ---
FAMILY_DATASET_URL=                # local path or https:// CSV
USE_BIGQUERY=false
BQ_TABLE=
MAX_RESULT_LIMIT=100
EMBEDDING_MODEL=all-MiniLM-L6-v2

# --- Frontend/CORS ---
ALLOWED_ORIGINS=https://scoutfoxtravel.com,https://www.scoutfoxtravel.com

# --- Persistence (Phase 1) ---
DATABASE_URL=

# --- Auth (optional) ---
FIREBASE_PROJECT_ID=
TOKEN_TTL_MINUTES=60

# --- Payments (Phase 2) ---
STRIPE_SECRET_KEY=
STRIPE_PRICE_ID=
STRIPE_WEBHOOK_SECRET=
SUCCESS_URL=https://scoutfoxtravel.com/welcome?session_id={CHECKOUT_SESSION_ID}
CANCEL_URL=https://scoutfoxtravel.com/pricing

# --- Affiliate (Phase 2) ---
AFFILIATE_BASE_URL=
AFFILIATE_REF=

# --- Content providers (Phase 1) ---
NPS_API_KEY=
GOOGLE_PLACES_API_KEY=
YELP_API_KEY=
OPENWEATHER_API_KEY=
EVENTBRITE_TOKEN=

# --- Bots ---
SLACK_BOT_TOKEN=
SLACK_APP_TOKEN=
DISCORD_BOT_TOKEN=

# --- AutomationBot prototype ---
OPENAI_API_KEY=
```

---

## 7. What I'd do Monday morning

| # | Action | Owner | Unblocks |
| --- | --- | --- | --- |
| 1 | Merge PR #38 and rotate the demo keys | Meghan + Arsalan | Everything — the repo currently ships working credentials |
| 2 | Decide the data source (my rec: NPS free tier first) | Meghan | All recommendation quality |
| 3 | Mount the points + payments routers, close the 5 duplicate PRs | Arsalan | Every button in the widgets |
| 4 | Open the Google Cloud account, deploy to Cloud Run | Arsalan | Bots, mobile, widgets, dashboard |
| 5 | Apply to an affiliate programme | Meghan | The revenue model |
| 6 | Replace the placeholder logo on the live homepage | Meghan | Credibility with beta testers |
| 7 | Triage the 6 outside-fork `vercel.json` PRs | Arsalan | Deploy safety |

**One-line summary:** we have more scaffolding than product. Three of our own endpoints are unreachable because a single `include_router()` call was never written, the recommendation engine has no data to recommend from, and the revenue path points at a domain that does not exist. None of these are hard problems — they are unfinished ones, and Phase 0 closes all three in about a week.
