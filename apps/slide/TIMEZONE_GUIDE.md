# Timezone Implementation Guide

## Overview

This application now has comprehensive timezone support to ensure all times are displayed correctly regardless of where users and event hosts are located.

## How It Works

### Storage

- All dates are stored in the database as **UTC timestamps** (this is standard practice)
- Each event has a `timezone` field (e.g., "America/New_York", "Europe/London")

### Display

- Dates are **displayed in the event's timezone**, not the user's browser timezone
- All date displays include a timezone abbreviation (e.g., EST, PST, GMT) for clarity
- Relative times ("in 2 hours", "3 days ago") are calculated based on the event's timezone

### Input

- When creating or editing events, datetime-local inputs are interpreted in the **event's timezone**
- Labels clearly indicate which timezone the input is in (e.g., "Submission Deadline (in EST)")

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

### `fromDateTimeLocal(dateTimeLocal, timezone)`

Convert a datetime-local input value to a UTC Date object.

```typescript
fromDateTimeLocal("2025-12-25T15:00", "America/New_York");
// Returns: Date object representing Dec 25, 3:00 PM EST in UTC
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

## Components

### TimezoneBadge

Visual badge component to show timezone:

```svelte
<TimezoneBadge timezone={event.timezone} />
```

## Where Timezone is Used

1. **Event Creation** (`/event/create`)

   - Host selects event timezone from dropdown
   - Defaults to user's browser timezone
   - Deadline input is interpreted in selected timezone

2. **Event Display** (`/night/[code]`)

   - Deadline shown in event timezone with abbreviation
   - Host settings show timezone context for inputs

3. **Event Management** (`/event/[id]`)

   - All times displayed in event timezone
   - Edit form uses event timezone for inputs

4. **Dashboard** (`/dashboard`)

   - Upcoming deadlines shown with timezone context
   - Relative times calculated in event timezone

5. **Live View** (`/night/[code]/live`)
   - All event times respect event timezone

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

3. Server receives datetime-local string and can create Date directly:
   ```typescript
   new Date(dateTimeLocalString); // Correctly interpreted as UTC
   ```

### Common Timezone Options

Pre-defined list in `COMMON_TIMEZONES`:

- US timezones (ET, CT, MT, PT, Alaska, Hawaii, Arizona)
- European timezones (London, Paris, Berlin)
- Asian timezones (Tokyo, Shanghai, Dubai)
- Australian timezones (Sydney)
- UTC

## Migration Notes

If you have existing events without timezone data, they default to "America/New_York" as set in the schema. You may want to run a migration to set appropriate timezones for existing events.

## Testing Considerations

1. Test deadline display across timezone boundaries (e.g., event in EST, view from PST)
2. Test daylight saving time transitions
3. Test with international timezones
4. Verify datetime-local inputs handle timezone conversions correctly
5. Check relative time calculations ("in 2 hours") are accurate

## Future Enhancements

Potential improvements:

- Allow users to view times in their local timezone vs event timezone (toggle)
- Show multiple timezones for international events
- Automatic timezone detection improvements
- iCal export with proper timezone data
