# ── Build stage ───────────────────────────────────────────────
FROM python:3.12-slim AS builder

RUN pip install uv

WORKDIR /build
COPY pyproject.toml uv.lock ./
# Install dependencies into a virtual env
RUN uv venv /build/.venv && uv sync --frozen --no-dev

# ── Runtime stage ─────────────────────────────────────────────
FROM python:3.12-slim

# Runtime dependencies for audio processing
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgomp1 \
    ffmpeg \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy virtual env from builder
COPY --from=builder /build/.venv /app/.venv

# Copy source
COPY . .

# Make venv executables available
ENV PATH="/app/.venv/bin:$PATH"
ENV PYTHONUNBUFFERED=1

# Ports: 7860 = Pipecat bot, 7861 = Config API
EXPOSE 7860 7861

# Default: run the interview coach bot (also spawns config server)
CMD ["python", "bot.py"]
