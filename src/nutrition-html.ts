/**
 * Generates a self-contained HTML file with nutrition labels
 * displayed as a proper scrollable table + detailed cards.
 */

import fs from "fs";
import os from "os";
import path from "path";
import type { NutritionLabelEntry } from "./types.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function generateNutritionHtml(entries: NutritionLabelEntry[]): string {
  const now = new Date().toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });

  const tableRows = entries.map((e, i) => {
    const factor = e.serving_size_g > 0 ? e.serving_size_g / 100 : 0;
    return `<tr>
      <td>${i + 1}</td>
      <td class="name">${esc(e.product_name)}</td>
      <td>${esc(e.brand)}</td>
      <td>${esc(e.serving_size)}</td>
      <td class="num">${e.serving_size_g}</td>
      <td class="num cal">${e.calories_per_100g}</td>
      <td class="num prot">${e.protein_per_100g}</td>
      <td class="num carb">${e.carbs_per_100g}</td>
      <td class="num fat">${e.fat_per_100g}</td>
      <td class="num">${e.sugar_per_100g}</td>
      <td class="num">${e.fiber_per_100g}</td>
      <td class="num">${e.sodium_per_100g}</td>
      <td class="num cal">${factor ? Math.round(e.calories_per_100g * factor) : "—"}</td>
      <td class="num prot">${factor ? (e.protein_per_100g * factor).toFixed(1) : "—"}</td>
      <td class="num carb">${factor ? (e.carbs_per_100g * factor).toFixed(1) : "—"}</td>
      <td class="num fat">${factor ? (e.fat_per_100g * factor).toFixed(1) : "—"}</td>
    </tr>`;
  }).join("\n");

  const cards = entries.map((e, i) => {
    const factor = e.serving_size_g > 0 ? e.serving_size_g / 100 : 0;
    return `<div class="card">
      <div class="card-header">#${i + 1} ${esc(e.product_name)}${e.brand ? ` <span class="brand">(${esc(e.brand)})</span>` : ""}</div>
      <div class="card-serving">Serving: ${esc(e.serving_size)} (${e.serving_size_g}g)</div>
      <div class="card-grid">
        <div class="card-section">
          <div class="section-title">Per 100g</div>
          <div class="macro"><span class="label">Calories</span><span class="value cal">${e.calories_per_100g}</span></div>
          <div class="macro"><span class="label">Protein</span><span class="value prot">${e.protein_per_100g}g</span></div>
          <div class="macro"><span class="label">Carbs</span><span class="value carb">${e.carbs_per_100g}g</span></div>
          <div class="macro"><span class="label">Fat</span><span class="value fat">${e.fat_per_100g}g</span></div>
          <div class="macro"><span class="label">Sugar</span><span class="value">${e.sugar_per_100g}g</span></div>
          <div class="macro"><span class="label">Fiber</span><span class="value">${e.fiber_per_100g}g</span></div>
          <div class="macro"><span class="label">Sodium</span><span class="value">${e.sodium_per_100g}mg</span></div>
        </div>
        ${factor ? `<div class="card-section">
          <div class="section-title">Per serving (${e.serving_size_g}g)</div>
          <div class="macro"><span class="label">Calories</span><span class="value cal">${Math.round(e.calories_per_100g * factor)}</span></div>
          <div class="macro"><span class="label">Protein</span><span class="value prot">${(e.protein_per_100g * factor).toFixed(1)}g</span></div>
          <div class="macro"><span class="label">Carbs</span><span class="value carb">${(e.carbs_per_100g * factor).toFixed(1)}g</span></div>
          <div class="macro"><span class="label">Fat</span><span class="value fat">${(e.fat_per_100g * factor).toFixed(1)}g</span></div>
          <div class="macro"><span class="label">Sugar</span><span class="value">${(e.sugar_per_100g * factor).toFixed(1)}g</span></div>
          <div class="macro"><span class="label">Fiber</span><span class="value">${(e.fiber_per_100g * factor).toFixed(1)}g</span></div>
          <div class="macro"><span class="label">Sodium</span><span class="value">${Math.round(e.sodium_per_100g * factor)}mg</span></div>
        </div>` : ""}
      </div>
      ${e.notes ? `<div class="card-notes">${esc(e.notes)}</div>` : ""}
    </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nutrition Labels — ${now}</title>
<style>
  :root {
    --bg: #0f0f0f;
    --surface: #1a1a1a;
    --surface2: #242424;
    --border: #333;
    --text: #e8e8e8;
    --text2: #999;
    --cal: #ff9f43;
    --prot: #ee5a24;
    --carb: #0abde3;
    --fat: #feca57;
    --accent: #0abde3;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    padding: 16px;
    padding-bottom: 60px;
    -webkit-text-size-adjust: 100%;
  }
  h1 {
    font-size: 20px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .subtitle {
    color: var(--text2);
    font-size: 13px;
    margin-bottom: 20px;
  }

  /* --- Scrollable table --- */
  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    border: 1px solid var(--border);
    border-radius: 8px;
    margin-bottom: 32px;
  }
  table {
    border-collapse: collapse;
    min-width: 900px;
    width: 100%;
    font-size: 13px;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
  }
  thead th {
    background: var(--surface2);
    color: var(--text2);
    font-weight: 600;
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.5px;
    padding: 10px 8px;
    text-align: left;
    white-space: nowrap;
    border-bottom: 2px solid var(--border);
  }
  thead th.num { text-align: right; }
  thead th.group-start { border-left: 2px solid var(--border); }
  tbody tr { border-bottom: 1px solid var(--border); }
  tbody tr:last-child { border-bottom: none; }
  tbody tr:hover { background: var(--surface2); }
  td {
    padding: 8px 8px;
    white-space: nowrap;
    vertical-align: middle;
  }
  td.name { font-weight: 600; white-space: normal; min-width: 140px; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.cal { color: var(--cal); font-weight: 600; }
  td.prot { color: var(--prot); }
  td.carb { color: var(--carb); }
  td.fat { color: var(--fat); }

  /* --- Cards --- */
  .cards-title {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 16px;
    color: var(--text2);
  }
  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .card-header {
    font-size: 16px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .card-header .brand { color: var(--text2); font-weight: 400; }
  .card-serving {
    font-size: 13px;
    color: var(--text2);
    margin-bottom: 12px;
  }
  .card-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 400px) {
    .card-grid { grid-template-columns: 1fr; }
  }
  .card-section {
    background: var(--surface2);
    border-radius: 8px;
    padding: 10px 12px;
  }
  .section-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text2);
    margin-bottom: 8px;
    font-weight: 600;
  }
  .macro {
    display: flex;
    justify-content: space-between;
    padding: 3px 0;
    font-size: 13px;
  }
  .macro .label { color: var(--text2); }
  .macro .value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .macro .value.cal { color: var(--cal); }
  .macro .value.prot { color: var(--prot); }
  .macro .value.carb { color: var(--carb); }
  .macro .value.fat { color: var(--fat); }
  .card-notes {
    font-size: 12px;
    color: var(--text2);
    margin-top: 10px;
    font-style: italic;
  }
</style>
</head>
<body>
  <h1>🏷 Nutrition Labels</h1>
  <div class="subtitle">${entries.length} products — updated ${now}</div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Product</th>
          <th>Brand</th>
          <th>Serving</th>
          <th class="num">g</th>
          <th class="num group-start">Cal</th>
          <th class="num">Prot</th>
          <th class="num">Carb</th>
          <th class="num">Fat</th>
          <th class="num">Sugar</th>
          <th class="num">Fiber</th>
          <th class="num">Na(mg)</th>
          <th class="num group-start">Cal*</th>
          <th class="num">Prot*</th>
          <th class="num">Carb*</th>
          <th class="num">Fat*</th>
        </tr>
        <tr>
          <th></th><th></th><th></th><th></th><th></th>
          <th class="num group-start" colspan="7">per 100g</th>
          <th class="num group-start" colspan="4">per serving</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows}
      </tbody>
    </table>
  </div>

  <div class="cards-title">Detailed breakdown</div>
  ${cards}
</body>
</html>`;
}

/**
 * Write nutrition HTML to a temp file and return the path.
 * Caller is responsible for cleanup after sending.
 */
export function writeNutritionHtmlFile(entries: NutritionLabelEntry[]): string {
  const html = generateNutritionHtml(entries);
  const tmpPath = path.join(os.tmpdir(), `nutrition-labels-${Date.now()}.html`);
  fs.writeFileSync(tmpPath, html, "utf8");
  return tmpPath;
}
