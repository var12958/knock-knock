# Plan: KnockKnock UI/UX Redesign — Premium Web3 Privacy Platform

## Goal
Transform the existing KnockKnock Next.js frontend into a cohesive, premium dark-mode Web3 privacy platform for the hackathon demo. All major user-facing surfaces (layout, header, dashboard, send form, inbox, chat) will share a slate/indigo dark theme with subtle gradients, rounded cards, and clear affordances.

## Approach

### 1. Global Theme & Layout
- Set `html` / `body` to `bg-slate-950 text-slate-100 antialiased`.
- Keep the existing `Inter` font from Next.js Google Fonts.
- Update the layout wrapper to remove the bright `max-w-5xl` container background and let the dark background fill the viewport.

### 2. Header
- Convert `Web3Header.tsx` to a sticky, glassmorphic header (`sticky top-0`, `bg-slate-950/80 backdrop-blur`, bottom border `border-slate-800`).
- Logo: modern styled text "KnockKnock" with a subtle indigo gradient and a small " verified" lock / shield icon.
- Right side: when connected, render a profile chip showing the username (uppercase), a green dot + "Verified" label, and a subtle Disconnect button. When disconnected, keep the existing Connect button but styled for dark mode.
- Move network status into the chip as a small badge instead of a separate colored block.

### 3. Dashboard
- `Dashboard.tsx` already has a two-column responsive grid (`lg:grid-cols-2`). Keep the structure, remove the inline `console.log`/IIFE noise, and add consistent section spacing.
- Wrap each column in a subtle `border-slate-800` card with rounded corners so the two surfaces feel like distinct panels.

### 4. Send Request Form
- Convert `SendRequestForm.tsx` to a dark card: `bg-slate-900 border-slate-800 rounded-2xl`.
- Inputs: `bg-slate-950 border-slate-700 text-slate-100` with indigo focus rings.
- Labels: `text-slate-300`.
- Helper / privacy note: use a `bg-indigo-500/10 text-indigo-300` subtle info box.
- Primary CTA: `bg-indigo-600 hover:bg-indigo-500` gradient-ish solid button.
- Error states: `bg-red-500/10 text-red-300`.
- Success state: replace the inline `style` block with a polished dark success card and a link to the inbox.
- Keep all business logic, TEE proof flow, and constants untouched.

### 5. Inbox List
- Convert `InboxList.tsx` to a dark surface: `bg-slate-900 border-slate-800 rounded-2xl`.
- Header: "Your Inbox" with a refresh button styled for dark mode.
- Request cards: dark card with `bg-slate-800/50` hover state.
- Badges:
  - "Verified Human" — green badge with checkmark emoji/icon.
  - "Old Wallet" — amber/emerald badge with clock icon (per user request: "green checkmarks/emojis").
- Hidden sender: show a masked avatar (generic user icon / question mark) and a "Sender address hidden" caption.
- Actions: prominent `Accept` (emerald) and `Reject` (rose/red) buttons.
- Empty / connect states: dark-themed friendly copy.

### 6. Chat Room
- Convert `ChatRoom.tsx` to a dark chat shell: `bg-slate-900 border-slate-800 rounded-2xl`.
- Header: chat ID, shortened other address, "Active" badge.
- Messages:
  - Own messages align right with `bg-gradient-to-br from-indigo-600 to-violet-600 text-white` bubble.
  - Other messages align left with `bg-slate-800 text-slate-100` bubble.
- Input bar: dark input + indigo send button at the bottom.
- Loading / error / not-found states: dark-themed.

### 7. Shared Tokens
- Keep using the existing Tailwind `brand-*` colors where appropriate, but bias toward `indigo` / `violet` / `slate` for the Web3 premium feel.
- No Tailwind config changes required; current palette already includes brand indigos.

## Files to Modify
1. `frontend/app/layout.tsx` — dark body + container.
2. `frontend/app/globals.css` — dark base background/text.
3. `frontend/components/Web3Header.tsx` — premium sticky header + profile chip.
4. `frontend/components/Dashboard.tsx` — clean two-column dark layout.
5. `frontend/components/SendRequestForm.tsx` — dark send card + inputs.
6. `frontend/components/InboxList.tsx` — dark inbox cards with badges + actions.
7. `frontend/components/ChatRoom.tsx` — dark modern chat interface.

## Out of Scope
- No contract, Firebase, or wallet logic changes.
- No new routes or context changes.
- No dependency updates.

## Verification
- Run the Next.js dev build (`npm run dev` in `frontend/`) and visually confirm all screens.
- Use responsive mode to confirm the two-column dashboard stacks on mobile.
