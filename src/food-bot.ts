/**
 * Food Agent — Telegram bot for tracking food and calories.
 *
 * Main entry point. Handles:
 * - Free-form food logging via LLM orchestrator
 * - Natural language editing ("change #2 to 3 eggs")
 * - Cross-questioning for missing info
 * - Daily/weekly summaries
 * - Proactive check-ins every 30 minutes
 * - Deep Q&A via Claude CLI
 */

import "dotenv/config";
import TelegramBot from "node-telegram-bot-api";
import { resolveBotToken, resolveOpenRouterKey } from "./settings.js";
import {
  isUserAllowed,
  upsertPairingRequest,
  buildPairingMessage,
  listApprovedUsers,
} from "./pairing.js";
import { MessageBuffer, type BufferedMessage } from "./buffer.js";
import { processMessage, type OrchestratorContext } from "./orchestrator.js";
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
import { markdownToTelegramHtml } from "./format.js";
import {
  appendSleepEntry,
  getTodaySleep,
  updateSleepEntry,
  removeSleepEntry,
} from "./sleep-log.js";
import { appendNote, getTodayNotes, updateTodayNote, removeTodayNote, updateNoteByDate, removeNoteByDate } from "./notes-log.js";
import { appendWeight, updateWeight, removeWeight } from "./weight-log.js";
import { appendNutritionLabel, updateNutritionLabel, removeNutritionLabel } from "./nutrition-labels.js";
import type { FoodEntry, SleepEntry } from "./types.js";
import { ensureUserRepo, commitUserData } from "./user-git.js";
import { transcribeAudio, describeImage } from "./transcribe.js";

// --- Logging ---

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [telegram] ${message}`);
}

// --- Config ---

const DEBOUNCE_MS = 2000;
const MAX_WAIT_MS = 10000;
const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const CHECKIN_INTERVAL_MS = 2 * 60 * 60 * 1000;
const QUIET_HOUR_START = 1;
const QUIET_HOUR_END = 7;
const MIN_GAP_SINCE_ACTIVITY_MS = 20 * 60 * 1000;

// --- State ---

const lastCheckinTime = new Map<string, number>();
const lastUserMessageTime = new Map<string, number>();

// --- Helpers ---

async function sendText(
  bot: TelegramBot,
  chatId: number,
  text: string,
): Promise<void> {
  const html = markdownToTelegramHtml(text);
  try {
    await bot.sendMessage(chatId, html, { parse_mode: "HTML" });
  } catch {
    await bot.sendMessage(chatId, text);
  }
}

function isQuietHours(timezone: string): boolean {
  const hourStr = new Date().toLocaleString("en-US", {
    timeZone: timezone,
    hour: "numeric",
    hour12: false,
  });
  const hour = parseInt(hourStr, 10);
  return hour >= QUIET_HOUR_START && hour < QUIET_HOUR_END;
}

/**
 * Format today's entries with daily numbers (#1, #2, ...).
 */
function formatNumberedEntries(
  entries: FoodEntry[],
): string {
  return entries
    .map((e, i) => {
      const time = extractTime(e.timestamp);
      return `#${i + 1}  ${time} — ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
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
  lines.push(`**Total: ${total} / ${target} cal (${pct}%)**`);

  const remaining = target - total;
  if (remaining > 0) {
    lines.push(`${remaining} cal remaining`);
  } else {
    lines.push(`${Math.abs(remaining)} cal over target`);
  }

  return lines.join("\n");
}

/**
 * Build a confirmation message after logging food.
 * Shows the LLM's message + structured entries with daily numbers.
 */
function buildLogConfirmation(
  llmMessage: string,
  newEntries: FoodEntry[],
  allTodayEntries: FoodEntry[],
  dailyTarget: number,
  timezone: string,
): string {
  const startNum = allTodayEntries.length - newEntries.length + 1;
  const entryLines = newEntries
    .map((e, i) => {
      return `  #${startNum + i}  ${e.food_item} (${e.quantity} ${e.unit}) — ${e.calories} cal`;
    })
    .join("\n");

  const total = allTodayEntries.reduce((sum, e) => sum + e.calories, 0);
  const pct = Math.round((total / dailyTarget) * 100);

  return `${llmMessage}\n\n${entryLines}\n  Today: ${total}/${dailyTarget} cal (${pct}%)`;
}

// --- Message handler ---

async function handleMessages(
  bot: TelegramBot,
  openrouterKey: string,
  userId: string,
  messages: BufferedMessage[],
  blockId: string,
): Promise<void> {
  const chatId = messages[0].chatId;
  const combined = messages.map((m) => m.text).join("\n");

  // Detect stale messages (bot was down when user sent them)
  const firstMsgAge = Date.now() - messages[0].date * 1000;
  if (firstMsgAge > STALE_THRESHOLD_MS) {
    const minsAgo = Math.round(firstMsgAge / 60000);
    log("WARN", `Stale block [${blockId}] from ${userId}: ${messages.length} message(s) sent ${minsAgo} min ago`);
  }

  log("INFO", `[${blockId}] Processing ${messages.length} message(s) from ${userId}: "${combined.slice(0, 100)}"`);

  ensureUserRepo(userId);
  lastUserMessageTime.set(userId, Date.now());
  addMessage(userId, "user", combined);

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

  let result;
  try {
    result = await processMessage(combined, context, openrouterKey);
  } catch (err) {
    log("ERROR", `Orchestrator failed: ${(err as Error).message}`);
    await sendText(
      bot,
      chatId,
      "Sorry, I had trouble processing that. Try again?",
    );
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

      const updatedToday = getTodayEntries(userId, target.timezone);
      const confirmMsg = buildLogConfirmation(
        result.message,
        entries,
        updatedToday,
        target.daily_calories,
        target.timezone,
      );

      log(
        "INFO",
        `Logged ${entries.length} items for ${userId}: ${entries.map((e) => `${e.food_item} (${e.calories} cal)`).join(", ")}`,
      );

      await sendText(bot, chatId, confirmMsg);
      addMessage(userId, "assistant", confirmMsg);
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
      log(
        "INFO",
        `Logged sleep for ${userId}: ${sleepEntry.type} ${durationHours}h quality=${sleepEntry.quality}/10`,
      );
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_note": {
      appendNote(userId, { timestamp: nowTZ(target.timezone), note: result.note }, target.timezone);
      log("INFO", `Saved note for ${userId}: "${result.note.slice(0, 50)}"`);
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_weight": {
      appendWeight(userId, {
        timestamp: nowTZ(target.timezone),
        weight_kg: result.weight_kg,
        notes: result.notes || "",
      });
      log("INFO", `Logged weight for ${userId}: ${result.weight_kg} kg`);
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "log_nutrition_label": {
      appendNutritionLabel(userId, {
        timestamp: nowTZ(target.timezone),
        ...result.entry,
      });
      log("INFO", `Saved nutrition label for ${userId}: ${result.entry.product_name}`);
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "edit_entry": {
      const editDate =
        result.date ||
        new Date().toLocaleDateString("en-CA", { timeZone: target.timezone });

      if (result.log_type === "sleep") {
        const updates = result.updates as Partial<SleepEntry>;
        const updated = updateSleepEntry(userId, editDate, result.entry_number, updates);
        if (updated) {
          log("INFO", `Edited sleep #${result.entry_number} (${editDate}) for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find sleep entry #${result.entry_number} on ${editDate}.`);
        }
      } else if (result.log_type === "notes") {
        const noteUpdates = result.updates as { note?: string };
        const updated = result.date
          ? updateNoteByDate(userId, editDate, result.entry_number, noteUpdates)
          : updateTodayNote(userId, result.entry_number, noteUpdates, target.timezone);
        if (updated) {
          log("INFO", `Edited note #${result.entry_number} (${editDate}) for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find note #${result.entry_number} on ${editDate}.`);
        }
      } else if (result.log_type === "weight") {
        const updated = updateWeight(userId, result.entry_number, result.updates as { weight_kg?: number; notes?: string });
        if (updated) {
          log("INFO", `Edited weight #${result.entry_number} for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find weight entry #${result.entry_number}.`);
        }
      } else if (result.log_type === "nutrition_labels") {
        const updated = updateNutritionLabel(userId, result.entry_number, result.updates as Record<string, unknown>);
        if (updated) {
          log("INFO", `Edited nutrition label #${result.entry_number} for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find nutrition label #${result.entry_number}.`);
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
          log("INFO", `Edited #${result.entry_number} (${editDate}) for ${userId}: ${updated.food_item} (${updated.calories} cal)`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find entry #${result.entry_number} on ${editDate}.`);
        }
      }
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "remove_entry": {
      const removeDate =
        result.date ||
        new Date().toLocaleDateString("en-CA", { timeZone: target.timezone });

      if (result.log_type === "sleep") {
        const removed = removeSleepEntry(userId, removeDate, result.entry_number);
        if (removed) {
          log("INFO", `Removed sleep #${result.entry_number} (${removeDate}) for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find sleep entry #${result.entry_number} on ${removeDate}.`);
        }
      } else if (result.log_type === "notes") {
        const removed = result.date
          ? removeNoteByDate(userId, removeDate, result.entry_number)
          : removeTodayNote(userId, result.entry_number, target.timezone);
        if (removed) {
          log("INFO", `Removed note #${result.entry_number} (${removeDate}) for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find note #${result.entry_number} on ${removeDate}.`);
        }
      } else if (result.log_type === "weight") {
        const removed = removeWeight(userId, result.entry_number);
        if (removed) {
          log("INFO", `Removed weight #${result.entry_number} for ${userId}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find weight entry #${result.entry_number}.`);
        }
      } else if (result.log_type === "nutrition_labels") {
        const removed = removeNutritionLabel(userId, result.entry_number);
        if (removed) {
          log("INFO", `Removed nutrition label #${result.entry_number} for ${userId}: ${removed.product_name}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find nutrition label #${result.entry_number}.`);
        }
      } else {
        const removed = result.date
          ? removeEntryByDate(userId, removeDate, result.entry_number)
          : removeTodayEntry(userId, result.entry_number, target.timezone);
        if (removed) {
          log("INFO", `Removed #${result.entry_number} (${removeDate}) for ${userId}: ${removed.food_item}`);
          await sendText(bot, chatId, result.message);
        } else {
          await sendText(bot, chatId, `Couldn't find entry #${result.entry_number} on ${removeDate}.`);
        }
      }
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "ask_claude":
    case "tell_claude": {
      const prompt = result.type === "ask_claude" ? result.question : result.instruction;
      await sendText(bot, chatId, "Let me look into that...");
      try {
        const logsDir = getLogDirPath(userId);
        const answer = await askAboutFoodData(userId, logsDir, prompt, target.timezone);
        await sendText(bot, chatId, answer);
        addMessage(userId, "assistant", `[claude]\n${answer}`);
      } catch (err) {
        log("ERROR", `Claude failed: ${(err as Error).message}`);
        await sendText(
          bot,
          chatId,
          "Sorry, I couldn't complete that. Try asking differently?",
        );
      }
      break;
    }

    case "set_target": {
      setTarget(userId, { daily_calories: result.daily_calories });
      log("INFO", `Updated target for ${userId}: ${result.daily_calories} cal/day`);
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "set_timezone": {
      setTarget(userId, { timezone: result.timezone });
      log("INFO", `Updated timezone for ${userId}: ${result.timezone}`);
      await sendText(bot, chatId, result.message);
      addMessage(userId, "assistant", result.message);
      break;
    }

    case "message": {
      await sendText(bot, chatId, result.text);
      addMessage(userId, "assistant", result.text);
      break;
    }
  }

  // Auto-commit user data after every round
  const commitMsg = buildCommitMessage(result);
  if (commitMsg) {
    commitUserData(userId, `[${blockId}] ${commitMsg}`);
  }
}

function buildCommitMessage(result: { type: string; [k: string]: unknown }): string {
  switch (result.type) {
    case "log_food": {
      const entries = result.entries as Array<{ food_item: string; calories: number }>;
      const items = entries.map((e) => `${e.food_item} (${e.calories} cal)`).join(", ");
      return `log_food: ${items}`;
    }
    case "log_sleep": {
      const entry = result.entry as { type: string; quality: number };
      return `log_sleep: ${entry.type} (quality ${entry.quality}/10)`;
    }
    case "log_note":
      return `log_note: ${(result.note as string).slice(0, 60)}`;
    case "log_weight":
      return `log_weight: ${result.weight_kg} kg`;
    case "log_nutrition_label": {
      const entry = result.entry as { product_name: string };
      return `log_nutrition_label: ${entry.product_name}`;
    }
    case "edit_entry":
      return `edit_entry: ${result.log_type} #${result.entry_number}`;
    case "remove_entry":
      return `remove_entry: ${result.log_type} #${result.entry_number}`;
    case "set_target":
      return `set_target: ${result.daily_calories} cal`;
    case "set_timezone":
      return `set_timezone: ${result.timezone}`;
    default:
      return "";
  }
}

// --- Commands ---

function setupCommands(bot: TelegramBot): void {
  bot.onText(/\/start/, (msg) => {
    const userId = String(msg.from?.id);
    const chatId = msg.chat.id;
    const sender = msg.from?.username || msg.from?.first_name || "Unknown";

    if (isUserAllowed(userId)) {
      bot.sendMessage(chatId, "You're already set up! Just tell me what you ate.");
      return;
    }

    const { code } = upsertPairingRequest(sender, userId);
    bot.sendMessage(chatId, buildPairingMessage(userId, code));
  });

  bot.onText(/\/help/, (msg) => {
    if (!isUserAllowed(String(msg.from?.id))) return;
    const help = [
      "**Food Agent**",
      "",
      "Just tell me what you ate in plain language!",
      'e.g. "had 2 eggs and toast" or "chicken rice for lunch at 1pm"',
      "",
      "To edit: \"change #2 to 3 eggs\" or \"remove #1\"",
      "",
      "**Commands:**",
      "/today — Today's food log",
      "/week — This week's summary",
      "/undo — Remove last entry",
      "/target <number> — Set daily calorie target",
      "/tz <timezone> — Set timezone (e.g. Asia/Kolkata)",
      "/search <query> — Search the web (results saved to chat history)",
      "/claude <question> — Ask Claude directly (with access to all your data)",
      "/clear — Clear all memory (chat history + Claude session)",
      "/help — Show this message",
    ].join("\n");
    sendText(bot, msg.chat.id, help);
  });

  bot.onText(/\/today/, (msg) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const target = getTarget(userId);
    const entries = getTodayEntries(userId, target.timezone);
    sendText(
      bot,
      msg.chat.id,
      formatTodaySummary(entries, target.daily_calories, target.timezone),
    );
  });

  bot.onText(/\/week/, (msg) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const target = getTarget(userId);
    const entries = getEntriesForDays(userId, 7);
    if (entries.length === 0) {
      sendText(bot, msg.chat.id, "No entries in the last 7 days.");
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

    const lines: string[] = ["**This week:**", ""];
    let weekTotal = 0;
    for (const [date, dayEntries] of byDate) {
      const dayTotal = dayEntries.reduce((s, e) => s + e.calories, 0);
      weekTotal += dayTotal;
      const pct = Math.round((dayTotal / target.daily_calories) * 100);
      lines.push(`${date}: ${dayTotal} cal (${pct}%)`);
    }
    lines.push("");
    lines.push(
      `**Weekly total:** ${weekTotal} cal | **Daily avg:** ${Math.round(weekTotal / byDate.size)} cal`,
    );

    sendText(bot, msg.chat.id, lines.join("\n"));
  });

  bot.onText(/\/undo/, (msg) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const removed = removeLastEntry(userId);
    if (removed) {
      sendText(
        bot,
        msg.chat.id,
        `Removed: ${removed.food_item} (${removed.quantity} ${removed.unit}) — ${removed.calories} cal`,
      );
    } else {
      sendText(bot, msg.chat.id, "Nothing to undo — log is empty.");
    }
  });

  bot.onText(/\/target\s+(\d+)/, (msg, match) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const cal = parseInt(match![1], 10);
    if (cal < 500 || cal > 10000) {
      sendText(bot, msg.chat.id, "Target should be between 500 and 10000 cal.");
      return;
    }
    const updated = setTarget(userId, { daily_calories: cal });
    sendText(bot, msg.chat.id, `Daily target set to ${updated.daily_calories} cal.`);
  });

  bot.onText(/\/tz\s+(.+)/, (msg, match) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const tz = match![1].trim();
    try {
      new Date().toLocaleString("en-US", { timeZone: tz });
    } catch {
      sendText(
        bot,
        msg.chat.id,
        `Invalid timezone: "${tz}". Use IANA format like Asia/Hong_Kong or Asia/Kolkata.`,
      );
      return;
    }
    setTarget(userId, { timezone: tz });
    sendText(bot, msg.chat.id, `Timezone set to ${tz}.`);
  });

  bot.onText(/\/search\s+([\s\S]+)/, async (msg, match) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const query = match![1].trim();
    if (!query) return;

    addMessage(userId, "user", `/search ${query}`);
    await sendText(bot, msg.chat.id, "Searching...");
    try {
      const apiKey = process.env.PERPLEXITY_API_KEY;
      if (!apiKey) throw new Error("PERPLEXITY_API_KEY not set");

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

      if (!res.ok) throw new Error(`Perplexity API error ${res.status}`);

      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const result = data.choices?.[0]?.message?.content ?? "No results found.";

      await sendText(bot, msg.chat.id, result);
      addMessage(userId, "assistant", `[search: ${query}]\n${result}`);
      log("INFO", `Search for ${userId}: "${query}"`);
    } catch (err) {
      log("ERROR", `/search failed: ${(err as Error).message}`);
      await sendText(bot, msg.chat.id, "Search failed. Try again?");
    }
  });

  bot.onText(/\/clear/, (msg) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    clearHistory(userId);
    clearSession(userId);
    log("INFO", `Cleared all memory for ${userId}`);
    sendText(bot, msg.chat.id, "Memory cleared — chat history and Claude session reset.");
  });

  bot.onText(/\/claude\s+([\s\S]+)/, async (msg, match) => {
    const userId = String(msg.from?.id);
    if (!isUserAllowed(userId)) return;
    const question = match![1].trim();
    if (!question) return;

    const target = getTarget(userId);
    addMessage(userId, "user", `/claude ${question}`);
    await sendText(bot, msg.chat.id, "Asking Claude...");
    try {
      const logsDir = getLogDirPath(userId);
      const answer = await askAboutFoodData(userId, logsDir, question, target.timezone);
      await sendText(bot, msg.chat.id, answer);
      addMessage(userId, "assistant", `[claude]\n${answer}`);
    } catch (err) {
      log("ERROR", `/claude failed: ${(err as Error).message}`);
      await sendText(
        bot,
        msg.chat.id,
        "Sorry, Claude couldn't process that. Try again?",
      );
    }
  });
}

// --- Check-ins ---

function startCheckins(bot: TelegramBot, openrouterKey: string): void {
  log("INFO", `Check-ins enabled: every ${CHECKIN_INTERVAL_MS / 60000} minutes`);

  setInterval(async () => {
    const users = listApprovedUsers();

    for (const user of users) {
      const userId = user.senderId;
      const chatId = parseInt(userId, 10);
      if (isNaN(chatId)) continue;

      const target = getTarget(userId);
      if (isQuietHours(target.timezone)) continue;

      const lastCheck = lastCheckinTime.get(userId) ?? 0;
      const lastMsg = lastUserMessageTime.get(userId) ?? 0;
      if (lastCheck > 0 && lastCheck > lastMsg) continue;
      if (Date.now() - lastMsg < MIN_GAP_SINCE_ACTIVITY_MS) continue;

      try {
        const todayEntries = getTodayEntries(userId, target.timezone);
        const todayCalories = todayEntries.reduce(
          (sum, e) => sum + e.calories,
          0,
        );

        const context: OrchestratorContext = {
          todayLog: todayEntries,
          todayCalories,
          dailyTarget: target.daily_calories,
          timezone: target.timezone,
          knownFoods: loadNutritionDB(),
          chatHistory: getHistory(userId),
          logsDir: getLogDirPath(userId),
          userId,
          todaySleep: getTodaySleep(userId, target.timezone),
          todayNotes: getTodayNotes(userId, target.timezone),
        };

        const result = await processMessage(
          `[CHECK-IN] Time for a proactive check-in with the user.`,
          context,
          openrouterKey,
        );

        if (result.type === "message") {
          await sendText(bot, chatId, result.text);
          addMessage(userId, "assistant", result.text);
          lastCheckinTime.set(userId, Date.now());
          log("INFO", `Check-in sent to ${userId}`);
        }
      } catch (err) {
        log("WARN", `Check-in failed for ${userId}: ${(err as Error).message}`);
      }
    }
  }, CHECKIN_INTERVAL_MS);
}

// --- Sleep check-in (daily at 10am) ---

const lastSleepCheckinDate = new Map<string, string>();

function startSleepCheckins(bot: TelegramBot, openrouterKey: string): void {
  log("INFO", "Sleep check-ins enabled: daily at 10:00 AM");

  // Check every 5 minutes if it's 10:00 AM for any user
  setInterval(async () => {
    const users = listApprovedUsers();

    for (const user of users) {
      const userId = user.senderId;
      const chatId = parseInt(userId, 10);
      if (isNaN(chatId)) continue;

      const target = getTarget(userId);

      // Check if it's 10:00 AM (10:00-10:04 window to match 5-min interval)
      const now = new Date();
      const hourStr = now.toLocaleString("en-US", {
        timeZone: target.timezone,
        hour: "numeric",
        hour12: false,
      });
      const minStr = now.toLocaleString("en-US", {
        timeZone: target.timezone,
        minute: "numeric",
      });
      const hour = parseInt(hourStr, 10);
      const min = parseInt(minStr, 10);
      if (hour !== 10 || min >= 5) continue;

      // Only once per day
      const today = now.toLocaleDateString("en-CA", {
        timeZone: target.timezone,
      });
      if (lastSleepCheckinDate.get(userId) === today) continue;

      // Skip if user already logged sleep today
      const todaySleepEntries = getTodaySleep(userId, target.timezone);
      if (todaySleepEntries.some((s) => s.type === "night")) continue;

      lastSleepCheckinDate.set(userId, today);

      try {
        const todayEntries = getTodayEntries(userId, target.timezone);
        const todayCalories = todayEntries.reduce(
          (sum, e) => sum + e.calories,
          0,
        );

        const context: OrchestratorContext = {
          todayLog: todayEntries,
          todayCalories,
          dailyTarget: target.daily_calories,
          timezone: target.timezone,
          knownFoods: loadNutritionDB(),
          chatHistory: getHistory(userId),
          logsDir: getLogDirPath(userId),
          userId,
          todaySleep: todaySleepEntries,
          todayNotes: getTodayNotes(userId, target.timezone),
        };

        const result = await processMessage(
          `[SLEEP-CHECK-IN] Morning check-in — ask the user about last night's sleep.`,
          context,
          openrouterKey,
        );

        if (result.type === "message") {
          await sendText(bot, chatId, result.text);
          addMessage(userId, "assistant", result.text);
          log("INFO", `Sleep check-in sent to ${userId}`);
        }
      } catch (err) {
        log("WARN", `Sleep check-in failed for ${userId}: ${(err as Error).message}`);
      }
    }
  }, 5 * 60 * 1000); // every 5 minutes
}

// --- Main ---

async function main(): Promise<void> {
  const token = resolveBotToken();
  if (!token) {
    console.error("No Telegram bot token. Set TELEGRAM_BOT_TOKEN in .env or run setup.");
    process.exit(1);
  }

  const openrouterKey = resolveOpenRouterKey();
  if (!openrouterKey) {
    console.error("No OpenRouter API key. Set OPENROUTER_API_KEY in .env or run setup.");
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: true });
  log("INFO", "Food Agent started. Waiting for messages...");

  setupCommands(bot);

  const buffer = new MessageBuffer(
    DEBOUNCE_MS,
    MAX_WAIT_MS,
    (userId) => getTarget(userId).timezone,
    (userId, msgs, blockId) => handleMessages(bot, openrouterKey, userId, msgs, blockId),
  );

  bot.on("message", async (msg) => {
    if (!msg.from) return;

    const userId = String(msg.from.id);
    if (!isUserAllowed(userId)) {
      if (msg.text || msg.voice || msg.photo) {
        const sender = msg.from.username || msg.from.first_name || "Unknown";
        const { code } = upsertPairingRequest(sender, userId);
        bot.sendMessage(msg.chat.id, buildPairingMessage(userId, code));
      }
      return;
    }

    // Voice messages: transcribe then feed into buffer
    if (msg.voice) {
      try {
        const fileLink = await bot.getFileLink(msg.voice.file_id);
        const res = await fetch(fileLink);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const audioBuf = Buffer.from(await res.arrayBuffer());

        const text = await transcribeAudio(audioBuf, openrouterKey);
        log("INFO", `Voice from ${userId}: "${text.slice(0, 100)}"`);

        buffer.add(userId, {
          text,
          messageId: msg.message_id,
          chatId: msg.chat.id,
          date: msg.date ?? Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        log("ERROR", `Voice transcription failed for ${userId}: ${(err as Error).message}`);
        await sendText(bot, msg.chat.id, "Couldn't understand that voice message. Try again or type it out?");
      }
      return;
    }

    // Photos: describe then feed into buffer
    if (msg.photo && msg.photo.length > 0) {
      try {
        // Telegram sends multiple sizes — pick the largest
        const photo = msg.photo[msg.photo.length - 1];
        const fileLink = await bot.getFileLink(photo.file_id);
        const res = await fetch(fileLink);
        if (!res.ok) throw new Error(`Download failed: ${res.status}`);
        const imgBuf = Buffer.from(await res.arrayBuffer());

        const description = await describeImage(imgBuf, openrouterKey);
        log("INFO", `Photo from ${userId}: "${description.slice(0, 100)}"`);

        // Combine image description with caption if present
        const caption = msg.caption || "";
        const text = caption
          ? `[Image: ${description}]\n${caption}`
          : `[Image: ${description}]`;

        buffer.add(userId, {
          text,
          messageId: msg.message_id,
          chatId: msg.chat.id,
          date: msg.date ?? Math.floor(Date.now() / 1000),
        });
      } catch (err) {
        log("ERROR", `Image description failed for ${userId}: ${(err as Error).message}`);
        await sendText(bot, msg.chat.id, "Couldn't process that image. Try again or describe what's in it?");
      }
      return;
    }

    if (!msg.text) return;
    if (msg.text.startsWith("/")) return;

    buffer.add(userId, {
      text: msg.text,
      messageId: msg.message_id,
      chatId: msg.chat.id,
      date: msg.date ?? Math.floor(Date.now() / 1000),
    });
  });

  startCheckins(bot, openrouterKey);
  startSleepCheckins(bot, openrouterKey);

  process.on("SIGINT", () => {
    log("INFO", "Shutting down...");
    bot.stopPolling();
    process.exit(0);
  });

  process.on("SIGTERM", () => {
    log("INFO", "Shutting down...");
    bot.stopPolling();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
