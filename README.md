# Family Friendly Dataset / Scout Fox Go

Two things live in this repository:

| | What | Start here |
|---|---|---|
| **Scout platform** | Travel intelligence: SourceMesh ingestion, travel/user/topic graphs, truth layer, radar, sentinel, rewards, recommendation API | [`scout/README.md`](scout/README.md) |
| **Family Friendly bundle** | The original Python seed dataset, FastAPI service, bots and dashboard | this file, below |

```bash
# Scout platform (TypeScript, zero runtime dependencies)
npm install && npm run bootstrap && npm test
npm run scout:demo          # the nine-step proof scenario
npm run command-center      # operational status, derived from live state

# Family Friendly bundle (Python)
make seed && make test
```

Scout runs on real open data: 250 countries, ~46,500 cities and 28,291
airports across all 8 region flags, fetched from package registries and
ingested through SourceMesh. See [`scout/BLOCKED.md`](scout/BLOCKED.md) for
what is waiting on network egress or a commercial decision, and
[`data/upstream/PROVENANCE.md`](data/upstream/README.md) for licences and the
one derived field.

---

## Family Friendly Master Bundle

This master bundle includes:
- Seed data (activities, families, trips, feedback, points) + build tooling
- API (FastAPI + Docker + BigQuery + Firebase/Auth)
- Slack Bot (with NLU)
- Discord Bot (with NLU)
- Streamlit dashboard and React widgets

## 🚀 Quick Start

### 1. Build the seed data (do this first)

The API loads `data/processed/family_friendly_dataset.csv`, which is generated
from the JSON seeds in `data/seeds/`. Nothing else works until it exists.

```bash
make seed     # validate seeds, build the CSV/JSON, SQLite db and db/seed.sql
make test     # 21 checks over the seed data (standard library only)
```

No dependencies are required for this step. See [data/README.md](data/README.md)
for the full layout, the field reference and what is real vs. synthetic.

### API
```bash
cd api
pip install -r requirements.txt
export FAMILY_API_KEY="mysecretkey"
uvicorn server:app --host 0.0.0.0 --port 8000
```

Check it came up with the seed data loaded:

```bash
curl localhost:8000/health
# {"status":"ok","activities":120,"states":["AZ","CA","FL","GA","IL","NY","OH","TX"], ...}

curl -H "X-API-Key: mysecretkey" "localhost:8000/recommend?state=CA&indoor=indoor&limit=3"
```

| endpoint | auth | purpose |
|---|---|---|
| `GET /health` | none | liveness + dataset row count |
| `GET /states` | `X-API-Key` | states with seeded activities |
| `GET /recommend` | `X-API-Key` | filter by `state`, `indoor`, `limit` |
| `GET /activities/{id}` | `X-API-Key` | one activity by id |
| `GET /recommend_jwt`, `/recommend_firebase` | bearer token | same data, other auth |
| `/points/*` | tier key | balance, history, leaderboard, booking |
| `/payments/*` | none | Stripe checkout (mounted only if `stripe` imports) |

Demo API keys for the `/points/*` routes come from `data/seeds/users.json`:
`demo_free_key`, `demo_pro_key`, `demo_business_key` (plus a `_2` variant of
each). `FAMILY_API_KEY` is a separate single key guarding `/recommend`.

### Docker
```bash
# build from the repo root -- the image needs data/ in the context
docker build -f api/Dockerfile -t family-api .
docker run -p 8000:8000 -e FAMILY_API_KEY=mysecretkey family-api
```

### PostgreSQL
```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
```

### Dashboard
```bash
cd dashboard
pip install -r requirements.txt
export FAMILY_API_KEY="mysecretkey"
streamlit run app.py
```

### Slack Bot
```bash
cd bots
pip install spacy slack_bolt requests
python -m spacy download en_core_web_sm
export SLACK_BOT_TOKEN="xoxb-your-slack-token"
export SLACK_APP_TOKEN="xapp-your-slack-app-token"
export FAMILY_API_KEY="mysecretkey"
python slack_bot.py
```

### Discord Bot
```bash
cd bots
pip install spacy discord.py requests
python -m spacy download en_core_web_sm
export DISCORD_BOT_TOKEN="your-discord-token"
export FAMILY_API_KEY="mysecretkey"
python discord_bot.py
```

## Environment variables

| variable | default | used by |
|---|---|---|
| `FAMILY_API_KEY` | `supersecretkey` | API `/recommend`, bots, dashboard |
| `FAMILY_DATASET_URL` | `data/processed/family_friendly_dataset.csv` | API, semantic search |
| `FAMILY_SEED_DIR` | `data/seeds` | API users/points loading |
| `USE_BIGQUERY` / `BQ_TABLE` | `false` | API, to read activities from BigQuery |
| `JWT_SECRET` | `jwtsecret` | `/recommend_jwt` |
| `FIREBASE_PROJECT_ID` | unset | `/recommend_firebase` |
| `STRIPE_SECRET_KEY` / `STRIPE_PRICE_ID` | unset | `/payments/create-checkout-session` |

## Repository layout

```
data/       seed JSON + generated dataset      (see data/README.md)
scripts/    validate / build / load the seeds
db/         PostgreSQL + SQLite schemas, generated seed.sql
tests/      seed data test suite
api/        FastAPI service
bots/       Slack + Discord bots
dashboard/  Streamlit UI
widgets/    React components
docs/       static marketing site
```
