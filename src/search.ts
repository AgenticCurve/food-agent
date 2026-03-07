/**
 * Standalone web search via Perplexity API.
 * Usage: npx tsx src/search.ts "your search query"
 *
 * Called by Claude CLI for web research.
 * All calls are logged to .food-agent/search.log
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(__dirname, "..", ".food-agent", "search.log");

function logSearch(query: string, status: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${status}] ${query}\n`;
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line);
  } catch {}
}

const query = process.argv.slice(2).join(" ");
if (!query) {
  console.error("Usage: npx tsx src/search.ts <query>");
  process.exit(1);
}

const apiKey = process.env.PERPLEXITY_API_KEY;
if (!apiKey) {
  console.error("PERPLEXITY_API_KEY not set");
  process.exit(1);
}

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

if (!res.ok) {
  const body = await res.text().catch(() => "");
  logSearch(query, `ERROR:${res.status}`);
  console.error(`Perplexity API error ${res.status}: ${body.slice(0, 300)}`);
  process.exit(1);
}

const data = (await res.json()) as {
  choices?: Array<{ message?: { content?: string } }>;
};
const result = data.choices?.[0]?.message?.content ?? "No results found.";
logSearch(query, "OK");
console.log(result);
