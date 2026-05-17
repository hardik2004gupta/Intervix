#
# Copyright (c) 2024–2025, Daily
# Enhanced: AI Interview Coach
#
# SPDX-License-Identifier: BSD 2-Clause License
#
"""Pipecat AI Interview Coach — Enhanced Voice Agent

Pipeline: Deepgram STT → Groq LLM → ElevenLabs TTS
Extras  : Silero VAD, SmartTurn, animated robot avatar, configurable interview modes

Run:
    uv run bot.py
"""

import json
import os

from dotenv import load_dotenv
from loguru import logger
from PIL import Image

from pipecat.audio.vad.vad_analyzer import VADParams

# onnxruntime (needed by Silero VAD and SmartTurn) only supports Python <=3.13.
# Import conditionally so the bot still starts on Python 3.14 using basic WebRTC VAD.
try:
    from pipecat.audio.vad.silero import SileroVADAnalyzer
    from pipecat.audio.turn.smart_turn.local_smart_turn_v3 import LocalSmartTurnAnalyzerV3
    SILERO_AVAILABLE = True
except Exception:
    from pipecat.audio.vad.vad_analyzer import VADAnalyzer as SileroVADAnalyzer  # type: ignore[assignment]
    LocalSmartTurnAnalyzerV3 = None  # type: ignore[assignment,misc]
    SILERO_AVAILABLE = False
    import sys as _sys
    print(
        f"[WARNING] onnxruntime unavailable on Python {_sys.version.split()[0]}. "
        "Silero VAD + SmartTurn disabled. Use Python 3.12 or 3.13 for full support.",
        flush=True,
    )
from pipecat.frames.frames import (
    BotStartedSpeakingFrame,
    BotStoppedSpeakingFrame,
    Frame,
    LLMRunFrame,
    OutputImageRawFrame,
    SpriteFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.runner import PipelineRunner
from pipecat.pipeline.task import PipelineParams, PipelineTask
from pipecat.processors.aggregators.openai_llm_context import OpenAILLMContext
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor
from pipecat.processors.frameworks.rtvi import RTVIObserver, RTVIProcessor
from pipecat.runner.types import RunnerArguments, SmallWebRTCRunnerArguments
from pipecat.services.deepgram.stt import DeepgramSTTService
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService
from pipecat.services.groq.llm import GroqLLMService
from pipecat.transports.base_transport import BaseTransport, TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport

# daily-python has no Windows wheel.
# Pipecat raises a plain Exception (not ImportError) when the 'daily' C module
# is missing, so we catch the base Exception class here.
try:
    from pipecat.runner.types import DailyRunnerArguments
    from pipecat.transports.daily.transport import DailyParams, DailyTransport
    DAILY_AVAILABLE = True
except Exception:  # bare Exception — pipecat raises Exception, not ImportError
    DAILY_AVAILABLE = False
    DailyRunnerArguments = None  # type: ignore[assignment,misc]
    DailyParams = None           # type: ignore[assignment,misc]
    DailyTransport = None        # type: ignore[assignment,misc]
    logger.warning(
        "Daily transport unavailable (daily-python has no Windows wheel). "
        "Using SmallWebRTC instead — no action needed."
    )

# ── Load .env with an explicit path so Windows never misses it ──────────────
_env_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
if os.path.exists(_env_path):
    load_dotenv(dotenv_path=_env_path, override=True, encoding="utf-8-sig")
    logger.info(f".env loaded from: {_env_path}")
else:
    logger.warning(
        f".env file NOT found at: {_env_path}\n"
        "Create it by copying server/.env.example and filling in your API keys."
    )

# ──────────────────────────────────────────────
# Avatar sprite loading (graceful — audio-only if assets/ missing)
# ──────────────────────────────────────────────
sprites: list = []
script_dir = os.path.dirname(__file__)
_assets_dir = os.path.join(script_dir, "assets")

if os.path.isdir(_assets_dir):
    for i in range(1, 26):
        full_path = os.path.join(_assets_dir, f"robot0{i}.png")
        if os.path.exists(full_path):
            with Image.open(full_path) as img:
                sprites.append(
                    OutputImageRawFrame(image=img.tobytes(), size=img.size, format=img.format)
                )
    if sprites:
        sprites.extend(sprites[::-1])   # ping-pong animation
        logger.info(f"Loaded {len(sprites)//2} avatar sprite frames")
    else:
        logger.warning("assets/ folder found but contained no robot*.png files")
else:
    logger.warning(
        "assets/ folder not found — avatar video disabled, audio-only mode active. "
        "Copy the 'assets' folder from the original project zip to enable the robot avatar."
    )

# Fall back to None when assets are missing; TalkingAnimation checks before pushing frames.
quiet_frame = sprites[0] if sprites else None
talking_frame = SpriteFrame(images=sprites) if sprites else None


class TalkingAnimation(FrameProcessor):
    """Switches robot avatar between idle and talking animation states.
    
    When sprites are unavailable (assets/ folder missing) it passes frames
    through unchanged so the pipeline still functions in audio-only mode.
    """

    def __init__(self):
        super().__init__()
        self._is_talking = False

    async def process_frame(self, frame: Frame, direction: FrameDirection):
        await super().process_frame(frame, direction)
        if sprites:  # only animate when frames are loaded
            if isinstance(frame, BotStartedSpeakingFrame):
                if not self._is_talking:
                    await self.push_frame(talking_frame)
                    self._is_talking = True
            elif isinstance(frame, BotStoppedSpeakingFrame):
                await self.push_frame(quiet_frame)
                self._is_talking = False
        await self.push_frame(frame, direction)


# ──────────────────────────────────────────────
# Config management
# ──────────────────────────────────────────────
DEFAULT_CONFIG: dict = {
    "botNature": "decent",
    "jd": "",
    "interviewType": "mixed",
    "difficulty": "mid",
    "maxQuestions": 8,
    "focusAreas": [],
    "companyName": "",
    "roleName": "",
}

VALID_NATURES = ["friendly", "decent", "strict"]
VALID_TYPES = ["technical", "behavioral", "mixed"]
VALID_DIFFICULTIES = ["junior", "mid", "senior"]


def get_config_file_path() -> str:
    return os.path.join(os.path.dirname(__file__), "interview_config.json")


def load_interview_config() -> dict:
    config_file = get_config_file_path()
    try:
        if os.path.exists(config_file):
            with open(config_file, "r", encoding="utf-8") as f:
                raw = json.load(f)
            merged = {**DEFAULT_CONFIG, **raw}
            if merged["botNature"] not in VALID_NATURES:
                merged["botNature"] = "decent"
            if merged["interviewType"] not in VALID_TYPES:
                merged["interviewType"] = "mixed"
            if merged["difficulty"] not in VALID_DIFFICULTIES:
                merged["difficulty"] = "mid"
            merged["maxQuestions"] = max(3, min(20, int(merged.get("maxQuestions", 8))))
            if not isinstance(merged.get("focusAreas"), list):
                merged["focusAreas"] = []
            logger.info(
                f"Config — nature={merged['botNature']}, type={merged['interviewType']}, "
                f"diff={merged['difficulty']}, maxQ={merged['maxQuestions']}"
            )
            return merged
        logger.info("Config file not found, using defaults")
        return DEFAULT_CONFIG.copy()
    except Exception as e:
        logger.error(f"Error loading config: {e}")
        return DEFAULT_CONFIG.copy()


def save_interview_config(
    bot_nature: str,
    jd: str,
    interview_type: str = "mixed",
    difficulty: str = "mid",
    max_questions: int = 8,
    focus_areas=None,
    company_name: str = "",
    role_name: str = "",
) -> bool:
    if bot_nature not in VALID_NATURES:
        bot_nature = "decent"
    if interview_type not in VALID_TYPES:
        interview_type = "mixed"
    if difficulty not in VALID_DIFFICULTIES:
        difficulty = "mid"
    max_questions = max(3, min(20, int(max_questions)))

    config = {
        "botNature": bot_nature,
        "jd": jd,
        "interviewType": interview_type,
        "difficulty": difficulty,
        "maxQuestions": max_questions,
        "focusAreas": focus_areas or [],
        "companyName": company_name,
        "roleName": role_name,
    }
    try:
        with open(get_config_file_path(), "w", encoding="utf-8") as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        logger.info("Config saved successfully")
        return True
    except Exception as e:
        logger.error(f"Error saving config: {e}")
        return False


# ──────────────────────────────────────────────
# Prompt builder
# ──────────────────────────────────────────────
def build_system_prompt(config: dict) -> str:
    bot_nature = config.get("botNature", "decent")
    jd = config.get("jd", "")
    interview_type = config.get("interviewType", "mixed")
    difficulty = config.get("difficulty", "mid")
    max_questions = int(config.get("maxQuestions", 8))
    focus_areas = config.get("focusAreas", [])
    company_name = config.get("companyName", "").strip()
    role_name = config.get("roleName", "").strip()

    MAX_JD = 1500
    if len(jd) > MAX_JD:
        jd = jd[:MAX_JD] + "... [truncated]"
        logger.warning(f"JD truncated to {MAX_JD} chars")

    nature_map = {
        "friendly": {
            "tone": "warm, encouraging, and supportive",
            "approach": (
                "Be conversational and empathetic. Acknowledge good answers briefly before continuing."
            ),
            "pressure": "Light — help the candidate feel comfortable.",
        },
        "decent": {
            "tone": "professional, balanced, and respectful",
            "approach": (
                "Maintain a professional, engaging tone. Be fair and thorough. Neutral acknowledgements only."
            ),
            "pressure": "Moderate — expect solid answers but allow the candidate to develop thoughts.",
        },
        "strict": {
            "tone": "formal, direct, and demanding",
            "approach": (
                "Be rigorous. Push for specifics. If an answer is vague, ask a targeted follow-up immediately."
            ),
            "pressure": "High — challenge incomplete answers and hold the candidate to a high standard.",
        },
    }

    difficulty_map = {
        "junior": (
            "Entry-level candidate. Focus on fundamentals, core concepts, and learning potential. "
            "Avoid advanced system-design or niche topics."
        ),
        "mid": (
            "Mid-level candidate (2-5 years). Expect practical, hands-on knowledge. "
            "Ask about real-world trade-offs, debugging, and past project outcomes."
        ),
        "senior": (
            "Senior/lead candidate (5+ years). Expect deep expertise, architectural thinking, "
            "cross-team collaboration, and leadership through ambiguity."
        ),
    }

    half = max_questions // 2
    remainder = max_questions - half
    type_map = {
        "technical": (
            f"Ask ONLY technical questions: algorithms, system design, debugging, tools, code quality. "
            f"Target ~{max_questions} questions."
        ),
        "behavioral": (
            f"Ask ONLY behavioral questions (STAR method): past situations, teamwork, conflict, leadership. "
            f"Target ~{max_questions} questions."
        ),
        "mixed": (
            f"Balance technical ({half}) and behavioral ({remainder}) questions, totalling ~{max_questions}. "
            "Start with 1-2 behavioral warm-ups, then alternate."
        ),
    }

    traits = nature_map.get(bot_nature, nature_map["decent"])
    company_str = f" at {company_name}" if company_name else ""
    role_str = f" for the {role_name} role{company_str}" if role_name else company_str

    prompt = f"""You are Alex, an AI technical interviewer{role_str}.

PERSONALITY
Tone: {traits['tone']}
Approach: {traits['approach']}
Pressure: {traits['pressure']}

SENIORITY TARGET
{difficulty_map.get(difficulty, difficulty_map['mid'])}

INTERVIEW TYPE
{type_map.get(interview_type, type_map['mixed'])}
"""

    if focus_areas:
        prompt += f"\nFOCUS AREAS: Prioritise questions around: {', '.join(focus_areas)}\n"

    if jd:
        prompt += f"""
JOB DESCRIPTION
{jd}

Use the JD to tailor questions. Assess how well the candidate's background aligns with the stated requirements.
"""

    prompt += f"""
INTERVIEW STRUCTURE
Phase 1 - Introduction (1-2 exchanges):
  Greet the candidate. Introduce yourself as Alex. Ask them to briefly introduce themselves.

Phase 2 - Core Questions (~{max_questions} questions):
  Ask one question at a time. Wait for the full answer. Follow up if the answer is vague before moving on.

Phase 3 - Wrap-Up (final 1-2 exchanges):
  Ask if the candidate has any questions. Thank them by name and close the interview professionally.

HARD RULES — never break these:
- Output is converted to speech. NEVER use markdown, bullet points, code blocks, or special characters.
- Ask exactly ONE question per turn. Never stack multiple questions.
- Do not reveal scoring or internal evaluation during the interview.
- If the candidate goes off-topic, redirect politely but firmly.
- Keep each response under 60 words unless context is essential.

Begin now with Phase 1.
"""
    return prompt


# ──────────────────────────────────────────────
# Bot runner
# ──────────────────────────────────────────────
async def run_bot(transport: BaseTransport):
    config = load_interview_config()

    logger.info(
        f"Starting bot — nature={config['botNature']}, type={config['interviewType']}, "
        f"difficulty={config['difficulty']}, maxQ={config['maxQuestions']}"
    )

    # ── Validate API keys before trying to use them ─────────────────────────
    _missing = []
    _deepgram_key    = os.getenv("DEEPGRAM_API_KEY", "").strip()
    _groq_key        = os.getenv("GROQ_API_KEY", "").strip()
    _elevenlabs_key  = os.getenv("ELEVENLABS_API_KEY", "").strip()

    if not _deepgram_key:
        _missing.append("DEEPGRAM_API_KEY")
    if not _groq_key:
        _missing.append("GROQ_API_KEY")
    if not _elevenlabs_key:
        _missing.append("ELEVENLABS_API_KEY")

    if _missing:
        _env_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
        raise RuntimeError(
            f"Missing API keys: {', '.join(_missing)}\n"
            f"  → Open {_env_file}\n"
            "  → Make sure each key has a real value (not a placeholder)\n"
            "  → Save the file and restart the server"
        )

    logger.info("API keys loaded ✓ (Deepgram, Groq, ElevenLabs)")

    stt = DeepgramSTTService(api_key=_deepgram_key)

    tts = ElevenLabsTTSService(
        api_key=_elevenlabs_key,
        voice_id=os.getenv("ELEVENLABS_VOICE_ID", "pNInz6obpgDQGcFmaJgB").strip(),
    )

    llm = GroqLLMService(
        api_key=_groq_key,
        model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile").strip(),
    )

    system_prompt = build_system_prompt(config)
    logger.debug(f"System prompt: {len(system_prompt)} chars")

    context = OpenAILLMContext([{"role": "system", "content": system_prompt}])
    context_aggregator = llm.create_context_aggregator(context)

    rtvi = RTVIProcessor()
    ta = TalkingAnimation()

    pipeline = Pipeline(
        [
            transport.input(),
            rtvi,
            stt,
            context_aggregator.user(),
            llm,
            tts,
            ta,
            transport.output(),
            context_aggregator.assistant(),
        ]
    )

    task = PipelineTask(
        pipeline,
        params=PipelineParams(enable_metrics=True, enable_usage_metrics=True),
        observers=[RTVIObserver(rtvi)],
    )

    if quiet_frame:  # only queue avatar frame when assets are loaded
        await task.queue_frame(quiet_frame)

    @rtvi.event_handler("on_client_ready")
    async def on_client_ready(rtvi):
        await rtvi.set_bot_ready()
        await task.queue_frames([LLMRunFrame()])

    @transport.event_handler("on_client_connected")
    async def on_client_connected(transport, client):
        logger.info("Client connected")

    @transport.event_handler("on_client_disconnected")
    async def on_client_disconnected(transport, client):
        logger.info("Client disconnected — cancelling pipeline")
        await task.cancel()

    runner = PipelineRunner(handle_sigint=False)
    await runner.run(task)


def _make_transport_params(**extra):
    """Build transport params, adding VAD/SmartTurn only when onnxruntime is available."""
    kwargs = dict(
        audio_in_enabled=True,
        audio_out_enabled=True,
        video_out_enabled=True,
        video_out_width=1024,
        video_out_height=576,
        **extra,
    )
    if SILERO_AVAILABLE:
        kwargs["vad_analyzer"] = SileroVADAnalyzer(params=VADParams(stop_secs=0.5))
        kwargs["turn_analyzer"] = LocalSmartTurnAnalyzerV3()
    else:
        logger.warning("Running without Silero VAD / SmartTurn (onnxruntime unavailable on this Python version).")
    return kwargs


async def bot(runner_args: RunnerArguments):
    """Entry point called by the Pipecat runner."""
    transport = None
    tp = _make_transport_params()

    # Daily transport is only available on Linux / macOS (daily-python has no Windows wheel).
    # On Windows the SmallWebRTC branch is used exclusively.
    if DAILY_AVAILABLE and DailyRunnerArguments and isinstance(runner_args, DailyRunnerArguments):
        transport = DailyTransport(
            runner_args.room_url,
            runner_args.token,
            "Interview Coach",
            params=DailyParams(**tp),
        )
    elif isinstance(runner_args, SmallWebRTCRunnerArguments):
        webrtc_connection: SmallWebRTCConnection = runner_args.webrtc_connection
        transport = SmallWebRTCTransport(
            webrtc_connection=webrtc_connection,
            params=TransportParams(**tp),
        )
    else:
        logger.error(
            f"Unsupported runner args: {type(runner_args)}. "
            "On Windows only SmallWebRTC transport is supported."
        )
        return

    await run_bot(transport)


# ──────────────────────────────────────────────
# Direct execution
# ──────────────────────────────────────────────
if __name__ == "__main__":
    import threading

    from pipecat.runner.run import main

    from config_server import run_config_server

    def _run_config_server():
        import asyncio

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(run_config_server())
        except Exception as e:
            logger.error(f"Config server crashed: {e}")

    t = threading.Thread(target=_run_config_server, daemon=True, name="ConfigServer")
    t.start()
    logger.info("Config server thread started")
    main()
