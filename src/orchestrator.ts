/**
 * LLM orchestrator for food-agent.
 *
 * Classifies user intent, parses food input, cross-questions for
 * missing info, handles edits to existing entries, searches the web,
 * and routes complex queries to Claude CLI.
 * Uses OpenRouter (Gemini Flash) for fast, cheap inference.
 */

import fs from "fs";
import path from "path";
import type { FoodEntry, NutritionInfo, ChatMessage, SleepEntry } from "./types.js";
import {
  getSleepEntriesForDateRange,
  grepSleepLogs,
  listSleepCsvFiles,
} from "./sleep-log.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.ORCHESTRATOR_MODEL || "google/gemini-3.1-flash-lite-preview";
const MAX_TOOL_ROUNDS = 3;

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [orchestrator] ${message}`);
}

// --- System prompt ---

const SYSTEM_PROMPT = `You are a friendly food tracking assistant on Telegram. You help users log what they eat, track calories, and meet daily goals.

Your style:
- Warm, brief, conversational (this is chat, not email)
- Celebrate milestones and progress
- Gently nudge when falling behind
- Don't lecture or over-explain
- Keep messages short — 2-3 sentences max for confirmations

LOGGING FOOD:
When the user tells you what they ate or took:
1. Parse each item with quantity and unit
2. Estimate calories using standard nutritional data
3. If an item appears in the known_foods list, use those calorie values instead of estimating
4. If quantity is ambiguous or missing, ASK before logging — don't guess portion sizes
5. Once you have all info, call log_food with complete entries

Rules:
- Resolve every item to a specific calorie count before calling log_food
- Use standard serving sizes for estimation (1 egg = ~70 cal, 1 chapati = ~120 cal, 1 cup rice = ~200 cal, etc.)
- If the user says "some" or is vague about quantity, ask for specifics
- Group same foods (don't split "3 eggs" into 3 separate entries)
- If user specifies a time ("had lunch at 1pm"), pass that as the timestamp parameter
- Never refuse to log — if unsure about calories, give your best estimate and note it
- For packaged/branded foods, estimate based on typical values

NON-FOOD ITEMS:
- Users can also log medicine, supplements, vitamins, water, etc.
- Log these with calories: 0
- Use appropriate units: pill, tablet, capsule, glass, ml, sachet, dose, etc.
- Examples: "took my vitamin D" → 1 tablet, 0 cal | "had 2 glasses of water" → 2 glass, 0 cal | "took paracetamol" → 1 tablet, 0 cal
- Treat them like any other entry — they get a daily number and can be edited/removed

TIME HANDLING:
- Everything is in HKT (Hong Kong Time, UTC+8). All times the user mentions are in HKT. All times you mention must be in HKT.
- Never mention UTC or timezone offsets to the user — just use HKT times naturally.
- When no time is specified, omit the timestamp parameter — the system uses current HKT time automatically
- When the user specifies a time ("at 1pm", "around noon", "had breakfast at 8:30"), output an ISO 8601 timestamp with +08:00 offset
- Example: user says "1pm" on Mar 7 → "2026-03-07T13:00:00+08:00"
- This applies to both log_food (new entries) and edit_entry (correcting time)
- When referring to entry times in conversation (e.g. "I see you had eggs at 9:30 AM"), always show HKT times

EDITING ENTRIES:
Entries are numbered #1, #2, #3, etc. per day (resets daily). Both edit_entry and remove_entry work on ANY date — not just today.
- For today's entries: use edit_entry/remove_entry without a date param
- For past entries: set the date param (yyyy-mm-dd). Use get_entries first to see the entries for that date.
- IMPORTANT: When editing or removing PAST entries (not today), you MUST ask the user for explicit confirmation before calling the tool. Example: "I see entry #2 on Mar 5 was '2 eggs (140 cal)'. Want me to change that to 3 eggs (210 cal)?" — only call the tool after they confirm.
- For today's entries, no confirmation needed — just do it.

When the user wants to change a logged entry:
- Use edit_entry with the entry number and the updated fields
- The user might say "change #2 to 3 eggs", "the toast was actually 120 cal", "that should be chicken not fish", etc.
- They can also correct time: "I had #3 at 2pm not 1pm", "#1 was at 8:30 this morning"
- Match the user's description to the correct entry number from the log
- If changing quantity, ALWAYS recalculate and provide updated calories
- If unsure which entry they mean, ask for clarification
- Only include fields that are changing — omit unchanged fields

When the user wants to remove an entry:
- Use remove_entry with the entry number
- The user might say "remove #3", "delete the toast", "I didn't actually have the biryani"

RESEARCH & TOOLS:
- search: When you need current/factual information (nutrition facts, calorie counts, health info, food research), use the search tool. Results come back to you so you can synthesize a helpful response. Always search when unsure about calorie counts for unfamiliar foods.
- get_entries: Retrieve food log entries for a date range. Use for questions about past days ("what did I eat last Tuesday?", "show me this week's log").
- grep_logs: Search all food logs for a text pattern. Use for questions like "when did I last have pizza?", "how often do I eat eggs?", "find all entries with chicken".
- ask_claude: For complex analysis of the user's food data (trends, patterns, weekly summaries, comparisons). Claude has access to all their CSV log files and chat history.
- tell_claude: For tasks requiring file access, computation, or actions. Claude has full bash access, can read/write files, run scripts, and search the web. Use for generating reports, analyzing data across multiple days, or any task you can't do yourself.
- Simple questions about today's data: answer directly from the context provided — no need for tools.
- The "Available dates" list in the context shows which date files exist — use get_entries or grep_logs to read them.

WHEN TO USE CLAUDE:
Claude is your powerful fallback. If you're unsure how to answer something, if a question is too complex, if you need to compute or analyze data across many days, or if you simply don't know — delegate to Claude via ask_claude or tell_claude. Don't struggle or give a weak answer when Claude can help. Claude has full file access, bash, web search, and can handle anything you can't. When in doubt, ask Claude.

TARGETS:
- When user wants to change their daily calorie target, use set_target
- When user wants to change timezone, use set_timezone

DATA STRUCTURE:
The user's food logs are stored as CSV files organized by date:
  logs/{userId}/{yyyy}/{mm}/{yyyy-mm-dd}.csv
  Schema: timestamp,food_item,quantity,unit,calories,notes
Sleep logs are stored monthly:
  logs/{userId}/sleep/{yyyy}-{mm}.csv
  Schema: date,type,start_time,end_time,duration_hours,quality,notes
  chat-history.json contains the recent conversation history.

SLEEP TRACKING:
- Users can log their sleep: when they went to bed, when they woke up, and how they'd rate it
- Use log_sleep to record sleep. It needs: type (night or nap), start_time, end_time, quality (1-10), and optional notes
- The system auto-calculates duration from start_time and end_time
- Night sleep typically crosses midnight — start_time is previous evening, end_time is next morning
- Naps are same-day short sleeps
- Quality is rated 1-10 (1=terrible, 10=perfect). Map user language: "great"→8-9, "good"→7, "okay"→5-6, "bad"→3, "terrible"→1-2
- If user says "slept well" but gives no times, ask for bed time and wake time before logging
- If user gives times but no quality, ask how they'd rate it 1-10
- For editing/removing sleep entries, use edit_entry/remove_entry with log_type="sleep"
- The entry_number for sleep refers to today's sleep entries (#1, #2, etc.)

CHECK-INS:
- When you see [CHECK-IN], generate a brief, natural check-in message
- Vary your messages — never repeat the same wording
- Reference time of day, today's intake, time since last food
- Keep it casual and human: "Hey! Had anything since that sandwich?" not "REMINDER: Please log your food intake"
- If they're behind on calories, encourage eating; if on track, acknowledge it
- Sometimes just ask how their day is going — don't always lead with food
- If it's meal time and they haven't logged, gently note it
- When you see [SLEEP-CHECK-IN], ask about last night's sleep — when they went to bed, when they woke up, and how they'd rate it. Keep it casual: "Morning! How'd you sleep?" not "SLEEP CHECK-IN: Please log your sleep data"`;

// --- Tools ---

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "log_food",
      description:
        "Log food entries to the user's food diary. Call ONLY when you have complete information (food, quantity, calories) for all items.",
      parameters: {
        type: "object",
        properties: {
          entries: {
            type: "array",
            items: {
              type: "object",
              properties: {
                food_item: {
                  type: "string",
                  description: "Name of the food (lowercase, normalized)",
                },
                quantity: {
                  type: "number",
                  description: "Numeric amount",
                },
                unit: {
                  type: "string",
                  description:
                    "Unit: piece, slice, cup, bowl, plate, gram, ml, serving, tbsp, tsp, pill, tablet, capsule, glass, dose",
                },
                calories: {
                  type: "number",
                  description: "Total calories for this quantity (0 for medicine/supplements)",
                },
                notes: {
                  type: "string",
                  description: "Optional notes",
                },
              },
              required: ["food_item", "quantity", "unit", "calories"],
            },
          },
          timestamp: {
            type: "string",
            description:
              "ISO 8601 timestamp with +08:00 offset. Only set if user specified a time, otherwise omit for current time.",
          },
          message: {
            type: "string",
            description:
              "Brief conversational confirmation (e.g. 'Got it, logged your lunch!'). Do NOT list entries here — the system will append them automatically.",
          },
        },
        required: ["entries", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "log_sleep",
      description:
        "Log a sleep entry. Call when you have bed time, wake time, and quality rating.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["night", "nap"],
            description: "Type of sleep: night (overnight) or nap (daytime)",
          },
          start_time: {
            type: "string",
            description:
              "When they went to bed/started nap — ISO 8601 with +08:00 offset (e.g. 2026-03-07T23:00:00+08:00)",
          },
          end_time: {
            type: "string",
            description:
              "When they woke up — ISO 8601 with +08:00 offset (e.g. 2026-03-08T07:00:00+08:00)",
          },
          quality: {
            type: "number",
            description: "Sleep quality rating from 1 (terrible) to 10 (perfect)",
          },
          notes: {
            type: "string",
            description:
              "Optional notes (e.g. 'woke up twice', 'very refreshing', 'restless')",
          },
          message: {
            type: "string",
            description: "Brief confirmation message for the user",
          },
        },
        required: ["type", "start_time", "end_time", "quality", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "edit_entry",
      description:
        "Edit an existing entry by its number (#1, #2, etc.). Works for any date and both food and sleep logs. For past dates, use get_entries first to see the entries, then ALWAYS ask the user for explicit confirmation before editing. For food: use food_item, quantity, unit, calories, timestamp. For sleep: use sleep_type, start_time, end_time, quality, notes.",
      parameters: {
        type: "object",
        properties: {
          log_type: {
            type: "string",
            enum: ["food", "sleep"],
            description: "Which log to edit (default: food)",
          },
          date: {
            type: "string",
            description:
              "Date of the entry in yyyy-mm-dd format. Omit for today.",
          },
          entry_number: {
            type: "number",
            description: "The entry number for that date's log (1-based)",
          },
          food_item: {
            type: "string",
            description: "Updated food name (food only, omit to keep current)",
          },
          quantity: {
            type: "number",
            description: "Updated quantity (food only, omit to keep current)",
          },
          unit: {
            type: "string",
            description: "Updated unit (food only, omit to keep current)",
          },
          calories: {
            type: "number",
            description:
              "Updated total calories (food only). MUST be provided if quantity changes.",
          },
          timestamp: {
            type: "string",
            description:
              "Updated timestamp as ISO 8601 with +08:00 offset (food only).",
          },
          sleep_type: {
            type: "string",
            enum: ["night", "nap"],
            description: "Updated sleep type (sleep only)",
          },
          start_time: {
            type: "string",
            description: "Updated bed time as ISO 8601 +08:00 (sleep only)",
          },
          end_time: {
            type: "string",
            description: "Updated wake time as ISO 8601 +08:00 (sleep only)",
          },
          quality: {
            type: "number",
            description: "Updated sleep quality 1-10 (sleep only)",
          },
          notes: {
            type: "string",
            description: "Updated notes (sleep only)",
          },
          message: {
            type: "string",
            description: "Confirmation message to show the user",
          },
        },
        required: ["entry_number", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "remove_entry",
      description:
        "Remove an entry by its number (#1, #2, etc.). Works for any date and both food and sleep logs. For past dates, use get_entries first to see the entries, then ALWAYS ask the user for explicit confirmation before removing.",
      parameters: {
        type: "object",
        properties: {
          log_type: {
            type: "string",
            enum: ["food", "sleep"],
            description: "Which log to remove from (default: food)",
          },
          date: {
            type: "string",
            description:
              "Date of the entry in yyyy-mm-dd format. Omit for today.",
          },
          entry_number: {
            type: "number",
            description: "The entry number from today's log (1-based)",
          },
          message: {
            type: "string",
            description: "Confirmation message to show the user",
          },
        },
        required: ["entry_number", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "search",
      description:
        "Search the web for current information via Perplexity. Use for nutrition facts, calorie counts for unfamiliar foods, health research, or any question needing up-to-date data. Results come back to you to synthesize into a response.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query",
          },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "ask_claude",
      description:
        "Ask Claude for analysis or information. Claude has access to all the user's food log CSV files, chat history, and web search. Use for complex questions about eating patterns, trends, detailed nutritional analysis, or research that requires reading the data files.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question for Claude, including any relevant context",
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "tell_claude",
      description:
        "Instruct Claude to perform an action. Claude has full bash access, can read/write files, run scripts, and search the web. Use for tasks like: generating reports across multiple days, creating summaries, modifying data, or any task requiring file access or computation that you cannot do yourself.",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description: "What Claude should do, with full context",
          },
        },
        required: ["instruction"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_target",
      description: "Update the user's daily calorie target.",
      parameters: {
        type: "object",
        properties: {
          daily_calories: {
            type: "number",
            description: "New daily calorie target",
          },
          message: {
            type: "string",
            description: "Confirmation message to show the user",
          },
        },
        required: ["daily_calories", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_timezone",
      description: "Update the user's timezone.",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description:
              "IANA timezone string, e.g. Asia/Hong_Kong, Asia/Kolkata",
          },
          message: {
            type: "string",
            description: "Confirmation message to show the user",
          },
        },
        required: ["timezone", "message"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_entries",
      description:
        "Retrieve log entries for a date range. Returns CSV data for all entries between start_date and end_date (inclusive). Works for both food and sleep logs — set log_type accordingly.",
      parameters: {
        type: "object",
        properties: {
          log_type: {
            type: "string",
            enum: ["food", "sleep"],
            description: "Which log to query (default: food)",
          },
          start_date: {
            type: "string",
            description: "Start date in yyyy-mm-dd format",
          },
          end_date: {
            type: "string",
            description: "End date in yyyy-mm-dd format",
          },
        },
        required: ["start_date", "end_date"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "grep_logs",
      description:
        "Search all log entries for a text pattern (case-insensitive). Returns matching entries with their dates. Works for both food and sleep logs — set log_type accordingly.",
      parameters: {
        type: "object",
        properties: {
          log_type: {
            type: "string",
            enum: ["food", "sleep"],
            description: "Which log to search (default: food)",
          },
          pattern: {
            type: "string",
            description:
              "Text to search for (e.g. 'pizza', 'vitamin', 'nap', 'night')",
          },
        },
        required: ["pattern"],
      },
    },
  },
];

// --- Types ---

export type OrchestratorResult =
  | {
      type: "log_food";
      entries: Array<{
        food_item: string;
        quantity: number;
        unit: string;
        calories: number;
        notes?: string;
      }>;
      timestamp?: string;
      message: string;
    }
  | {
      type: "log_sleep";
      entry: {
        type: "night" | "nap";
        start_time: string;
        end_time: string;
        quality: number;
        notes?: string;
      };
      message: string;
    }
  | {
      type: "edit_entry";
      log_type: "food" | "sleep";
      date?: string;
      entry_number: number;
      updates: Record<string, unknown>;
      message: string;
    }
  | {
      type: "remove_entry";
      log_type: "food" | "sleep";
      date?: string;
      entry_number: number;
      message: string;
    }
  | { type: "ask_claude"; question: string }
  | { type: "tell_claude"; instruction: string }
  | { type: "set_target"; daily_calories: number; message: string }
  | { type: "set_timezone"; timezone: string; message: string }
  | { type: "message"; text: string };

interface ToolCall {
  id: string;
  type: string;
  function: {
    name: string;
    arguments: string;
  };
}

interface ChatChoice {
  message: {
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface ChatResponse {
  choices: ChatChoice[];
}

// --- Context builder ---

export interface OrchestratorContext {
  todayLog: FoodEntry[];
  todayCalories: number;
  dailyTarget: number;
  timezone: string;
  knownFoods: Record<string, NutritionInfo>;
  chatHistory: ChatMessage[];
  logsDir: string;
  userId: string;
  todaySleep: SleepEntry[];
}

function buildContextBlock(ctx: OrchestratorContext): string {
  const now = new Date();
  const timeStr = now.toLocaleString("en-US", {
    timeZone: ctx.timezone,
    dateStyle: "medium",
    timeStyle: "short",
  });

  const pct = Math.round((ctx.todayCalories / ctx.dailyTarget) * 100);

  const todayLogStr =
    ctx.todayLog.length > 0
      ? ctx.todayLog
          .map((e, i) => {
            const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
              timeZone: ctx.timezone,
              hour: "2-digit",
              minute: "2-digit",
            });
            return `  #${i + 1}  ${time} — ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
          })
          .join("\n")
      : "  (nothing logged yet)";

  const knownFoodsEntries = Object.entries(ctx.knownFoods);
  const knownFoodsStr =
    knownFoodsEntries.length > 0
      ? knownFoodsEntries
          .slice(0, 50)
          .map(
            ([name, info]) =>
              `  ${name}: ${info.calories} cal per ${info.quantity} ${info.unit}`,
          )
          .join("\n")
      : "";

  const historyStr =
    ctx.chatHistory.length > 0
      ? ctx.chatHistory
          .slice(-10)
          .map((m) => `[${m.role}] ${m.text}`)
          .join("\n")
      : "";

  const lastEntry = ctx.todayLog[ctx.todayLog.length - 1];
  let lastFoodAgo = "";
  if (lastEntry) {
    const mins = Math.round(
      (Date.now() - new Date(lastEntry.timestamp).getTime()) / 60000,
    );
    if (mins < 60) lastFoodAgo = `Last food logged: ${mins} minutes ago`;
    else
      lastFoodAgo = `Last food logged: ${Math.round(mins / 60)} hours ago`;
  }

  // Build sleep summary
  const todaySleepStr =
    ctx.todaySleep.length > 0
      ? ctx.todaySleep
          .map((s, i) => {
            const bedTime = new Date(s.start_time).toLocaleTimeString("en-US", {
              timeZone: ctx.timezone,
              hour: "2-digit",
              minute: "2-digit",
            });
            const wakeTime = new Date(s.end_time).toLocaleTimeString("en-US", {
              timeZone: ctx.timezone,
              hour: "2-digit",
              minute: "2-digit",
            });
            return `  #${i + 1}  ${s.type === "night" ? "Night" : "Nap"}: ${bedTime} → ${wakeTime} (${s.duration_hours}h, quality: ${s.quality}/10)${s.notes ? ` — ${s.notes}` : ""}`;
          })
          .join("\n")
      : "  (no sleep logged today)";

  const parts = [
    `Current time (HKT): ${timeStr}`,
    `Daily target: ${ctx.dailyTarget} cal`,
    `Today's intake: ${ctx.todayCalories} cal (${pct}%)`,
    lastFoodAgo,
    "",
    "Today's food log:",
    todayLogStr,
    "",
    "Today's sleep log:",
    todaySleepStr,
  ];

  if (knownFoodsStr) {
    parts.push("", "Known foods (use these calorie values):", knownFoodsStr);
  }

  if (historyStr) {
    parts.push("", "Recent conversation:", historyStr);
  }

  // Show available date files so the LLM knows what data exists
  if (ctx.logsDir) {
    const dateFiles = listCsvFiles(ctx.logsDir);
    if (dateFiles.length > 0) {
      const dates = dateFiles.map((f) => path.basename(f, ".csv"));
      parts.push("", `Available food dates (${dates.length} files): ${dates.join(", ")}`);
    }
    const sleepFiles = listSleepCsvFiles(ctx.userId);
    if (sleepFiles.length > 0) {
      parts.push(`Available sleep files: ${sleepFiles.join(", ")}`);
    }
  }

  return parts.filter((l) => l !== undefined).join("\n");
}

// --- File helpers for log exploration ---

function listCsvFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  function walk(d: string, prefix: string): void {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(d, entry.name), rel);
      else if (entry.name.endsWith(".csv")) results.push(rel);
    }
  }
  walk(dir, "");
  return results.sort();
}

function readCsvEntries(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  return lines.slice(1); // skip header
}

function getEntriesForDateRange(
  logsDir: string,
  startDate: string,
  endDate: string,
): string {
  const files = listCsvFiles(logsDir);
  const results: string[] = [];
  for (const f of files) {
    const datePart = path.basename(f, ".csv"); // yyyy-mm-dd
    if (datePart >= startDate && datePart <= endDate) {
      const entries = readCsvEntries(path.join(logsDir, f));
      if (entries.length > 0) {
        results.push(`--- ${datePart} ---`);
        results.push(...entries);
      }
    }
  }
  return results.length > 0
    ? `timestamp,food_item,quantity,unit,calories,notes\n${results.join("\n")}`
    : "No entries found for this date range.";
}

function grepLogs(logsDir: string, pattern: string): string {
  const files = listCsvFiles(logsDir);
  const lower = pattern.toLowerCase();
  const results: string[] = [];
  for (const f of files) {
    const datePart = path.basename(f, ".csv");
    const entries = readCsvEntries(path.join(logsDir, f));
    for (const line of entries) {
      if (line.toLowerCase().includes(lower)) {
        results.push(`[${datePart}] ${line}`);
      }
    }
  }
  return results.length > 0
    ? results.slice(0, 50).join("\n") + (results.length > 50 ? `\n... and ${results.length - 50} more` : "")
    : `No entries matching "${pattern}".`;
}

// --- Web search via Perplexity ---

async function searchWeb(query: string): Promise<string> {
  const apiKey = process.env.PERPLEXITY_API_KEY;
  if (!apiKey) return "Search unavailable: PERPLEXITY_API_KEY not set.";

  log("DEBUG", `Searching: "${query}"`);

  try {
    const res = await fetch("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar-pro",
        messages: [{ role: "user", content: query }],
      }),
    });

    if (!res.ok) return `Search failed (${res.status}).`;

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const result = data.choices?.[0]?.message?.content ?? "No results found.";
    log("DEBUG", `Search result: ${result.length} chars`);
    return result;
  } catch (err) {
    log("ERROR", `Search error: ${(err as Error).message}`);
    return "Search failed.";
  }
}

// --- Main ---

export async function processMessage(
  userMessage: string,
  context: OrchestratorContext,
  apiKey: string,
): Promise<OrchestratorResult> {
  const contextBlock = buildContextBlock(context);
  const fullUserContent = `--- Context ---\n${contextBlock}\n\n--- New message ---\n${userMessage}`;

  log(
    "DEBUG",
    `Calling OpenRouter: model=${MODEL}, input=${fullUserContent.length} chars`,
  );

  // Build message array for multi-turn tool calling
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: fullUserContent },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch(OPENROUTER_URL, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log("ERROR", `OpenRouter ${res.status}: ${body.slice(0, 500)}`);
      throw new Error(
        `OpenRouter API error ${res.status}: ${body.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as ChatResponse;
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("OpenRouter returned empty choices array");
    }

    const calls = choice.message.tool_calls;
    if (calls && calls.length > 0) {
      const call = calls[0];
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(call.function.arguments);
      } catch {
        throw new Error("LLM returned invalid tool call arguments");
      }

      // --- Multi-turn tools (feed results back to LLM) ---
      if (call.function.name === "search") {
        const searchResult = await searchWeb(parsed.query as string);
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [call],
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: searchResult,
        });
        continue;
      }

      if (call.function.name === "get_entries") {
        const logType = (parsed.log_type as string) || "food";
        const result =
          logType === "sleep"
            ? getSleepEntriesForDateRange(
                context.userId,
                parsed.start_date as string,
                parsed.end_date as string,
              )
            : getEntriesForDateRange(
                context.logsDir,
                parsed.start_date as string,
                parsed.end_date as string,
              );
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [call],
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
        continue;
      }

      if (call.function.name === "grep_logs") {
        const logType = (parsed.log_type as string) || "food";
        const result =
          logType === "sleep"
            ? grepSleepLogs(context.userId, parsed.pattern as string)
            : grepLogs(context.logsDir, parsed.pattern as string);
        messages.push({
          role: "assistant",
          content: null,
          tool_calls: [call],
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: result,
        });
        continue;
      }

      // --- All other tools: return result to handler ---
      switch (call.function.name) {
        case "log_food": {
          const entries = parsed.entries as Array<{
            food_item: string;
            quantity: number;
            unit: string;
            calories: number;
            notes?: string;
          }>;
          return {
            type: "log_food",
            entries,
            timestamp: (parsed.timestamp as string) || undefined,
            message: (parsed.message as string) || "Logged!",
          };
        }

        case "log_sleep": {
          return {
            type: "log_sleep",
            entry: {
              type: (parsed.type as "night" | "nap") || "night",
              start_time: parsed.start_time as string,
              end_time: parsed.end_time as string,
              quality: parsed.quality as number,
              notes: (parsed.notes as string) || undefined,
            },
            message: (parsed.message as string) || "Sleep logged!",
          };
        }

        case "edit_entry": {
          const updates: Record<string, unknown> = {};
          const logType = ((parsed.log_type as string) || "food") as "food" | "sleep";
          if (logType === "sleep") {
            if (parsed.sleep_type !== undefined) updates.type = parsed.sleep_type;
            if (parsed.start_time !== undefined) updates.start_time = parsed.start_time;
            if (parsed.end_time !== undefined) updates.end_time = parsed.end_time;
            if (parsed.quality !== undefined) updates.quality = parsed.quality;
            if (parsed.notes !== undefined) updates.notes = parsed.notes;
          } else {
            if (parsed.food_item !== undefined) updates.food_item = parsed.food_item;
            if (parsed.quantity !== undefined) updates.quantity = parsed.quantity;
            if (parsed.unit !== undefined) updates.unit = parsed.unit;
            if (parsed.calories !== undefined) updates.calories = parsed.calories;
            if (parsed.timestamp !== undefined) updates.timestamp = parsed.timestamp;
          }

          return {
            type: "edit_entry",
            log_type: logType,
            date: (parsed.date as string) || undefined,
            entry_number: parsed.entry_number as number,
            updates,
            message: (parsed.message as string) || "Updated!",
          };
        }

        case "remove_entry":
          return {
            type: "remove_entry",
            log_type: ((parsed.log_type as string) || "food") as "food" | "sleep",
            date: (parsed.date as string) || undefined,
            entry_number: parsed.entry_number as number,
            message: (parsed.message as string) || "Removed!",
          };

        case "ask_claude":
          return {
            type: "ask_claude",
            question: parsed.question as string,
          };

        case "tell_claude":
          return {
            type: "tell_claude",
            instruction: parsed.instruction as string,
          };

        case "set_target":
          return {
            type: "set_target",
            daily_calories: parsed.daily_calories as number,
            message: (parsed.message as string) || "Target updated!",
          };

        case "set_timezone":
          return {
            type: "set_timezone",
            timezone: parsed.timezone as string,
            message: (parsed.message as string) || "Timezone updated!",
          };
      }
    }

    // No tool calls — plain text response
    return {
      type: "message",
      text:
        choice.message.content ??
        "Hey! Tell me what you ate and I'll log it for you.",
    };
  }

  // Exceeded max tool rounds
  return {
    type: "message",
    text: "I wasn't able to complete that. Could you try rephrasing?",
  };
}
