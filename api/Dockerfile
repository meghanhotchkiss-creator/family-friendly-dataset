FROM python:3.10-slim

WORKDIR /app

# The whole api/ directory, not just server.py: the server imports dataset.py
# for dataset resolution, and copying a single file leaves the image with an
# ImportError that only surfaces at container start.
COPY api/ /app/

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8000

# No dataset is baked into the image. Set FAMILY_DATASET_URL to a path mounted
# into the container or an http(s) URL, or set USE_BIGQUERY=true with BQ_TABLE.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
