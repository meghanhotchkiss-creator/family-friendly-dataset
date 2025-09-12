FROM python:3.10-slim

WORKDIR /app

COPY api/server.py /app/server.py
COPY api/requirements.txt /app/requirements.txt

RUN pip install --no-cache-dir -r requirements.txt

EXPOSE 8000

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
