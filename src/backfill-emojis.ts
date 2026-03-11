/**
 * One-time script to backfill food emojis for all existing food entries.
 *
 * Usage: npx tsx src/backfill-emojis.ts <userId>
 *
 * Reads all food entries (last 90 days), extracts unique food items,
 * sends them to the LLM in batches to pick emojis, and saves the mappings.
 */

import "dotenv/config";
import { getEntriesForDays } from "./food-log.js";
import { getEmoji, setEmoji, getAllEmojis } from "./food-emojis.js";
import { resolveOpenRouterKey } from "./settings.js";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3-flash-preview";

async function assignEmojis(foods: string[], apiKey: string): Promise<Record<string, string>> {
  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: "You assign a single emoji to each food item. Return ONLY a JSON object mapping food name to emoji. No markdown, no explanation. Example: {\"rice\": \"🍚\", \"apple\": \"🍎\"}",
        },
        {
          role: "user",
          content: `Assign one emoji to each:\n${foods.join("\n")}`,
        },
      ],
      temperature: 0,
    }),
  });

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim() || "{}";
  // Strip markdown fences if present
  const json = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "");
  try {
    return JSON.parse(json);
  } catch {
    console.error("Failed to parse LLM response:", text);
    return {};
  }
}

async function main() {
  const userId = process.argv[2];
  if (!userId) {
    console.error("Usage: npx tsx src/backfill-emojis.ts <userId>");
    process.exit(1);
  }

  const apiKey = resolveOpenRouterKey();
  if (!apiKey) {
    console.error("No OPENROUTER_API_KEY found.");
    process.exit(1);
  }

  // Get all food entries from last 90 days
  const entries = getEntriesForDays(userId, 90);
  const uniqueFoods = [...new Set(entries.map((e) => e.food_item.toLowerCase().trim()))];

  // Filter out ones that already have emojis
  const existing = getAllEmojis(userId);
  const missing = uniqueFoods.filter((f) => !existing[f]);

  if (missing.length === 0) {
    console.log(`All ${uniqueFoods.length} food items already have emojis.`);
    return;
  }

  console.log(`Found ${uniqueFoods.length} unique foods, ${missing.length} need emojis.`);

  // Process in batches of 30
  const BATCH = 30;
  let assigned = 0;
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    console.log(`Batch ${Math.floor(i / BATCH) + 1}: ${batch.length} items...`);
    const result = await assignEmojis(batch, apiKey);
    for (const [food, emoji] of Object.entries(result)) {
      if (emoji) {
        setEmoji(userId, food, emoji);
        assigned++;
        console.log(`  ${emoji} ${food}`);
      }
    }
  }

  console.log(`\nDone! Assigned ${assigned} emojis.`);
}

main().catch(console.error);
