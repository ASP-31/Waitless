# Responsive and accessibility audit

Scope: the Phase 1–10 web UI (`apps/web`: patient, staff/admin, public pages).
This is a **source-level checklist**, not a certification. The pass reviewed
component markup and Tailwind classes only; no real browser, viewport emulation,
screen reader, or automated axe/Lighthouse run was performed in this
environment. Items marked "source-verified" still need a manual browser check
before claiming full compliance.

## Checklist and current status

| Area | Check | Status | Notes |
| --- | --- | --- | --- |
| Keyboard dialogs | Focus trap, `Escape` to close, focus return, labelled close button | Implemented via Radix `Dialog` (`components/ui/dialog.tsx`); source-verified, browser-unverified | Dialogs in Appointments, Doctors, Departments, and Settings use `DialogTitle` / `DialogDescription` and a close button with `sr-only` label. The notification bell's custom `role="dialog"` popover (`components/shared/notification-bell.tsx`) still needs an explicit focus-trap/restore check. |
| ARIA labels / landmarks | Named navigation, icon buttons, form controls, charts | Partially implemented; spot-checked | `aria-label` on Patient/Admin/Main/bottom-nav landmarks, queue date/doctor selectors, refresh/back icon buttons, "mark as read" buttons, and notification counters. Peak-hours chart uses `role="img"` with a descriptive label. Full page-by-page audit not done. |
| Scrollable tables | Wide data tables scroll horizontally instead of clipping | Implemented; source-verified | Shared `components/ui/table.tsx` wraps tables in `overflow-x-auto`; `pages/admin/QueueManagement.tsx` also wraps its queue grid. Keyboard scrolling and focus visibility inside those regions still need a browser check. |
| Mobile breakpoints | Usable at phone/tablet/desktop widths | Implemented; not device-verified | Tailwind `sm`/`md`/`lg`/`xl` grids throughout; patient bottom navigation at `md`, admin sidebar at `lg` with a horizontal mobile tab bar below that; `RoomView` wall display scales type at `sm`. No physical device or emulator testing in this pass. |
| Focus visibility | Visible focus ring on interactive elements | Implemented; source-verified | Global `:focus-visible` rule in `src/index.css` plus ring utilities on buttons, inputs, tabs, and dialog close. Contrast of the ring against every surface was not measured. |
| Reduced motion | Honour `prefers-reduced-motion` | **Gap** | No `motion-reduce:` or `prefers-reduced-motion` rule found. Dialog/select enter/exit animations, `animate-pulse` skeletons, hover transforms, and the landing-page pulse still run for users who request reduced motion. |
| Live regions | Async status changes announced | Partial | `aria-live="polite"` on the wall-display current token and swap-expiry text; toasts are handled by Sonner. Queue/ETA updates rely on visual refresh — verify screen-reader announcements. |
| Colour contrast and text sizing | WCAG contrast, 200% zoom, reflow at 320 px | **Not verified** | Requires a browser and contrast tooling. Do not claim compliance from source review alone. |
| Forms and error messages | Errors associated with fields, not colour-only | Partially implemented; not audited | React Hook Form + Zod + Radix Label are in use; error announcement and colour-only status cues need a manual pass. |
| Touch target sizing | Adequate tap targets on mobile | **Not measured** | Bottom-nav and icon buttons have spacing utilities, but no 44×44 px audit was performed. |

## Follow-ups (future work, not blocking Phase 1–10)

1. Add `motion-reduce:` / `prefers-reduced-motion` guards for skeleton pulses,
   dialog/select animations, and hover transforms.
2. Browser-check dialog focus trap/restore (including the notification popover),
   keyboard scrolling of wide tables, and focus visibility at 200% zoom.
3. Run an automated accessibility scan plus a manual screen-reader spot check
   (NVDA/VoiceOver) on the booking, queue, swap, and admin queue flows.
4. Record viewport screenshots under `docs/assets/` for the README demo section
   once captures are available.

Browser E2E (`pnpm test:e2e`) and coverage (`pnpm test:coverage`) help prevent
regressions but do not replace the manual checks above. Phase 11 remains out of
scope; no Phase 11 behaviour is assumed here.
