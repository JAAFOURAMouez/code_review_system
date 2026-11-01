# Public deployment: the Horizon dashboard + the review agents in one container.
# Build:  docker build -t horizon-review .      Run:  docker run -p 8787:8787 horizon-review
# Any platform that builds a Dockerfile from git (Render, Koyeb, Fly.io, Railway, Cloud Run...) works.

# --- 1. build the front end ---
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json ./
RUN npm install --no-audit --no-fund
COPY frontend/ ./
# Leave empty: the page and the API are served from the same address.
ARG HORIZON_API_URL=""
ENV HORIZON_API_URL=$HORIZON_API_URL
RUN npm run build

# --- 2. the Python app ---
FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 \
    HORIZON_MODE=public PORT=8787 \
    HORIZON_MAX_CONCURRENT_RUNS=1 HORIZON_RUNS_PER_HOUR=8
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY orchestrator.py server.py horizon_adapter.py config.json ./
COPY agents/ agents/
COPY --from=web /web/dist frontend/dist
# Run as an unprivileged user; it only needs to write its own session data.
RUN useradd --create-home app && mkdir -p .horizon && chown -R app:app /app
USER app
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD python -c "import os,urllib.request as u; u.urlopen('http://127.0.0.1:%s/api/health' % os.environ.get('PORT','8787'))"
CMD ["python", "server.py"]
