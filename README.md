# Scout Fox — Family Friendly Activities

A recommendation API for family-friendly activities, plus the clients that
consume it: a web explorer, React widgets, Slack and Discord bots, a Streamlit
dashboard, and an Expo mobile app.

## Quick start

```bash
# 1. Install
pip install -r api/requirements.txt

# 2. Build the dataset (no credentials needed -- uses the curated seed)
python scripts/build_dataset.py

# 3. Run the API
cd api
export FAMILY_API_KEY="pick-a-key"
export JWT_SECRET="pick-another"
uvicorn server:app --port 8000

# 4. Serve the web explorer, in a second terminal
python -m http.server 8080 --directory docs
# then set apiUrl/apiKey in docs/index.html and open http://localhost:8080
```

Check it works:

```bash
curl -H "X-API-Key: pick-a-key" "http://localhost:8000/recommend?state=CA&limit=3"
curl -H "X-API-Key: pick-a-key" "http://localhost:8000/meta"
```

## The data

The API reads `data/processed/family_friendly_dataset.csv`, which is **built,
not hand-edited**:

```bash
python scripts/build_dataset.py --list-sources    # what is available
python scripts/build_dataset.py                   # seed only, no keys
python scripts/build_dataset.py --source seed_curated,nps
python scripts/build_dataset.py --source nps --states CA,TX,FL
```

| Source | Credential | Notes |
| --- | --- | --- |
| `seed_curated` | none | 122 curated public attractions across 27 states. Ships in the repo |
| `nps` | `NPS_API_KEY` | National Park Service. Free key, issued instantly |
| `places` | `GOOGLE_PLACES_API_KEY` | Google Places. Billed per request — set a quota cap |

A source with no credential is skipped with a message rather than failing the
build. Schema and provider instructions: [`data/README.md`](data/README.md).

**Seed rows carry `verified=false`.** Names, states, and categories are
reliable; URLs and age bands have not been checked one by one, and the web
explorer says so on every unverified card.

## API

| Endpoint | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | none | Liveness. Answers without touching the dataset |
| `GET /recommend?state=&indoor=&limit=` | `X-API-Key` | Activities in a state |
| `GET /search?q=&limit=` | `X-API-Key` | Free-text search over names |
| `GET /meta` | `X-API-Key` | Row count, states, types — clients build filters from this |
| `GET /weather?place=` | `X-API-Key` | Live conditions plus an indoor/outdoor verdict. Needs `OPENWEATHER_API_KEY` |
| `GET /recommend_today?state=` | `X-API-Key` | Recommendations reordered by today's weather. Degrades to unfiltered when weather is unavailable |
| `GET /recommend_jwt` | Bearer JWT | Same as `/recommend`. **No `/token` endpoint issues these yet** |
| `GET /recommend_firebase` | Firebase ID token | Requires `FIREBASE_PROJECT_ID` |
| `/points/*` | `X-API-Key` | Balance, history, redeem, leaderboard, bookings |
| `/payments/*` | `X-API-Key` | Stripe checkout. Mounted only when `stripe` is installed |

Interactive docs at `/docs` when the server is running.

## Clients

Every client reads its API base URL from the environment — no more editing
seven files to deploy.

| Client | Configure with |
| --- | --- |
| Web explorer (`docs/`) | `window.SCOUTFOX_CONFIG` in `docs/index.html` |
| React widgets (`widgets/`) | `REACT_APP_SCOUTFOX_API_URL`, `REACT_APP_SCOUTFOX_API_KEY` |
| Mobile (`mobile/`) | `EXPO_PUBLIC_SCOUTFOX_API_URL`, `EXPO_PUBLIC_SCOUTFOX_API_KEY` |
| Dashboard (`dashboard/`) | `SCOUTFOX_API_URL` |
| Bots (`bots/`) | `SCOUTFOX_API_URL`, plus the platform tokens |

Keys sent from a browser or a mobile bundle are **public**. Use a free-tier,
rate-limited key for them — never the business tier.

## Bots

```bash
cd bots
pip install spacy slack_bolt discord.py requests
python -m spacy download en_core_web_sm

export SCOUTFOX_API_URL="https://your-api"
export FAMILY_API_KEY="..."
export SLACK_BOT_TOKEN="xoxb-..." SLACK_APP_TOKEN="xapp-..."
python slack_bot.py

export DISCORD_BOT_TOKEN="..."
python discord_bot.py
```

## Tests

```bash
pip install pytest fastapi httpx pandas python-jose
python -m pytest tests/ -q
```

## Configuration

Copy `.env.example` to `.env`. **Never commit `.env`** — this repository is
public, and git history keeps deleted secrets readable forever.

## Project documentation

| Document | Contents |
| --- | --- |
| [`docs/SCOUTFOX_API_INVENTORY.md`](docs/SCOUTFOX_API_INVENTORY.md) | Every API built, called, or planned, and the plan to finish them |
| [`docs/SYSTEMS_REGISTER.md`](docs/SYSTEMS_REGISTER.md) | Hosting, domains, deployments, access |
| [`docs/CREDENTIAL_REGISTER.md`](docs/CREDENTIAL_REGISTER.md) | Credential tracking (metadata only, never values) |
| [`docs/ADMIN_TASK_LIST.md`](docs/ADMIN_TASK_LIST.md) | Administrative work with named owners |
| [`data/README.md`](data/README.md) | Dataset schema and how to add a source |

## Known gaps

- `/recommend_jwt` advertises JWT auth but nothing issues a token.
- The points ledger is in-memory: balances reset on every restart.
- `book_activity` returns an affiliate link to a host that does not exist.
- No rate limiting, so tiers gate access but not volume.

These are tracked in the API inventory and admin task list above.
