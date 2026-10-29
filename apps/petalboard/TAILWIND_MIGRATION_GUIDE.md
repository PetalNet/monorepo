# Tailwind CSS Migration Guide

**Note:** This project uses **Tailwind CSS v3** for better stability and compatibility with the current Vite/SvelteKit setup.

## ✅ Completed Migrations

The following files have been successfully migrated to Tailwind CSS:

1. **Configuration Files**

   - `tailwind.config.js` - Custom colors, fonts, gradients, shadows
   - `postcss.config.js` - PostCSS configuration
   - `src/app.css` - Tailwind directives + custom component classes

2. **Layout & Core Pages**

   - `src/routes/+layout.svelte` - Global layout, navigation, footer
   - `src/routes/+page.svelte` - Homepage with hero, features, CTA sections
   - `src/routes/create/+page.svelte` - Event creation form
   - `src/routes/login/+page.svelte` - Login form
   - `src/routes/register/+page.svelte` - Registration form
   - `src/routes/dashboard/+page.svelte` - Events dashboard

3. **Components**
   - `src/lib/components/AddressInput.svelte` - Address autocomplete with Google Maps

## 🚧 Remaining Files to Migrate

### 1. Event Public View (`src/routes/event/[code]/+page.svelte`)

**Size:** ~1900 lines  
**Complexity:** High - Contains multiple sections with complex state management

#### Key Sections to Migrate:

- Event header with RSVP button
- Success/info banners
- Attendees list (attending/maybe/not attending collapsible sections)
- Public question responses
- PIN prompt modal
- RSVP form modal with dynamic question fields
- Edit RSVP modal

#### Recommended Approach:

Replace the `<style>` block starting around line 600 with Tailwind classes. Use the utility classes from `app.css`:

- `.btn-primary`, `.btn-secondary`, `.btn-ghost` for buttons
- `.input-field` for form inputs
- `.card`, `.card-sm` for containers
- `.error-banner`, `.success-banner` for notifications
- `.badge-attending`, `.badge-maybe`, `.badge-not-attending` for status badges

### 2. Event Management Page (`src/routes/event/manage/[token]/+page.svelte`)

**Size:** ~1081 lines  
**Complexity:** Very High - Most complex page in the app

#### Key Sections to Migrate:

- Management header with public link display
- Welcome banner (for newly created events)
- Success toasts
- Tab navigation (Management vs RSVPs)
- Edit event form panel
- Questions section with add/edit/delete functionality
- Add question modal with dynamic fields
- RSVPs tab with detailed cards
- Question responses display
- Danger zone (delete event)

#### Recommended Approach:

1. Start with the tab navigation and basic layout structure
2. Migrate the event edit form (reuse patterns from create page)
3. Convert question cards and their forms
4. Migrate the modal (similar structure to event public view modals)
5. Convert RSVP cards in the RSVPs tab
6. Finish with the danger zone section

## 🎨 Custom Tailwind Utilities Available

### Colors

- **Primary:** `primary-{50-900}` (Purple shades)
- **Accent:** `accent-500` (#9b6bff)
- **Dark:** `dark-{500-900}` (Text colors)
- **Status Colors:**
  - Success: `bg-success-bg`, `text-success-text`
  - Warning: `bg-warning-bg`, `text-warning-text`
  - Danger: `bg-danger-bg`, `text-danger-text`

### Background Gradients

- `bg-app-gradient` - Main app background
- `bg-primary-gradient` - Button gradient

### Box Shadows

- `shadow-card` - Standard card shadow
- `shadow-card-hover` - Hover state for cards
- `shadow-card-lg` - Large card shadow
- `shadow-card-sm` - Small card shadow
- `shadow-button` - Button shadow

### Component Classes (from app.css)

- `.input-field` - Standard input styling
- `.btn-primary` - Primary button
- `.btn-secondary` - Secondary button
- `.btn-ghost` - Ghost button (transparent)
- `.card` - Standard card container
- `.card-sm` - Small card
- `.form-label` - Form label styling
- `.error-text` - Error message text
- `.error-banner` - Error notification banner
- `.success-banner` - Success notification banner

## 📝 Migration Patterns

### Buttons

**Old:**

```svelte
<button class="primary-btn">Click me</button>
<style>
  .primary-btn {
    background: linear-gradient(135deg, #7c5dfa, #9b6bff);
    color: white;
    padding: 0.85rem 1.75rem;
    border-radius: 999px;
    /* ... */
  }
</style>
```

**New:**

```svelte
<button class="btn-primary">Click me</button>
<!-- OR with inline classes: -->
<button class="px-7 py-3.5 rounded-full bg-primary-gradient text-white font-semibold cursor-pointer shadow-button hover:-translate-y-px">
  Click me
</button>
```

### Form Inputs

**Old:**

```svelte
<input type="text" name="title" />
<style>
  input {
    border-radius: 12px;
    border: 1px solid rgba(123, 95, 250, 0.25);
    /* ... */
  }
</style>
```

**New:**

```svelte
<input type="text" name="title" class="input-field" />
<!-- OR: -->
<input type="text" name="title" class="rounded-xl border border-primary-700/25 px-4 py-3 font-inherit bg-white/90 focus:outline-none focus:border-primary-700 focus:ring-4 focus:ring-primary-700/18" />
```

### Cards

**Old:**

```svelte
<div class="card">Content</div>
<style>
  .card {
    background: white;
    border-radius: 20px;
    padding: 2rem;
    box-shadow: 0 20px 40px rgba(60, 35, 110, 0.08);
  }
</style>
```

**New:**

```svelte
<div class="card">Content</div>
<!-- OR: -->
<div class="bg-white rounded-[20px] p-6 lg:p-10 shadow-card">Content</div>
```

### Status Badges

**Old:**

```svelte
<span class="badge attending">✓ Attending</span>
<style>
  .badge.attending {
    background: rgba(34, 197, 94, 0.1);
    color: #15803d;
  }
</style>
```

**New:**

```svelte
<span class="badge-attending px-3 py-1 rounded-full text-xs font-semibold">
  ✓ Attending
</span>
```

## 🧪 Testing Checklist

After completing the migration:

- [ ] Run `pnpm dev` and check for any build errors
- [ ] Test all form submissions (create event, RSVP, edit RSVP)
- [ ] Verify modals open/close correctly
- [ ] Test tab navigation in event management
- [ ] Check responsive design on mobile (< 640px)
- [ ] Verify all hover states work
- [ ] Test collapsible sections (attendees, questions)
- [ ] Check that Google Maps integration still works
- [ ] Verify status badges display correctly
- [ ] Test dark mode compatibility (if applicable)

## 💡 Tips

1. **Use VS Code's multi-cursor** to replace repeated class patterns
2. **Keep the browser dev tools open** to inspect actual rendered styles
3. **Test frequently** - Don't migrate everything at once without checking
4. **Reference the completed pages** for consistent class patterns
5. **Use Tailwind's JIT mode** - arbitrary values like `rounded-[18px]` work great
6. **Opacity syntax** - `text-dark-900/80` = `rgba` with 80% opacity

## 🚀 Next Steps

1. Complete migration of `/event/[code]/+page.svelte`
2. Complete migration of `/event/manage/[token]/+page.svelte`
3. Run full application test suite
4. Remove any unused style blocks
5. Consider creating additional component classes for repeated patterns
6. Update any documentation that references old styling approach

---

**Note:** The linting errors you see in `app.css` for `@apply` and `@tailwind` directives are expected - VS Code's CSS linter doesn't recognize Tailwind directives, but the build system handles them correctly.
