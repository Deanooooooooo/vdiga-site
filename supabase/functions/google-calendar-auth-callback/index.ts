import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type JsonObject = Record<string, unknown>;

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const googleClientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
const googleClientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET");
const googleRedirectUri = Deno.env.get("GOOGLE_CALENDAR_REDIRECT_URI");
const siteUrl = Deno.env.get("PUBLIC_SITE_URL") || "http://localhost:4321";

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

const decodeState = (value: string): JsonObject | null => {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as JsonObject : null;
  } catch {
    return null;
  }
};

const redirectToApp = (status: "connected" | "error", message?: string) => {
  const url = new URL("/app", siteUrl);
  url.searchParams.set("calendar", status);
  if (message) url.searchParams.set("message", message);
  return Response.redirect(url.toString(), 302);
};

const fetchJson = async <T>(url: string, init: RequestInit): Promise<T> => {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(typeof data.error_description === "string" ? data.error_description : `Request failed: ${response.status}`);
  }
  return data as T;
};

Deno.serve(async (request) => {
  if (!supabase || !googleClientId || !googleClientSecret || !googleRedirectUri) {
    return redirectToApp("error", "google_oauth_env_missing");
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const stateParam = url.searchParams.get("state");
  const googleError = url.searchParams.get("error");

  if (googleError) {
    return redirectToApp("error", googleError);
  }

  if (!code || !stateParam) {
    return redirectToApp("error", "missing_code_or_state");
  }

  const state = decodeState(stateParam);
  const tenantId = asString(state?.tenant_id);
  const connectionId = asString(state?.connection_id);
  const oauthState = asString(state?.state);
  const mode = asString(state?.mode) || "solo_google";

  if (!tenantId || !connectionId || !oauthState) {
    return redirectToApp("error", "invalid_state");
  }

  const { data: connection } = await supabase
    .from("calendar_connections")
    .select("id, metadata")
    .eq("id", connectionId)
    .eq("tenant_id", tenantId)
    .maybeSingle();

  const metadata = connection?.metadata && typeof connection.metadata === "object" && !Array.isArray(connection.metadata)
    ? connection.metadata as JsonObject
    : {};
  const expectedState = asString(metadata.oauth_state);
  const expiresAt = asString(metadata.state_expires_at);

  if (!connection || expectedState !== oauthState) {
    return redirectToApp("error", "state_mismatch");
  }

  if (expiresAt && new Date(expiresAt).getTime() < Date.now()) {
    return redirectToApp("error", "state_expired");
  }

  try {
    const tokenData = await fetchJson<JsonObject>("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: googleClientId,
        client_secret: googleClientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: googleRedirectUri,
      }),
    });

    const accessToken = asString(tokenData.access_token);
    const refreshToken = asString(tokenData.refresh_token);
    const expiresIn = typeof tokenData.expires_in === "number" ? tokenData.expires_in : null;

    if (!accessToken) {
      return redirectToApp("error", "missing_access_token");
    }

    const userInfo = await fetchJson<JsonObject>("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const calendarList = await fetchJson<{ items?: JsonObject[] }>("https://www.googleapis.com/calendar/v3/users/me/calendarList", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    const calendars = calendarList.items || [];
    const primaryCalendar = calendars.find((calendar) => calendar.primary === true) || calendars[0] || {};
    const selectedCalendarId = asString(primaryCalendar.id);
    const selectedCalendarName = asString(primaryCalendar.summary) || selectedCalendarId;
    const connectedEmail = asString(userInfo.email) || asString(primaryCalendar.id);
    const tokenExpiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    const { data: tokenRow, error: tokenError } = await supabase
      .from("calendar_oauth_tokens")
      .upsert({
        tenant_id: tenantId,
        calendar_connection_id: connectionId,
        provider: "google_calendar",
        access_token: accessToken,
        refresh_token: refreshToken,
        token_type: asString(tokenData.token_type),
        scope: asString(tokenData.scope),
        expires_at: tokenExpiresAt,
        metadata: {
          connected_email: connectedEmail,
        },
      }, { onConflict: "calendar_connection_id,provider" })
      .select("id")
      .single();

    if (tokenError || !tokenRow?.id) {
      throw new Error(tokenError?.message || "Token persistence failed");
    }

    await supabase
      .from("calendar_connections")
      .update({
        provider: "google_calendar",
        mode,
        provider_account_id: asString(userInfo.sub),
        connected_email: connectedEmail,
        status: "connected",
        selected_calendar_id: selectedCalendarId,
        selected_calendar_name: selectedCalendarName,
        token_vault_ref: tokenRow.id,
        last_connected_at: new Date().toISOString(),
        metadata: {
          connected_email: connectedEmail,
          calendars: calendars.slice(0, 20).map((calendar) => ({
            id: asString(calendar.id),
            summary: asString(calendar.summary),
            primary: calendar.primary === true,
            access_role: asString(calendar.accessRole),
          })),
        },
      })
      .eq("id", connectionId)
      .eq("tenant_id", tenantId);

    if (selectedCalendarId) {
      const resourcePayload = {
          tenant_id: tenantId,
          calendar_connection_id: connectionId,
          name: selectedCalendarName || "Основен календар",
          role: "primary_calendar",
          provider_calendar_id: selectedCalendarId,
          provider_calendar_name: selectedCalendarName,
          provider_account_email: connectedEmail,
          active: true,
          metadata: {
            source: "google_oauth_callback",
          },
        };
      const { data: existingResource } = await supabase
        .from("calendar_resources")
        .select("id")
        .eq("calendar_connection_id", connectionId)
        .eq("provider_calendar_id", selectedCalendarId)
        .maybeSingle();

      if (existingResource?.id) {
        await supabase
          .from("calendar_resources")
          .update(resourcePayload)
          .eq("id", existingResource.id);
      } else {
        await supabase
          .from("calendar_resources")
          .insert(resourcePayload);
      }
    }

    return redirectToApp("connected");
  } catch (error) {
    console.error(error);
    return redirectToApp("error", "google_oauth_callback_failed");
  }
});
