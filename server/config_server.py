"""Interview Coach — Config & Session API Server

Endpoints:
  GET  /health                  — liveness probe
  GET  /api/interview-config    — retrieve current config
  POST /api/interview-config    — save new config
  POST /api/session-transcript  — persist a session transcript (optional)
  GET  /api/session-transcript  — retrieve last saved transcript

Port defaults to 7861 (override via CONFIG_SERVER_PORT env var).
"""

import asyncio
import json
import os
from datetime import datetime, timezone
from typing import Optional

from aiohttp import web
from loguru import logger

from bot import DEFAULT_CONFIG, VALID_DIFFICULTIES, VALID_NATURES, VALID_TYPES
from bot import load_interview_config as _load_config
from bot import save_interview_config as _save_config

CONFIG_SERVER_PORT = int(os.getenv("CONFIG_SERVER_PORT", "7861"))

# In-memory cache for latest session transcript
_last_transcript: dict = {}


# ──────────────────────────────────────────────
# CORS middleware
# ──────────────────────────────────────────────
@web.middleware
async def cors_middleware(request: web.Request, handler):
    # Pre-flight
    if request.method == "OPTIONS":
        response = web.Response()
    else:
        response = await handler(request)

    allowed_origins_str = os.getenv("ALLOWED_ORIGINS", "*")
    origin = request.headers.get("Origin", "")

    if allowed_origins_str == "*":
        response.headers["Access-Control-Allow-Origin"] = "*"
    else:
        allowed = [o.strip() for o in allowed_origins_str.split(",")]
        response.headers["Access-Control-Allow-Origin"] = origin if origin in allowed else allowed[0]

    response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization"
    return response


# ──────────────────────────────────────────────
# Handlers
# ──────────────────────────────────────────────
async def handle_health(request: web.Request) -> web.Response:
    return web.json_response(
        {
            "status": "ok",
            "service": "interview-coach-config",
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
    )


async def handle_get_config(request: web.Request) -> web.Response:
    """Return the currently active interview configuration."""
    try:
        config = _load_config()
        # Redact JD if it's very long (>200 chars) for quick reads
        display_jd = config.get("jd", "")
        if len(display_jd) > 200:
            display_jd = display_jd[:200] + "... [truncated for display]"
        config["jdPreview"] = display_jd
        return web.json_response(config)
    except Exception as e:
        logger.error(f"GET /api/interview-config error: {e}")
        return web.json_response({"error": str(e)}, status=500)


async def handle_post_config(request: web.Request) -> web.Response:
    """Save a new interview configuration."""
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    bot_nature = data.get("botNature", "decent")
    jd = data.get("jd", "").strip()
    interview_type = data.get("interviewType", "mixed")
    difficulty = data.get("difficulty", "mid")
    max_questions = data.get("maxQuestions", 8)
    focus_areas = data.get("focusAreas", [])
    company_name = data.get("companyName", "").strip()
    role_name = data.get("roleName", "").strip()

    # Validation
    errors = []
    if bot_nature not in VALID_NATURES:
        errors.append(f"botNature must be one of: {', '.join(VALID_NATURES)}")
    if interview_type not in VALID_TYPES:
        errors.append(f"interviewType must be one of: {', '.join(VALID_TYPES)}")
    if difficulty not in VALID_DIFFICULTIES:
        errors.append(f"difficulty must be one of: {', '.join(VALID_DIFFICULTIES)}")
    if not jd:
        errors.append("jd (job description) is required and cannot be empty")
    elif len(jd) < 30:
        errors.append("jd must be at least 30 characters")
    try:
        max_questions = int(max_questions)
        if not (3 <= max_questions <= 20):
            errors.append("maxQuestions must be between 3 and 20")
    except (ValueError, TypeError):
        errors.append("maxQuestions must be an integer")
    if not isinstance(focus_areas, list):
        errors.append("focusAreas must be an array")

    if errors:
        return web.json_response({"errors": errors}, status=400)

    success = _save_config(
        bot_nature=bot_nature,
        jd=jd,
        interview_type=interview_type,
        difficulty=difficulty,
        max_questions=max_questions,
        focus_areas=focus_areas,
        company_name=company_name,
        role_name=role_name,
    )

    if success:
        return web.json_response(
            {
                "success": True,
                "message": "Configuration saved",
                "botNature": bot_nature,
                "interviewType": interview_type,
                "difficulty": difficulty,
                "maxQuestions": max_questions,
                "jdLength": len(jd),
            }
        )
    return web.json_response({"error": "Failed to write config file"}, status=500)


async def handle_post_transcript(request: web.Request) -> web.Response:
    """Accept and store a session transcript from the client."""
    global _last_transcript
    try:
        data = await request.json()
    except json.JSONDecodeError:
        return web.json_response({"error": "Invalid JSON"}, status=400)

    messages = data.get("messages", [])
    if not isinstance(messages, list):
        return web.json_response({"error": "messages must be an array"}, status=400)

    _last_transcript = {
        "savedAt": datetime.now(timezone.utc).isoformat(),
        "durationSeconds": data.get("durationSeconds", 0),
        "config": data.get("config", {}),
        "messages": messages,
    }

    # Optionally persist to disk
    try:
        transcript_path = os.path.join(os.path.dirname(__file__), "last_session_transcript.json")
        with open(transcript_path, "w", encoding="utf-8") as f:
            json.dump(_last_transcript, f, indent=2, ensure_ascii=False)
        logger.info(f"Transcript saved: {len(messages)} messages")
    except Exception as e:
        logger.warning(f"Could not persist transcript to disk: {e}")

    return web.json_response({"success": True, "messageCount": len(messages)})


async def handle_get_transcript(request: web.Request) -> web.Response:
    """Return the most recently saved session transcript."""
    if _last_transcript:
        return web.json_response(_last_transcript)

    # Try loading from disk
    transcript_path = os.path.join(os.path.dirname(__file__), "last_session_transcript.json")
    if os.path.exists(transcript_path):
        try:
            with open(transcript_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return web.json_response(data)
        except Exception as e:
            logger.error(f"Error reading transcript file: {e}")

    return web.json_response({"error": "No transcript available"}, status=404)


# ──────────────────────────────────────────────
# App factory
# ──────────────────────────────────────────────
def create_app() -> web.Application:
    app = web.Application(middlewares=[cors_middleware])
    app.router.add_get("/health", handle_health)
    app.router.add_get("/api/interview-config", handle_get_config)
    app.router.add_post("/api/interview-config", handle_post_config)
    app.router.add_post("/api/session-transcript", handle_post_transcript)
    app.router.add_get("/api/session-transcript", handle_get_transcript)
    return app


async def run_config_server(port: Optional[int] = None) -> None:
    if port is None:
        port = CONFIG_SERVER_PORT

    app = create_app()
    runner = web.AppRunner(app)
    await runner.setup()

    host = os.getenv("CONFIG_SERVER_HOST", "0.0.0.0")
    site = web.TCPSite(runner, host, port)
    await site.start()

    logger.info(f"Config server: http://{host}:{port}")
    logger.info(f"  GET  /health")
    logger.info(f"  GET  /api/interview-config")
    logger.info(f"  POST /api/interview-config")
    logger.info(f"  POST /api/session-transcript")
    logger.info(f"  GET  /api/session-transcript")

    try:
        await asyncio.Event().wait()
    except KeyboardInterrupt:
        logger.info("Config server shutting down")
    finally:
        await runner.cleanup()


if __name__ == "__main__":
    asyncio.run(run_config_server())
