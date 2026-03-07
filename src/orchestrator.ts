/**
 * LLM orchestrator for food-agent.
 *
 * Classifies user intent, parses food input, cross-questions for
 * missing info, handles edits to existing entries, and routes
 * complex queries to Claude CLI.
 * Uses OpenRouter (Gemini Flash) for fast, cheap inference.
 */

import type { FoodEntry, NutritionInfo, ChatMessage } from "./types.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = process.env.ORCHESTRATOR_MODEL || "google/gemini-3.1-flash-lite-preview";

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
Today's log shows entries numbered #1, #2, #3, etc. (resets daily). When the user wants to change a logged entry:
- Use edit_entry with the entry number and the updated fields
- The user might say "change #2 to 3 eggs", "the toast was actually 120 cal", "that should be chicken not fish", etc.
- They can also correct time: "I had #3 at 2pm not 1pm", "#1 was at 8:30 this morning"
- Match the user's description to the correct entry number from today's log
- If changing quantity, ALWAYS recalculate and provide updated calories
- If unsure which entry they mean, ask for clarification
- Only include fields that are changing — omit unchanged fields

When the user wants to remove an entry:
- Use remove_entry with the entry number
- The user might say "remove #3", "delete the toast", "I didn't actually have the biryani"

QUESTIONS:
- Simple questions about today/recent data: answer directly from the context provided
- Complex analysis (weekly trends, patterns, detailed nutrition research): use deep_question to route to a research assistant with web search
- When using deep_question, include full context in the question so the research assistant has everything it needs

TARGETS:
- When user wants to change their daily calorie target, use set_target
- When user wants to change timezone, use set_timezone

CHECK-INS:
- When you see [CHECK-IN], generate a brief, natural check-in message
- Vary your messages — never repeat the same wording
- Reference time of day, today's intake, time since last food
- Keep it casual and human: "Hey! Had anything since that sandwich?" not "REMINDER: Please log your food intake"
- If they're behind on calories, encourage eating; if on track, acknowledge it
- Sometimes just ask how their day is going — don't always lead with food
- If it's meal time and they haven't logged, gently note it`;

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
                    "Unit: piece, slice, cup, bowl, plate, gram, ml, serving, tbsp, tsp",
                },
                calories: {
                  type: "number",
                  description: "Total calories for this quantity",
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
              "ISO 8601 timestamp. Only set if user specified a time, otherwise omit for current time.",
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
      name: "edit_entry",
      description:
        "Edit an existing entry in today's food log by its daily number (#1, #2, etc.).",
      parameters: {
        type: "object",
        properties: {
          entry_number: {
            type: "number",
            description: "The entry number from today's log (1-based)",
          },
          food_item: {
            type: "string",
            description: "Updated food name (omit to keep current)",
          },
          quantity: {
            type: "number",
            description: "Updated quantity (omit to keep current)",
          },
          unit: {
            type: "string",
            description: "Updated unit (omit to keep current)",
          },
          calories: {
            type: "number",
            description:
              "Updated total calories for the new quantity. MUST be provided if quantity changes.",
          },
          timestamp: {
            type: "string",
            description:
              "Updated timestamp as ISO 8601 with timezone offset (e.g. 2026-03-07T13:00:00+08:00). Use to correct when the user ate.",
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
        "Remove an entry from today's food log by its daily number (#1, #2, etc.).",
      parameters: {
        type: "object",
        properties: {
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
      name: "deep_question",
      description:
        "Route complex questions to a research assistant with web search. Use for nutrition research, weekly analysis, trend spotting, or any question requiring deeper analysis beyond what's in the provided context.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The full question with context for the research assistant",
          },
        },
        required: ["question"],
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
      type: "edit_entry";
      entry_number: number;
      updates: {
        food_item?: string;
        quantity?: number;
        unit?: string;
        calories?: number;
        timestamp?: string;
      };
      message: string;
    }
  | { type: "remove_entry"; entry_number: number; message: string }
  | { type: "deep_question"; question: string }
  | { type: "set_target"; daily_calories: number; message: string }
  | { type: "set_timezone"; timezone: string; message: string }
  | { type: "message"; text: string };

interface ChatChoice {
  message: {
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
    }>;
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

  const parts = [
    `Current time (HKT): ${timeStr}`,
    `Daily target: ${ctx.dailyTarget} cal`,
    `Today's intake: ${ctx.todayCalories} cal (${pct}%)`,
    lastFoodAgo,
    "",
    "Today's log:",
    todayLogStr,
  ];

  if (knownFoodsStr) {
    parts.push("", "Known foods (use these calorie values):", knownFoodsStr);
  }

  if (historyStr) {
    parts.push("", "Recent conversation:", historyStr);
  }

  return parts.filter((l) => l !== undefined).join("\n");
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

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: fullUserContent },
      ],
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

      case "edit_entry": {
        const updates: Record<string, unknown> = {};
        if (parsed.food_item !== undefined) updates.food_item = parsed.food_item;
        if (parsed.quantity !== undefined) updates.quantity = parsed.quantity;
        if (parsed.unit !== undefined) updates.unit = parsed.unit;
        if (parsed.calories !== undefined) updates.calories = parsed.calories;
        if (parsed.timestamp !== undefined) {
          updates.timestamp = parsed.timestamp as string;
        }

        return {
          type: "edit_entry",
          entry_number: parsed.entry_number as number,
          updates: updates as {
            food_item?: string;
            quantity?: number;
            unit?: string;
            calories?: number;
            timestamp?: string;
          },
          message: (parsed.message as string) || "Updated!",
        };
      }

      case "remove_entry":
        return {
          type: "remove_entry",
          entry_number: parsed.entry_number as number,
          message: (parsed.message as string) || "Removed!",
        };

      case "deep_question":
        return {
          type: "deep_question",
          question: parsed.question as string,
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

  return {
    type: "message",
    text:
      choice.message.content ??
      "Hey! Tell me what you ate and I'll log it for you.",
  };
}
