# Intervix - The Real-Time AI Interview Coach

A full-stack, production-ready AI interviewer built with **Pipecat**, **Groq LLM**, **Deepgram STT**, and **ElevenLabs TTS**. Practice interviews with a configurable AI interviewer through real-time voice interaction in your browser.

```
User (Voice) → Deepgram STT → Groq LLM → ElevenLabs TTS → Real-Time Audio + Robot Avatar
                    ↑
         Config Server (port 7861)
         ← Bot Nature / Difficulty / JD / Interview Type
```

---

## ✨ Features

| Feature | Description |
|---|---|
| 🎙 Real-time voice | Speak naturally; Deepgram transcribes, Groq responds, ElevenLabs speaks back |
| 🤖 Animated avatar | Robot avatar animates while speaking |
| 🎛 Configurable | Bot style (friendly/professional/strict), seniority, interview type, max questions |
| 📋 JD-aware | Paste any job description; bot tailors every question to the role |
| ⏱ Session timer | Live elapsed-time counter |
| 📊 Phase tracking | Introduction → Core Questions → Wrap-Up |
| ⬇ Transcript export | Download full conversation as `.txt` |
| 🔄 Two transports | SmallWebRTC (local, no API key needed) or Daily (cloud) |
| 🐳 Docker ready | One-command start with Docker Compose |

---

## 🏗 Architecture

```
interview-coach-enhanced/
├── server/
│   ├── bot.py                  # Pipecat pipeline + LLM prompt engine
│   ├── config_server.py        # aiohttp REST API (port 7861)
│   ├── interview_config.json   # Active runtime config
│   ├── assets/                 # Robot avatar sprite frames
│   ├── Dockerfile
│   ├── pyproject.toml
│   └── .env.example
├── client/
│   ├── index.html              # Single-page app
│   ├── src/
│   │   ├── app.js              # Main client class
│   │   ├── config.js           # Transport configuration
│   │   └── style.css           # Dark-mode UI
│   ├── package.json
│   └── .env.example
├── docker-compose.yml
└── .github/
    └── workflows/ci.yml
```

---

## 🔑 API Keys Required

| Service | Purpose | Get it |
|---|---|---|
| **Deepgram** | Speech-to-Text | [console.deepgram.com](https://console.deepgram.com) |
| **Groq** | LLM (Llama 3.3) | [console.groq.com](https://console.groq.com) |
| **ElevenLabs** | Text-to-Speech | [elevenlabs.io](https://elevenlabs.io) |
| **Daily** | Cloud WebRTC transport *(optional)* | [dashboard.daily.co](https://dashboard.daily.co) |

---

## 🚀 Local Deployment

### Option A — Manual (recommended for development)

#### 1. Clone & set up server

```bash
git clone https://github.com/YOUR_USERNAME/interview-coach.git
cd interview-coach

# Copy and fill in env vars
cp server/.env.example server/.env
# Edit server/.env with your API keys

# Install Python dependencies (requires Python 3.10+)
cd server
pip install uv        # if not already installed
uv sync

# Start the bot server + config API
uv run bot.py
```

The server will print:
```
Config server: http://0.0.0.0:7861
Bot server: http://0.0.0.0:7860
```

#### 2. Set up & start the client (new terminal)

```bash
cd client

# Copy env
cp .env.example .env

# Install and run
npm install
npm run dev
```

Open **http://localhost:5173** in your browser.

---

### Option B — Docker Compose (one command)

```bash
# 1. Fill in API keys
cp server/.env.example server/.env
# edit server/.env

# 2. Start everything
docker compose up --build

# 3. Open http://localhost:5173
```

Stop everything:
```bash
docker compose down
```

---

### Verifying services are running

```bash
# Bot server health
curl http://localhost:7861/health

# Current config
curl http://localhost:7861/api/interview-config

# Set new config manually
curl -X POST http://localhost:7861/api/interview-config \
  -H "Content-Type: application/json" \
  -d '{"botNature":"strict","interviewType":"technical","difficulty":"senior","maxQuestions":10,"jd":"Senior Python developer..."}'
```

---

## ☁️ Online Deployment (GitHub + Cloud)

### Step 1 — Push to GitHub

```bash
git init
git remote add origin https://github.com/YOUR_USERNAME/interview-coach.git
git add .
git commit -m "Initial commit — AI Interview Coach"
git push -u origin main
```

### Step 2 — Deploy the bot server

#### Option A: Railway (easiest)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select your repo, set **Root Directory** to `server`
3. Add environment variables (copy from `server/.env.example`)
4. Railway auto-detects the Dockerfile and deploys
5. Note your deployment URL, e.g. `https://interview-coach.railway.app`

#### Option B: Render

1. Go to [render.com](https://render.com) → New Web Service → GitHub repo
2. **Root Directory**: `server`
3. **Build Command**: `pip install uv && uv sync`
4. **Start Command**: `uv run bot.py`
5. Add env vars under Environment
6. Expose ports 7860 and 7861

#### Option C: Fly.io

```bash
cd server
fly launch --dockerfile Dockerfile
fly secrets set DEEPGRAM_API_KEY=xxx GROQ_API_KEY=xxx ELEVENLABS_API_KEY=xxx
fly deploy
```

#### Option D: Pipecat Cloud (native, recommended for production)

```bash
cd server
pip install pipecatcloud
pcc login
pcc deploy
```

The included `pcc-deploy.toml` configures the Pipecat Cloud deployment.

---

### Step 3 — Deploy the frontend

#### Vercel (recommended)

```bash
cd client
npm install -g vercel
vercel

# Set environment variables in Vercel dashboard:
#   VITE_BOT_START_URL       = https://your-server.railway.app/start
#   VITE_CONFIG_SERVER_URL   = https://your-server.railway.app
```

#### Netlify

```bash
cd client
npm run build
npx netlify deploy --dir=dist --prod
```

Set the same two environment variables in Netlify's site settings.

#### GitHub Pages (static only)

```bash
cd client

# Install gh-pages
npm install --save-dev gh-pages

# Add to package.json scripts:
#   "deploy": "vite build && gh-pages -d dist"

# Set env vars in a .env.production file:
echo "VITE_BOT_START_URL=https://your-server.example.com/start" >> .env.production
echo "VITE_CONFIG_SERVER_URL=https://your-server.example.com" >> .env.production

npm run deploy
```

> **Note:** GitHub Pages serves from `github.io` (HTTPS), so your bot server must also be HTTPS.  
> Use a reverse proxy (Nginx, Caddy, Cloudflare Tunnel) or deploy to Railway/Render which provide HTTPS automatically.

---

## ⚙️ Configuration Reference

### Server environment variables (`server/.env`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `DEEPGRAM_API_KEY` | ✅ | — | Deepgram STT key |
| `GROQ_API_KEY` | ✅ | — | Groq LLM key |
| `ELEVENLABS_API_KEY` | ✅ | — | ElevenLabs TTS key |
| `DAILY_API_KEY` | Daily only | — | Daily.co API key |
| `ELEVENLABS_VOICE_ID` | ❌ | Adam | ElevenLabs voice ID |
| `GROQ_MODEL` | ❌ | llama-3.3-70b-versatile | Groq model name |
| `CONFIG_SERVER_PORT` | ❌ | 7861 | Config API port |
| `ALLOWED_ORIGINS` | ❌ | * | CORS allowed origins |

### Interview config (`interview_config.json` or via POST API)

| Field | Type | Values | Description |
|---|---|---|---|
| `botNature` | string | `friendly`, `decent`, `strict` | Interviewer personality |
| `interviewType` | string | `technical`, `behavioral`, `mixed` | Question type focus |
| `difficulty` | string | `junior`, `mid`, `senior` | Seniority target |
| `maxQuestions` | int | 3–20 | Approximate question count |
| `jd` | string | any | Full job description |
| `roleName` | string | any | Role title |
| `companyName` | string | any | Company name |
| `focusAreas` | array | any | Topics to prioritise |

---

## 🛠 Development Tips

```bash
# Lint Python
cd server && uv run ruff check . && uv run ruff format --check .

# Type-check Python
cd server && uv run pyright

# Build client for production
cd client && npm run build

# Preview production build locally
cd client && npm run preview
```

---

## 🙋 FAQ

**Q: The bot doesn't respond to my voice.**  
A: Check that your microphone is allowed in the browser and the Deepgram key is valid. Look at the System Events panel for errors.

**Q: I get a CORS error in the browser console.**  
A: Set `ALLOWED_ORIGINS=*` in `server/.env`, or set it to your exact frontend URL (e.g. `http://localhost:5173`).

**Q: Can I use a different LLM?**  
A: Yes — swap `GroqLLMService` in `bot.py` for `OpenAILLMService` or `AnthropicLLMService` and update the API key.

**Q: Can I use a different TTS voice?**  
A: Set `ELEVENLABS_VOICE_ID` to any voice ID from your ElevenLabs account.

---

## 📄 License

BSD 2-Clause — see `server/` headers. Project built on [Pipecat](https://github.com/pipecat-ai/pipecat).
