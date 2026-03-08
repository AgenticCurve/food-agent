import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { WeightEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER = "timestamp,weight_kg,notes";

function getWeightPath(userId: string): string {
  return path.join(LOGS_DIR, userId, "weight.csv");
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

function readWeightFile(userId: string): WeightEntry[] {
  const p = getWeightPath(userId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const f = parseCSVLine(line);
    return {
      timestamp: f[0] || "",
      weight_kg: parseFloat(f[1]) || 0,
      notes: f[2] || "",
    };
  }).filter((e) => e.weight_kg > 0);
}

function writeWeightFile(userId: string, entries: WeightEntry[]): void {
  const p = getWeightPath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [
    CSV_HEADER,
    ...entries.map(
      (e) => `${e.timestamp},${e.weight_kg},${escapeCSV(e.notes || "")}`,
    ),
  ];
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

export function appendWeight(userId: string, entry: WeightEntry): void {
  const entries = readWeightFile(userId);
  entries.push(entry);
  writeWeightFile(userId, entries);
}

export function getAllWeights(userId: string): WeightEntry[] {
  return readWeightFile(userId);
}

export function getLatestWeight(userId: string): WeightEntry | null {
  const entries = readWeightFile(userId);
  return entries.length > 0 ? entries[entries.length - 1] : null;
}

export function updateWeight(
  userId: string,
  entryNumber: number,
  updates: Partial<WeightEntry>,
): WeightEntry | null {
  const entries = readWeightFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeWeightFile(userId, entries);
  return entries[entryNumber - 1];
}

export function removeWeight(
  userId: string,
  entryNumber: number,
): WeightEntry | null {
  const entries = readWeightFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeWeightFile(userId, entries);
  return removed;
}

export function getWeightsForDateRange(
  userId: string,
  startDate: string,
  endDate: string,
): string {
  const entries = readWeightFile(userId);
  const results = entries.filter((e) => {
    const d = e.timestamp.slice(0, 10);
    return d >= startDate && d <= endDate;
  });
  return results.length > 0
    ? `${CSV_HEADER}\n${results.map((e) => `${e.timestamp},${e.weight_kg},${escapeCSV(e.notes || "")}`).join("\n")}`
    : "No weight entries found for this date range.";
}

export function grepWeights(userId: string, pattern: string): string {
  const entries = readWeightFile(userId);
  const lower = pattern.toLowerCase();
  const results = entries.filter((e) => {
    const line = `${e.timestamp},${e.weight_kg},${e.notes || ""}`;
    return line.toLowerCase().includes(lower);
  });
  return results.length > 0
    ? results
        .slice(0, 50)
        .map((e) => `[${e.timestamp.slice(0, 10)}] ${e.weight_kg} kg${e.notes ? ` — ${e.notes}` : ""}`)
        .join("\n") +
        (results.length > 50 ? `\n... and ${results.length - 50} more` : "")
    : `No weight entries matching "${pattern}".`;
}
