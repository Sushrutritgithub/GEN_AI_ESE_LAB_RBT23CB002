# CS Concept Tutor

A local chat web app that explains Computer Science concepts using a local LLM (`llama3.1:8b`) served by Ollama. No cloud services, API keys, or databases.

## Problem statement
Students need quick, simple explanations of CS topics with follow-up questions. Cloud chatbots need accounts and send questions off-device. This project provides a private, offline tutor on a personal machine.

## Objectives
- Answer CS questions in simple, student-friendly language, with follow-ups.
- Run entirely on local Ollama with a small, token-efficient prompt.
- Render Markdown (headings, lists, code blocks) safely.
- Show real Ollama performance metrics (tokens, tokens/sec).

## Stack
- Backend: Python, FastAPI, Pydantic, httpx, Uvicorn
- Frontend: HTML, CSS, vanilla JavaScript
- LLM runtime: Ollama with `llama3.1:8b`
- API: JSON over REST

## Architecture
```
Browser (static/) --JSON--> FastAPI (main.py) --JSON--> Ollama /api/chat (localhost:11434)
```
- The browser keeps the conversation in memory and sends the question plus recent history.
- The backend validates input, trims history to the last 5 exchanges, prepends one system prompt, and calls Ollama with `stream: false`.
- The backend is stateless; it stores nothing.

## Directory structure
```
cs-concept-tutor/
├── main.py
├── requirements.txt
├── README.md
├── .gitignore
└── static/
    ├── index.html
    ├── style.css
    └── script.js
```

## Installation (CachyOS, Fish shell)
```fish
sudo pacman -S --needed python
# Ollama is assumed to be installed already.
```

## Verify Ollama
```fish
systemctl status ollama --no-pager        # or run: ollama serve
curl -s http://localhost:11434/api/version
ollama list                               # must show llama3.1:8b
```
Do not pull or replace models; this project uses the existing one.

## Python virtual environment
```fish
cd ~/Documents/genai-practicals/cs-concept-tutor
python -m venv .venv
source .venv/bin/activate.fish
pip install -r requirements.txt
```

## Run
```fish
cd ~/Documents/genai-practicals/cs-concept-tutor
source .venv/bin/activate.fish
uvicorn main:app --host 127.0.0.1 --port 8000
```
Open http://127.0.0.1:8000.

Optional environment variables (Fish): `set -x NUM_PREDICT 768`, `set -x NUM_CTX 4096`, `set -x TEMPERATURE 0.3`, `set -x OLLAMA_TIMEOUT 120`, `set -x OLLAMA_MODEL llama3.1:8b`, `set -x OLLAMA_URL http://localhost:11434`.

## API

### GET /api/health
```json
{"backend":"ok","ollama":"ok","model":"llama3.1:8b","model_available":true,"status":"ok"}
```
`status` is `ok` when Ollama is reachable and the model is installed, otherwise `degraded`.

### POST /api/chat
Request:
```json
{"question": "Process vs thread", "history": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
```
Response:
```json
{"answer": "...", "metrics": {"model": "llama3.1:8b", "prompt_eval_count": 0, "eval_count": 0, "eval_duration": 0, "total_duration": 0, "tokens_per_second": 0.0}}
```
Metric fields are `null` if Ollama did not return them.

Errors return `{"detail": "..."}`: 422 invalid request (for example empty question), 502 Ollama or model error, 503 Ollama unreachable, 504 timeout.

## Test cases
Run these with the server running:
```fish
curl -s http://127.0.0.1:8000/api/health | python -m json.tool

# 1 Basic
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Explain an operating system."}' | python -m json.tool

# 2 Detailed
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Explain deadlock and its four necessary conditions."}' | python -m json.tool

# 3 Comparison
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Process vs thread."}' | python -m json.tool

# 4 Programming
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Explain binary search with C++ code."}' | python -m json.tool

# 5 Follow-up
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Which of those conditions does resource ordering break?","history":[{"role":"user","content":"Explain deadlock and its four necessary conditions."},{"role":"assistant","content":"Deadlock needs four conditions: mutual exclusion, hold and wait, no preemption, and circular wait."}]}' | python -m json.tool

# 6 Out of scope
curl -s http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"Give me a butter chicken recipe."}' | python -m json.tool

# Validation: empty question must return 422
curl -s -w ' [%{http_code}]\n' http://127.0.0.1:8000/api/chat -H 'Content-Type: application/json' -d '{"question":"  "}'
```
Expected: 1-4 give accurate CS answers (4 includes a C++ code block); 5 answers in terms of deadlock (circular wait); 6 politely redirects to CS (this depends on the model and may need a prompt tweak if it does not).

## Performance measurement
Each response includes metrics straight from Ollama. Tokens/sec is computed as `eval_count / (eval_duration / 1,000,000,000)`. The first request after idle includes model load time in `total_duration`, so run a request twice and compare.

- `ollama ps`: shows loaded models, their memory size, the **PROCESSOR** split (for example `100% GPU` or `100% CPU`) and when they unload.
- `nvidia-smi`: shows NVIDIA GPU memory use, utilization, and processes (NVIDIA GPUs only).
- `watch -n 1 nvidia-smi`: refreshes that view every second so you can watch VRAM and utilization during generation.

## Limitations
- An 8B model can be wrong or inconsistent; verify important facts.
- Staying on topic relies on the system prompt and is not enforced.
- No streaming: the reply appears when generation finishes.
- History lives in the browser tab and is lost on refresh.
- Only the last 5 exchanges are sent, so older context is forgotten.
- Basic Markdown only (no tables, links, nested lists, italics).
- Single local user; no authentication.

## Future improvements
- Streaming responses.
- Save and export conversations.
- Model selector from `/api/tags`.
- Automated tests with a mocked Ollama.
- Tables and nested lists in the Markdown renderer.
