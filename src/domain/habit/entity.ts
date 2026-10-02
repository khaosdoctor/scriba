export interface HabitField {
  key: string;
  value: string;
}
export interface Habit {
  index: number; // position among habit bullets, stable regardless of check state
  line: string; // the full raw bullet line
  done: boolean; // `- [x]`
  label: string; // human prompt: the field key for value habits, else the bare text
  field: HabitField | null; // non-completion inline field, or null ⇒ yes/no habit
}
