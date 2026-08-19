FROM python:3.11-slim

WORKDIR /app

# Build from the repository root:
#   docker build -f api/Dockerfile -t scoutfox-api .
# The previous version copied only api/server.py, so the container was missing
# points.py, payments.py, the providers package, and the dataset itself. It
# started and then failed on the first request.

COPY api/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY api/ /app/

# The dataset is baked into the image so the container has no runtime
# dependency on object storage. Rebuild the image to ship new data, or point
# FAMILY_DATASET_URL at a hosted CSV to swap it without a rebuild.
COPY data/processed/family_friendly_dataset.csv /app/data/processed/
ENV FAMILY_DATASET_URL=/app/data/processed/family_friendly_dataset.csv

# Cloud Run supplies PORT; default to 8000 for local runs.
ENV PORT=8000
EXPOSE 8000

# FAMILY_API_KEY and JWT_SECRET are deliberately not defaulted here. A default
# would let a misconfigured deployment start and look healthy while accepting
# a credential published in this repository.
CMD ["sh", "-c", "uvicorn server:app --host 0.0.0.0 --port ${PORT}"]
