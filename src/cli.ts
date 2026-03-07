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
import { processMessage, type OrchestratorContext } from "./orchestrator.js";
import { askAboutFoodData, clearSession } from "./claude.js";
import {
  appendEntries,
  removeLastEntry,
  updateTodayEntry,
  removeTodayEntry,
  getTodayEntries,
  getEntriesForDays,
  getLogDirPath,
  nowHKT,
} from "./food-log.js";
import { loadNutritionDB, addFood } from "./nutrition-db.js";
import { getTarget, setTarget } from "./targets.js";
import { getHistory, addMessage, clearHistory } from "./history.js";
import type { FoodEntry } from "./types.js";

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

function formatNumberedEntries(entries: FoodEntry[], timezone: string): string {
  return entries
    .map((e, i) => {
      const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
        timeZone: timezone,
        hour: "2-digit",
        minute: "2-digit",
      });
      return `  #${i + 1}  ${time} — ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
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

  const lines = [formatNumberedEntries(entries, timezone)];
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
  };

  let result;
  try {
    result = await processMessage(input, context, openrouterKey);
  } catch (err) {
    print(`Error: ${(err as Error).message}`);
    return;
  }

  switch (result.type) {
    case "log_food": {
      const now = result.timestamp || nowHKT();
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
          const time = new Date(e.timestamp).toLocaleTimeString("en-US", {
            timeZone: target.timezone,
            hour: "2-digit",
            minute: "2-digit",
          });
          return `  #${startNum + i}  ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
        })
        .join("\n");
      const total = updatedToday.reduce((sum, e) => sum + e.calories, 0);
      const pct = Math.round((total / target.daily_calories) * 100);
      print(`\n${entryLines}\n  Today: ${total}/${target.daily_calories} cal (${pct}%)`);

      addMessage(userId, "assistant", result.message);
      break;
    }

    case "edit_entry": {
      const updates: Partial<FoodEntry> = {};
      if (result.updates.food_item !== undefined)
        updates.food_item = result.updates.food_item;
      if (result.updates.quantity !== undefined)
        updates.quantity = result.updates.quantity;
      if (result.updates.unit !== undefined)
        updates.unit = result.updates.unit;
      if (result.updates.calories !== undefined)
        updates.calories = result.updates.calories;
      if (result.updates.timestamp !== undefined)
        updates.timestamp = result.updates.timestamp;

      if (updates.quantity !== undefined && updates.calories === undefined) {
        const entry = todayEntries[result.entry_number - 1];
        if (entry && entry.quantity > 0) {
          updates.calories = Math.round(
            (entry.calories / entry.quantity) * updates.quantity,
          );
        }
      }

      const updated = updateTodayEntry(
        userId,
        result.entry_number,
        updates,
        target.timezone,
      );

      if (updated) {
        if (updated.quantity > 0) {
          addFood(updated.food_item, {
            calories: Math.round(updated.calories / updated.quantity),
            unit: updated.unit,
            quantity: 1,
          });
        }
        print(result.message);
      } else {
        print(`Couldn't find entry #${result.entry_number} in today's log.`);
      }
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "remove_entry": {
      const removed = removeTodayEntry(
        userId,
        result.entry_number,
        target.timezone,
      );
      if (removed) {
        print(result.message);
      } else {
        print(`Couldn't find entry #${result.entry_number} in today's log.`);
      }
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "deep_question": {
      printDim("Thinking...");
      try {
        const logsDir = getLogDirPath(userId);
        const answer = await askAboutFoodData(
          userId,
          logsDir,
          result.question,
        );
        print(answer);
        addMessage(userId, "assistant", answer);
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

    case "message": {
      print(result.text);
      addMessage(userId, "assistant", result.text);
      break;
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

    const claudeMatch = input.match(/^\/claude\s+([\s\S]+)$/);
    if (claudeMatch) {
      printDim("Asking Claude...");
      try {
        const logsDir = getLogDirPath(userId);
        const answer = await askAboutFoodData(userId, logsDir, claudeMatch[1].trim());
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

    case "claude": {
      const q = args.slice(1).join(" ");
      if (!q) {
        console.error('Usage: npm run cli -- claude "your question"');
        process.exit(1);
      }
      printDim("Asking Claude...");
      const logsDir = getLogDirPath(userId);
      const answer = await askAboutFoodData(userId, logsDir, q);
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
