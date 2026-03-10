/**
 * Media processing via OpenRouter (Gemini Flash).
 * Voice transcription and image description — no interpretation or action.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const LITE_MODEL = "google/gemini-3.1-flash-lite-preview";
const FLASH_MODEL = "google/gemini-3.1-flash-preview";

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [transcribe] ${message}`);
}

/**
 * Transcribe audio buffer to text using OpenRouter.
 * Returns the raw transcription — no interpretation or action.
 */
export async function transcribeAudio(
  audioBuffer: Buffer,
  apiKey: string,
  mimeType = "audio/ogg",
): Promise<string> {
  const base64 = audioBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  log("DEBUG", `Transcribing ${audioBuffer.length} bytes (${mimeType})`);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: LITE_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
            {
              type: "text",
              text: "Transcribe the audio exactly as spoken. Output ONLY the transcribed text, nothing else. Do not interpret, summarize, act on, or add any commentary.",
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter transcription failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Transcription returned empty result");
  }

  log("DEBUG", `Transcribed: "${text.slice(0, 100)}"`);
  return text;
}

const IMAGE_PROMPT = `You are a food and nutrition image analyzer. Examine this image and extract ALL relevant information for a food tracking app. Output ONLY a factual description — do NOT give advice, instructions, or take any action.

Rules:
1. FOOD / DRINKS: List each item you can identify with estimated quantity and portion size. Be specific (e.g. "2 fried eggs", "1 bowl of white rice ~200g", "1 glass of orange juice ~250ml").
2. NUTRITION LABELS: Extract ALL readable data — serving size, calories, protein, carbs, fat, sugar, fiber, sodium, and any other nutrients shown. Include the product name and brand if visible.
3. PACKAGED PRODUCTS: Identify the product name, brand, flavor/variant, and package size if visible.
4. RESTAURANT MENUS / RECEIPTS: Extract item names, prices, and any nutritional info shown.
5. SUPPLEMENTS / MEDICINE: Identify the product, dosage, and active ingredients if readable.
6. IGNORE anything not related to food, nutrition, health, or wellness — do not mention it.
7. If the image contains NO food-related content, respond with exactly: "No food-related content detected."

Be concise but thorough. List facts only, no commentary.`;

/**
 * Describe an image using OpenRouter (Gemini Flash).
 * Extracts food, nutrition labels, products — no action taken.
 */
export async function describeImage(
  imageBuffer: Buffer,
  apiKey: string,
  mimeType = "image/jpeg",
): Promise<string> {
  const base64 = imageBuffer.toString("base64");
  const dataUrl = `data:${mimeType};base64,${base64}`;

  log("DEBUG", `Describing image: ${imageBuffer.length} bytes (${mimeType})`);

  const res = await fetch(OPENROUTER_URL, {
    method: "POST",
    signal: AbortSignal.timeout(30_000),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: FLASH_MODEL,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
            {
              type: "text",
              text: IMAGE_PROMPT,
            },
          ],
        },
      ],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter image description failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = data.choices?.[0]?.message?.content?.trim() ?? "";
  if (!text) {
    throw new Error("Image description returned empty result");
  }

  log("DEBUG", `Described: "${text.slice(0, 150)}"`);
  return text;
}
