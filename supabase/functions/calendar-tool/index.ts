import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type JsonObject = Record<string, unknown>;
type SlotSuggestion = {
  slot_id: string;
  starts_at: string;
  ends_at: string;
  label: string;
  label_bg: string;
  resource_id: string | null;
  resource_name: string;
  calendar_id: string;
};
type DecodedSlot = {
  startsAt: Date;
  endsAt: Date;
  durationMinutes: number;
  calendarId: string;
  connectionId: string | null;
  resourceId: string | null;
};
type CalendarTarget = {
  connectionId: string;
  resourceId: string | null;
  calendarId: string;
  calendarName: string;
  accountEmail: string | null;
  requestedResourceName: string | null;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retell-signature, x-retell-tool-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const googleClientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
const googleClientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET");
const defaultRetellAgentId = Deno.env.get("RETELL_DEFAULT_AGENT_ID") || "agent_42a61a2e13af1933c17eb03dd8";
const retellToolToken = Deno.env.get("RETELL_TOOL_TOKEN");

const supabase = supabaseUrl && serviceRoleKey
  ? createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  : null;

const json = (body: JsonObject, status = 200) => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
};

const asString = (value: unknown): string | null => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const asNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const objectValue = (value: unknown): JsonObject => {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
};

const encodeSlotId = (slot: {
  starts_at: string;
  ends_at: string;
  duration_minutes: number;
  calendar_id: string;
  connection_id?: string | null;
  resource_id?: string | null;
}) => {
  const encoded = btoa(JSON.stringify(slot)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `slot_${encoded}`;
};

const decodeSlotId = (value: string | null) => {
  if (!value?.startsWith("slot_")) return null;
  try {
    const base64 = value.slice(5).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const slot = objectValue(JSON.parse(atob(padded)));
    const startsAt = asString(slot.starts_at);
    const endsAt = asString(slot.ends_at);
    const durationMinutes = asNumber(slot.duration_minutes);
    const calendarId = asString(slot.calendar_id);
    const connectionId = asString(slot.connection_id);
    const resourceId = asString(slot.resource_id);
    if (!startsAt || !endsAt || !durationMinutes || !calendarId) return null;
    return { startsAt: new Date(startsAt), endsAt: new Date(endsAt), durationMinutes, calendarId, connectionId, resourceId };
  } catch {
    return null;
  }
};

const getArgs = (body: JsonObject) => {
  return {
    ...objectValue(body.args),
    ...objectValue(body.arguments),
    ...objectValue(body.parameters),
    ...objectValue(body),
  };
};

const normalizeForMatch = (value: string | null) => {
  return (value || "")
    .toLowerCase()
    .replace(/д-р|доктор/g, "")
    .replace(/[^а-яa-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const isValidBookingCustomerName = (value: string | null) => {
  const normalized = normalizeForMatch(value);
  if (!normalized) return false;
  if (
    /неуточн|неясн|неизвест|unknown|unspecified|unnamed|no name|без име|няма име|клиент|пациент|да се провери|провери от записа/.test(
      normalized,
    )
  ) {
    return false;
  }
  const parts = normalized.split(" ").filter((part) => part.length >= 2);
  return parts.length >= 2;
};

const sofiaDateParts = (date: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Sofia",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
};

const sofiaLocalToUtc = (parts: { year: number; month: number; day: number; hour: number; minute: number }) => {
  let utc = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0));
  for (let index = 0; index < 3; index += 1) {
    const actual = sofiaDateParts(utc);
    const wantedMs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0);
    const actualMs = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const diffMs = actualMs - wantedMs;
    if (diffMs === 0) break;
    utc = new Date(utc.getTime() - diffMs);
  }
  return utc;
};

const addDays = (parts: { year: number; month: number; day: number }, days: number) => {
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 12, 0, 0));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
};

const nextWorkingDay = (parts: { year: number; month: number; day: number }) => {
  let candidate = addDays(parts, 1);
  for (let index = 0; index < 7; index += 1) {
    const weekday = new Date(Date.UTC(candidate.year, candidate.month - 1, candidate.day)).getUTCDay();
    if (weekday >= 1 && weekday <= 6) return candidate;
    candidate = addDays(candidate, 1);
  }
  return candidate;
};

const monthByName: Record<string, number> = {
  януари: 1,
  февруари: 2,
  март: 3,
  април: 4,
  май: 5,
  юни: 6,
  юли: 7,
  август: 8,
  септември: 9,
  октомври: 10,
  ноември: 11,
  декември: 12,
};

const weekdayByName: Record<string, number> = {
  неделя: 0,
  понеделник: 1,
  вторник: 2,
  сряда: 3,
  четвъртък: 4,
  петък: 5,
  събота: 6,
};

const hourWords: Record<string, number> = {
  един: 1,
  едно: 1,
  два: 2,
  две: 2,
  три: 3,
  четири: 4,
  пет: 5,
  шест: 6,
  седем: 7,
  осем: 8,
  девет: 9,
  десет: 10,
  единадесет: 11,
  единайсет: 11,
  единаисет: 11,
  дванадесет: 12,
  тринадесет: 13,
  четиринадесет: 14,
  петнадесет: 15,
  петнайсет: 15,
  шестнадесет: 16,
  шестнайсет: 16,
  седемнадесет: 17,
  седемнайсет: 17,
  осемнадесет: 18,
  осемнайсет: 18,
  деветнадесет: 19,
  деветнайсет: 19,
};

const findHourWord = (value: string) => {
  return Object.entries(hourWords)
    .sort((first, second) => second[0].length - first[0].length)
    .find(([word]) => new RegExp(`(^|\\s)${word}(?=\\s|[.,!?]|$)`, "i").test(value)) || null;
};

const parseWordTime = (value: string) => {
  const normalized = value
    .replace(/четирийсет/g, "четиресет")
    .replace(/четиресе/g, "четиресет")
    .replace(/трийсет/g, "тридесет")
    .replace(/\s+/g, " ")
    .trim();

  const withoutQuarterMatch = normalized.match(/без\s+(?:петнайсет|петнадесет|15)\s+([а-я]+)/i);
  if (withoutQuarterMatch) {
    const nextHour = hourWords[withoutQuarterMatch[1]];
    if (nextHour) return { hour: nextHour - 1, minute: 45 };
  }

  const hourEntry = findHourWord(normalized);
  if (!hourEntry) return null;
  const [hourWord, hour] = hourEntry;
  const afterHour = normalized.slice(normalized.indexOf(hourWord) + hourWord.length);
  let minute = 0;
  if (/половина|и\s+(?:тридесет|30)(?=\s|[.,!?]|$)/i.test(afterHour)) {
    minute = 30;
  } else if (/и\s+(?:четиресет\s+и\s+пет|45)(?=\s|[.,!?]|$)/i.test(afterHour)) {
    minute = 45;
  } else if (/и\s+(?:петнайсет|петнадесет|15)(?=\s|[.,!?]|$)/i.test(afterHour)) {
    minute = 15;
  }
  return { hour, minute };
};

const parsePreferredDateTime = (value: string | null): Date | null => {
  if (!value) return null;
  const direct = new Date(value);
  if (!Number.isNaN(direct.getTime()) && /T|\d{4}-\d{2}-\d{2}/.test(value)) return direct;

  const normalized = value.toLowerCase().replace(/\s+/g, " ").trim();
  const timeMatch = normalized.match(/\b(?:в\s*)?((?:[01]?\d|2[0-3])(?::([0-5]\d))?)(?:\s*ч(?:аса)?)?\b/);
  const wordTime = !timeMatch ? parseWordTime(normalized) : null;
  if (!timeMatch && !wordTime) return null;

  let hour = timeMatch ? Number(timeMatch[1].split(":")[0]) : wordTime?.hour || 0;
  const minute = timeMatch ? Number(timeMatch[2] || 0) : wordTime?.minute || 0;
  if (/следобед|вечер/.test(normalized) && hour < 12) hour += 12;

  const today = sofiaDateParts(new Date());
  let dayParts = { year: today.year, month: today.month, day: today.day };
  let hasExplicitDay = false;
  if (/(^|\s)утре(?=\s|[.,!?]|$)/.test(normalized)) {
    hasExplicitDay = true;
    dayParts = addDays(dayParts, 1);
  } else if (/(^|\s)вдругиден(?=\s|[.,!?]|$)/.test(normalized)) {
    hasExplicitDay = true;
    dayParts = addDays(dayParts, 2);
  } else {
    const numericDate = normalized.match(/\b(\d{1,2})[./-](\d{1,2})(?:[./-](\d{2,4}))?\b/);
    const namedMonthDate = normalized.match(/\b(\d{1,2})\s*(януари|февруари|март|април|май|юни|юли|август|септември|октомври|ноември|декември)\b/i);
    const weekday = Object.entries(weekdayByName).find(([name]) => new RegExp(`(^|\\s)${name}(?=\\s|[.,!?]|$)`, "i").test(normalized));
    if (numericDate) {
      hasExplicitDay = true;
      const year = numericDate[3] ? Number(numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3]) : today.year;
      dayParts = { year, month: Number(numericDate[2]), day: Number(numericDate[1]) };
    } else if (namedMonthDate) {
      hasExplicitDay = true;
      dayParts = { year: today.year, month: monthByName[namedMonthDate[2]], day: Number(namedMonthDate[1]) };
    } else if (weekday) {
      hasExplicitDay = true;
      const todayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      let daysUntil = weekday[1] - todayWeekday;
      if (daysUntil <= 0) daysUntil += 7;
      dayParts = addDays(dayParts, daysUntil);
    }
  }
  let startsAt = sofiaLocalToUtc({ ...dayParts, hour, minute });
  if (!hasExplicitDay && startsAt.getTime() <= Date.now() + 15 * 60_000) {
    dayParts = nextWorkingDay(dayParts);
    startsAt = sofiaLocalToUtc({ ...dayParts, hour, minute });
  }
  return Number.isNaN(startsAt.getTime()) ? null : startsAt;
};

const durationMinutesForService = (service: string | null, durationMinutes: number | null) => {
  if (durationMinutes && durationMinutes > 0) return durationMinutes;
  const text = (service || "").toLowerCase();
  if (/почиств|зъбен камък|избел/.test(text)) return 60;
  if (/коронк|имплант|операц|екстракц|ваден/.test(text)) return 60;
  return 30;
};

const labelSlot = (startsAt: string) => {
  return new Intl.DateTimeFormat("bg-BG", {
    timeZone: "Europe/Sofia",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(startsAt));
};

const resourceLabel = (target: CalendarTarget) => target.calendarName || target.accountEmail || target.calendarId;

const makeSlotSuggestion = (startsAt: Date, endsAt: Date, durationMinutes: number, target: CalendarTarget): SlotSuggestion => {
  const starts_at = startsAt.toISOString();
  const ends_at = endsAt.toISOString();
  const label = labelSlot(starts_at);
  const resourceName = resourceLabel(target);
  return {
    slot_id: encodeSlotId({
      starts_at,
      ends_at,
      duration_minutes: durationMinutes,
      calendar_id: target.calendarId,
      connection_id: target.connectionId,
      resource_id: target.resourceId,
    }),
    starts_at,
    ends_at,
    label,
    label_bg: `${label} при ${resourceName}`,
    resource_id: target.resourceId,
    resource_name: resourceName,
    calendar_id: target.calendarId,
  };
};

const resolveTenantId = async (args: JsonObject) => {
  if (!supabase) return null;
  const tenantId = asString(args.tenant_id);
  if (tenantId) return tenantId;
  const agentId = asString(args.agent_id) || defaultRetellAgentId;
  const { data } = await supabase
    .from("retell_agents")
    .select("tenant_id")
    .eq("retell_agent_id", agentId)
    .maybeSingle();
  return data?.tenant_id as string || null;
};

const getCalendarTargets = async (tenantId: string, resourceName: string | null, decodedSlot: DecodedSlot | null = null): Promise<CalendarTarget[]> => {
  if (!supabase) return [];
  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("id, selected_calendar_id, selected_calendar_name, connected_email")
    .eq("tenant_id", tenantId)
    .eq("provider", "google_calendar")
    .eq("status", "connected")
    .order("updated_at", { ascending: false });
  const usableConnections = (connections || []).filter((connection) => asString(connection.selected_calendar_id));
  if (!usableConnections.length) return [];
  const connectionById = new Map(usableConnections.map((connection) => [connection.id as string, connection]));

  const { data: resources } = await supabase
    .from("calendar_resources")
    .select("id, calendar_connection_id, name, provider_calendar_id, provider_calendar_name, provider_account_email")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  const toTarget = (resource: JsonObject | null, fallbackConnection?: JsonObject): CalendarTarget | null => {
    const connectionId = asString(resource?.calendar_connection_id) || asString(fallbackConnection?.id);
    const connection = connectionId ? connectionById.get(connectionId) : fallbackConnection;
    if (!connection) return null;
    const fallbackCalendarId = asString(connection.selected_calendar_id);
    const calendarId = asString(resource?.provider_calendar_id) || fallbackCalendarId;
    if (!calendarId) return null;
    return {
      connectionId: connection.id as string,
      resourceId: asString(resource?.id),
      calendarId,
      calendarName: asString(resource?.name) || asString(resource?.provider_calendar_name) || asString(connection.selected_calendar_name) || calendarId,
      accountEmail: asString(resource?.provider_account_email) || asString(connection.connected_email),
      requestedResourceName: resourceName,
    };
  };

  const dedupeTargets = (targets: CalendarTarget[]) => {
    const seen = new Set<string>();
    return targets.filter((target) => {
      const key = `${target.connectionId}:${target.calendarId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (decodedSlot) {
    const slotResource = decodedSlot.resourceId
      ? resources?.find((resource) => asString(resource.id) === decodedSlot.resourceId)
      : null;
    const slotConnection = decodedSlot.connectionId ? connectionById.get(decodedSlot.connectionId) : null;
    const slotTarget = slotResource
      ? toTarget(slotResource)
      : usableConnections
        .map((connection) => toTarget(null, connection))
        .find((target) => target?.calendarId === decodedSlot.calendarId && (!decodedSlot.connectionId || target.connectionId === decodedSlot.connectionId));
    if (slotTarget) return [slotTarget];
    if (slotConnection) {
      return [{
        connectionId: slotConnection.id as string,
        resourceId: null,
        calendarId: decodedSlot.calendarId,
        calendarName: asString(slotConnection.selected_calendar_name) || decodedSlot.calendarId,
        accountEmail: asString(slotConnection.connected_email),
        requestedResourceName: resourceName,
      }];
    }
  }

  const activeResources = resources || [];
  const requested = normalizeForMatch(resourceName);
  if (requested) {
    const matchedTargets = activeResources
      .filter((resource) => {
      const haystack = [resource.name, resource.provider_calendar_name, resource.provider_account_email]
        .map((value) => normalizeForMatch(asString(value))).join(" ");
      return haystack.includes(requested) || requested.includes(normalizeForMatch(asString(resource.name)));
    })
      .map((resource) => toTarget(resource))
      .filter((target): target is CalendarTarget => Boolean(target));
    return dedupeTargets(matchedTargets);
  }

  const resourceTargets = activeResources
    .map((resource) => toTarget(resource))
    .filter((target): target is CalendarTarget => Boolean(target));
  if (resourceTargets.length) return dedupeTargets(resourceTargets);

  return dedupeTargets(usableConnections
    .map((connection) => toTarget(null, connection))
    .filter((target): target is CalendarTarget => Boolean(target)));
};

const refreshGoogleAccessToken = async (tokenId: string, refreshToken: string) => {
  if (!supabase || !googleClientId || !googleClientSecret || !refreshToken) return null;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json() as JsonObject;
  if (!response.ok) return null;
  const accessToken = asString(data.access_token);
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  if (!accessToken) return null;
  await supabase
    .from("calendar_oauth_tokens")
    .update({ access_token: accessToken, expires_at: new Date(Date.now() + expiresIn * 1000).toISOString() })
    .eq("id", tokenId);
  return accessToken;
};

const getAccessToken = async (connectionId: string) => {
  if (!supabase) return null;
  const { data: token } = await supabase
    .from("calendar_oauth_tokens")
    .select("id, access_token, refresh_token, expires_at")
    .eq("calendar_connection_id", connectionId)
    .eq("provider", "google_calendar")
    .maybeSingle();
  if (!token?.access_token) return null;
  const expiresAt = token.expires_at ? new Date(token.expires_at as string).getTime() : 0;
  if (expiresAt && expiresAt < Date.now() + 60_000) {
    return await refreshGoogleAccessToken(token.id as string, asString(token.refresh_token) || "") || token.access_token as string;
  }
  return token.access_token as string;
};

const getBusyRanges = async (accessToken: string, calendarId: string, startsAt: Date, endsAt: Date) => {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: { "Authorization": `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ timeMin: startsAt.toISOString(), timeMax: endsAt.toISOString(), items: [{ id: calendarId }] }),
  });
  const data = await response.json() as JsonObject;
  if (!response.ok) return null;
  const calendars = objectValue(data.calendars) as Record<string, JsonObject>;
  const calendar = calendars[calendarId] || Object.values(calendars)[0] || {};
  const busy = Array.isArray(calendar.busy) ? calendar.busy : [];
  return busy.map((range) => objectValue(range)).map((range) => ({ start: asString(range.start), end: asString(range.end) })).filter((range) => range.start && range.end);
};

const isTargetAvailable = async (target: CalendarTarget, startsAt: Date, endsAt: Date) => {
  const accessToken = await getAccessToken(target.connectionId);
  if (!accessToken) return { target, accessToken: null, busyRanges: null, available: false };
  const busyRanges = await getBusyRanges(accessToken, target.calendarId, startsAt, endsAt);
  return { target, accessToken, busyRanges, available: Array.isArray(busyRanges) && busyRanges.length === 0 };
};

const findSlotSuggestions = async (accessToken: string, target: CalendarTarget, requestedStart: Date, durationMinutes: number): Promise<SlotSuggestion[]> => {
  const day = sofiaDateParts(requestedStart);
  const searchStart = sofiaLocalToUtc({ year: day.year, month: day.month, day: day.day, hour: 9, minute: 0 });
  const searchEnd = sofiaLocalToUtc({ year: day.year, month: day.month, day: day.day, hour: 18, minute: 0 });
  const busyRanges = await getBusyRanges(accessToken, target.calendarId, searchStart, searchEnd);
  if (!busyRanges) return [];
  const suggestions: SlotSuggestion[] = [];
  let cursor = new Date(Math.max(requestedStart.getTime(), searchStart.getTime()));
  const intervalMs = 15 * 60_000;
  cursor = new Date(Math.ceil(cursor.getTime() / intervalMs) * intervalMs);
  while (cursor.getTime() + durationMinutes * 60_000 <= searchEnd.getTime() && suggestions.length < 3) {
    const candidateEnd = new Date(cursor.getTime() + durationMinutes * 60_000);
    const conflict = busyRanges.some((range) => {
      const busyStart = new Date(range.start || "").getTime();
      const busyEnd = new Date(range.end || "").getTime();
      return cursor.getTime() < busyEnd && candidateEnd.getTime() > busyStart;
    });
    if (!conflict) {
      suggestions.push(makeSlotSuggestion(cursor, candidateEnd, durationMinutes, target));
    }
    cursor = new Date(cursor.getTime() + intervalMs);
  }
  return suggestions;
};

const resolveRequest = async (args: JsonObject) => {
  const tenantId = await resolveTenantId(args);
  if (!tenantId) return { error: "tenant_not_resolved" };
  const decodedSlot = decodeSlotId(asString(args.slot_id));
  const startsAt = decodedSlot?.startsAt || parsePreferredDateTime(asString(args.starts_at) || asString(args.preferred_time) || asString(args.datetime));
  if (!startsAt) return { error: "datetime_not_understood" };
  const durationMinutes = decodedSlot?.durationMinutes || durationMinutesForService(asString(args.service) || asString(args.intent), asNumber(args.duration_minutes));
  const endsAt = decodedSlot?.endsAt || new Date(startsAt.getTime() + durationMinutes * 60_000);
  const targets = await getCalendarTargets(tenantId, asString(args.resource_name) || asString(args.doctor_name), decodedSlot);
  if (!targets.length) return { error: decodedSlot ? "slot_resource_not_found" : "calendar_not_connected" };
  return { tenantId, targets, startsAt, endsAt, durationMinutes, decodedSlot };
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405);
  if (!supabase) return json({ ok: false, error: "supabase_env_missing" }, 500);
  const url = new URL(request.url);
  const providedToken = request.headers.get("x-retell-tool-token") || url.searchParams.get("token");
  if (retellToolToken && providedToken !== retellToolToken) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }

  const body = await request.json().catch(() => null) as JsonObject | null;
  if (!body) return json({ ok: false, error: "invalid_json" }, 400);

  const args = getArgs(body);
  const action = asString(url.searchParams.get("action")) || asString(args.action) || asString(body.function_name) || asString(body.name) || "check_availability";
  const resolved = await resolveRequest(args);
  if ("error" in resolved) return json({ ok: false, available: false, error: resolved.error });
  const { tenantId, targets, startsAt, endsAt, durationMinutes } = resolved;

  const checkedTargets = await Promise.all(targets.map((target) => isTargetAvailable(target, startsAt, endsAt)));
  const availableTargets = checkedTargets.filter((item) => item.available && item.accessToken);
  const firstCheckedTarget = checkedTargets.find((item) => item.accessToken) || checkedTargets[0];
  if (!firstCheckedTarget?.accessToken) return json({ ok: false, available: false, error: "google_token_missing" });
  const selectedTarget = availableTargets[0]?.target || firstCheckedTarget.target;
  const selectedAccessToken = availableTargets[0]?.accessToken || firstCheckedTarget.accessToken;
  const available = availableTargets.length > 0;
  const suggestions = available
    ? availableTargets.slice(0, 3).map((item) => makeSlotSuggestion(startsAt, endsAt, durationMinutes, item.target))
    : (await Promise.all(checkedTargets
      .filter((item) => item.accessToken)
      .map((item) => findSlotSuggestions(item.accessToken as string, item.target, startsAt, durationMinutes))))
      .flat()
      .sort((first, second) => new Date(first.starts_at).getTime() - new Date(second.starts_at).getTime())
      .slice(0, 3);

  if (!available || action === "check_availability") {
    return json({
      ok: true,
      available,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMinutes,
      slot_id: encodeSlotId({
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        duration_minutes: durationMinutes,
        calendar_id: selectedTarget.calendarId,
        connection_id: selectedTarget.connectionId,
        resource_id: selectedTarget.resourceId,
      }),
      calendar_name: selectedTarget.calendarName,
      resource_id: selectedTarget.resourceId,
      resource_name: resourceLabel(selectedTarget),
      suggestions,
      message_bg: available
        ? `Свободно е за ${labelSlot(startsAt.toISOString())} при ${resourceLabel(selectedTarget)}.`
        : `Този час е зает. Свободните алтернативи са: ${suggestions.map((slot) => slot.label_bg).join(", ")}.`,
    });
  }

  const customerName = asString(args.customer_name);
  if (!isValidBookingCustomerName(customerName)) {
    return json({
      ok: false,
      available: true,
      error: "missing_customer_name",
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMinutes,
      message_bg: "Преди да запиша часа, попитай: На кое име и фамилия да го запиша?",
    }, 422);
  }

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(selectedTarget.calendarId)}/events`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${selectedAccessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      summary: `Vdiga: ${customerName}`,
      description: [
        asString(args.service) ? `Услуга: ${asString(args.service)}` : null,
        asString(args.customer_phone) ? `Телефон: ${asString(args.customer_phone)}` : null,
        asString(args.retell_call_id) ? `Retell call: ${asString(args.retell_call_id)}` : null,
      ].filter(Boolean).join("\n"),
      start: { dateTime: startsAt.toISOString(), timeZone: "Europe/Sofia" },
      end: { dateTime: endsAt.toISOString(), timeZone: "Europe/Sofia" },
    }),
  });
  const event = await response.json() as JsonObject;
  if (!response.ok) return json({ ok: false, available: true, error: "google_event_create_failed", details: event });

  await supabase.from("bookings").insert({
    tenant_id: tenantId,
    provider: "google_calendar",
    provider_booking_id: asString(event.id),
    customer_name: customerName,
    customer_phone: asString(args.customer_phone),
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    status: "confirmed",
    calendar_resource_id: selectedTarget.resourceId,
    requested_resource_name: selectedTarget.requestedResourceName,
    assigned_resource_name: selectedTarget.calendarName || selectedTarget.accountEmail,
    external_calendar_event_id: asString(event.id),
    source: "retell_live_tool",
    metadata: {
      retell_call_id: asString(args.retell_call_id),
      service: asString(args.service),
      duration_minutes: durationMinutes,
      google_html_link: asString(event.htmlLink),
      calendar_id: selectedTarget.calendarId,
      connected_email: selectedTarget.accountEmail,
      resource_id: selectedTarget.resourceId,
      resource_name: resourceLabel(selectedTarget),
    },
  });

  return json({
    ok: true,
    booked: true,
    available: true,
    starts_at: startsAt.toISOString(),
    ends_at: endsAt.toISOString(),
    duration_minutes: durationMinutes,
    calendar_event_id: asString(event.id),
    resource_id: selectedTarget.resourceId,
    resource_name: resourceLabel(selectedTarget),
    message_bg: `Записах часа за ${labelSlot(startsAt.toISOString())} при ${resourceLabel(selectedTarget)}.`,
  });
});
