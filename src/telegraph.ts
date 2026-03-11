/**
 * Telegraph (telegra.ph) integration for publishing nutrition label tables.
 *
 * Creates a Telegraph account once (cached), then publishes pages
 * with nutrition data formatted as a monospace table inside <pre> blocks.
 */

import fs from "fs";
import { dataPath } from "./paths.js";
import type { NutritionLabelEntry } from "./types.js";

const TOKEN_PATH = dataPath("telegraph-token.json");
const API_BASE = "https://api.telegra.ph";

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [telegraph] ${message}`);
}

// --- Account management ---

function loadToken(): string | null {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    return data.access_token || null;
  } catch {
    return null;
  }
}

function saveToken(token: string): void {
  const dir = dataPath("");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ access_token: token }), "utf8");
}

async function getOrCreateToken(): Promise<string> {
  const cached = loadToken();
  if (cached) return cached;

  const res = await fetch(`${API_BASE}/createAccount`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      short_name: "FoodAgent",
      author_name: "Food Agent Bot",
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegraph createAccount failed: ${data.error}`);

  const token = data.result.access_token;
  saveToken(token);
  log("INFO", "Created Telegraph account");
  return token;
}

// --- Table formatting ---

function pad(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + " ".repeat(len - str.length);
}

function padNum(n: number | string, len: number): string {
  const s = String(n);
  return s.length >= len ? s : " ".repeat(len - s.length) + s;
}

function buildTable(entries: NutritionLabelEntry[]): string {
  // Column widths
  const hdr = {
    num: 3,
    name: 22,
    brand: 14,
    serving: 10,
    cal: 5,
    prot: 5,
    carb: 5,
    fat: 5,
    sugar: 5,
    fiber: 5,
    sodium: 6,
  };

  const sep = "─".repeat(
    hdr.num + hdr.name + hdr.brand + hdr.serving +
    hdr.cal + hdr.prot + hdr.carb + hdr.fat +
    hdr.sugar + hdr.fiber + hdr.sodium + 12 * 3,
  );

  const header = [
    pad("#", hdr.num),
    pad("Product", hdr.name),
    pad("Brand", hdr.brand),
    pad("Serving", hdr.serving),
    padNum("Cal", hdr.cal),
    padNum("Prot", hdr.prot),
    padNum("Carb", hdr.carb),
    padNum("Fat", hdr.fat),
    padNum("Sugar", hdr.sugar),
    padNum("Fiber", hdr.fiber),
    padNum("Na(mg)", hdr.sodium),
  ].join(" │ ");

  const subheader = [
    pad("", hdr.num),
    pad("", hdr.name),
    pad("", hdr.brand),
    pad("", hdr.serving),
    padNum("/100g", hdr.cal),
    padNum("/100g", hdr.prot),
    padNum("/100g", hdr.carb),
    padNum("/100g", hdr.fat),
    padNum("/100g", hdr.sugar),
    padNum("/100g", hdr.fiber),
    padNum("/100g", hdr.sodium),
  ].join(" │ ");

  const rows = entries.map((e, i) =>
    [
      pad(`${i + 1}`, hdr.num),
      pad(e.product_name, hdr.name),
      pad(e.brand, hdr.brand),
      pad(`${e.serving_size_g}g`, hdr.serving),
      padNum(e.calories_per_100g, hdr.cal),
      padNum(e.protein_per_100g, hdr.prot),
      padNum(e.carbs_per_100g, hdr.carb),
      padNum(e.fat_per_100g, hdr.fat),
      padNum(e.sugar_per_100g, hdr.sugar),
      padNum(e.fiber_per_100g, hdr.fiber),
      padNum(e.sodium_per_100g, hdr.sodium),
    ].join(" │ "),
  );

  return [header, subheader, sep, ...rows].join("\n");
}

// --- Publish ---

export async function publishNutritionTable(
  entries: NutritionLabelEntry[],
): Promise<string> {
  const token = await getOrCreateToken();
  const table = buildTable(entries);
  const now = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const content: any[] = [
    { tag: "p", children: [
      { tag: "strong", children: [`${entries.length} saved nutrition labels`] },
      ` — updated ${now}`,
    ]},
    { tag: "p", children: ["All values are per 100g/100ml."] },
    { tag: "pre", children: [table] },
  ];

  // Add detailed cards for each entry below the table
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const lines = [
      `#${i + 1}  ${e.product_name}${e.brand ? ` (${e.brand})` : ""}`,
      `Serving: ${e.serving_size} (${e.serving_size_g}g)`,
      ``,
      `Per 100g:`,
      `  Calories:  ${e.calories_per_100g} kcal`,
      `  Protein:   ${e.protein_per_100g}g`,
      `  Carbs:     ${e.carbs_per_100g}g`,
      `  Fat:       ${e.fat_per_100g}g`,
      `  Sugar:     ${e.sugar_per_100g}g`,
      `  Fiber:     ${e.fiber_per_100g}g`,
      `  Sodium:    ${e.sodium_per_100g}mg`,
    ];
    if (e.notes) lines.push(``, `Notes: ${e.notes}`);

    // Per-serving calculation
    if (e.serving_size_g > 0) {
      const factor = e.serving_size_g / 100;
      lines.push(
        ``,
        `Per serving (${e.serving_size_g}g):`,
        `  Calories:  ${Math.round(e.calories_per_100g * factor)} kcal`,
        `  Protein:   ${(e.protein_per_100g * factor).toFixed(1)}g`,
        `  Carbs:     ${(e.carbs_per_100g * factor).toFixed(1)}g`,
        `  Fat:       ${(e.fat_per_100g * factor).toFixed(1)}g`,
      );
    }

    content.push(
      { tag: "hr" },
      { tag: "pre", children: [lines.join("\n")] },
    );
  }

  const res = await fetch(`${API_BASE}/createPage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      access_token: token,
      title: `Nutrition Labels — ${now}`,
      author_name: "Food Agent",
      content,
    }),
  });

  const data = await res.json();
  if (!data.ok) throw new Error(`Telegraph createPage failed: ${data.error}`);

  log("INFO", `Published nutrition table: ${data.result.url}`);
  return data.result.url;
}
