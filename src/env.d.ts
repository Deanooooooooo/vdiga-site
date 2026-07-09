/// <reference path="../.astro/types.d.ts" />

interface ImportMetaEnv {
  readonly PUBLIC_SUPABASE_URL?: string;
  readonly PUBLIC_SUPABASE_ANON_KEY?: string;
  readonly SUPABASE_SERVICE_ROLE_KEY?: string;
  readonly SUPABASE_DB_PASSWORD?: string;
  readonly GOOGLE_CALENDAR_CLIENT_ID?: string;
  readonly GOOGLE_CALENDAR_CLIENT_SECRET?: string;
  readonly GOOGLE_CALENDAR_REDIRECT_URI?: string;
  readonly PUBLIC_SITE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
