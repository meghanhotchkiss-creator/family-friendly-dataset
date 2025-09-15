from fastapi import FastAPI, Depends, HTTPException
from fastapi.security import APIKeyHeader, OAuth2PasswordBearer
from jose import JWTError, jwt
import pandas as pd
import os
from pathlib import Path

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

def _resolve_data_source() -> str:
    configured_source = os.getenv("FAMILY_DATA_SOURCE") or os.getenv("FAMILY_DATA_URL")
    if configured_source:
        return configured_source

    default_path = Path(__file__).resolve().parents[1] / "data/processed/family_friendly_dataset.csv"
    return str(default_path)


DATA_SOURCE = _resolve_data_source()
USE_BIGQUERY = os.getenv("USE_BIGQUERY", "false").lower() == "true"

if USE_BIGQUERY:
    from google.cloud import bigquery
    BQ_TABLE = os.getenv("BQ_TABLE", "your_project.family_dataset.activities")
    bq_client = bigquery.Client()

def load_dataset():
    return pd.read_csv(DATA_SOURCE)

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
