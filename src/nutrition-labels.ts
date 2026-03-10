import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";
import type { NutritionLabelEntry } from "./types.js";

const LOGS_DIR = dataPath("logs");
const CSV_HEADER = "timestamp,product_name,brand,serving_size,serving_size_g,calories_per_100g,protein_per_100g,carbs_per_100g,fat_per_100g,sugar_per_100g,fiber_per_100g,sodium_per_100g,notes";

function getFilePath(userId: string): string {
  return path.join(LOGS_DIR, userId, "nutrition-labels.csv");
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

function entryToLine(e: NutritionLabelEntry): string {
  return [
    e.timestamp,
    escapeCSV(e.product_name),
    escapeCSV(e.brand),
    escapeCSV(e.serving_size),
    String(e.serving_size_g),
    String(e.calories_per_100g),
    String(e.protein_per_100g),
    String(e.carbs_per_100g),
    String(e.fat_per_100g),
    String(e.sugar_per_100g),
    String(e.fiber_per_100g),
    String(e.sodium_per_100g),
    escapeCSV(e.notes),
  ].join(",");
}

function readFile(userId: string): NutritionLabelEntry[] {
  const p = getFilePath(userId);
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const f = parseCSVLine(line);
    return {
      timestamp: f[0] || "",
      product_name: f[1] || "",
      brand: f[2] || "",
      serving_size: f[3] || "",
      serving_size_g: parseFloat(f[4]) || 0,
      calories_per_100g: parseFloat(f[5]) || 0,
      protein_per_100g: parseFloat(f[6]) || 0,
      carbs_per_100g: parseFloat(f[7]) || 0,
      fat_per_100g: parseFloat(f[8]) || 0,
      sugar_per_100g: parseFloat(f[9]) || 0,
      fiber_per_100g: parseFloat(f[10]) || 0,
      sodium_per_100g: parseFloat(f[11]) || 0,
      notes: f[12] || "",
    };
  }).filter((e) => e.product_name);
}

function writeFile(userId: string, entries: NutritionLabelEntry[]): void {
  const p = getFilePath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const lines = [CSV_HEADER, ...entries.map(entryToLine)];
  fs.writeFileSync(p, lines.join("\n") + "\n", "utf8");
}

export function appendNutritionLabel(userId: string, entry: NutritionLabelEntry): void {
  const entries = readFile(userId);
  entries.push(entry);
  writeFile(userId, entries);
}

export function getAllNutritionLabels(userId: string): NutritionLabelEntry[] {
  return readFile(userId);
}

export function updateNutritionLabel(
  userId: string,
  entryNumber: number,
  updates: Partial<NutritionLabelEntry>,
): NutritionLabelEntry | null {
  const entries = readFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  entries[entryNumber - 1] = { ...entries[entryNumber - 1], ...updates };
  writeFile(userId, entries);
  return entries[entryNumber - 1];
}

export function removeNutritionLabel(
  userId: string,
  entryNumber: number,
): NutritionLabelEntry | null {
  const entries = readFile(userId);
  if (entryNumber < 1 || entryNumber > entries.length) return null;
  const removed = entries.splice(entryNumber - 1, 1)[0];
  writeFile(userId, entries);
  return removed;
}

export function grepNutritionLabels(userId: string, pattern: string): string {
  const entries = readFile(userId);
  const lower = pattern.toLowerCase();
  const results = entries.filter(
    (e) =>
      e.product_name.toLowerCase().includes(lower) ||
      e.brand.toLowerCase().includes(lower) ||
      e.notes.toLowerCase().includes(lower),
  );
  return results.length > 0
    ? results
        .slice(0, 30)
        .map(
          (e) =>
            `#${entries.indexOf(e) + 1} ${e.product_name}${e.brand ? ` (${e.brand})` : ""} — serving: ${e.serving_size} (${e.serving_size_g}g) | per 100g: ${e.calories_per_100g} cal, P${e.protein_per_100g}g C${e.carbs_per_100g}g F${e.fat_per_100g}g`,
        )
        .join("\n") +
        (results.length > 30 ? `\n... and ${results.length - 30} more` : "")
    : `No nutrition labels matching "${pattern}".`;
}

export function getNutritionLabelsCSV(userId: string): string {
  const entries = readFile(userId);
  if (entries.length === 0) return "";
  return `${CSV_HEADER}\n${entries.map(entryToLine).join("\n")}`;
}
