# Build from the repository root so the seed data is in the context:
#   docker build -f api/Dockerfile -t family-api .
#   docker run -p 8000:8000 -e FAMILY_API_KEY=mysecretkey family-api
FROM python:3.11-slim

WORKDIR /app

COPY api/requirements.txt /app/api/requirements.txt
RUN pip install --no-cache-dir -r /app/api/requirements.txt

# The repo layout is preserved inside the image because the API resolves the
# dataset relative to its own file: api/server.py -> ../data/processed/.
COPY api/ /app/api/
COPY data/ /app/data/

WORKDIR /app/api

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD python -c "import urllib.request, sys; sys.exit(0 if urllib.request.urlopen('http://localhost:8000/health').status == 200 else 1)"

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
