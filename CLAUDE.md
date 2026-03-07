# Food Agent

Telegram bot for tracking food intake and calories via natural conversation.

## Stack
- TypeScript + Node.js (ES2022, ESM)
- node-telegram-bot-api for Telegram
- OpenRouter (Gemini Flash) for orchestration — intent classification, food parsing, cross-questioning
- Claude CLI for deep Q&A, web search, and complex analysis
- CSV files for food log storage (one per user, 90-day retention)
- JSON files for config, nutrition DB, targets

## Architecture
- `src/telegram.ts` — Main bot: message handling, commands, proactive check-ins
- `src/orchestrator.ts` — LLM orchestrator: parses food, classifies intent, generates responses
- `src/claude.ts` — Claude CLI wrapper for deep analysis and web search
- `src/food-log.ts` — CSV read/write for food entries
- `src/nutrition-db.ts` — Local calorie lookup DB (grows organically as users log food)
- `src/targets.ts` — Per-user daily calorie targets + timezone
- `src/history.ts` — In-memory chat history (last 20 messages per user)
- `src/pairing.ts` — User authentication (allowlist + pairing codes)
- `src/buffer.ts` — Per-user message debouncing (1.5s)
- `src/format.ts` — Markdown to Telegram HTML
- `src/settings.ts` — Config management (env vars + settings.json)
- `src/paths.ts` — Data directory resolution

## Data (in `.food-agent/`)
- `logs/food_log_{userId}.csv` — per-user food log
- `nutrition.json` — shared calorie database
- `targets.json` — per-user calorie targets + timezone
- `pairing/` — user allowlist and pending requests
- `sessions/` — Claude CLI session markers
- `settings.json` — bot token, API keys

## Running
```bash
npm install
cp .env.example .env  # fill in TELEGRAM_BOT_TOKEN and OPENROUTER_API_KEY
npm run telegram
```

## Key flows
1. User says "had 2 eggs and toast" → orchestrator parses → asks clarifying questions if needed → logs to CSV → confirms with daily total
2. User asks "how many calories this week?" → simple questions answered from context, complex ones routed to Claude CLI
3. Bot checks in every 30 min (except 1am-7am) asking if user ate anything
4. Nutrition DB grows automatically as foods are logged
