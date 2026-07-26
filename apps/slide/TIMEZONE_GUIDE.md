# Timezone Implementation Guide

## Overview

Events carry an IANA timezone such as `America/New_York`. The UI uses that zone when formatting
deadlines and when populating `datetime-local` controls. This is display/input context, not a
complete timezone conversion layer.

## How It Works

### Storage

- Prisma stores deadline instants in its `DateTime` column
- Each event has a `timezone` field (e.g., "America/New_York", "Europe/London")

### Display

- Dates are **displayed in the event's timezone**, not the user's browser timezone
- All date displays include a timezone abbreviation (e.g., EST, PST, GMT) for clarity
- Relative durations compare the stored instant with `Date.now()`; the event timezone is used only
  when the utility falls back to an absolute formatted date

### Input

- `toDateTimeLocal` renders a stored instant as wall-clock fields in the event timezone
- Server handlers currently pass submitted timezone-less strings directly to `new Date(value)`.
  JavaScript interprets those strings in the server process's local timezone, not in the event's
  selected timezone. Deployments should therefore set a deliberate process timezone (normally UTC)
  and must not claim that input was converted from the event timezone

## Utility Functions

All timezone utilities are in `/src/lib/utils/timezone.ts`:

### `formatInTimezone(date, timezone, options?)`

Format a date in a specific timezone using Intl.DateTimeFormat.

```typescript
formatInTimezone(event.submissionDeadline, event.timezone, {
	month: "short",
	day: "numeric",
	hour: "numeric",
	minute: "2-digit",
});
// Returns: "Dec 25, 3:00 PM"
```

### `toDateTimeLocal(date, timezone)`

Convert a UTC date to datetime-local format for input fields.

```typescript
toDateTimeLocal(event.submissionDeadline, event.timezone);
// Returns: "2025-12-25T15:00" (in the event's timezone)
```

### `getTimezoneAbbr(timezone, date?)`

Get the short timezone abbreviation (e.g., "EST", "PST").

```typescript
getTimezoneAbbr("America/New_York");
// Returns: "EST" (or "EDT" depending on DST)
```

### `formatRelativeWithTimezone(date, timezone)`

Format relative time with appropriate precision.

```typescript
formatRelativeWithTimezone(event.submissionDeadline, event.timezone);
// Returns: "in 2 hours" or "3 days ago" or formatted date if far in future/past
```

### `getUserTimezone()`

Get the user's browser timezone.

```typescript
getUserTimezone();
// Returns: "America/Los_Angeles" (based on browser)
```

## Where Timezone is Used

1. **Event Creation** (`/event/create`)
   - Host selects event timezone from dropdown
   - Defaults to user's browser timezone
   - Deadline input is parsed by the server process as described above

2. **Event Display and host settings** (`/night/[code]`)
   - Deadline shown in event timezone with abbreviation
   - Host settings show timezone context for inputs

3. **Event Management** (`/event/[id]`)
   - All times displayed in event timezone
   - Edit form uses event timezone for inputs

4. **Dashboard** (`/dashboard`)
   - Upcoming deadlines shown with timezone context
   - Relative durations compare instants; distant dates are formatted in the event timezone

## Best Practices

### When Displaying Dates

Always show the timezone abbreviation or name:

```svelte
{formatInTimezone(date, timezone)} {getTimezoneAbbr(timezone)}
```

### When Using datetime-local Inputs

1. Convert UTC date to local format for value:

   ```svelte
   <input
     type="datetime-local"
     value={toDateTimeLocal(event.submissionDeadline, event.timezone)}
   />
   ```

2. Label should indicate timezone:

   ```svelte
   <label>Deadline (in {getTimezoneAbbr(event.timezone)})</label>
   ```

3. Do not describe direct parsing as event-zone conversion:

   ```typescript
   new Date(dateTimeLocalString); // Interpreted in the server process's local timezone
   ```

   A future event-zone-aware parser must explicitly handle DST gaps and repeated wall-clock times.

### Common Timezone Options

Pre-defined list in `COMMON_TIMEZONES`:

- US timezones (ET, CT, MT, PT, Alaska, Hawaii, Arizona)
- European timezones (London, Paris, Berlin)
- Asian timezones (Tokyo, Shanghai, Dubai)
- Australian timezones (Sydney)
- UTC

## Migration Notes

The schema default is `America/New_York`. Migration
`prisma/migrations/20251023003608_add_event_timezone/migration.sql` added and backfilled the
column; review that default for imported or older events.

## Testing Considerations

1. Test deadline display across timezone boundaries (e.g., event in EST, view from PST)
2. Test daylight saving time transitions
3. Test with international timezones
4. Verify timezone-less datetime inputs under the deployment's configured process timezone
5. Check relative time calculations ("in 2 hours") are accurate

## Future Enhancements

Potential improvements:

- Allow users to view times in their local timezone vs event timezone (toggle)
- Show multiple timezones for international events
- Automatic timezone detection improvements
- iCal export with proper timezone data
