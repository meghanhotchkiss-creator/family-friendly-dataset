import hmac
import logging
import os

from fastapi import FastAPI, Depends, HTTPException, Query
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from jose import JWTError, jwt

from dataset import DatasetUnavailable, dataset_source, read_dataset

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

# Where the CSV lives is resolved per request by dataset.dataset_source():
# FAMILY_DATASET_URL when set, otherwise a path inside the checkout. Reading it
# per request rather than at import keeps the environment authoritative for
# workers forked or configured after this module is imported, and means a
# redeployment that only moves the data does not need a code change here.
USE_BIGQUERY = os.getenv("USE_BIGQUERY", "false").lower() == "true"

# Upper bound on rows a caller may request. Without it, ?limit=10000000
# turns into an unbounded (and, on BigQuery, billed) scan.
MAX_LIMIT = int(os.getenv("MAX_RESULT_LIMIT", "100"))

if USE_BIGQUERY:
    from google.cloud import bigquery
    BQ_TABLE = os.getenv("BQ_TABLE", "your_project.family_dataset.activities")
    bq_client = bigquery.Client()

def load_dataset():
    source = dataset_source()
    try:
        return read_dataset(source)
    except DatasetUnavailable as exc:
        # The path/URL is deployment configuration; echoing it to callers
        # discloses internal layout. Keep the detail server-side.
        logger.exception("Failed to load dataset from %s", source)
        raise HTTPException(status_code=500, detail="Dataset is unavailable") from exc

def verify_api_key(api_key: str = Depends(api_key_header)):
    # compare_digest keeps the comparison constant-time; a plain != leaks how
    # much of the key matched through response timing.
    if not api_key or not hmac.compare_digest(api_key, API_KEY):
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

# Values accepted by the ?indoor= filter. An unrecognised value is a client
# error: returning an empty list for it is indistinguishable from "no matches",
# which hides typos.
VALID_SETTINGS = {"indoor", "outdoor"}


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
            query += " AND indoor_or_outdoor = @indoor"
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
