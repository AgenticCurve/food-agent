import fs from "fs";
import path from "path";
import { dataPath } from "./paths.js";

const LOGS_DIR = dataPath("logs");

// --- State ---

export interface OnboardingState {
  currentStep: number;
  completedSteps: number[];
  startedAt: string;
  completedAt: string | null;
  skipped: boolean;
}

function getFilePath(userId: string): string {
  return path.join(LOGS_DIR, userId, "onboarding.json");
}

function writeState(userId: string, state: OnboardingState): void {
  const p = getFilePath(userId);
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, JSON.stringify(state, null, 2), "utf8");
}

export function getOnboardingState(userId: string): OnboardingState | null {
  const p = getFilePath(userId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function isOnboarding(userId: string): boolean {
  const state = getOnboardingState(userId);
  if (!state) return false;
  return !state.completedAt && !state.skipped;
}

export function startOnboarding(userId: string): OnboardingState {
  const state: OnboardingState = {
    currentStep: 1,
    completedSteps: [],
    startedAt: new Date().toISOString(),
    completedAt: null,
    skipped: false,
  };
  writeState(userId, state);
  return state;
}

export function restartOnboarding(userId: string): OnboardingState {
  return startOnboarding(userId);
}

export function skipOnboarding(userId: string): void {
  const state = getOnboardingState(userId) || startOnboarding(userId);
  state.skipped = true;
  writeState(userId, state);
}

export function advanceStep(userId: string): OnboardingState {
  const state = getOnboardingState(userId) || startOnboarding(userId);
  if (state.completedAt || state.skipped) return state;

  state.completedSteps.push(state.currentStep);

  if (state.currentStep >= 10) {
    state.completedAt = new Date().toISOString();
  } else {
    state.currentStep += 1;
  }

  writeState(userId, state);
  return state;
}

// --- Step definitions ---

export interface OnboardingStep {
  id: number;
  title: string;
  introMessage: string;
  completionCheck: (resultType: string) => boolean;
}

export const ONBOARDING_STEPS: OnboardingStep[] = [
  {
    id: 1,
    title: "Welcome",
    introMessage: [
      "👋 **Welcome to Food Agent!**",
      "",
      "I'm your personal health & nutrition tracker. I can help you:",
      "",
      "🍽 Track everything you eat with calorie estimates",
      "😴 Log your sleep patterns",
      "⚖️ Monitor your weight",
      "📝 Keep health notes",
      "🏷 Save nutrition labels from products",
      "👤 Remember your dietary preferences",
      "📷 Analyze food photos & nutrition labels",
      "",
      "I'll walk you through each feature — it only takes a few minutes.",
      "",
      "**Ready? Just say hi to get started!** 🚀",
    ].join("\n"),
    completionCheck: () => true,
  },
  {
    id: 2,
    title: "Set timezone",
    introMessage: [
      "🌍 **Step 2/10 — Set your timezone**",
      "",
      "I need your timezone so all your logs have the correct time.",
      "",
      "Tell me your timezone:",
      '• _"set timezone to Asia/Kolkata"_',
      '• _"America/New_York"_',
      '• _"I live in London"_',
      "",
      "Or just tell me your city — I'll figure it out! 🗺",
    ].join("\n"),
    completionCheck: (type) => type === "set_timezone",
  },
  {
    id: 3,
    title: "Set calorie target",
    introMessage: [
      "🎯 **Step 3/10 — Set your daily calorie target**",
      "",
      "This helps me track your daily progress. Default is 2400 cal.",
      "",
      "Tell me yours:",
      '• _"set target to 2000"_',
      '• _"1800 calories per day"_',
      "",
      "Not sure? Just pick a number — you can change it anytime with /target 🔄",
    ].join("\n"),
    completionCheck: (type) => type === "set_target",
  },
  {
    id: 4,
    title: "Profile setup",
    introMessage: [
      "👤 **Step 4/10 — Tell me about yourself**",
      "",
      "I can remember things about you permanently — dietary restrictions, allergies, preferences. I'll keep these in mind in every conversation.",
      "",
      "Tell me at least one thing:",
      '• _"remember I\'m vegetarian"_',
      '• _"I\'m allergic to peanuts"_',
      '• _"I don\'t eat gluten"_',
      '• _"I\'m trying to eat more protein"_',
      "",
      "You can always add more later! 💡",
    ].join("\n"),
    completionCheck: (type) => type === "save_profile",
  },
  {
    id: 5,
    title: "Log your first food",
    introMessage: [
      "🍽 **Step 5/10 — Log your first food!**",
      "",
      "This is the core feature. Just tell me what you ate in plain language — I'll estimate calories automatically.",
      "",
      "Try it now:",
      '• _"had 2 eggs and toast for breakfast"_',
      '• _"a cup of coffee with milk"_',
      '• _"chicken rice for lunch"_',
      "",
      "I'll ask follow-ups if I need more details. Go ahead! 🍳",
    ].join("\n"),
    completionCheck: (type) => type === "log_food",
  },
  {
    id: 6,
    title: "Edit an entry",
    introMessage: [
      "✏️ **Step 6/10 — Edit or remove an entry**",
      "",
      "Made a mistake? Every entry has a number (#1, #2, etc.).",
      "",
      "Try editing what you just logged:",
      '• _"change #1 to 3 eggs"_',
      '• _"remove #1"_',
      '• _"#1 was actually 200 calories"_',
      "",
      "Give it a try! 🔧",
    ].join("\n"),
    completionCheck: (type) => type === "edit_entry" || type === "remove_entry",
  },
  {
    id: 7,
    title: "Save a note",
    introMessage: [
      "📝 **Step 7/10 — Save a note**",
      "",
      "Notes are for any health observation or reminder you want to track.",
      "",
      "Try saving one:",
      '• _"note: feeling energetic today"_',
      '• _"note: started creatine supplement"_',
      '• _"save a note: doctor said eat more greens"_',
      "",
      "Notes are stored daily and searchable! 🔍",
    ].join("\n"),
    completionCheck: (type) => type === "log_note",
  },
  {
    id: 8,
    title: "Log sleep",
    introMessage: [
      "😴 **Step 8/10 — Log your sleep**",
      "",
      "I track when you slept, how long, and how well.",
      "",
      "Tell me about last night:",
      '• _"slept 11pm to 7am, quality 8"_',
      '• _"went to bed at midnight, woke up at 6:30, slept okay"_',
      "",
      "Quality is 1-10 (10 = perfect). I'll ask if you skip it 💤",
    ].join("\n"),
    completionCheck: (type) => type === "log_sleep",
  },
  {
    id: 9,
    title: "Log weight",
    introMessage: [
      "⚖️ **Step 9/10 — Log your weight**",
      "",
      "I track your weight over time. I accept kg or lbs.",
      "",
      "Tell me:",
      '• _"72.5 kg"_',
      '• _"I weigh 160 lbs"_',
      '• _"weight: 68 kg, morning measurement"_',
      "",
      "📈 You'll be able to see trends over time!",
    ].join("\n"),
    completionCheck: (type) => type === "log_weight",
  },
  {
    id: 10,
    title: "Explore features",
    introMessage: [
      "🎉 **Step 10/10 — You made it!**",
      "",
      "A few more things to know:",
      "",
      "📊 **Data commands** — view your data anytime:",
      "  /today · /week · /sleep · /notes · /weight · /nutrition · /profile",
      "  Tip: add a question → `/today how much protein?`",
      "",
      "📷 **Photos** — send me photos of food, nutrition labels, products, or menus",
      "🎤 **Voice** — send voice messages, I'll transcribe them",
      "🔍 /search — web search for nutrition info",
      "🧠 /claude — deep analysis of your data",
      "",
      "**Say anything to complete onboarding!** 🏁",
    ].join("\n"),
    completionCheck: () => true,
  },
];

export function getCurrentStep(userId: string): OnboardingStep | null {
  const state = getOnboardingState(userId);
  if (!state || state.completedAt || state.skipped) return null;
  return ONBOARDING_STEPS.find((s) => s.id === state.currentStep) || null;
}

export function getOnboardingStatusText(userId: string): string {
  const state = getOnboardingState(userId);
  if (!state) return "You haven't started onboarding yet. Type /onboarding to begin!";
  if (state.skipped) return "⏭ Onboarding was skipped. Type `/onboarding restart` to redo it anytime.";
  if (state.completedAt) return "✅ Onboarding complete! Type `/onboarding restart` to redo it anytime.";

  const lines = ONBOARDING_STEPS.map((step) => {
    if (state.completedSteps.includes(step.id)) return `  ✅ ${step.id}. ${step.title}`;
    if (step.id === state.currentStep) return `  ➡️ ${step.id}. ${step.title} ← *you are here*`;
    return `  ⬜ ${step.id}. ${step.title}`;
  });

  return `**Onboarding progress (${state.completedSteps.length}/10):**\n\n${lines.join("\n")}`;
}

export function getCompletionMessage(): string {
  return [
    "🎊 **Onboarding complete!**",
    "",
    "You're all set. From now on, just chat naturally — I'll track everything.",
    "",
    "Quick reference: /help for all commands, /profile to see your saved preferences.",
    "",
    "Let's go! 💪",
  ].join("\n");
}

// --- Onboarding system prompt ---

function getStepGoal(stepId: number): string {
  switch (stepId) {
    case 1:
      return "The user just started onboarding. Welcome them warmly and wait for any response to proceed.";
    case 2:
      return "Help the user set their timezone. If they name a city, figure out the IANA timezone and call set_timezone. If they already have a timezone set, acknowledge it and call set_timezone to confirm.";
    case 3:
      return "Help the user set a daily calorie target. Suggest common ranges (1500-2500) if they're unsure. Call set_target.";
    case 4:
      return "Ask the user about dietary restrictions, allergies, or preferences. Save at least one fact with save_profile. Examples: vegetarian, vegan, allergies, intolerances, religious dietary laws, fitness goals.";
    case 5:
      return "Help the user log their first food item. Encourage them to just type what they ate naturally. Call log_food with complete info.";
    case 6:
      return "The user just logged food in the previous step. Now help them try editing or removing it. Remind them of the entry number (#1) and suggest editing or removing. Call edit_entry or remove_entry.";
    case 7:
      return "Help the user save a note. Explain notes are for health observations, reminders, events — anything not food/sleep/weight. Call log_note.";
    case 8:
      return "Help the user log a sleep entry. Ask about last night if they don't volunteer info. Need: bed time, wake time, quality (1-10). Call log_sleep.";
    case 9:
      return "Help the user log their weight. Accept kg or lbs (convert lbs to kg). Call log_weight.";
    case 10:
      return "The user is on the final step. They've already seen the feature overview. Any response completes onboarding. Congratulate them!";
    default:
      return "";
  }
}

export function buildOnboardingSystemPrompt(
  currentStep: OnboardingStep,
  normalSystemPrompt: string,
): string {
  return `You are Food Agent, guiding a new user through onboarding step by step.

ONBOARDING MODE — STEP ${currentStep.id}/10: "${currentStep.title}"

YOUR GOAL RIGHT NOW:
${getStepGoal(currentStep.id)}

ONBOARDING RULES:
- Focus on completing the current step. Be encouraging, warm, and concise.
- If the user asks questions about the app or how things work, answer them fully — you know everything.
- If they try something unrelated (like logging food when we're on the timezone step), process it normally but gently remind them about the current step afterward.
- When they complete the step's action, celebrate briefly. The system will automatically advance to the next step.
- Keep messages short — this is Telegram chat.
- If they seem confused, give them a specific example they can copy-paste.
- Don't mention step numbers unless the user asks about progress.

--- TOOL & FEATURE REFERENCE ---

${normalSystemPrompt}`;
}
