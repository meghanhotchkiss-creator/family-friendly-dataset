import os
from functools import lru_cache
from pathlib import Path

import pandas as pd
from fastapi import FastAPI, Depends, HTTPException
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from jose import JWTError, jwt

API_KEY = os.getenv("FAMILY_API_KEY", "supersecretkey")
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

BUILD_HINT = (
    "The dataset is generated from data/seeds/. Build it with: "
    "python scripts/build_dataset.py"
)

if USE_BIGQUERY:
    from google.cloud import bigquery
    BQ_TABLE = os.getenv("BQ_TABLE", "your_project.family_dataset.activities")
    bq_client = bigquery.Client()


@lru_cache(maxsize=1)
def load_dataset():
    """Load the activity dataset once and keep it in memory.

    Call load_dataset.cache_clear() to pick up a rebuilt CSV without a restart.
    """
    try:
        return pd.read_csv(DATA_URL)
    except FileNotFoundError as exc:
        raise HTTPException(
            status_code=500,
            detail=f"Dataset not found at {DATA_URL}. {BUILD_HINT}",
        ) from exc
    except Exception as exc:
        raise HTTPException(
            status_code=500, detail=f"Failed to load dataset from {DATA_URL}"
        ) from exc

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

# The React widgets in widgets/ call /points/... and /payments/..., so both
# routers have to be mounted for the dashboard to work.
from points import router as points_router  # noqa: E402

app.include_router(points_router, prefix="/points", tags=["points"])

try:
    from payments import router as payments_router
except Exception:  # stripe not installed or not configured
    payments_router = None
else:
    app.include_router(payments_router, prefix="/payments", tags=["payments"])

def get_data(state: str, indoor: str, limit: int):
    if USE_BIGQUERY:
        query = f"""
        SELECT *
        FROM `{BQ_TABLE}`
        WHERE LOWER(state) = LOWER(@state)
        {"AND indoor_or_outdoor = @indoor" if indoor else ""}
        LIMIT @limit
        """
        parameters = [
            bigquery.ScalarQueryParameter("state", "STRING", state),
            bigquery.ScalarQueryParameter("limit", "INT64", limit),
        ]
        if indoor:
            parameters.append(bigquery.ScalarQueryParameter("indoor", "STRING", indoor))
        job_config = bigquery.QueryJobConfig(query_parameters=parameters)
        return bq_client.query(query, job_config=job_config).to_dataframe()
    else:
        df = load_dataset()
        df = df[df["state"].str.lower() == state.lower()]
        if indoor:
            df = df[df["indoor_or_outdoor"] == indoor]
        return df

@app.get("/health")
def health():
    """Liveness plus a quick check that the seeded dataset is actually loadable."""
    if USE_BIGQUERY:
        return {"status": "ok", "source": "bigquery", "table": BQ_TABLE}
    try:
        df = load_dataset()
    except HTTPException as exc:
        return {"status": "degraded", "source": DATA_URL, "detail": exc.detail}
    return {
        "status": "ok",
        "source": DATA_URL,
        "activities": int(len(df)),
        "states": sorted(df["state"].dropna().unique().tolist()),
    }

@app.get("/states")
def states(auth: bool = Depends(verify_api_key)):
    """States that have seeded activities, with a count for each."""
    df = load_dataset()
    counts = df.groupby("state").size().sort_index()
    return [{"state": state, "activities": int(count)} for state, count in counts.items()]

@app.get("/activities/{activity_id}")
def activity(activity_id: str, auth: bool = Depends(verify_api_key)):
    """Look up a single activity by the id returned from /recommend."""
    df = load_dataset()
    match = df[df["id"] == activity_id]
    if match.empty:
        raise HTTPException(status_code=404, detail=f"No activity with id {activity_id!r}")
    return match.iloc[0].to_dict()

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
