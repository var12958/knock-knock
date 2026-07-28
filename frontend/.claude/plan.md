# Plan: KnockKnock Premium Tailwind Redesign — Custom Color Palette

## Goal
Apply the user's exact color palette to all major KnockKnock UI surfaces so the app looks like a premium, high-end Web3 SaaS product for the hackathon demo.

## Color Tokens
- **Background:** `#222831` → `bg-[#222831]`
- **Cards / Secondary Backgrounds:** `#393E46` → `bg-[#393E46]`
- **Primary Text / Highlights / Borders:** `#DFD0B8` → `text-[#DFD0B8]`, `border-[#DFD0B8]`
- **Secondary Text / Muted Accents:** `#948979` → `text-[#948979]`

## Components to Update
1. **Web3Header.tsx**
   - Background: `bg-[#222831]/95` with `backdrop-blur` and `border-b border-[#DFD0B8]/10`.
   - Logo: use the user's image at `/logo.png` via Next.js `Image` or an `<img>` tag. Keep text fallback.
   - Profile chip on the right: `bg-[#393E46]` with `text-[#DFD0B8]`, uppercase username, green verified dot, and subtle disconnect button.
   - Connect button: use primary palette with premium transitions.

2. **Dashboard.tsx**
   - No extra wrapper colors needed since layout sets the page background.
   - Use clean two-column responsive grid with generous gap and cards that sit on `bg-[#222831]`.
   - Section wrappers can be transparent or use a very subtle `border-[#DFD0B8]/10`.

3. **SendRequestForm.tsx**
   - Card: `bg-[#393E46]` with `rounded-3xl`, soft shadow, and `border border-[#DFD0B8]/10`.
   - Inputs: `bg-[#222831]`, `border-[#948979]`, `text-[#DFD0B8]`, focus ring in primary.
   - Submit button: `bg-[#DFD0B8] text-[#222831]` with hover lift/glow.
   - Labels: `text-[#DFD0B8]`; helper text: `text-[#948979]`.
   - Success / error states styled with the same palette.
   - Keep all business logic unchanged.

4. **InboxList.tsx**
   - Inbox cards: `bg-[#393E46]` with `border-[#DFD0B8]/10`.
   - Preview area: `bg-[#222831]/50` with `border-[#948979]/30`.
   - Badges: "Verified Human" → emerald/champagne styling with `text-[#DFD0B8]` accents.
   - Accept button: `bg-[#DFD0B8] text-[#222831]`.
   - Reject button: `bg-[#948979] text-[#222831]`.
   - Empty / connect states styled consistently.

5. **ChatRoom.tsx**
   - Chat shell: `bg-[#393E46]` with `border-[#DFD0B8]/10`.
   - Header: `bg-[#393E46]/80` with border.
   - Own bubbles: `bg-[#DFD0B8] text-[#222831]`.
   - Other bubbles: `bg-[#393E46] text-[#DFD0B8]` (slightly different shade via `bg-[#31363F]` if needed for contrast against shell).
   - Input bar: `bg-[#222831]`, `border-[#948979]`, send button `bg-[#DFD0B8]`.
   - Loading / error / not-found states styled with palette.

6. **ProofBadge.tsx**
   - Update badge colors to match the new palette.

7. **globals.css & layout.tsx**
   - Set global background to `bg-[#222831]` and text to `text-[#DFD0B8]`.
   - Remove slate tokens from body; rely on custom palette.

## Design Principles
- Generous spacing: `gap-6`, `p-6`, `rounded-3xl`, `shadow-2xl`.
- Subtle borders with low opacity (`/10`, `/20`) for depth without clutter.
- Transitions on interactive elements: `transition-all duration-200`.
- Premium feel through glassmorphism on the header and soft shadows on cards.

## Verification
- Run `npm run build` to confirm no Tailwind/className errors.
- Run `npm run test` to confirm tests still pass.
- Visual spot-check via `npm run dev` (optional, user can run).
