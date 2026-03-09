# Food Agent

Telegram bot for tracking food, sleep, weight, and notes via natural conversation.

## Stack
- TypeScript + Node.js (ES2022, ESM)
- node-telegram-bot-api for Telegram
- OpenRouter (Gemini Flash) for orchestration — intent classification, food parsing, cross-questioning
- Claude CLI for deep Q&A, web search, and complex analysis
- Perplexity (sonar-pro) for web search
- CSV files for data storage, JSON for config
- Per-user git repos for data versioning

## Architecture
- `src/food-bot.ts` — Main bot: message handling, commands, check-ins (food + sleep)
- `src/orchestrator.ts` — LLM orchestrator: 13 tools, multi-turn tool loop (max 10 rounds)
- `src/claude.ts` — Claude CLI wrapper for deep analysis and web search
- `src/food-log.ts` — CSV read/write for food entries (one file per day)
- `src/sleep-log.ts` — CSV read/write for sleep entries (one file per month)
- `src/notes-log.ts` — CSV read/write for notes (single file per user)
- `src/weight-log.ts` — CSV read/write for weight (single file per user)
- `src/nutrition-db.ts` — Local calorie lookup DB (grows organically)
- `src/targets.ts` — Per-user daily calorie targets + timezone
- `src/history.ts` — Chat history (last 100 messages per user)
- `src/pairing.ts` — User authentication (allowlist + pairing codes)
- `src/buffer.ts` — Adaptive message debouncing (2s base, 10s ceiling, block IDs)
- `src/user-git.ts` — Per-user git repos for data versioning
- `src/format.ts` — Markdown to Telegram HTML
- `src/settings.ts` — Config management (env vars + settings.json)
- `src/paths.ts` — Data directory resolution
- `src/search.ts` — Perplexity web search CLI
- `src/cli.ts` — Interactive CLI (for local testing without Telegram)

## Data layout (in `.food-agent/`)
```
logs/{userId}/              ← per-user dir (has its own .git repo)
  {yyyy}/{mm}/{yyyy-mm-dd}.csv  ← daily food log
  sleep/{yyyy}-{mm}.csv         ← monthly sleep log
  notes.csv                     ← all notes
  weight.csv                    ← all weight entries
  chat-history.json             ← recent chat (last 100)
nutrition.json               ← shared calorie database
targets.json                 ← per-user calorie targets + timezone
pairing/                     ← user allowlist and pending requests
sessions/                    ← Claude CLI session markers
settings.json                ← bot token, API keys
```

## CSV schemas
- Food: `timestamp,food_item,quantity,unit,calories,notes`
- Sleep: `date,type,start_time,end_time,duration_hours,quality,notes`
- Notes: `timestamp,note`
- Weight: `timestamp,weight_kg,notes`

## Dev workflow

### Local development
```bash
npm install
npm run build          # tsc — compile TypeScript
npm run cli            # interactive CLI for testing (no Telegram needed)
npm run telegram       # run the bot locally (needs .env with tokens)
```

### Build check
Always run `npm run build` after changes. If it passes with no output below the `> tsc` line, you're good.

### Deploy to remote
Remote server: `aiadmin@100.88.77.72`
Bot runs at: `~/projects/food-agent`
Managed by: systemd user service `food-agent.service`

Full deploy cycle (do this every time after committing):
```bash
# 1. Push
git push origin main

# 2. Pull and build on remote
ssh aiadmin@100.88.77.72 "cd ~/projects/food-agent && git pull && npm run build"

# 3. Restart the bot
ssh aiadmin@100.88.77.72 "systemctl --user restart food-agent"
```

Managed by systemd with `Restart=always`. Logs: `.food-agent/bot.log`.

### GitHub
Repo: `AgenticCurve/food-agent` (private)
Branch: `main` only

## Key design decisions
- No meal types — just timestamp + food + calories
- AI cross-questions for missing info before logging
- `log_type` parameter on shared tools (edit/remove/get/grep) instead of separate tools per data type
- Adaptive debounce batches rapid messages; each batch gets a block ID (first message's Telegram timestamp)
- Per-user git repos auto-commit after every data-changing action with block ID in commit message
- Stale message detection: warns when messages are >5 min old (bot was down)
- System prompt context: today's food + sleep in full, last 7 days of notes + weight, older data via tools
- Default: 2400 cal/day, Asia/Hong_Kong timezone
- 90-day CSV retention for food logs
- Check-ins: food every 30 min (quiet hours 1am-7am), sleep at 10am daily
