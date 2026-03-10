export interface FoodEntry {
  timestamp: string;
  food_item: string;
  quantity: number;
  unit: string;
  calories: number;
  notes: string;
}

export interface NutritionInfo {
  calories: number;
  unit: string;
  quantity: number;
}

export interface UserTarget {
  daily_calories: number;
  timezone: string;
}

export interface SleepEntry {
  date: string; // yyyy-mm-dd (wake date for night sleep, start date for naps)
  type: "night" | "nap";
  start_time: string; // ISO 8601 +08:00
  end_time: string; // ISO 8601 +08:00
  duration_hours: number;
  quality: number; // 1-10
  notes: string;
}

export interface NoteEntry {
  timestamp: string;
  note: string;
}

export interface WeightEntry {
  timestamp: string;
  weight_kg: number;
  notes: string;
}

export interface NutritionLabelEntry {
  timestamp: string;
  product_name: string;
  brand: string;
  serving_size: string;
  calories: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  sugar_g: number;
  fiber_g: number;
  sodium_mg: number;
  notes: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}
