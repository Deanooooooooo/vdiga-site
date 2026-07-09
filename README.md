# Vdiga Site

Static Astro site for `vdiga.bg`, the Bulgarian-first AI receptionist project.

## Scripts
- `npm run dev` — local dev server
- `npm run build` — Astro type check + static build
- `npm run preview` — preview built site

## SaaS Foundation
- Supabase browser config lives in `src/lib/supabase.ts`
- Example environment variables live in `.env.example`
- Initial database schema and RLS policies live in `supabase/migrations/202607090001_foundation.sql`
- Auth entry points: `/signup`, `/login`, `/app`

Required environment variables:

```bash
PUBLIC_SUPABASE_URL=
PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_DB_PASSWORD=
GOOGLE_CALENDAR_CLIENT_ID=
GOOGLE_CALENDAR_CLIENT_SECRET=
GOOGLE_CALENDAR_REDIRECT_URI=
PUBLIC_SITE_URL=
```

Google Calendar OAuth is handled by Supabase Edge Functions:

- `google-calendar-auth-start`
- `google-calendar-auth-callback`

## Current Scope
- Core pages: `/`, `/tseni`, `/demo`, `/kak-raboti`, `/za-nas`
- Reusable layout, header, footer, CTA, FAQ, pricing, and product visual components
- Organization, BreadcrumbList, FAQPage, Product, and Article schema helpers
- AI-crawler friendly `robots.txt`
- EUR pricing placeholders from the project brief
- SaaS foundation for auth, tenant data, call logs, leads, phone mappings, provisioning, and calendar bookings

## Launch Notes
The public demo number is intentionally not hardcoded yet. Add it in `src/data/site.ts` after Retell/Twilio testing passes.
