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

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string;
}
