# EMDO MVP design system

The accepted visual references are `emdo-today-desktop.png` and `emdo-approval-mobile.png`. They define the primary desktop shell and the highest-risk mobile approval state.

## Visual direction

- Background: true white `#ffffff`.
- Primary ink: `#07162f`; secondary text: `#667085`.
- Eucalyptus action/selection: `#087154`; pale selection: `#edf4f1`.
- Dividers: `#d9dfe5`; soft track: `#edf0f2`.
- Safety/apricot: `#f26a3d`, reserved for warnings and destructive-risk context.
- No gradients, glass, neon, decorative artwork, or default card grids.
- Open canvas with fine rules. Rounded frames are limited to the composer, focused controls, and the before/after proposal preview.
- Typography: `Inter`, `Avenir Next`, `Segoe UI`, system UI, sans-serif. Content headings use 600–700 weight; controls use deliberate 14–16px sizes.
- Icons: consistent outline family, 1.75px stroke, round caps/joins, 20–24px optical size.
- Motion: 140–200ms ease-out for selection, disclosures, and sync state; respect `prefers-reduced-motion`.

## Desktop shell

- 256px quiet left sidebar with the EMDO wordmark, eight routes, selected rail, and sync state at the bottom.
- Main content has a conversational composer, an open day timeline, three lower domain columns, and an optional right context rail.
- The app must remain useful at 1024px before collapsing to mobile navigation.

## Mobile shell

- Top app bar, scrollable content, and a five-item safe-area bottom navigation: Today, Ask, Schedule, Finance, More.
- More exposes Shopping, Approvals, Activity, and Settings; the current secondary destination remains visible.
- All tap targets are at least 44px. Persistent approval actions sit above navigation and never overlap content.

## Allowed visible copy

Desktop first viewport:

- EMDO
- Today
- Ask EMDO
- Schedule
- Finance
- Shopping
- Approvals
- Activity
- Settings
- Good morning
- Sunday, August 9
- What can I help with?
- Next up
- Household
- Money this month
- Shopping
- Coming up
- Offline-ready · Synced just now

Mobile approval state:

- Approve calendar change
- Review every detail before EMDO writes to Google Calendar.
- Expires in 08:42
- Create event
- Dentist appointment
- Calendar / Personal
- Date / Tuesday, August 11
- Time / 2:30 PM–3:30 PM
- Travel / Leave by 1:55 PM
- Location / 225 King St W, Toronto
- What will change
- Before / No event
- After / 1 new Google Calendar event
- Only these event fields will be sent to Google.
- Approve and create
- Reject
- Voice, typed replies, email, and notifications cannot approve this action.

## Component families

- `AppShell`, `DesktopSidebar`, `MobileNavigation`, `TopBar`
- `AskComposer`, `VoiceTrigger`, `SyncStatus`
- `Timeline`, `AgendaRow`, `DomainSummary`
- `ProposalDetail`, `FieldComparison`, `ApprovalActions`, `ExpiryClock`
- `Button` variants: primary, secondary, quiet, danger; every variant has focus-visible, disabled, busy, and pressed states.

## Intentional corrections from generated references

- The desktop right rail will not label an event “Tomorrow” when that event appears on the current-day timeline; seeded dates remain internally consistent.
- Google Calendar brand artwork is not required. The implementation uses the shared calendar outline icon so UI assets remain code-native and theme-consistent.

