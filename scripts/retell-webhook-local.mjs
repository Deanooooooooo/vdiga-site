import http from "node:http";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const envPath = new URL("../.env.local", import.meta.url);
const envText = readFileSync(envPath, "utf8");

for (const line of envText.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
  const [key, ...rest] = trimmed.split("=");
  if (!process.env[key]) process.env[key] = rest.join("=");
}

const port = Number(process.env.PORT || 8787);
const supabaseUrl = process.env.PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const webhookToken = process.env.RETELL_WEBHOOK_TOKEN || "";
const defaultRetellAgentId = process.env.RETELL_DEFAULT_AGENT_ID || "agent_42a61a2e13af1933c17eb03dd8";

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});

const asString = (value) => {
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const asNumber = (value) => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const timestampToIso = (value) => {
  const timestamp = asNumber(value);
  if (!timestamp) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const durationSeconds = (startedAt, endedAt) => {
  const start = asNumber(startedAt);
  const end = asNumber(endedAt);
  if (!start || !end || end < start) return null;
  return Math.round((end - start) / 1000);
};

const callStatusForEvent = (event) => {
  if (event === "call_started") return "started";
  if (event === "call_analyzed") return "analyzed";
  if (event === "call_ended") return "ended";
  return "ended";
};

const normalizeAnalysis = (call) => {
  const callAnalysis = call.call_analysis;
  return callAnalysis && typeof callAnalysis === "object" && !Array.isArray(callAnalysis) ? callAnalysis : {};
};

const pickAnalysisField = (analysis, keys) => {
  const customData = analysis.custom_analysis_data;
  const custom = customData && typeof customData === "object" && !Array.isArray(customData) ? customData : {};

  for (const key of keys) {
    const value = asString(custom[key]) || asString(analysis[key]);
    if (value) return value;
  }

  return null;
};

const userLinesFromTranscript = (transcript) => {
  return (asString(transcript) || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("User:"))
    .map((line) => line.replace(/^User:\s*/, "").trim())
    .filter(Boolean);
};

const extractNameFromTranscript = (transcript) => {
  const userLines = userLinesFromTranscript(transcript);
  const text = userLines.join(" ");
  const direct = text.match(/(?:казвам се|името ми е|аз съм|на името на)\s+([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){1,2})/);
  if (direct?.[1]) return direct[1].trim();

  const blocked = new Set(["Здравейте", "Да", "Не", "Може", "Усещам", "Всички", "В"]);
  for (const line of userLines) {
    const cleaned = line.replace(/[.,!?]+$/g, "").trim();
    const match = cleaned.match(/^([А-ЯA-Z][а-яa-z]+(?:\s+[А-ЯA-Z][а-яa-z]+){1,2})$/);
    if (match?.[1] && !blocked.has(match[1].split(/\s+/)[0])) return match[1];
  }

  return null;
};

const extractIntentFromText = (text) => {
  const normalized = text.toLowerCase();
  const parts = [];
  if (/зъбобол|забобол|болк|кътн/.test(normalized)) parts.push("болка в зъб/кътник");
  if (/коронк/.test(normalized)) parts.push("възможна коронка");
  if (/почиств|зъбен камък/.test(normalized)) parts.push("почистване на зъбен камък");
  if (/час|запиша|заявк/.test(normalized)) parts.unshift("заявка за час");

  return parts.length ? [...new Set(parts)].join("; ") : null;
};

const extractPreferredTimeFromText = (text) => {
  const normalized = text.replace(/\s+/g, " ").trim();
  const time = normalized.match(/\b(?:в\s*)?((?:[01]?\d|2[0-3])(?::[0-5]\d)?)(?:\s*ч(?:аса)?)?\b/i)?.[1];
  const relativeDay = normalized.match(/(?:^|\s)(днес|утре|вдругиден)(?=\s|[.,!?]|$)/i)?.[1];
  const weekday = normalized.match(/(?:^|\s)(понеделник|вторник|сряда|четвъртък|петък|събота|неделя)(?=\s|[.,!?]|$)/i)?.[1];
  const date = normalized.match(/(?:^|\s)(\d{1,2}\s*(?:юли|август|септември|октомври|ноември|декември|януари|февруари|март|април|май|юни)|\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?)(?=\s|[.,!?]|$)/i)?.[1];
  const dayPart = normalized.match(/(?:^|\s)(сутрин|следобед|вечер|преди обяд|през нощта|на обяд)(?=\s|[.,!?]|$)/i)?.[1];

  const pieces = [relativeDay || date || weekday, time ? `${time.includes(":") ? time : `${time}:00`}` : null, dayPart].filter(Boolean);
  return pieces.length ? pieces.join(" ") : null;
};

const extractUrgencyFromText = (text) => {
  return /спешн|силна болк|зъбобол|забобол/.test(text.toLowerCase()) ? "urgent" : null;
};

const findTenantId = async (call) => {
  const agentId = asString(call.agent_id) || defaultRetellAgentId;
  if (agentId) {
    const { data } = await supabase
      .from("retell_agents")
      .select("tenant_id")
      .eq("retell_agent_id", agentId)
      .maybeSingle();

    if (data?.tenant_id) return data.tenant_id;
  }

  const toNumber = asString(call.to_number);
  if (toNumber) {
    const { data } = await supabase
      .from("phone_numbers")
      .select("tenant_id")
      .or(`retell_phone_number.eq.${toNumber},didww_number.eq.${toNumber}`)
      .not("tenant_id", "is", null)
      .maybeSingle();

    if (data?.tenant_id) return data.tenant_id;
  }

  const { data: tenants } = await supabase
    .from("tenants")
    .select("id")
    .order("created_at", { ascending: true })
    .limit(2);

  return tenants?.length === 1 ? tenants[0].id : null;
};

const upsertRetellAgent = async (tenantId, call) => {
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
      metadata: { source: "retell_webhook_local" },
    }, { onConflict: "retell_agent_id" });
};

const upsertPhoneNumber = async (tenantId, call) => {
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
        source: "retell_webhook_local",
      },
    }, { onConflict: "didww_number" })
    .select("id")
    .maybeSingle();

  return data?.id || null;
};

const maybeUpsertLead = async (tenantId, callId, call, analysis) => {
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
    ? existingLead.metadata
    : {};
  const name = pickAnalysisField(analysis, ["name", "customer_name", "patient_name", "full_name"])
    || extractNameFromTranscript(transcript)
    || existingLead?.name
    || null;
  const phone = pickAnalysisField(analysis, ["phone", "customer_phone", "patient_phone"])
    || asString(call.from_number)
    || existingLead?.phone
    || null;
  const intent = pickAnalysisField(analysis, ["intent", "service", "requested_service", "reason"])
    || extractIntentFromText(extractionText)
    || existingLead?.intent
    || null;
  const preferredTime = pickAnalysisField(analysis, ["preferred_time", "preferred_datetime", "preferred_day_time"])
    || extractPreferredTimeFromText(userText)
    || extractPreferredTimeFromText(extractionText)
    || existingMetadata.preferred_time
    || null;
  const urgency = pickAnalysisField(analysis, ["urgency", "urgent"])
    || extractUrgencyFromText(extractionText)
    || existingMetadata.urgency
    || null;
  const outcome = pickAnalysisField(analysis, ["outcome", "call_outcome"])
    || existingMetadata.outcome
    || (name || intent ? "appointment_request" : null);
  const notes = summary || existingLead?.notes || null;

  if (!name && !intent && !notes) return;

  await supabase
    .from("leads")
    .upsert({
      tenant_id: tenantId,
      call_id: callId,
      name,
      phone,
      intent,
      notes,
      status: existingLead?.status || "new",
      metadata: {
        outcome,
        urgency,
        preferred_time: preferredTime,
        source: "retell_webhook_local",
      },
    }, { onConflict: "call_id" });
};

const ingestRetellWebhook = async (payload) => {
  const event = asString(payload.event);
  const call = payload.call && typeof payload.call === "object" && !Array.isArray(payload.call) ? payload.call : null;
  const retellCallId = call ? asString(call.call_id) : null;

  if (!event || !call || !retellCallId) {
    throw new Error("Missing event or call");
  }

  const tenantId = await findTenantId(call);
  if (!tenantId) {
    console.warn("Tenant not resolved", { event, retellCallId });
    return { accepted: true, stored: false };
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
    throw new Error(`Call persistence failed: ${callError?.message || "missing id"}`);
  }

  await supabase
    .from("call_events")
    .upsert({
      tenant_id: tenantId,
      call_id: savedCall.id,
      provider: "retell",
      event_type: event,
      payload,
      dedupe_key: `${event}:${retellCallId}`,
    }, { onConflict: "dedupe_key" });

  if (event === "call_analyzed" || event === "call_ended") {
    await maybeUpsertLead(tenantId, savedCall.id, call, analysis);
  }

  return { accepted: true, stored: true, event, retellCallId };
};

const readBody = (request) => {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_000_000) {
        request.destroy();
        reject(new Error("Payload too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
};

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);

  if (request.method === "GET" && url.pathname === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
    return;
  }

  if (request.method !== "POST" || url.pathname !== "/retell-webhook") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  if (webhookToken && url.searchParams.get("token") !== webhookToken) {
    response.writeHead(401);
    response.end("Unauthorized");
    return;
  }

  try {
    const body = await readBody(request);
    const payload = JSON.parse(body);
    const result = await ingestRetellWebhook(payload);
    console.log("Retell webhook stored", result);
    response.writeHead(204);
    response.end();
  } catch (error) {
    console.error(error);
    response.writeHead(500, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: error.message }));
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Retell webhook receiver listening on http://127.0.0.1:${port}/retell-webhook`);
  if (webhookToken) {
    console.log("Webhook token protection enabled");
  }
});
