/**
 * Interactive CLI for food-agent.
 * Same brain as the Telegram bot, but runs in the terminal.
 *
 * Usage:
 *   npm run cli                    Interactive REPL (default user: "cli")
 *   npm run cli -- --user <id>     Use a specific user ID (to share data with Telegram)
 *   npm run cli -- log "2 eggs"    One-shot: log food and exit
 *   npm run cli -- today           One-shot: show today's summary
 *   npm run cli -- week            One-shot: show week summary
 *   npm run cli -- undo            One-shot: remove last entry
 *   npm run cli -- ask "question"  One-shot: ask a question
 */

import "dotenv/config";
import readline from "readline";
import { resolveOpenRouterKey } from "./settings.js";
import { processMessage, SYSTEM_PROMPT, type OrchestratorContext } from "./orchestrator.js";
import {
  getCurrentStep,
  advanceStep,
  startOnboarding,
  restartOnboarding,
  skipOnboarding,
  getOnboardingState,
  getOnboardingStatusText,
  getCompletionMessage,
  buildOnboardingSystemPrompt,
} from "./onboarding.js";
import { askAboutFoodData, clearSession } from "./claude.js";
import {
  appendEntries,
  removeLastEntry,
  updateTodayEntry,
  removeTodayEntry,
  updateEntryByDate,
  removeEntryByDate,
  getTodayEntries,
  getEntriesForDays,
  getLogDirPath,
  nowTZ,
  extractTime,
} from "./food-log.js";
import { loadNutritionDB, addFood } from "./nutrition-db.js";
import { getTarget, setTarget } from "./targets.js";
import { getHistory, addMessage, clearHistory } from "./history.js";
import {
  appendSleepEntry,
  getTodaySleep,
  updateSleepEntry,
  removeSleepEntry,
} from "./sleep-log.js";
import { appendNote, getTodayNotes, updateTodayNote, removeTodayNote, updateNoteByDate, removeNoteByDate } from "./notes-log.js";
import { appendWeight, updateWeight, removeWeight } from "./weight-log.js";
import { appendNutritionLabel, updateNutritionLabel, removeNutritionLabel, getAllNutritionLabels } from "./nutrition-labels.js";
import { addProfileFact, removeProfileFact } from "./profile.js";
import type { FoodEntry, SleepEntry } from "./types.js";

// --- Helpers ---

function print(text: string): void {
  console.log(text);
}

function printBold(text: string): void {
  console.log(`\x1b[1m${text}\x1b[0m`);
}

function printDim(text: string): void {
  console.log(`\x1b[2m${text}\x1b[0m`);
}

function formatNumberedEntries(entries: FoodEntry[]): string {
  return entries
    .map((e, i) => {
      return `  #${i + 1}  ${extractTime(e.timestamp)} — ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
    })
    .join("\n");
}

function formatTodaySummary(
  entries: FoodEntry[],
  target: number,
  timezone: string,
): string {
  if (entries.length === 0) {
    return `Nothing logged today yet. Target: ${target} cal.`;
  }

  const total = entries.reduce((sum, e) => sum + e.calories, 0);
  const pct = Math.round((total / target) * 100);

  const lines = [formatNumberedEntries(entries)];
  lines.push("");
  lines.push(`Total: ${total} / ${target} cal (${pct}%)`);

  const remaining = target - total;
  if (remaining > 0) {
    lines.push(`${remaining} cal remaining`);
  } else {
    lines.push(`${Math.abs(remaining)} cal over target`);
  }

  return lines.join("\n");
}

// --- Core processing ---

async function processInput(
  userId: string,
  input: string,
  openrouterKey: string,
): Promise<void> {
  addMessage(userId, "user", input);

  const target = getTarget(userId);
  const todayEntries = getTodayEntries(userId, target.timezone);
  const todayCalories = todayEntries.reduce((sum, e) => sum + e.calories, 0);
  const knownFoods = loadNutritionDB();
  const history = getHistory(userId);

  const context: OrchestratorContext = {
    todayLog: todayEntries,
    todayCalories,
    dailyTarget: target.daily_calories,
    timezone: target.timezone,
    knownFoods,
    chatHistory: history,
    logsDir: getLogDirPath(userId),
    userId,
    todaySleep: getTodaySleep(userId, target.timezone),
    todayNotes: getTodayNotes(userId, target.timezone),
  };

  // Onboarding system prompt override
  const onboardingStep = getCurrentStep(userId);
  const systemPrompt = onboardingStep
    ? buildOnboardingSystemPrompt(onboardingStep, SYSTEM_PROMPT)
    : undefined;

  let result;
  try {
    result = await processMessage(input, context, openrouterKey, systemPrompt);
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return;
  }

  switch (result.type) {
    case "log_food": {
      const now = result.timestamp || nowTZ(target.timezone);
      const entries: FoodEntry[] = result.entries.map((e) => ({
        timestamp: now,
        food_item: e.food_item,
        quantity: e.quantity,
        unit: e.unit,
        calories: e.calories,
        notes: e.notes || "",
      }));

      appendEntries(userId, entries);

      for (const entry of entries) {
        if (entry.quantity > 0) {
          addFood(entry.food_item, {
            calories: Math.round(entry.calories / entry.quantity),
            unit: entry.unit,
            quantity: 1,
          });
        }
      }

      // Show LLM message + structured entries with daily numbers
      print(result.message);
      const updatedToday = getTodayEntries(userId, target.timezone);
      const startNum = updatedToday.length - entries.length + 1;
      const entryLines = entries
        .map((e, i) => {
          return `  #${startNum + i}  ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
        })
        .join("\n");
      const total = updatedToday.reduce((sum, e) => sum + e.calories, 0);
      const pct = Math.round((total / target.daily_calories) * 100);
      print(`\n${entryLines}\n  Today: ${total}/${target.daily_calories} cal (${pct}%)`);

      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_sleep": {
      const startMs = new Date(result.entry.start_time).getTime();
      const endMs = new Date(result.entry.end_time).getTime();
      const durationHours =
        Math.round(((endMs - startMs) / 3600000) * 10) / 10;
      const today = new Date()
        .toLocaleDateString("en-CA", { timeZone: target.timezone });
      const sleepEntry: SleepEntry = {
        date: today,
        type: result.entry.type,
        start_time: result.entry.start_time,
        end_time: result.entry.end_time,
        duration_hours: durationHours,
        quality: result.entry.quality,
        notes: result.entry.notes || "",
      };
      appendSleepEntry(userId, sleepEntry);
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_note": {
      appendNote(userId, { timestamp: nowTZ(target.timezone), note: result.note }, target.timezone);
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_weight": {
      appendWeight(userId, {
        timestamp: nowTZ(target.timezone),
        weight_kg: result.weight_kg,
        notes: result.notes || "",
      });
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_nutrition_label": {
      appendNutritionLabel(userId, {
        timestamp: nowTZ(target.timezone),
        ...result.entry,
      });
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "edit_entry": {
      const editDate =
        result.date ||
        new Date().toLocaleDateString("en-CA", { timeZone: target.timezone });

      let editMsg = "";

      if (result.log_type === "sleep") {
        const updated = updateSleepEntry(userId, editDate, result.entry_number, result.updates as Partial<SleepEntry>);
        if (updated) {
          const dur = updated.duration_hours ? `${updated.duration_hours}h` : "";
          const qual = updated.quality ? `quality ${updated.quality}/10` : "";
          editMsg = `${result.message}\n\n✏️ Sleep #${result.entry_number} now:\n😴 ${updated.start_time ? extractTime(updated.start_time) : "?"} → ${updated.end_time ? extractTime(updated.end_time) : "?"}${dur ? ` (${dur})` : ""}${qual ? ` · ${qual}` : ""}${updated.notes ? ` · ${updated.notes}` : ""}`;
        } else {
          editMsg = `Couldn't find sleep entry #${result.entry_number} on ${editDate}.`;
        }
      } else if (result.log_type === "notes") {
        const noteUpdates = result.updates as { note?: string };
        const updated = result.date
          ? updateNoteByDate(userId, editDate, result.entry_number, noteUpdates)
          : updateTodayNote(userId, result.entry_number, noteUpdates, target.timezone);
        if (updated) {
          editMsg = `${result.message}\n\n✏️ Note #${result.entry_number} now:\n📝 ${updated.note}`;
        } else {
          editMsg = `Couldn't find note #${result.entry_number} on ${editDate}.`;
        }
      } else if (result.log_type === "weight") {
        const updated = updateWeight(userId, result.entry_number, result.updates as { weight_kg?: number; notes?: string });
        if (updated) {
          editMsg = `${result.message}\n\n✏️ Weight #${result.entry_number} now:\n⚖️ ${updated.weight_kg} kg${updated.notes ? ` · ${updated.notes}` : ""}`;
        } else {
          editMsg = `Couldn't find weight entry #${result.entry_number}.`;
        }
      } else if (result.log_type === "nutrition_labels") {
        const updated = updateNutritionLabel(userId, result.entry_number, result.updates as Record<string, unknown>);
        if (updated) {
          const allLabels = getAllNutritionLabels(userId);
          const verified = result.entry_number <= allLabels.length ? allLabels[result.entry_number - 1] : updated;
          editMsg = `${result.message}\n\n✏️ Label #${result.entry_number} now:\n🏷 ${verified.product_name}${verified.brand ? ` (${verified.brand})` : ""}\nServing: ${verified.serving_size} (${verified.serving_size_g}g)\nPer 100g: ${verified.calories_per_100g} cal · P${verified.protein_per_100g}g · C${verified.carbs_per_100g}g · F${verified.fat_per_100g}g\nSugar ${verified.sugar_per_100g}g · Fiber ${verified.fiber_per_100g}g · Sodium ${verified.sodium_per_100g}mg${verified.notes ? `\n${verified.notes}` : ""}`;
        } else {
          editMsg = `Couldn't find nutrition label #${result.entry_number}.`;
        }
      } else {
        const updates: Partial<FoodEntry> = result.updates as Partial<FoodEntry>;
        const updated = result.date
          ? updateEntryByDate(userId, editDate, result.entry_number, updates)
          : updateTodayEntry(userId, result.entry_number, updates, target.timezone);
        if (updated) {
          if (updated.quantity > 0) {
            addFood(updated.food_item, {
              calories: Math.round(updated.calories / updated.quantity),
              unit: updated.unit,
              quantity: 1,
            });
          }
          editMsg = `${result.message}\n\n✏️ Entry #${result.entry_number} now:\n🍽 ${updated.food_item} — ${updated.quantity} ${updated.unit} · ${updated.calories} cal`;
        } else {
          editMsg = `Couldn't find entry #${result.entry_number} on ${editDate}.`;
        }
      }
      print(editMsg);
      addMessage(userId, "assistant", editMsg);
      break;
    }

    case "remove_entry": {
      const removeDate =
        result.date ||
        new Date().toLocaleDateString("en-CA", { timeZone: target.timezone });

      if (result.log_type === "sleep") {
        const removed = removeSleepEntry(userId, removeDate, result.entry_number);
        print(removed ? result.message : `Couldn't find sleep entry #${result.entry_number} on ${removeDate}.`);
      } else if (result.log_type === "notes") {
        const removed = result.date
          ? removeNoteByDate(userId, removeDate, result.entry_number)
          : removeTodayNote(userId, result.entry_number, target.timezone);
        print(removed ? result.message : `Couldn't find note #${result.entry_number} on ${removeDate}.`);
      } else if (result.log_type === "weight") {
        const removed = removeWeight(userId, result.entry_number);
        print(removed ? result.message : `Couldn't find weight entry #${result.entry_number}.`);
      } else if (result.log_type === "nutrition_labels") {
        const removed = removeNutritionLabel(userId, result.entry_number);
        print(removed ? result.message : `Couldn't find nutrition label #${result.entry_number}.`);
      } else {
        const removed = result.date
          ? removeEntryByDate(userId, removeDate, result.entry_number)
          : removeTodayEntry(userId, result.entry_number, target.timezone);
        print(removed ? result.message : `Couldn't find entry #${result.entry_number} on ${removeDate}.`);
      }
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "ask_claude":
    case "tell_claude": {
      const prompt = result.type === "ask_claude" ? result.question : result.instruction;
      printDim("Thinking...");
      try {
        const logsDir = getLogDirPath(userId);
        const answer = await askAboutFoodData(userId, logsDir, prompt, target.timezone);
        print(answer);
        addMessage(userId, "assistant", `[claude]\n${answer}`);
      } catch (err) {
        print(`Error: ${(err as Error).message}`);
      }
      break;
    }

    case "set_target": {
      setTarget(userId, { daily_calories: result.daily_calories });
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "set_timezone": {
      setTarget(userId, { timezone: result.timezone });
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "save_profile": {
      addProfileFact(userId, result.fact);
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "remove_profile_fact": {
      removeProfileFact(userId, result.fact_number);
      print(result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "message": {
      print(result.text);
      addMessage(userId, "assistant", result.text);
      break;
    }
  }

  // Onboarding step completion check
  if (onboardingStep && onboardingStep.completionCheck(result.type)) {
    const newState = advanceStep(userId);
    if (newState.completedAt) {
      print(getCompletionMessage());
    } else {
      const nextStep = getCurrentStep(userId);
      if (nextStep) print(nextStep.introMessage);
    }
  }
}

// --- Command handlers ---

function handleToday(userId: string): void {
  const target = getTarget(userId);
  const entries = getTodayEntries(userId, target.timezone);
  print(formatTodaySummary(entries, target.daily_calories, target.timezone));
}

function handleWeek(userId: string): void {
  const target = getTarget(userId);
  const entries = getEntriesForDays(userId, 7);
  if (entries.length === 0) {
    print("No entries in the last 7 days.");
    return;
  }

  const byDate = new Map<string, FoodEntry[]>();
  for (const e of entries) {
    const date = new Date(e.timestamp).toLocaleDateString("en-CA", {
      timeZone: target.timezone,
    });
    const arr = byDate.get(date) ?? [];
    arr.push(e);
    byDate.set(date, arr);
  }

  const lines: string[] = ["This week:", ""];
  let weekTotal = 0;
  for (const [date, dayEntries] of byDate) {
    const dayTotal = dayEntries.reduce((s, e) => s + e.calories, 0);
    weekTotal += dayTotal;
    const pct = Math.round((dayTotal / target.daily_calories) * 100);
    lines.push(`  ${date}: ${dayTotal} cal (${pct}%)`);
  }
  lines.push("");
  lines.push(
    `Weekly total: ${weekTotal} cal | Daily avg: ${Math.round(weekTotal / byDate.size)} cal`,
  );

  print(lines.join("\n"));
}

function handleUndo(userId: string): void {
  const removed = removeLastEntry(userId);
  if (removed) {
    print(
      `Removed: ${removed.food_item} (${removed.quantity} ${removed.unit}) — ${removed.calories} cal`,
    );
  } else {
    print("Nothing to undo — log is empty.");
  }
}

function handleTarget(userId: string, value: string): void {
  const cal = parseInt(value, 10);
  if (isNaN(cal) || cal < 500 || cal > 10000) {
    print("Target should be a number between 500 and 10000.");
    return;
  }
  const updated = setTarget(userId, { daily_calories: cal });
  print(`Daily target set to ${updated.daily_calories} cal.`);
}

function handleTz(userId: string, tz: string): void {
  try {
    new Date().toLocaleString("en-US", { timeZone: tz });
  } catch {
    print(`Invalid timezone: "${tz}". Use IANA format like Asia/Hong_Kong.`);
    return;
  }
  setTarget(userId, { timezone: tz });
  print(`Timezone set to ${tz}.`);
}

function printHelp(): void {
  print(`
Food Agent CLI

  Just type what you ate in plain language:
    > had 2 eggs and toast
    > chicken rice for lunch at 1pm

  To edit, just say what to change:
    > change #1 to 3 eggs
    > the toast was 120 cal
    > remove #2

  Commands:
    /today              Today's food log
    /week               This week's summary
    /undo               Remove last entry
    /target <number>    Set daily calorie target
    /tz <timezone>      Set timezone
    /search <query>     Search the web (results saved to chat history)
    /claude <question>  Ask Claude directly (with access to all your data)
    /clear              Clear all memory (chat history + Claude session)
    /help               Show this message
    /quit               Exit

  One-shot mode:
    npm run cli -- today
    npm run cli -- week
    npm run cli -- undo
    npm run cli -- log "2 eggs and toast"
    npm run cli -- ask "how many calories this week?"
    npm run cli -- search "calories in biryani"
    npm run cli -- claude "analyze my eating patterns"
    npm run cli -- --user <telegram-id>   Share data with Telegram bot
`);
}

// --- REPL ---

async function startRepl(
  userId: string,
  openrouterKey: string,
): Promise<void> {
  const target = getTarget(userId);
  const todayEntries = getTodayEntries(userId, target.timezone);
  const todayCalories = todayEntries.reduce((sum, e) => sum + e.calories, 0);
  const pct = Math.round((todayCalories / target.daily_calories) * 100);

  printBold("Food Agent");
  printDim(
    `User: ${userId} | Today: ${todayCalories}/${target.daily_calories} cal (${pct}%) | /help for commands`,
  );
  print("");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "> ",
  });

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input === "/quit" || input === "/exit" || input === "/q") {
      rl.close();
      return;
    }

    if (input === "/help" || input === "/h") {
      printHelp();
      rl.prompt();
      return;
    }

    if (input === "/today") {
      handleToday(userId);
      rl.prompt();
      return;
    }

    if (input === "/week") {
      handleWeek(userId);
      rl.prompt();
      return;
    }

    if (input === "/undo") {
      handleUndo(userId);
      rl.prompt();
      return;
    }

    if (input.startsWith("/onboarding")) {
      const arg = input.replace("/onboarding", "").trim().toLowerCase();
      if (arg === "skip") {
        skipOnboarding(userId);
        print("Onboarding skipped. Use /help for a quick reference.");
      } else if (arg === "restart") {
        restartOnboarding(userId);
        const step = getCurrentStep(userId);
        if (step) print(step.introMessage);
      } else if (arg === "status") {
        print(getOnboardingStatusText(userId));
      } else {
        const state = getOnboardingState(userId);
        if (!state || state.completedAt || state.skipped) {
          startOnboarding(userId);
        }
        const step = getCurrentStep(userId);
        if (step) print(step.introMessage);
      }
      rl.prompt();
      return;
    }

    if (input === "/clear") {
      clearHistory(userId);
      clearSession(userId);
      print("Memory cleared — chat history and Claude session reset.");
      rl.prompt();
      return;
    }

    const targetMatch = input.match(/^\/target\s+(\d+)$/);
    if (targetMatch) {
      handleTarget(userId, targetMatch[1]);
      rl.prompt();
      return;
    }

    const tzMatch = input.match(/^\/tz\s+(.+)$/);
    if (tzMatch) {
      handleTz(userId, tzMatch[1].trim());
      rl.prompt();
      return;
    }

    const searchMatch = input.match(/^\/search\s+([\s\S]+)$/);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      addMessage(userId, "user", `/search ${query}`);
      printDim("Searching...");
      try {
        const apiKey = process.env.PERPLEXITY_API_KEY || process.env.OPENROUTER_API_KEY;
        if (!apiKey) throw new Error("No API key for search");

        const isPplx = !!process.env.PERPLEXITY_API_KEY;
        const url = isPplx
          ? "https://api.perplexity.ai/chat/completions"
          : "https://openrouter.ai/api/v1/chat/completions";
        const model = isPplx ? "sonar-pro" : "perplexity/sonar-pro-search";

        const res = await fetch(url, {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "user", content: query }],
          }),
        });

        if (!res.ok) throw new Error(`Search API error ${res.status}`);

        const data = (await res.json()) as {
          choices?: Array<{ message?: { content?: string } }>;
        };
        const result = data.choices?.[0]?.message?.content ?? "No results found.";
        print(result);
        addMessage(userId, "assistant", `[search: ${query}]\n${result}`);
      } catch (err) {
        print(`Error: ${(err as Error).message}`);
      }
      rl.prompt();
      return;
    }

    const claudeMatch = input.match(/^\/claude\s+([\s\S]+)$/);

    if (claudeMatch) {
      printDim("Asking Claude...");
      try {
        const logsDir = getLogDirPath(userId);
        const answer = await askAboutFoodData(userId, logsDir, claudeMatch[1].trim(), target.timezone);
        print(answer);
        addMessage(userId, "assistant", answer);
      } catch (err) {
        print(`Error: ${(err as Error).message}`);
      }
      rl.prompt();
      return;
    }

    // Everything else goes through the orchestrator
    await processInput(userId, input, openrouterKey);
    print("");
    rl.prompt();
  });

  rl.on("close", () => {
    print("\nBye!");
    process.exit(0);
  });
}

// --- Main ---

async function main(): Promise<void> {
  const openrouterKey = resolveOpenRouterKey();
  if (!openrouterKey) {
    console.error("No OpenRouter API key. Set OPENROUTER_API_KEY in .env.");
    process.exit(1);
  }

  const args = process.argv.slice(2);

  let userId = "cli";
  const userIdx = args.indexOf("--user");
  if (userIdx !== -1 && args[userIdx + 1]) {
    userId = args[userIdx + 1];
    args.splice(userIdx, 2);
  }

  const command = args[0];

  switch (command) {
    case "today":
      handleToday(userId);
      return;

    case "week":
      handleWeek(userId);
      return;

    case "undo":
      handleUndo(userId);
      return;

    case "log": {
      const text = args.slice(1).join(" ");
      if (!text) {
        console.error('Usage: npm run cli -- log "what you ate"');
        process.exit(1);
      }
      await processInput(userId, text, openrouterKey);
      return;
    }

    case "ask": {
      const q = args.slice(1).join(" ");
      if (!q) {
        console.error('Usage: npm run cli -- ask "your question"');
        process.exit(1);
      }
      await processInput(userId, q, openrouterKey);
      return;
    }

    case "target": {
      const val = args[1];
      if (!val) {
        const target = getTarget(userId);
        print(`Current target: ${target.daily_calories} cal/day`);
        return;
      }
      handleTarget(userId, val);
      return;
    }

    case "tz": {
      const tz = args[1];
      if (!tz) {
        const target = getTarget(userId);
        print(`Current timezone: ${target.timezone}`);
        return;
      }
      handleTz(userId, tz);
      return;
    }

    case "clear":
      clearHistory(userId);
      clearSession(userId);
      print("Memory cleared — chat history and Claude session reset.");
      return;

    case "search": {
      const sq = args.slice(1).join(" ");
      if (!sq) {
        console.error('Usage: npm run cli -- search "your query"');
        process.exit(1);
      }
      printDim("Searching...");
      const apiKey = process.env.PERPLEXITY_API_KEY || openrouterKey;
      const isPplx = !!process.env.PERPLEXITY_API_KEY;
      const searchRes = await fetch(
        isPplx ? "https://api.perplexity.ai/chat/completions" : "https://openrouter.ai/api/v1/chat/completions",
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: isPplx ? "sonar-pro" : "perplexity/sonar-pro-search",
            messages: [{ role: "user", content: sq }],
          }),
        },
      );
      if (!searchRes.ok) { console.error(`Search failed: ${searchRes.status}`); process.exit(1); }
      const searchData = (await searchRes.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const searchResult = searchData.choices?.[0]?.message?.content ?? "No results.";
      print(searchResult);
      addMessage(userId, "user", `/search ${sq}`);
      addMessage(userId, "assistant", `[search: ${sq}]\n${searchResult}`);
      return;
    }

    case "claude": {
      const q = args.slice(1).join(" ");
      if (!q) {
        console.error('Usage: npm run cli -- claude "your question"');
        process.exit(1);
      }
      printDim("Asking Claude...");
      const logsDir = getLogDirPath(userId);
      const answer = await askAboutFoodData(userId, logsDir, q, getTarget(userId).timezone);
      print(answer);
      return;
    }

    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    default:
      await startRepl(userId, openrouterKey);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
