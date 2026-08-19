import logging
import os
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from jose import JWTError, jwt

API_KEY = os.getenv("FAMILY_API_KEY", "supersecretkey")
logger = logging.getLogger(__name__)

api_key_header = APIKeyHeader(name="X-API-Key", auto_error=False)

SECRET_KEY = os.getenv("JWT_SECRET", "jwtsecret")
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

if USE_BIGQUERY:
    from google.cloud import bigquery
    BQ_TABLE = os.getenv("BQ_TABLE", "your_project.family_dataset.activities")
    bq_client = bigquery.Client()

def load_dataset():
    try:
        return pd.read_csv(DATA_URL)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to load dataset from {DATA_URL}") from exc

def verify_api_key(api_key: str = Depends(api_key_header)):
    if api_key != API_KEY:
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

# The points and payments routers existed since the first commit but were never
# mounted, so every path the web widgets call -- /points/* and /payments/* --
# returned 404 in production. The prefixes below are the ones those clients
# already use; changing them would break the widgets again.
from points import router as points_router  # noqa: E402

app.include_router(points_router, prefix="/points", tags=["points"])

# Payments are mounted only if the Stripe SDK is installed. payments.py imports
# stripe at module level, so an unguarded import would mean a deployment
# without Stripe cannot serve recommendations either -- one optional feature
# taking down the whole API. Recommendations must not depend on billing.
PAYMENTS_MOUNTED = False
try:
    from payments import router as payments_router  # noqa: E402

    app.include_router(payments_router, prefix="/payments", tags=["payments"])
    PAYMENTS_MOUNTED = True
except ImportError as exc:  # pragma: no cover - depends on the install
    logger.warning(
        "Payments routes are unavailable: %s. Install `stripe` to enable /payments/*.",
        exc,
    )

# The widgets are served from scoutfoxtravel.com and call this API
# cross-origin. Without CORS the browser blocks every call even though the
# routes now exist.
ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "https://scoutfoxtravel.com,https://www.scoutfoxtravel.com,http://localhost:3000,http://localhost:8000",
    ).split(",")
    if origin.strip()
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_methods=["GET", "POST"],
    allow_headers=["X-API-Key", "Content-Type", "Authorization"],
)


@app.get("/healthz", include_in_schema=False)
def healthz():
    """Liveness check that does not touch the dataset.

    Cloud Run needs a route that answers even when the dataset is missing,
    otherwise a data problem reads as a dead container and the revision is
    rolled back for the wrong reason.
    """
    return {"status": "ok"}


@app.get("/meta")
def meta(auth: bool = Depends(verify_api_key)):
    """What the dataset actually contains.

    The frontends were built with a hardcoded list of eight states. This lets
    them populate their filters from the data instead of guessing.
    """
    if USE_BIGQUERY:
        raise HTTPException(status_code=501, detail="/meta is not available in BigQuery mode")

    df = load_dataset()
    return {
        "rows": int(len(df)),
        "states": sorted(df["state"].dropna().unique().tolist()),
        "types": sorted(df["type"].dropna().unique().tolist()) if "type" in df else [],
        "indoor_or_outdoor": sorted(df["indoor_or_outdoor"].dropna().unique().tolist()),
        "sources": sorted(df["source"].dropna().unique().tolist()) if "source" in df else [],
        "verified": int((df["verified"].astype(str) == "true").sum()) if "verified" in df else 0,
    }


@app.get("/search")
def search(q: str, limit: int = Query(10, ge=1, le=50), auth: bool = Depends(verify_api_key)):
    """Free-text search over activity names.

    Uses the sentence-transformer index in ai_recommender when it is
    installed, and falls back to substring matching when it is not. The
    fallback matters: the semantic stack pulls ~2GB of wheels, and the API
    should still answer a search on a machine that does not have it.
    """
    try:
        from ai_recommender import semantic_search

        return {"query": q, "mode": "semantic", "results": semantic_search(q, top_k=limit)}
    except Exception:
        df = load_dataset()
        needle = q.strip().lower()
        haystack = df["name"].fillna("").str.lower()
        matches = df[haystack.str.contains(needle, regex=False)]
        if "city" in df.columns and matches.empty:
            matches = df[df["city"].fillna("").str.lower().str.contains(needle, regex=False)]
        return {
            "query": q,
            "mode": "substring",
            "results": matches.head(limit).to_dict(orient="records"),
        }


def get_data(state: str, indoor: str, limit: int):
    if USE_BIGQUERY:
        query = f"""
        SELECT *
        FROM `{BQ_TABLE}`
        WHERE LOWER(state) = LOWER('{state}')
        {"AND indoor_or_outdoor = '" + indoor + "'" if indoor else ""}
        LIMIT {limit}
        """
        return bq_client.query(query).to_dataframe()
    else:
        df = load_dataset()
        df = df[df["state"].str.lower() == state.lower()]
        if indoor:
            df = df[df["indoor_or_outdoor"] == indoor]
        return df

@app.get("/recommend")
def recommend(state: str, indoor: str = None, limit: int = 10, auth: bool = Depends(verify_api_key)):
    df = get_data(state, indoor, limit)
    return df.head(limit).to_dict(orient="records")

@app.get("/recommend_jwt")
def recommend_jwt(state: str, indoor: str = None, limit: int = 10, user=Depends(verify_jwt)):
    df = get_data(state, indoor, limit)
    return {"user": user, "results": df.head(limit).to_dict(orient="records")}

@app.get("/recommend_firebase")
def recommend_firebase(state: str, indoor: str = None, limit: int = 10, user=Depends(verify_firebase_token)):
    df = get_data(state, indoor, limit)
    return {"firebase_user": user, "results": df.head(limit).to_dict(orient="records")}
