import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { FoodEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER = "timestamp,food_item,quantity,unit,calories,notes";
const HKT_TZ = "Asia/Hong_Kong";

/**
 * Current timestamp in HKT as ISO 8601 with +08:00 offset.
 * All timestamps in the DB are stored in HKT.
 */
export function nowHKT(): string {
  const d = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: HKT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}+08:00`;
}

function todayHKT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: HKT_TZ });
}

function hktDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: HKT_TZ });
}

function getUserDir(userId: string): string {
  const dir = path.join(LOGS_DIR, userId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** logs/{userId}/{yyyy}/{mm}/{yyyy-mm-dd}.csv */
function getDateFilePath(userId: string, date: string): string {
  const [year, month] = date.split("-");
  return path.join(LOGS_DIR, userId, year, month, `${date}.csv`);
}

function escapeCSV(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

function entryToCSVLine(e: FoodEntry): string {
  return [
    e.timestamp,
    escapeCSV(e.food_item),
    String(e.quantity),
    e.unit,
    String(e.calories),
    escapeCSV(e.notes || ""),
  ].join(",");
}

function readDateFile(filePath: string): FoodEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines
    .slice(1)
    .map((line) => {
      const f = parseCSVLine(line);
      return {
        timestamp: f[0] || "",
        food_item: f[1] || "",
        quantity: parseFloat(f[2]) || 0,
        unit: f[3] || "",
        calories: parseFloat(f[4]) || 0,
        notes: f[5] || "",
      };
    })
    .filter((e) => e.food_item);
}

function writeDateFile(filePath: string, entries: FoodEntry[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [CSV_HEADER, ...entries.map(entryToCSVLine)];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

export function appendEntries(userId: string, entries: FoodEntry[]): void {
  const date = todayHKT();
  const filePath = getDateFilePath(userId, date);
  const existing = readDateFile(filePath);
  existing.push(...entries);
  writeDateFile(filePath, existing);
}

export function removeLastEntry(userId: string): FoodEntry | null {
  for (let i = 0; i < 365; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = hktDateStr(d);
    const filePath = getDateFilePath(userId, date);
    const entries = readDateFile(filePath);
    if (entries.length > 0) {
      const removed = entries.pop()!;
      writeDateFile(filePath, entries);
      return removed;
    }
  }
  return null;
}

export function getTodayEntries(userId: string, _timezone?: string): FoodEntry[] {
  return readDateFile(getDateFilePath(userId, todayHKT()));
}

export function getEntriesForDays(userId: string, days: number): FoodEntry[] {
  const entries: FoodEntry[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = hktDateStr(d);
    entries.push(...readDateFile(getDateFilePath(userId, date)));
  }
  return entries;
}

export function updateTodayEntry(
  userId: string,
  entryNumber: number,
  updates: Partial<FoodEntry>,
  _timezone?: string,
): FoodEntry | null {
  const filePath = getDateFilePath(userId, todayHKT());
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeDateFile(filePath, entries);
  return entries[entryNumber - 1];
}

export function removeTodayEntry(
  userId: string,
  entryNumber: number,
  _timezone?: string,
): FoodEntry | null {
  const filePath = getDateFilePath(userId, todayHKT());
  const entries = readDateFile(filePath);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeDateFile(filePath, entries);
  return removed;
}

/** Returns the user's log directory (contains yyyy/mm/ subdirectories with CSV files). */
export function getLogDirPath(userId: string): string {
  return getUserDir(userId);
}
