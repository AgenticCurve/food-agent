import fs from "fs";
import { DATA_DIR, dataPath } from "./paths.js";
import type { NutritionInfo } from "./types.js";

const DB_PATH = dataPath("nutrition.json");

type NutritionDB = Record<string, NutritionInfo>;

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

export function loadNutritionDB(): NutritionDB {
  ensureDataDir();
  try {
    if (!fs.existsSync(DB_PATH)) return {};
    return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function saveNutritionDB(db: NutritionDB): void {
  ensureDataDir();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function lookupFood(name: string): NutritionInfo | null {
  const db = loadNutritionDB();
  const key = name.toLowerCase().trim();
  if (db[key]) return db[key];
  for (const [k, v] of Object.entries(db)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
}

export function addFood(name: string, entry: NutritionInfo): void {
  const db = loadNutritionDB();
  db[name.toLowerCase().trim()] = entry;
  saveNutritionDB(db);
}
