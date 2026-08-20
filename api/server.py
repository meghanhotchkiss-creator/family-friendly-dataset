import hmac
import logging
import os
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from jose import JWTError, jwt

logger = logging.getLogger(__name__)

def _required_secret(name: str) -> str:
    """Read a secret from the environment, refusing to fall back to a default.

    A hard-coded fallback here is worse than a crash: the service would start
    and appear healthy while accepting a credential published in this
    repository. Failing at import makes a misconfigured deployment obvious.
    """
    value = os.getenv(name)
    if not value:
        raise RuntimeError(
            f"{name} is not set. Refusing to start with a default credential. "
            f"Set {name} to a secret value in the deployment environment."
        )
    return value


API_KEY = _required_secret("FAMILY_API_KEY")
api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

SECRET_KEY = _required_secret("JWT_SECRET")
ALGORITHM = "HS256"

FIREBASE_PROJECT_ID = os.getenv("FIREBASE_PROJECT_ID", None)

if FIREBASE_PROJECT_ID:
    import firebase_admin
    from firebase_admin import auth, credentials
    if not firebase_admin._apps:
        cred = credentials.ApplicationDefault()
        firebase_admin.initialize_app(cred, {"projectId": FIREBASE_PROJECT_ID})

DEFAULT_DATASET_PATH = Path(__file__).resolve().parents[1] / "data" / "processed" / "family_friendly_dataset.csv"
DATA_URL = os.getenv("FAMILY_DATASET_URL", str(DEFAULT_DATASET_PATH))
USE_BIGQUERY = os.getenv("USE_BIGQUERY", "false").lower() == "true"

# Written to the log, never to a response: it names internal paths.
BUILD_HINT = (
    "The dataset is generated from data/seeds/. Build it with: "
    "python scripts/build_dataset.py"
)

# Upper bound on rows a caller may request. Without it, ?limit=10000000
# turns into an unbounded (and, on BigQuery, billed) scan.
MAX_LIMIT = int(os.getenv("MAX_RESULT_LIMIT", "100"))

# Browsers block cross-origin reads unless the server opts in, so the widgets
# and the static explorer cannot call this API without it. Defaults to the
# closed case: no origins, i.e. same-origin only.
ALLOWED_ORIGINS = [o for o in os.getenv("CORS_ALLOW_ORIGINS", "").split(",") if o.strip()]

if USE_BIGQUERY:
    from google.cloud import bigquery
    BQ_TABLE = os.getenv("BQ_TABLE", "your_project.family_dataset.activities")
    bq_client = bigquery.Client()


@lru_cache(maxsize=1)
def load_dataset():
    """Load the activity dataset once and keep it in memory.

    Reading the CSV per request meant a disk read on every call, and a full
    network download per call when FAMILY_DATASET_URL is an http(s) URL.
    Call load_dataset.cache_clear() to pick up a rebuilt CSV without a restart.
    """
    try:
        return pd.read_csv(DATA_URL)
    except Exception as exc:
        # The path/URL is deployment configuration; echoing it to callers
        # discloses internal layout. Keep the detail server-side.
        logger.exception("Failed to load dataset from %s. %s", DATA_URL, BUILD_HINT)
        raise HTTPException(status_code=500, detail="Dataset is unavailable") from exc

def verify_api_key(api_key: str = Depends(api_key_header)):
    # compare_digest keeps the comparison constant-time; a plain != leaks how
    # much of the key matched through response timing. Both sides are encoded
    # first: compare_digest raises TypeError on non-ASCII str, which turned an
    # unauthenticated request into a 500.
    if not api_key or not hmac.compare_digest(api_key.encode("utf-8"), API_KEY.encode("utf-8")):
        raise HTTPException(status_code=401, detail="Invalid API Key")
    return True

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="token")

def verify_jwt(token: str = Depends(oauth2_scheme)):
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload
    except JWTError:
        raise HTTPException(status_code=403, detail="Invalid or expired token")

def verify_firebase_token(token: str = Depends(oauth2_scheme)):
    try:
        from firebase_admin import auth
        decoded = auth.verify_id_token(token)
        return decoded
    except Exception:
        raise HTTPException(status_code=403, detail="Invalid Firebase token")

app = FastAPI(title="Family Friendly Dataset API", version="4.0")

if ALLOWED_ORIGINS:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=ALLOWED_ORIGINS,
        allow_methods=["GET", "POST"],
        allow_headers=["X-API-Key", "Authorization", "Content-Type"],
    )

# The React widgets in widgets/ call /points/... and /payments/..., so both
# routers have to be mounted for the dashboard to work. Without this the
# endpoints exist in the source and 404 in production.
from points import router as points_router  # noqa: E402

app.include_router(points_router, prefix="/points", tags=["points"])

try:
    from payments import router as payments_router
except Exception:  # stripe not installed or not configured
    logger.warning("Payments router unavailable; /payments will not be served")
    payments_router = None
else:
    app.include_router(payments_router, prefix="/payments", tags=["payments"])

# Values accepted by the ?indoor= filter. An unrecognised value is a client
# error: returning an empty list for it is indistinguishable from "no matches",
# which hides typos.
VALID_SETTINGS = {"indoor", "outdoor"}

# Column holding the stable per-activity identifier. The curated dataset uses
# `id`; the synthetic seed uses `activity_id`. Whichever is present is used.
ID_COLUMNS = ("id", "activity_id")


def _records(df):
    """Serialise a frame to JSON-safe records.

    pandas represents a blank cell as NaN, and json.dumps rejects NaN as
    non-compliant, so any dataset with a missing value crashed the response
    with a 500. Missing values become null.
    """
    return df.astype(object).where(df.notna(), None).to_dict(orient="records")


def _validate_setting(indoor):
    if indoor and indoor.lower() not in VALID_SETTINGS:
        raise HTTPException(
            status_code=422,
            detail=f"indoor must be one of {sorted(VALID_SETTINGS)}",
        )


def _id_column(df):
    for column in ID_COLUMNS:
        if column in df.columns:
            return column
    raise HTTPException(status_code=500, detail="Dataset has no activity id column")


def get_data(state: str, indoor: str, limit: int):
    if USE_BIGQUERY:
        # Values are passed as query parameters, never interpolated into the
        # SQL text, so a caller cannot inject statements through ?state= or
        # ?indoor=. BQ_TABLE is operator-supplied configuration rather than
        # user input, and a table name cannot be parameterised, so it stays in
        # the string.
        query = f"SELECT * FROM `{BQ_TABLE}` WHERE LOWER(state) = LOWER(@state)"
        params = [bigquery.ScalarQueryParameter("state", "STRING", state)]

        if indoor:
            # LOWER on both sides so BigQuery matches the CSV path, which is
            # case-insensitive. Without it the same request returns different
            # results depending on the backend.
            query += " AND LOWER(indoor_or_outdoor) = LOWER(@indoor)"
            params.append(bigquery.ScalarQueryParameter("indoor", "STRING", indoor))

        query += " LIMIT @row_limit"
        params.append(bigquery.ScalarQueryParameter("row_limit", "INT64", limit))

        job_config = bigquery.QueryJobConfig(query_parameters=params)
        return bq_client.query(query, job_config=job_config).to_dataframe()
    else:
        df = load_dataset()
        df = df[df["state"].astype(str).str.lower() == state.lower()]
        if indoor:
            df = df[df["indoor_or_outdoor"].astype(str).str.lower() == indoor.lower()]
        return df

@app.get("/health")
def health():
    """Liveness, plus a check that the dataset is actually loadable."""
    if USE_BIGQUERY:
        return {"status": "ok", "source": "bigquery"}
    try:
        df = load_dataset()
    except HTTPException as exc:
        # Unauthenticated endpoint: report degraded without naming the path.
        return {"status": "degraded", "detail": exc.detail}
    return {"status": "ok", "activities": int(len(df))}

@app.get("/states")
def states(auth: bool = Depends(verify_api_key)):
    """States that have activities, with a count for each."""
    df = load_dataset()
    counts = df.groupby("state").size().sort_index()
    return [{"state": state, "activities": int(count)} for state, count in counts.items()]

@app.get("/activities/{activity_id}")
def activity(activity_id: str, auth: bool = Depends(verify_api_key)):
    """Look up a single activity by the id returned from /recommend."""
    df = load_dataset()
    match = df[df[_id_column(df)].astype(str) == activity_id]
    if match.empty:
        # The id came from the caller; echoing it back discloses nothing new.
        raise HTTPException(status_code=404, detail=f"No activity with id {activity_id!r}")
    return _records(match.head(1))[0]

@app.get("/recommend")
def recommend(state: str, indoor: str = None, limit: int = Query(10, ge=1, le=MAX_LIMIT), auth: bool = Depends(verify_api_key)):
    _validate_setting(indoor)
    df = get_data(state, indoor, limit)
    return _records(df.head(limit))

@app.get("/recommend_jwt")
def recommend_jwt(state: str, indoor: str = None, limit: int = Query(10, ge=1, le=MAX_LIMIT), user=Depends(verify_jwt)):
    _validate_setting(indoor)
    df = get_data(state, indoor, limit)
    return {"user": user, "results": _records(df.head(limit))}

@app.get("/recommend_firebase")
def recommend_firebase(state: str, indoor: str = None, limit: int = Query(10, ge=1, le=MAX_LIMIT), user=Depends(verify_firebase_token)):
    _validate_setting(indoor)
    df = get_data(state, indoor, limit)
    return {"firebase_user": user, "results": _records(df.head(limit))}
