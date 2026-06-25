export function formatDate(date: Date | string, timezone?: string): string {
  const parsed = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "full",
    timeStyle: "short",
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(parsed);
}

export function remainingCount(quantity: number, taken: number): number {
  return Math.max(quantity - taken, 0);
}

export function formatShortDate(
  date: Date | string,
  timezone?: string
): string {
  const parsed = typeof date === "string" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).format(parsed);
}
