import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..");

export const DATA_DIR =
  process.env.FOOD_AGENT_DATA_DIR || path.join(PROJECT_ROOT, ".food-agent");

export function dataPath(...segments: string[]): string {
  return path.join(DATA_DIR, ...segments);
}
