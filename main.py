"""CS Concept Tutor - FastAPI backend. Talks only to a local Ollama server."""

import logging
import os
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------- config
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://localhost:11434").rstrip("/")
MODEL = os.getenv("OLLAMA_MODEL", "llama3.1:8b")
OLLAMA_TIMEOUT = float(os.getenv("OLLAMA_TIMEOUT", "120"))  # seconds

OLLAMA_OPTIONS = {
    "num_ctx": int(os.getenv("NUM_CTX", "4096")),
    "num_predict": int(os.getenv("NUM_PREDICT", "512")),
    "temperature": float(os.getenv("TEMPERATURE", "0.3")),
}

MAX_EXCHANGES = 5            # recent user/assistant pairs sent to the model (4-6)
MAX_QUESTION_CHARS = 2000
MAX_HISTORY_MESSAGE_CHARS = 4000

SYSTEM_PROMPT = (
    "You are CS Tutor, an accurate and concise Computer Science teacher. "
    "Explain concepts clearly using definitions, important points and practical examples. "
    "Use code snippets when relevant. Default to concise answers; provide detailed "
    "explanations when requested. Stay focused on Computer Science. If uncertain, "
    "state that clearly. Never invent technical facts."
)

SCOPE_CHECK = os.getenv("SCOPE_CHECK", "1") != "0"

SCOPE_PROMPT = (
    "You are a topic filter for a Computer Science tutor. Reply with exactly one word: YES or NO.\n"
    "YES if the latest message is about Computer Science: programming, algorithms, software, "
    "hardware, operating systems, databases, networks, AI/ML, graphics, compilers, math used in "
    "computing, the history of computing or computer scientists, or a follow-up to such a conversation.\n"
    "NO for anything else, such as general history, politics, geography, cooking, sports, "
    "entertainment, health, or personal advice."
)

OUT_OF_SCOPE_REPLY = (
    "I'm CS Tutor, so I can only help with Computer Science topics. "
    "Try asking about data structures, operating systems, databases, networks, "
    "OOP, software engineering, AI/ML, computer graphics or compiler design."
)

STATIC_DIR = Path(__file__).resolve().parent / "static"

logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
log = logging.getLogger("cs-tutor")

app = FastAPI(title="CS Concept Tutor", version="1.0.0")


# ---------------------------------------------------------------- schemas
class Message(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(max_length=8000)


class ChatRequest(BaseModel):
    question: str = Field(max_length=MAX_QUESTION_CHARS)
    history: list[Message] = Field(default_factory=list, max_length=50)

    @field_validator("question")
    @classmethod
    def question_not_empty(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("Question must not be empty.")
        return value


# ---------------------------------------------------------------- helpers
def recent_history(history: list[Message]) -> list[dict[str, str]]:
    """Keep only the latest MAX_EXCHANGES exchanges, starting on a user turn."""
    msgs = [
        {"role": m.role, "content": m.content.strip()[:MAX_HISTORY_MESSAGE_CHARS]}
        for m in history
        if m.content.strip()
    ]
    msgs = msgs[-MAX_EXCHANGES * 2:]
    while msgs and msgs[0]["role"] != "user":
        msgs.pop(0)
    return msgs


def build_metrics(data: dict[str, Any]) -> dict[str, Any]:
    """Only report what Ollama actually returned; compute tokens/sec from it."""
    metrics: dict[str, Any] = {
        "model": data.get("model"),
        "prompt_eval_count": data.get("prompt_eval_count"),
        "eval_count": data.get("eval_count"),
        "eval_duration": data.get("eval_duration"),
        "total_duration": data.get("total_duration"),
        "tokens_per_second": None,
    }
    eval_count = metrics["eval_count"]
    eval_duration = metrics["eval_duration"]
    if (
        isinstance(eval_count, (int, float))
        and isinstance(eval_duration, (int, float))
        and eval_duration > 0
    ):
        metrics["tokens_per_second"] = round(eval_count / (eval_duration / 1_000_000_000), 2)
    return metrics


# ---------------------------------------------------------------- errors
@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    errors = exc.errors()
    message = "Invalid request."
    if errors:
        first = errors[0]
        text = str(first.get("msg", ""))
        if text.startswith("Value error, "):
            message = text[len("Value error, "):]
        else:
            where = ".".join(str(p) for p in first.get("loc", ())[1:])
            message = f"Invalid request ({where}): {text}" if where else f"Invalid request: {text}"
    return JSONResponse(status_code=422, content={"detail": message})


# ---------------------------------------------------------------- API
@app.get("/api/health")
async def health():
    result: dict[str, Any] = {
        "backend": "ok",
        "ollama": "unreachable",
        "model": MODEL,
        "model_available": False,
        "status": "degraded",
    }
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{OLLAMA_URL}/api/tags")
        resp.raise_for_status()
        names = [m.get("name", "") for m in resp.json().get("models", [])]
        result["ollama"] = "ok"
        result["model_available"] = any(n == MODEL or n.startswith(MODEL + ":") for n in names)
        if result["model_available"]:
            result["status"] = "ok"
    except (httpx.HTTPError, ValueError, AttributeError) as exc:
        log.warning("Health check could not reach Ollama: %s", type(exc).__name__)
    return result


async def ollama_chat(payload: dict[str, Any]) -> dict[str, Any]:
    """Call Ollama /api/chat and map every failure to a safe HTTP error."""
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(OLLAMA_TIMEOUT, connect=5.0)) as client:
            resp = await client.post(f"{OLLAMA_URL}/api/chat", json=payload)
    except httpx.ConnectError:
        raise HTTPException(503, "Cannot connect to Ollama. Make sure it is running (ollama serve).")
    except httpx.TimeoutException:
        raise HTTPException(504, "The model took too long to respond. Try a shorter question and retry.")
    except httpx.HTTPError as exc:
        log.error("Ollama request failed: %s", type(exc).__name__)
        raise HTTPException(502, "Could not get a response from Ollama.")

    if resp.status_code == 404:
        raise HTTPException(502, f"Model '{MODEL}' was not found in Ollama. Check it with: ollama list")
    if resp.status_code != 200:
        log.error("Ollama returned HTTP %s: %s", resp.status_code, resp.text[:300])
        raise HTTPException(502, "Ollama returned an error. Check the backend server logs.")

    try:
        data = resp.json()
    except ValueError:
        log.error("Ollama returned non-JSON body")
        raise HTTPException(502, "Ollama returned an unexpected response.")

    if not isinstance(data, dict) or data.get("error"):
        log.error("Ollama error payload: %s", str(data)[:300])
        raise HTTPException(502, "The model reported an error. Check the backend server logs.")
    return data


def message_text(data: dict[str, Any]) -> str:
    message = data.get("message")
    content = message.get("content") if isinstance(message, dict) else None
    return content.strip() if isinstance(content, str) else ""


async def is_cs_related(question: str, history: list[dict[str, str]]) -> bool:
    """Cheap YES/NO gate. Anything other than a clear NO is allowed (fail open)."""
    previous = next((m["content"] for m in reversed(history) if m["role"] == "user"), "")
    text = (f"Previous message: {previous[:300]}\n" if previous else "")
    text += f"Latest message: {question}\nAnswer YES or NO."
    payload = {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": SCOPE_PROMPT},
            {"role": "user", "content": text},
        ],
        # Same num_ctx as the main call so Ollama does not reload the model.
        "options": {"num_ctx": OLLAMA_OPTIONS["num_ctx"], "num_predict": 3, "temperature": 0},
    }
    verdict = message_text(await ollama_chat(payload)).upper()
    log.info("Scope check verdict: %s", verdict[:10] or "(empty)")
    return not verdict.startswith("NO")


@app.post("/api/chat")
async def chat(req: ChatRequest):
    history = recent_history(req.history)

    if SCOPE_CHECK and not await is_cs_related(req.question, history):
        return {"answer": OUT_OF_SCOPE_REPLY, "metrics": None, "in_scope": False}

    payload = {
        "model": MODEL,
        "stream": False,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            *history,
            {"role": "user", "content": req.question},
        ],
        "options": OLLAMA_OPTIONS,
    }
    data = await ollama_chat(payload)

    content = message_text(data)
    if not content:
        raise HTTPException(502, "The model returned an empty or unexpected response.")

    return {"answer": content, "metrics": build_metrics(data), "in_scope": True}

# ---------------------------------------------------------------- frontend
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/", include_in_schema=False)
async def index():
    return FileResponse(STATIC_DIR / "index.html")
