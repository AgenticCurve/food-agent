import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { SleepEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER =
  "date,type,start_time,end_time,duration_hours,quality,notes";
const HKT_TZ = "Asia/Hong_Kong";

function todayHKT(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: HKT_TZ });
}

function hktDateStr(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: HKT_TZ });
}

/** logs/{userId}/sleep/{yyyy}-{mm}.csv */
function getSleepFilePath(userId: string, date: string): string {
  const [year, month] = date.split("-");
  return path.join(LOGS_DIR, userId, "sleep", `${year}-${month}.csv`);
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

function entryToCSVLine(e: SleepEntry): string {
  return [
    e.date,
    e.type,
    e.start_time,
    e.end_time,
    String(e.duration_hours),
    String(e.quality),
    escapeCSV(e.notes || ""),
  ].join(",");
}

function readSleepFile(filePath: string): SleepEntry[] {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines
    .slice(1)
    .map((line) => {
      const f = parseCSVLine(line);
      return {
        date: f[0] || "",
        type: (f[1] || "night") as "night" | "nap",
        start_time: f[2] || "",
        end_time: f[3] || "",
        duration_hours: parseFloat(f[4]) || 0,
        quality: parseInt(f[5]) || 0,
        notes: f[6] || "",
      };
    })
    .filter((e) => e.date);
}

function writeSleepFile(filePath: string, entries: SleepEntry[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [CSV_HEADER, ...entries.map(entryToCSVLine)];
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

export function appendSleepEntry(userId: string, entry: SleepEntry): void {
  const filePath = getSleepFilePath(userId, entry.date);
  const existing = readSleepFile(filePath);
  existing.push(entry);
  writeSleepFile(filePath, existing);
}

export function getTodaySleep(userId: string, _timezone?: string): SleepEntry[] {
  const today = todayHKT();
  const filePath = getSleepFilePath(userId, today);
  return readSleepFile(filePath).filter((e) => e.date === today);
}

export function getSleepForDays(
  userId: string,
  days: number,
): SleepEntry[] {
  const entries: SleepEntry[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = hktDateStr(d);
    const fileKey = date.slice(0, 7); // yyyy-mm
    if (!seen.has(fileKey)) {
      seen.add(fileKey);
      const filePath = getSleepFilePath(userId, date);
      entries.push(...readSleepFile(filePath));
    }
  }
  // Filter to only the requested date range
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffStr = hktDateStr(cutoff);
  return entries.filter((e) => e.date >= cutoffStr).sort((a, b) => a.date.localeCompare(b.date));
}

export function updateSleepEntry(
  userId: string,
  entryDate: string,
  entryIndex: number,
  updates: Partial<SleepEntry>,
): SleepEntry | null {
  const filePath = getSleepFilePath(userId, entryDate);
  const all = readSleepFile(filePath);
  // Find entries for this date and map to file indices
  const dateEntries: Array<{ entry: SleepEntry; fileIndex: number }> = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].date === entryDate) {
      dateEntries.push({ entry: all[i], fileIndex: i });
    }
  }
  if (entryIndex < 1 || entryIndex > dateEntries.length) return null;
  const target = dateEntries[entryIndex - 1];
  all[target.fileIndex] = { ...all[target.fileIndex], ...updates };
  writeSleepFile(filePath, all);
  return all[target.fileIndex];
}

export function removeSleepEntry(
  userId: string,
  entryDate: string,
  entryIndex: number,
): SleepEntry | null {
  const filePath = getSleepFilePath(userId, entryDate);
  const all = readSleepFile(filePath);
  const dateEntries: Array<{ entry: SleepEntry; fileIndex: number }> = [];
  for (let i = 0; i < all.length; i++) {
    if (all[i].date === entryDate) {
      dateEntries.push({ entry: all[i], fileIndex: i });
    }
  }
  if (entryIndex < 1 || entryIndex > dateEntries.length) return null;
  const target = dateEntries[entryIndex - 1];
  const removed = all.splice(target.fileIndex, 1)[0];
  writeSleepFile(filePath, all);
  return removed;
}

/** Returns the user's sleep directory (contains yyyy-mm.csv files). */
export function getSleepDirPath(userId: string): string {
  const dir = path.join(LOGS_DIR, userId, "sleep");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** List all sleep CSV files for a user (relative paths). */
export function listSleepCsvFiles(userId: string): string[] {
  const dir = path.join(LOGS_DIR, userId, "sleep");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort();
}

/** Read sleep entries for a date range. */
export function getSleepEntriesForDateRange(
  userId: string,
  startDate: string,
  endDate: string,
): string {
  const dir = path.join(LOGS_DIR, userId, "sleep");
  if (!fs.existsSync(dir)) return "No sleep data yet.";
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort();
  const results: string[] = [];
  for (const file of files) {
    const entries = readSleepFile(path.join(dir, file));
    for (const e of entries) {
      if (e.date >= startDate && e.date <= endDate) {
        results.push(entryToCSVLine(e));
      }
    }
  }
  return results.length > 0
    ? `${CSV_HEADER}\n${results.join("\n")}`
    : "No sleep entries found for this date range.";
}

/** Grep sleep logs for a pattern. */
export function grepSleepLogs(userId: string, pattern: string): string {
  const dir = path.join(LOGS_DIR, userId, "sleep");
  if (!fs.existsSync(dir)) return "No sleep data yet.";
  const lower = pattern.toLowerCase();
  const results: string[] = [];
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".csv"))
    .sort();
  for (const file of files) {
    const entries = readSleepFile(path.join(dir, file));
    for (const e of entries) {
      const line = entryToCSVLine(e);
      if (line.toLowerCase().includes(lower)) {
        results.push(`[${e.date}] ${line}`);
      }
    }
  }
  return results.length > 0
    ? results.slice(0, 50).join("\n") +
        (results.length > 50
          ? `\n... and ${results.length - 50} more`
          : "")
    : `No sleep entries matching "${pattern}".`;
}
