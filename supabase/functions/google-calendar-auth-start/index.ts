import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type AuthStartPayload = {
  tenant_id?: string;
  mode?: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const googleClientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
const googleRedirectUri = Deno.env.get("GOOGLE_CALENDAR_REDIRECT_URI");

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
      },
    })
  : null;

const asString = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const encodeState = (value: unknown) => {
  return btoa(JSON.stringify(value))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
};

const json = (body: unknown, status = 200) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "content-type": "application/json",
    },
  });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  if (!supabase || !googleClientId || !googleRedirectUri) {
    return json({ error: "Google Calendar OAuth env missing" }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  const user = userData.user;

  if (userError || !user) {
    return json({ error: "Authentication required" }, 401);
  }

  let payload: AuthStartPayload;
  try {
    payload = await request.json() as AuthStartPayload;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const tenantId = asString(payload.tenant_id);
  const mode = asString(payload.mode) || "solo_google";

  if (!tenantId) {
    return json({ error: "tenant_id is required" }, 400);
  }

  const { data: membership } = await supabase
    .from("tenant_members")
    .select("role")
    .eq("tenant_id", tenantId)
    .eq("user_id", user.id)
    .maybeSingle();

  if (!membership || !["owner", "admin"].includes(String(membership.role))) {
    return json({ error: "Tenant admin access required" }, 403);
  }

  const oauthState = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const { data: connection, error: connectionError } = await supabase
    .from("calendar_connections")
    .insert({
      tenant_id: tenantId,
      provider: "google_calendar",
      mode,
      status: "pending",
      metadata: {
        oauth_state: oauthState,
        state_expires_at: expiresAt,
        requested_by: user.id,
      },
    })
    .select("id")
    .single();

  if (connectionError || !connection?.id) {
    return json({ error: connectionError?.message || "Could not create calendar connection" }, 500);
  }

  const state = encodeState({
    tenant_id: tenantId,
    connection_id: connection.id,
    mode,
    state: oauthState,
  });

  const scopes = [
    "openid",
    "email",
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.freebusy",
  ];

  const params = new URLSearchParams({
    client_id: googleClientId,
    redirect_uri: googleRedirectUri,
    response_type: "code",
    scope: scopes.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });

  return json({
    auth_url: `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`,
  });
});
