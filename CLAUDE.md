# Food Agent

Telegram bot for tracking food, sleep, weight, and notes via natural conversation.

## Stack
- TypeScript + Node.js (ES2022, ESM)
- node-telegram-bot-api for Telegram
- OpenRouter for orchestration — multiple models:
  - `google/gemini-3-flash-preview` — orchestrator (intent classification, food parsing, tool calling)
  - `anthropic/claude-haiku-4.5` — image description (food photos, nutrition labels, products)
  - `google/gemini-3.1-flash-lite-preview` — audio transcription (voice messages)
- Claude CLI for deep Q&A, web search, and complex analysis
- Perplexity (sonar-pro) for web search
- CSV files for data storage, JSON for config
- Per-user git repos for data versioning

## Architecture
- `src/food-bot.ts` — Main bot: message handling, commands, check-ins (food + sleep), slash commands with LLM formatting
- `src/orchestrator.ts` — LLM orchestrator: 16 tools, multi-turn tool loop (max 10 rounds), exportable SYSTEM_PROMPT with optional override for onboarding
- `src/claude.ts` — Claude CLI wrapper for deep analysis and web search
- `src/transcribe.ts` — Voice transcription (Gemini Flash Lite) and image description (Claude Haiku 4.5) via OpenRouter
- `src/food-log.ts` — CSV read/write for food entries (one file per day: `food-{date}.csv`)
- `src/sleep-log.ts` — CSV read/write for sleep entries (one file per month)
- `src/notes-log.ts` — CSV read/write for notes (one file per day: `notes-{date}.csv`)
- `src/weight-log.ts` — CSV read/write for weight (single file per user)
- `src/nutrition-labels.ts` — CSV read/write for nutrition label profiles (single file per user, all values per 100g)
- `src/nutrition-db.ts` — Local calorie lookup DB (grows organically)
- `src/profile.ts` — Persistent user profile (dietary restrictions, allergies, preferences) — plain text file
- `src/onboarding.ts` — 10-step interactive onboarding: step definitions, state tracking, dedicated system prompt
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
  {yyyy}/{mm}/food-{yyyy-mm-dd}.csv   ← daily food log
  {yyyy}/{mm}/notes-{yyyy-mm-dd}.csv  ← daily notes
  sleep/{yyyy}-{mm}.csv               ← monthly sleep log
  weight.csv                          ← all weight entries
  nutrition-labels.csv                ← nutrition profiles (per 100g)
  profile.txt                         ← persistent user facts (one per line)
  onboarding.json                     ← onboarding progress tracking
  chat-history.json                   ← recent chat (last 100)
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
- Nutrition labels: `timestamp,product_name,brand,serving_size,serving_size_g,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,sugar_per_100g,fiber_per_100g,sodium_per_100g,notes`

## Slash commands
All data commands support optional trailing question (e.g. `/today how much protein?`):
- `/today` — today's food log
- `/week` — this week's food summary
- `/sleep` — recent sleep data
- `/notes` — this week's notes
- `/weight` — weight history
- `/nutrition` — saved nutrition profiles (per 100g)
- `/profile` — persistent user preferences & restrictions
- `/onboarding` — start/resume guided setup (also: `skip`, `restart`, `status`)
- `/target <n>` — set daily calorie target
- `/tz <timezone>` — set timezone
- `/undo` — remove last food entry
- `/search <query>` — web search via Perplexity
- `/claude <question>` — deep analysis with Claude CLI
- `/clear` — clear chat memory
- `/help` — comprehensive help message

## Onboarding
10-step interactive flow tracked in `logs/{userId}/onboarding.json`:
1. Welcome  2. Set timezone  3. Set calorie target  4. Profile setup  5. Log food  6. Edit entry  7. Notes  8. Sleep  9. Weight  10. Feature overview

- During onboarding: a dedicated system prompt wraps the normal one with step-specific guidance
- All tools remain available — user can interact normally while being guided
- Steps auto-advance when the matching action is detected (e.g. `log_food` completes step 5)
- `/onboarding skip` exits to normal mode, `/onboarding restart` starts over

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
- Food and notes are per-day files (`food-{date}.csv`, `notes-{date}.csv`) in `{yyyy}/{mm}/` dirs; sleep is per-month; weight and nutrition-labels are single file
- Nutrition labels normalized to per 100g/100ml for instant cross-product comparison
- Profile vs notes distinction: profile = permanent facts (who they ARE), notes = dated events (what HAPPENED)
- Onboarding uses a dedicated system prompt that wraps the normal one — all tools stay available
- Slash commands use lightweight `formatWithLLM()` (Gemini Flash, no tools) for formatting
- Image pipeline: photo → Claude Haiku describes → `[Image: ...]` text into message buffer → orchestrator
- Voice pipeline: audio → Gemini Flash Lite transcribes → text into message buffer → orchestrator
- Adaptive debounce batches rapid messages; each batch gets a block ID (first message's Telegram timestamp)
- Per-user git repos auto-commit after every data-changing action with block ID in commit message
- Stale message detection: warns when messages are >5 min old (bot was down)
- System prompt context: today's food + sleep in full, user profile, last 7 days of notes + weight, nutrition labels, older data via tools
- Default: 2400 cal/day, Asia/Hong_Kong timezone
- Weeks start Monday (ISO 8601)
- 90-day CSV retention for food logs
- Check-ins: food every 30 min (quiet hours 1am-7am), sleep at 10am daily
