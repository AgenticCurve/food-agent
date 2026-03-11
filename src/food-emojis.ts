/**
 * Per-user food item → emoji mapping.
 * Stored as a simple JSON object in logs/{userId}/food-emojis.json
 */

import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

const LOGS_DIR = dataPath("logs");

function getFilePath(userId: string): string {
  return path.join(LOGS_DIR, userId, "food-emojis.json");
}

function readMap(userId: string): Record<string, string> {
  const p = getFilePath(userId);
  if (!fs.existsSync(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}

function writeMap(userId: string, map: Record<string, string>): void {
  const p = getFilePath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(map, null, 2), "utf8");
}

function normalize(foodItem: string): string {
  return foodItem.toLowerCase().trim();
}

export function getEmoji(userId: string, foodItem: string): string {
  const map = readMap(userId);
  return map[normalize(foodItem)] || "";
}

export function setEmoji(userId: string, foodItem: string, emoji: string): void {
  const map = readMap(userId);
  map[normalize(foodItem)] = emoji;
  writeMap(userId, map);
}

export function getAllEmojis(userId: string): Record<string, string> {
  return readMap(userId);
}
