/**
 * Voice message transcription via OpenRouter (Gemini Flash).
 * Pure transcription only — no interpretation or action.
 */

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "google/gemini-3.1-flash-lite-preview";

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
      model: MODEL,
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
