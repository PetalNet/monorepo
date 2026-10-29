# RSVP System Redesign

## Completed Changes

### Database Schema ✅

- Created `Rsvp` table - main RSVP with name, email, PIN
- Created `SlotSignup` table - links RSVPs to slots (many-to-many)
- Added `rsvpLimit` to Event (optional max attendees)
- Added `required` field to Slot (mark slots as required/optional)
- Dropped old `Signup` table
- Migration created and applied

### Validation Schemas ✅

- Updated `eventSchema` with `rsvpLimit`
- Updated `slotSchema` with `required` field
- Created `rsvpSchema` for new RSVPs with array of `slotIds`
- Created `rsvpUpdateSchema` for updating existing RSVPs with PIN

## Key Concepts

### New Flow:

1. **RSVP First**: User creates an RSVP with name, email (optional), and PIN
2. **Select Slots**: User can sign up for 0 or more slots
3. **Required Slots**: Host can mark certain slots as required
4. **Update with PIN**: User can update their RSVP using their PIN code
5. **RSVP Limit**: Host can optionally set max number of attendees

### Benefits:

- People can RSVP without signing up for anything
- One person = one RSVP (tracked by PIN)
- Can sign up for multiple slots in one RSVP
- Clearer UI - RSVP vs. Sign-ups are separate concepts

## TODO: Routes & UI

### 1. Create Page (`/create`)

- [ ] Add RSVP Limit field (optional)

### 2. Event Public Page (`/event/[code]`)

- [ ] Complete redesign:
  - [ ] Show RSVP count vs. limit
  - [ ] RSVP form (name, email, PIN)
  - [ ] Show available slots (required vs. optional)
  - [ ] Allow selecting multiple slots in one form
  - [ ] Success message with PIN reminder
  - [ ] "Update RSVP" link/section

### 3. Event Manage Page (`/event/manage/[token]`)

- [ ] Update event form - add RSVP Limit field
- [ ] Update slot form - add "Required" checkbox
- [ ] Show RSVPs list (not slot signups)
  - [ ] Show each person's name, email, slots they're signed up for
  - [ ] Remove RSVP button (removes all their slot signups too)
- [ ] Show slot fill status (X/Y signed up, required/optional)

### 4. Update RSVP (`/manage-signup` or new route)

- [ ] Form: Enter PIN
- [ ] If valid, show their current RSVP details
- [ ] Allow updating name, email, slot selections
- [ ] Allow canceling entire RSVP

### 5. Dashboard

- [ ] Update stats to show RSVP count instead of signup count
- [ ] Should work with new schema

## API Routes to Update

### `/api/signups/*`

All these routes need to be redesigned for the new RSVP system:

- [ ] `/api/signups/lookup` → `/api/rsvp/lookup` (lookup by event + PIN)
- [ ] `/api/signups/update` → `/api/rsvp/update`
- [ ] `/api/signups/cancel` → `/api/rsvp/cancel`

## Server Actions to Update

### `create/+page.server.ts`

- [ ] Add `rsvpLimit` to event creation

### `event/manage/[token]/+page.server.ts`

- [ ] Update `load` function to fetch RSVPs and SlotSignups
- [ ] Update `updateEvent` action to handle `rsvpLimit`
- [ ] Update `addSlot` action to handle `required` field
- [ ] Update `updateSlot` action to handle `required` field
- [ ] Replace `deleteSignup` with `deleteRsvp`

### `event/[code]/+page.server.ts`

- [ ] Complete rewrite for new RSVP submission flow
- [ ] Handle multiple slot selections
- [ ] Check RSVP limit before allowing new RSVPs
- [ ] Check slot quantities
- [ ] Validate required slots are selected

## Security & Validation

- [ ] Ensure PIN hashing is consistent (use scrypt like passwords)
- [ ] Validate required slots are selected when required
- [ ] Prevent over-booking slots
- [ ] Prevent exceeding RSVP limit
- [ ] Unique constraint on (eventId, pinHash) prevents duplicate PINs

## UI/UX Improvements

- [ ] Clear separation: "RSVP to attend" vs. "Sign up for items"
- [ ] Show which slots are required vs. optional
- [ ] Show available/remaining spots for each slot
- [ ] Show RSVP limit clearly
- [ ] Better success messages with PIN reminder
- [ ] Simpler forms - less overwhelming

## Notes

- The `required` field on slots should be used to indicate slots that every attendee must sign up for
- People can still RSVP without signing up for any optional slots
- The host sees one list of RSVPs, with each person's slot selections shown
- This is a breaking change - old data (Signup table) has been dropped
