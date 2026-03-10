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
  serving_size_g: number;
  calories_per_100g: number;
  protein_per_100g: number;
  carbs_per_100g: number;
  fat_per_100g: number;
  sugar_per_100g: number;
  fiber_per_100g: number;
  sodium_per_100g: number;
  notes: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}
