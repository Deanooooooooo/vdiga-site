import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type JsonObject = Record<string, unknown>;

type RetellWebhookPayload = {
  event?: string;
  call?: JsonObject;
};

type LeadSnapshot = {
  id: string | null;
  name: string | null;
  phone: string | null;
  intent: string | null;
  notes: string | null;
  preferredTime: string | null;
  requestedResourceName: string | null;
  urgency: string | null;
  outcome: string | null;
};

type CalendarTarget = {
  connectionId: string;
  resourceId: string | null;
  calendarId: string;
  calendarName: string | null;
  accountEmail: string | null;
  requestedResourceName: string | null;
};

type SlotSuggestion = {
  starts_at: string;
  ends_at: string;
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retell-signature",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const webhookToken = Deno.env.get("RETELL_WEBHOOK_TOKEN");
const defaultRetellAgentId = Deno.env.get("RETELL_DEFAULT_AGENT_ID") || "agent_42a61a2e13af1933c17eb03dd8";
const googleClientId = Deno.env.get("GOOGLE_CALENDAR_CLIENT_ID");
const googleClientSecret = Deno.env.get("GOOGLE_CALENDAR_CLIENT_SECRET");

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

const asNumber = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const timestampToIso = (value: unknown): string | null => {
  const timestamp = asNumber(value);
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const durationSeconds = (startedAt: unknown, endedAt: unknown): number | null => {
  const start = asNumber(startedAt);
  const end = asNumber(endedAt);
  if (!start || !end || end < start) return null;
  return Math.round((end - start) / 1000);
};

const callStatusForEvent = (event: string): "started" | "ended" | "analyzed" | "failed" => {
  if (event === "call_started") return "started";
  if (event === "call_analyzed") return "analyzed";
  if (event === "call_ended") return "ended";
  return "ended";
};

const normalizeAnalysis = (call: JsonObject): JsonObject => {
  const callAnalysis = call.call_analysis;
  if (callAnalysis && typeof callAnalysis === "object" && !Array.isArray(callAnalysis)) {
    return callAnalysis as JsonObject;
  }

  return {};
};

const pickAnalysisField = (analysis: JsonObject, keys: string[]): string | null => {
  const customData = analysis.custom_analysis_data;
  const custom = customData && typeof customData === "object" && !Array.isArray(customData)
    ? customData as JsonObject
    : {};

  for (const key of keys) {
    const value = asString(custom[key]) || asString(analysis[key]);
    if (value) return value;
  }

  return null;
};

const userLinesFromTranscript = (transcript: unknown): string[] => {
  return (asString(transcript) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("User:"))
    .map((line) => line.replace(/^User:\s*/, "").trim())
    .filter(Boolean);
};

const titleCase = (value: string) => {
  return value
    .trim()
    .replace(/\s+/g, " ")
    .split(" ")
    .map((part) => part ? `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}` : part)
    .join(" ");
};

const latinToCyrillicName = (value: string) => {
  const letters: Record<string, string> = {
    a: "а",
    b: "б",
    c: "к",
    d: "д",
    e: "е",
    f: "ф",
    g: "г",
    h: "х",
    i: "и",
    j: "й",
    k: "к",
    l: "л",
    m: "м",
    n: "н",
    o: "о",
    p: "п",
    q: "к",
    r: "р",
    s: "с",
    t: "т",
    u: "у",
    v: "в",
    w: "в",
    x: "кс",
    y: "и",
    z: "з",
  };
  const normalized = value
    .toLowerCase()
    .replace(/sh/g, "ш")
    .replace(/zh/g, "ж")
    .replace(/ch/g, "ч")
    .replace(/ts/g, "ц")
    .replace(/ya/g, "я")
    .replace(/yu/g, "ю")
    .replace(/yo/g, "ьо");

  return titleCase(normalized.replace(/[a-z]/g, (letter) => letters[letter] || letter));
};

const normalizePersonName = (value: string | null) => {
  if (!value) return null;
  const clean = value.replace(/[.,!?;:]+$/g, "").replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return /[A-Za-z]/.test(clean) && !/[А-Яа-я]/.test(clean) ? latinToCyrillicName(clean) : titleCase(clean);
};

const namePattern = "([А-ЯA-Z][а-яa-z]+(?:\\s+[А-ЯA-Z][а-яa-z]+){1,2})";

const extractCorrectedNameFromText = (text: string | null) => {
  if (!text) return null;
  const patterns = [
    new RegExp(`(?:не\\s+е?|не)\\s+${namePattern}\\s*(?:,|а|ами|а\\s+е)\\s*${namePattern}`, "i"),
    new RegExp(`(?:поправка|корекция|името\\s+е|казах|казва\\s+се|на\\s+името\\s+на|under\\s+the\\s+name)\\s+${namePattern}`, "i"),
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[2] || match?.[1];
    const normalized = normalizePersonName(candidate || null);
    if (normalized) return normalized;
  }

  return null;
};

const extractNameFromTranscript = (transcript: unknown): string | null => {
  const userLines = userLinesFromTranscript(transcript);
  const text = userLines.join(" ");
  const corrected = extractCorrectedNameFromText(text);
  if (corrected) return corrected;

  const direct = text.match(/(?:казвам се|името ми е|аз съм|на името на)\s+([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){1,2})/i);
  if (direct?.[1]) return normalizePersonName(direct[1]);

  const blocked = new Set(["Здравейте", "Да", "Не", "Може", "Усещам", "Всички", "В"]);
  for (const line of [...userLines].reverse()) {
    const cleaned = line.replace(/[.,!?]+$/g, "").trim();
    const match = cleaned.match(/^([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){1,2})$/);
    if (match?.[1] && !blocked.has(match[1].split(/\s+/)[0])) return normalizePersonName(match[1]);
  }

  return null;
};

const buildBulgarianLeadNotes = (lead: LeadSnapshot) => {
  const notes: string[] = [];
  if (lead.urgency) notes.push("Отбелязано като спешно.");
  if (lead.preferredTime) notes.push(`Предпочитан час: ${lead.preferredTime}.`);
  if (lead.outcome && lead.outcome !== "appointment_request") notes.push(`Резултат от разговора: ${lead.outcome}.`);
  return notes.join(" ");
};

const extractIntentFromText = (text: string): string | null => {
  const normalized = text.toLowerCase();
  const parts: string[] = [];
  if (/зъбобол|забобол|болк|кътн/.test(normalized)) parts.push("болка в зъб/кътник");
  if (/коронк/.test(normalized)) parts.push("възможна коронка");
  if (/почиств|зъбен камък/.test(normalized)) parts.push("почистване на зъбен камък");
  if (/час|запиша|заявк/.test(normalized)) parts.unshift("заявка за час");

  return parts.length ? [...new Set(parts)].join("; ") : null;
};

const extractPreferredTimeFromText = (text: string): string | null => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const time = normalized.match(/\b(?:в\s*)?((?:[01]?\d|2[0-3])(?::[0-5]\d)?)(?:\s*ч(?:аса)?)?\b/i)?.[1];
  const relativeDay = normalized.match(/(?:^|\s)(днес|утре|вдругиден)(?=\s|[.,!?]|$)/i)?.[1];
  const weekday = normalized.match(/(?:^|\s)(понеделник|вторник|сряда|четвъртък|петък|събота|неделя)(?=\s|[.,!?]|$)/i)?.[1];
  const date = normalized.match(/(?:^|\s)(\d{1,2}\s*(?:юли|август|септември|октомври|ноември|декември|януари|февруари|март|април|май|юни)|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)(?=\s|[.,!?]|$)/i)?.[1];
  const dayPart = normalized.match(/(?:^|\s)(сутрин|следобед|вечер|преди обяд|през нощта|на обяд)(?=\s|[.,!?]|$)/i)?.[1];

  const pieces = [relativeDay || date || weekday, time ? `${time.includes(":") ? time : `${time}:00`}` : null, dayPart].filter(Boolean);
  return pieces.length ? pieces.join(" ") : null;
};

const extractUrgencyFromText = (text: string): string | null => {
  return /спешн|силна болк|зъбобол|забобол/.test(text.toLowerCase()) ? "urgent" : null;
};

const extractRequestedResourceName = (text: string): string | null => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const match = normalized.match(/(?:при|със|за)\s+(?:д-р|доктор)?\s*([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){0,2})/i)
    || normalized.match(/(?:д-р|доктор)\s+([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){0,2})/i);

  return match?.[1]?.replace(/\s+(искам|за|утре|днес|вдругиден)$/i, "").trim() || null;
};

const durationMinutesForIntent = (intent: string | null, notes: string | null): number => {
  const text = [intent, notes].filter(Boolean).join(" ").toLowerCase();
  if (/почиств|зъбен камък|избел/.test(text)) return 60;
  if (/коронк|имплант|операц|екстракц|ваден/.test(text)) return 60;
  if (/първич|консултац|преглед/.test(text)) return 30;
  if (/болк|спешн|зъбобол|кътн/.test(text)) return 30;
  return 30;
};

const normalizeForMatch = (value: string | null) => {
  return (value || "")
    .toLowerCase()
    .replace(/д-р|доктор/g, "")
    .replace(/[^а-яa-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
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
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
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
  if (!Number.isNaN(direct.getTime()) && /T|\d{4}-\d{2}-\d{2}/.test(value)) {
    return direct;
  }

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
      const year = numericDate[3]
        ? Number(numericDate[3].length === 2 ? `20${numericDate[3]}` : numericDate[3])
        : today.year;
      dayParts = {
        year,
        month: Number(numericDate[2]),
        day: Number(numericDate[1]),
      };
    } else if (namedMonthDate) {
      hasExplicitDay = true;
      dayParts = {
        year: today.year,
        month: monthByName[namedMonthDate[2]],
        day: Number(namedMonthDate[1]),
      };
    } else if (weekday) {
      hasExplicitDay = true;
      const actualTodayWeekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
      let daysUntil = weekday[1] - actualTodayWeekday;
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

const findTenantId = async (call: JsonObject): Promise<string | null> => {
  if (!supabase) return null;

  const agentId = asString(call.agent_id) || defaultRetellAgentId;
  if (agentId) {
    const { data } = await supabase
      .from("retell_agents")
      .select("tenant_id")
      .eq("retell_agent_id", agentId)
      .maybeSingle();

    if (data?.tenant_id) return data.tenant_id as string;
  }

  const toNumber = asString(call.to_number);
  if (toNumber) {
    const { data } = await supabase
      .from("phone_numbers")
      .select("tenant_id")
      .or(`retell_phone_number.eq.${toNumber},didww_number.eq.${toNumber}`)
      .not("tenant_id", "is", null)
      .maybeSingle();

    if (data?.tenant_id) return data.tenant_id as string;
  }

  const { data: tenants } = await supabase
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(2);

  return tenants?.length === 1 ? tenants[0].id as string : null;
};

const upsertRetellAgent = async (tenantId: string, call: JsonObject) => {
  if (!supabase) return;

  const agentId = asString(call.agent_id) || defaultRetellAgentId;
  if (!agentId) return;

  await supabase
    .from("retell_agents")
    .upsert({
      tenant_id: tenantId,
      retell_agent_id: agentId,
      template_key: "dental_demo",
      nickname: "Vida",
      language: "bg-BG",
      status: "active",
      metadata: {
        source: "retell_webhook",
      },
    }, { onConflict: "retell_agent_id" });
};

const upsertPhoneNumber = async (tenantId: string, call: JsonObject) => {
  if (!supabase) return null;

  const toNumber = asString(call.to_number);
  if (!toNumber) return null;

  const { data } = await supabase
    .from("phone_numbers")
    .upsert({
      tenant_id: tenantId,
      didww_number: toNumber,
      retell_phone_number: toNumber,
      retell_agent_id: asString(call.agent_id) || defaultRetellAgentId,
      status: "active",
      last_test_call_at: new Date().toISOString(),
      metadata: {
        provider: "zadarma",
        source: "retell_webhook",
      },
    }, { onConflict: "didww_number" })
    .select("id")
    .maybeSingle();

  return data?.id as string | null;
};

const maybeUpsertLead = async (tenantId: string, callId: string, call: JsonObject, analysis: JsonObject): Promise<LeadSnapshot | null> => {
  if (!supabase) return null;

  const { data: existingLead } = await supabase
    .from("leads")
    .select("name, phone, intent, notes, status, metadata")
    .eq("call_id", callId)
    .maybeSingle();

  const transcript = asString(call.transcript);
  const summary = asString(analysis.call_summary) || asString(analysis.summary);
  const userText = userLinesFromTranscript(transcript).join(" ");
  const extractionText = [transcript, summary].filter(Boolean).join("\n");
  const existingMetadata = existingLead?.metadata && typeof existingLead.metadata === "object" && !Array.isArray(existingLead.metadata)
    ? existingLead.metadata as JsonObject
    : {};
  const correctedName = extractCorrectedNameFromText(extractionText) || extractNameFromTranscript(transcript);
  const name = correctedName
    || normalizePersonName(pickAnalysisField(analysis, ["name", "customer_name", "patient_name", "full_name"]))
    || normalizePersonName(asString(existingLead?.name))
    || null;
  const phone = pickAnalysisField(analysis, ["phone", "customer_phone", "patient_phone"])
    || asString(call.from_number)
    || asString(existingLead?.phone)
    || null;
  const intent = pickAnalysisField(analysis, ["intent", "service", "requested_service", "reason"])
    || extractIntentFromText(extractionText)
    || asString(existingLead?.intent)
    || null;
  const preferredTime = pickAnalysisField(analysis, ["preferred_time", "preferred_datetime", "preferred_day_time"])
    || extractPreferredTimeFromText(userText)
    || extractPreferredTimeFromText(extractionText)
    || asString(existingMetadata.preferred_time)
    || null;
  const requestedResourceName = pickAnalysisField(analysis, ["doctor", "doctor_name", "resource", "resource_name", "provider_name"])
    || extractRequestedResourceName(extractionText)
    || asString(existingMetadata.requested_resource_name)
    || null;
  const urgency = pickAnalysisField(analysis, ["urgency", "urgent"])
    || extractUrgencyFromText(extractionText)
    || asString(existingMetadata.urgency)
    || null;
  const outcome = pickAnalysisField(analysis, ["outcome", "call_outcome"])
    || asString(existingMetadata.outcome)
    || (name || intent ? "appointment_request" : null);
  const notes = summary || asString(existingLead?.notes);

  if (!name && !intent && !notes) return null;

  const { data: lead } = await supabase
    .from("leads")
    .upsert({
      tenant_id: tenantId,
      call_id: callId,
      name,
      phone,
      intent,
      notes,
      status: asString(existingLead?.status) || "new",
      metadata: {
        outcome,
        urgency,
        preferred_time: preferredTime,
        requested_resource_name: requestedResourceName,
        source: "retell_webhook",
      },
    }, { onConflict: "call_id" })
    .select("id")
    .maybeSingle();

  return {
    id: lead?.id as string || null,
    name,
    phone,
    intent,
    notes,
    preferredTime,
    requestedResourceName,
    urgency,
    outcome,
  };
};

const refreshGoogleAccessToken = async (tokenId: string, refreshToken: string): Promise<string | null> => {
  if (!supabase || !googleClientId || !googleClientSecret) return null;

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  });
  const data = await response.json() as JsonObject;

  if (!response.ok) {
    console.error("Google token refresh failed", data);
    return null;
  }

  const accessToken = asString(data.access_token);
  const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 3600;
  if (!accessToken) return null;

  await supabase
    .from("calendar_oauth_tokens")
    .update({
      access_token: accessToken,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    })
    .eq("id", tokenId);

  return accessToken;
};

const chooseCalendarTarget = async (tenantId: string, requestedResourceName: string | null): Promise<CalendarTarget | null> => {
  if (!supabase) return null;

  const { data: connections } = await supabase
    .from("calendar_connections")
    .select("id, selected_calendar_id, selected_calendar_name, connected_email")
    .eq("tenant_id", tenantId)
    .eq("provider", "google_calendar")
    .eq("status", "connected")
    .order("updated_at", { ascending: false });

  const usableConnections = (connections || []).filter((connection) => asString(connection.selected_calendar_id));
  if (!usableConnections.length) return null;

  const { data: resources } = await supabase
    .from("calendar_resources")
    .select("id, calendar_connection_id, name, provider_calendar_id, provider_calendar_name, provider_account_email")
    .eq("tenant_id", tenantId)
    .eq("active", true);

  const requested = normalizeForMatch(requestedResourceName);
  const matchedResource = requested
    ? resources?.find((resource) => {
      const haystack = [
        resource.name,
        resource.provider_calendar_name,
        resource.provider_account_email,
      ].map((value) => normalizeForMatch(asString(value))).join(" ");
      return haystack.includes(requested) || requested.includes(normalizeForMatch(asString(resource.name)));
    })
    : null;
  if (requested && !matchedResource) return null;
  if (!requested && (resources?.length || 0) > 1) return null;
  const onlyResource = !matchedResource && resources?.length === 1 ? resources[0] : null;
  const resource = matchedResource || onlyResource || null;
  const connection = resource
    ? usableConnections.find((item) => item.id === resource.calendar_connection_id) || usableConnections[0]
    : usableConnections[0];
  const fallbackCalendarId = asString(connection.selected_calendar_id) || "";

  return {
    connectionId: connection.id as string,
    resourceId: resource?.id as string || null,
    calendarId: asString(resource?.provider_calendar_id) || fallbackCalendarId,
    calendarName: asString(resource?.provider_calendar_name) || asString(resource?.name) || asString(connection.selected_calendar_name) || fallbackCalendarId,
    accountEmail: asString(resource?.provider_account_email) || asString(connection.connected_email),
    requestedResourceName,
  };
};

const getBusyRanges = async (accessToken: string, calendarId: string, startsAt: Date, endsAt: Date) => {
  const response = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      timeMin: startsAt.toISOString(),
      timeMax: endsAt.toISOString(),
      items: [{ id: calendarId }],
    }),
  });
  const data = await response.json() as JsonObject;

  if (!response.ok) {
    console.error("Google freeBusy check failed", data);
    return null;
  }

  const calendars = data.calendars && typeof data.calendars === "object" && !Array.isArray(data.calendars)
    ? data.calendars as Record<string, JsonObject>
    : {};
  const calendar = calendars[calendarId] || Object.values(calendars)[0] || {};
  const busy = Array.isArray(calendar.busy) ? calendar.busy : [];

  return busy
    .map((range) => {
      const item = range && typeof range === "object" && !Array.isArray(range) ? range as JsonObject : {};
      return {
        start: asString(item.start),
        end: asString(item.end),
      };
    })
    .filter((range) => range.start && range.end);
};

const hasConflict = (busyRanges: { start: string | null; end: string | null }[] | null) => {
  return busyRanges === null ? true : busyRanges.length > 0;
};

const findSlotSuggestions = async (
  accessToken: string,
  calendarId: string,
  requestedStart: Date,
  durationMinutes: number,
): Promise<SlotSuggestion[]> => {
  const day = sofiaDateParts(requestedStart);
  const searchStart = sofiaLocalToUtc({ year: day.year, month: day.month, day: day.day, hour: 9, minute: 0 });
  const searchEnd = sofiaLocalToUtc({ year: day.year, month: day.month, day: day.day, hour: 18, minute: 0 });
  const busyRanges = await getBusyRanges(accessToken, calendarId, searchStart, searchEnd);
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
      suggestions.push({
        starts_at: cursor.toISOString(),
        ends_at: candidateEnd.toISOString(),
      });
    }
    cursor = new Date(cursor.getTime() + intervalMs);
  }

  return suggestions;
};

const maybeCreateGoogleBooking = async (tenantId: string, callId: string, lead: LeadSnapshot | null) => {
  if (!supabase || !lead?.preferredTime) return;

  const { data: savedCall } = await supabase
    .from("calls")
    .select("retell_call_id")
    .eq("id", callId)
    .maybeSingle();
  const retellCallId = asString(savedCall?.retell_call_id);
  if (retellCallId) {
    const { data: liveToolBooking } = await supabase
      .from("bookings")
      .select("id")
      .eq("tenant_id", tenantId)
      .eq("source", "retell_live_tool")
      .contains("metadata", { retell_call_id: retellCallId })
      .maybeSingle();
    if (liveToolBooking?.id) return;
  }

  const startsAt = parsePreferredDateTime(lead.preferredTime);
  if (!startsAt) return;

  const { data: existingBooking } = await supabase
    .from("bookings")
    .select("id")
    .eq("call_id", callId)
    .maybeSingle();

  if (existingBooking?.id) return;

  const target = await chooseCalendarTarget(tenantId, lead.requestedResourceName);
  if (!target?.connectionId || !target.calendarId) return;

  const { data: token } = await supabase
    .from("calendar_oauth_tokens")
    .select("id, access_token, refresh_token, expires_at")
    .eq("calendar_connection_id", target.connectionId)
    .eq("provider", "google_calendar")
    .maybeSingle();

  if (!token?.access_token) return;

  const expiresAt = token.expires_at ? new Date(token.expires_at as string).getTime() : 0;
  let accessToken = token.access_token as string;
  if (expiresAt && expiresAt < Date.now() + 60_000) {
    accessToken = await refreshGoogleAccessToken(token.id as string, asString(token.refresh_token) || "") || accessToken;
  }

  const durationMinutes = durationMinutesForIntent(lead.intent, lead.notes);
  const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
  const busyRanges = await getBusyRanges(accessToken, target.calendarId, startsAt, endsAt);
  const calendarId = encodeURIComponent(target.calendarId);
  const summary = `Vdiga: ${lead.name || "Нов пациент"}`;
  const leadNotesBg = buildBulgarianLeadNotes(lead);
  const description = [
    lead.intent ? `Причина: ${lead.intent}` : null,
    lead.phone ? `Телефон: ${lead.phone}` : null,
    target.requestedResourceName ? `Поискан лекар/ресурс: ${target.requestedResourceName}` : null,
    leadNotesBg ? `Бележки: ${leadNotesBg}` : null,
    `Източник: Retell call ${callId}`,
  ].filter(Boolean).join("\n");

  if (hasConflict(busyRanges)) {
    const suggestions = busyRanges === null ? [] : await findSlotSuggestions(accessToken, target.calendarId, startsAt, durationMinutes);

    await supabase
      .from("bookings")
      .insert({
        tenant_id: tenantId,
        call_id: callId,
        lead_id: lead.id,
        provider: "google_calendar",
        customer_name: lead.name,
        customer_phone: lead.phone,
        starts_at: startsAt.toISOString(),
        ends_at: endsAt.toISOString(),
        status: "needs_review",
        calendar_resource_id: target.resourceId,
        requested_resource_name: target.requestedResourceName,
        assigned_resource_name: target.calendarName || target.accountEmail,
        source: "retell",
        metadata: {
          conflict: true,
          conflict_reason: busyRanges === null ? "freebusy_check_failed" : "requested_slot_busy",
          suggested_slots: suggestions,
          duration_minutes: durationMinutes,
          preferred_time_raw: lead.preferredTime,
          calendar_id: target.calendarId,
          connected_email: target.accountEmail,
        },
      });
    return;
  }

  const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      summary,
      description,
      start: { dateTime: startsAt.toISOString(), timeZone: "Europe/Sofia" },
      end: { dateTime: endsAt.toISOString(), timeZone: "Europe/Sofia" },
    }),
  });
  const event = await response.json() as JsonObject;

  if (!response.ok) {
    console.error("Google Calendar event creation failed", event);
    return;
  }

  const { data: resource } = await supabase
    .from("calendar_resources")
    .select("id")
    .eq("calendar_connection_id", target.connectionId)
    .eq("provider_calendar_id", target.calendarId)
    .maybeSingle();

  await supabase
    .from("bookings")
    .insert({
      tenant_id: tenantId,
      call_id: callId,
      lead_id: lead.id,
      provider: "google_calendar",
      provider_booking_id: asString(event.id),
      customer_name: lead.name,
      customer_phone: lead.phone,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: "confirmed",
      calendar_resource_id: target.resourceId || resource?.id || null,
      external_calendar_event_id: asString(event.id),
      requested_resource_name: target.requestedResourceName,
      assigned_resource_name: target.calendarName || target.accountEmail,
      source: "retell",
      metadata: {
        duration_minutes: durationMinutes,
        preferred_time_raw: lead.preferredTime,
        google_html_link: asString(event.htmlLink),
        calendar_id: target.calendarId,
        connected_email: target.accountEmail,
      },
    });
};

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }

  if (!supabase) {
    return new Response("Supabase env missing", { status: 500, headers: corsHeaders });
  }

  const url = new URL(request.url);
  if (webhookToken && url.searchParams.get("token") !== webhookToken) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }

  const rawBody = await request.text();
  let payload: RetellWebhookPayload;

  try {
    payload = JSON.parse(rawBody) as RetellWebhookPayload;
  } catch {
    return new Response("Invalid JSON", { status: 400, headers: corsHeaders });
  }

  const event = asString(payload.event);
  const call = payload.call && typeof payload.call === "object" && !Array.isArray(payload.call)
    ? payload.call
    : null;
  const retellCallId = call ? asString(call.call_id) : null;

  if (!event || !call || !retellCallId) {
    return new Response("Missing event or call", { status: 400, headers: corsHeaders });
  }

  const tenantId = await findTenantId(call);
  if (!tenantId) {
    return new Response("Tenant not resolved", { status: 202, headers: corsHeaders });
  }

  await upsertRetellAgent(tenantId, call);
  const phoneNumberId = await upsertPhoneNumber(tenantId, call);

  const analysis = normalizeAnalysis(call);
  const { data: savedCall, error: callError } = await supabase
    .from("calls")
    .upsert({
      tenant_id: tenantId,
      retell_call_id: retellCallId,
      phone_number_id: phoneNumberId,
      from_number: asString(call.from_number),
      to_number: asString(call.to_number),
      status: callStatusForEvent(event),
      started_at: timestampToIso(call.start_timestamp),
      ended_at: timestampToIso(call.end_timestamp),
      duration_seconds: durationSeconds(call.start_timestamp, call.end_timestamp),
      transcript: asString(call.transcript),
      summary: asString(analysis.call_summary) || asString(analysis.summary),
      recording_url: asString(call.recording_url),
      analysis,
    }, { onConflict: "retell_call_id" })
    .select("id")
    .maybeSingle();

  if (callError || !savedCall?.id) {
    console.error("Failed to upsert Retell call", callError);
    return new Response("Call persistence failed", { status: 500, headers: corsHeaders });
  }

  const dedupeKey = `${event}:${retellCallId}`;
  await supabase
    .from("call_events")
    .upsert({
      tenant_id: tenantId,
      call_id: savedCall.id,
      provider: "retell",
      event_type: event,
      payload,
      dedupe_key: dedupeKey,
    }, { onConflict: "dedupe_key" });

  if (event === "call_analyzed") {
    const lead = await maybeUpsertLead(tenantId, savedCall.id as string, call, analysis);
    await maybeCreateGoogleBooking(tenantId, savedCall.id as string, lead);
  }

  return new Response(null, { status: 204, headers: corsHeaders });
});
