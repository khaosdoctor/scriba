export function parseHabitRef(
  text: string,
): { date: string; index: number; digest: string } | null {
  const match = text.match(/hb:(\d{4}-\d{2}-\d{2}):(\d+):([0-9a-f]{8})/);
  if (!match) return null;
  return { date: match[1]!, index: Number(match[2]), digest: match[3]! };
}
