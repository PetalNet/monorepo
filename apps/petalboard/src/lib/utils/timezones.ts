export const COMMON_TIMEZONES = [
  { value: "America/New_York", label: "Eastern Time (US & Canada)" },
  { value: "America/Chicago", label: "Central Time (US & Canada)" },
  { value: "America/Denver", label: "Mountain Time (US & Canada)" },
  { value: "America/Los_Angeles", label: "Pacific Time (US & Canada)" },
  { value: "America/Anchorage", label: "Alaska" },
  { value: "Pacific/Honolulu", label: "Hawaii" },
  { value: "America/Phoenix", label: "Arizona" },
  { value: "America/Toronto", label: "Toronto" },
  { value: "America/Vancouver", label: "Vancouver" },
  { value: "America/Mexico_City", label: "Mexico City" },
  { value: "Europe/London", label: "London" },
  { value: "Europe/Paris", label: "Paris" },
  { value: "Europe/Berlin", label: "Berlin" },
  { value: "Europe/Rome", label: "Rome" },
  { value: "Europe/Madrid", label: "Madrid" },
  { value: "Europe/Amsterdam", label: "Amsterdam" },
  { value: "Europe/Brussels", label: "Brussels" },
  { value: "Europe/Vienna", label: "Vienna" },
  { value: "Europe/Warsaw", label: "Warsaw" },
  { value: "Europe/Athens", label: "Athens" },
  { value: "Europe/Istanbul", label: "Istanbul" },
  { value: "Europe/Moscow", label: "Moscow" },
  { value: "Asia/Dubai", label: "Dubai" },
  { value: "Asia/Kolkata", label: "India (IST)" },
  { value: "Asia/Bangkok", label: "Bangkok" },
  { value: "Asia/Singapore", label: "Singapore" },
  { value: "Asia/Hong_Kong", label: "Hong Kong" },
  { value: "Asia/Shanghai", label: "Beijing/Shanghai" },
  { value: "Asia/Tokyo", label: "Tokyo" },
  { value: "Asia/Seoul", label: "Seoul" },
  { value: "Australia/Sydney", label: "Sydney" },
  { value: "Australia/Melbourne", label: "Melbourne" },
  { value: "Australia/Brisbane", label: "Brisbane" },
  { value: "Australia/Perth", label: "Perth" },
  { value: "Pacific/Auckland", label: "Auckland" },
  { value: "America/Sao_Paulo", label: "São Paulo" },
  { value: "America/Buenos_Aires", label: "Buenos Aires" },
  { value: "America/Santiago", label: "Santiago" },
  { value: "Africa/Johannesburg", label: "Johannesburg" },
  { value: "Africa/Cairo", label: "Cairo" },
  { value: "Africa/Lagos", label: "Lagos" },
  { value: "UTC", label: "UTC (Coordinated Universal Time)" },
];

export function getUserTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "America/New_York";
}

/**
 * Converts a datetime-local input string (YYYY-MM-DDTHH:mm) to a UTC Date
 * interpreting the local time in the specified timezone.
 *
 * For example, if dateTimeString is "2025-11-03T17:00" and timezone is "America/Chicago",
 * this returns a Date representing 2025-11-03 17:00 CST in UTC (which would be 23:00 UTC).
 *
 * @param dateTimeString - The datetime string from datetime-local input (e.g., "2025-11-03T17:00")
 * @param timezone - The IANA timezone (e.g., "America/Chicago")
 * @returns A Date object in UTC representing that local time in the specified timezone
 */
export function parseLocalDateTimeInTimezone(
  dateTimeString: string,
  timezone: string
): Date {
  // The trick: append the timezone to create an ISO 8601 string that JavaScript can parse
  // We'll use a temporary approach: create a formatter to determine the offset

  // Parse components
  const [datePart, timePart] = dateTimeString.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);

  // Create a reference date to determine timezone offset at this date/time
  // We use UTC constructor to avoid any local timezone interpretation
  const refDate = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));

  // Format this date in the target timezone to see what "wall clock" time it represents
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(refDate);
  const getPartValue = (type: string) =>
    parts.find((p) => p.type === type)?.value || "0";

  const tzYear = parseInt(getPartValue("year"));
  const tzMonth = parseInt(getPartValue("month"));
  const tzDay = parseInt(getPartValue("day"));
  const tzHour = parseInt(getPartValue("hour"));
  const tzMinute = parseInt(getPartValue("minute"));

  // Calculate the offset: how many ms difference between UTC interpretation and timezone interpretation
  const utcTime = Date.UTC(year, month - 1, day, hour, minute, 0);
  const tzTime = Date.UTC(tzYear, tzMonth - 1, tzDay, tzHour, tzMinute, 0);
  const offset = tzTime - utcTime;

  // Correct the UTC time by subtracting the offset
  return new Date(utcTime - offset);
}

/**
 * Converts a UTC Date to a datetime-local input string (YYYY-MM-DDTHH:mm)
 * displaying the time in the specified timezone.
 *
 * For example, if the date is "2025-11-03T23:00:00Z" (UTC) and timezone is "America/Chicago",
 * this returns "2025-11-03T17:00" (5pm CST).
 *
 * @param date - The Date object in UTC
 * @param timezone - The IANA timezone (e.g., "America/Chicago")
 * @returns A string in YYYY-MM-DDTHH:mm format for datetime-local inputs
 */
export function formatDateTimeForInput(
  date: Date | string,
  timezone: string
): string {
  const parsed = typeof date === "string" ? new Date(date) : date;

  // Use Intl.DateTimeFormat to get the date/time components in the target timezone
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(parsed);
  const getPartValue = (type: string) =>
    parts.find((p) => p.type === type)?.value || "0";

  const year = getPartValue("year");
  const month = getPartValue("month");
  const day = getPartValue("day");
  const hour = getPartValue("hour");
  const minute = getPartValue("minute");

  return `${year}-${month}-${day}T${hour}:${minute}`;
}
