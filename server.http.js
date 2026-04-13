import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const BASE = "https://public-api.luma.com";

// ─── Luma API client ──────────────────────────────────────────────────────────

async function luma(apiKey, path, params = {}) {
  const url = new URL(BASE + path);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  const res = await fetch(url, { headers: { "x-luma-api-key": apiKey } });
  return res.json();
}

// Extract the caller's Luma API key from MCP request context.
// Alpic forwards request headers through the MCP protocol layer — they show up
// in extra.requestInfo.headers, not as raw HTTP headers on the Express request.
function getKey(extra) {
  const key = extra?.requestInfo?.headers?.["x-api-key"];
  if (!key) throw new Error("Pass your Luma API key via the x-api-key header");
  return key;
}

// ─── Field trimmers ───────────────────────────────────────────────────────────

function trimPerson(p) {
  return {
    id: p.id,
    name: p.user?.name ?? null,
    email: p.email ?? p.user?.email ?? null,
    created_at: p.created_at,
    tags: p.tags?.map(t => t.name) ?? [],
    events_registered: p.event_approved_count ?? 0,
    events_attended: p.event_checked_in_count ?? 0,
    revenue_usd: p.revenue_usd_cents != null ? (p.revenue_usd_cents / 100).toFixed(2) : "0.00",
  };
}

function trimEvent(raw) {
  const e = raw.event ?? raw;
  return {
    id: e.id,
    name: e.name,
    start_at: e.start_at,
    end_at: e.end_at,
    url: e.url,
    visibility: e.visibility,
    location: e.geo_address_json?.full_address ?? (e.meeting_url ? "Online" : null),
    timezone: e.timezone,
    created_at: e.created_at,
  };
}

function trimGuest(g) {
  return {
    id: g.id,
    name: g.user_name ?? null,
    email: g.user_email ?? null,
    registered_at: g.registered_at,
    approval_status: g.approval_status,
    checked_in: g.event_tickets?.some(t => t.check_in_at != null) ?? false,
    utm_source: g.utm_source ?? null,
  };
}

// ─── Time-bucketing helpers ───────────────────────────────────────────────────

function bucketKey(date, bucket) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  if (bucket === "day") return `${y}-${m}-${d}`;
  if (bucket === "week") {
    const jan1 = new Date(Date.UTC(y, 0, 1));
    const week = Math.ceil(((date - jan1) / 86400000 + jan1.getUTCDay() + 1) / 7);
    return `${y}-W${String(week).padStart(2, "0")}`;
  }
  return `${y}-${m}`;
}

function buildCumulativeSeries(dates, bucket) {
  const counts = {};
  for (const d of dates) {
    const k = bucketKey(new Date(d), bucket);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const series = [];
  let total = 0;
  for (const [date, count] of Object.entries(counts).sort()) {
    total += count;
    series.push({ date, new: count, total });
  }
  return series;
}

// ─── Pagination helpers ───────────────────────────────────────────────────────

async function fetchAllPeople(apiKey, { calendar_api_id, cutoff } = {}) {
  const people = [];
  let cursor = undefined;
  while (true) {
    const res = await luma(apiKey, "/v1/calendar/list-people", {
      calendar_api_id,
      sort_column: "created_at",
      sort_direction: "asc",
      pagination_limit: 50,
      pagination_cursor: cursor,
    });
    if (!res.entries?.length) break;
    for (const p of res.entries) {
      if (cutoff && new Date(p.created_at) > new Date(cutoff)) return people;
      people.push(p);
    }
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return people;
}

async function fetchAllEvents(apiKey, { calendar_api_id, after, before } = {}) {
  const events = [];
  let cursor = undefined;
  while (true) {
    const res = await luma(apiKey, "/v1/calendar/list-events", {
      calendar_api_id,
      after,
      before,
      pagination_limit: 50,
      pagination_cursor: cursor,
    });
    if (!res.entries?.length) break;
    events.push(...res.entries);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return events;
}

async function fetchAllGuests(apiKey, event_id) {
  const guests = [];
  let cursor = undefined;
  while (true) {
    const res = await luma(apiKey, "/v1/event/get-guests", {
      event_api_id: event_id,
      pagination_limit: 50,
      pagination_cursor: cursor,
    });
    if (!res.entries?.length) break;
    guests.push(...res.entries);
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return guests;
}

// ─── MCP server ───────────────────────────────────────────────────────────────

const server = new McpServer({ name: "luma", version: "1.0.0" });

server.tool("get_self", "Get authenticated user info", {}, async (p, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(await luma(k, "/v1/user/get-self"), null, 2) }] };
});

server.tool("get_calendar", "Get calendar details", {
  api_id: z.string().optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(await luma(k, "/v1/calendar/get", p), null, 2) }] };
});

server.tool("list_events", "List calendar events (trimmed)", {
  calendar_api_id: z.string().optional(),
  after: z.string().optional().describe("ISO 8601"),
  before: z.string().optional().describe("ISO 8601"),
  pagination_cursor: z.string().optional(),
  pagination_limit: z.number().optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  const res = await luma(k, "/v1/calendar/list-events", p);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        events: res.entries?.map(trimEvent) ?? [],
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      }, null, 2)
    }]
  };
});

server.tool("get_event", "Get details about a specific event", {
  api_id: z.string(),
}, async ({ api_id }, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(trimEvent(await luma(k, "/v1/event/get", { api_id })), null, 2) }] };
});

server.tool("list_people", "List people in a calendar (trimmed)", {
  calendar_api_id: z.string().optional(),
  query: z.string().optional().describe("Search over names and emails"),
  tags: z.string().optional().describe("Comma-separated tag names or IDs"),
  pagination_cursor: z.string().optional().describe("From next_cursor in previous response"),
  pagination_limit: z.number().optional(),
  sort_column: z.enum(["created_at", "event_checked_in_count", "event_approved_count", "name", "revenue_usd_cents"]).optional(),
  sort_direction: z.enum(["asc", "desc", "asc nulls last", "desc nulls last"]).optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  const res = await luma(k, "/v1/calendar/list-people", p);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        people: res.entries?.map(trimPerson) ?? [],
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      }, null, 2)
    }]
  };
});

server.tool("get_guests", "List guests for an event (trimmed)", {
  event_api_id: z.string(),
  pagination_cursor: z.string().optional(),
  pagination_limit: z.number().optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  const res = await luma(k, "/v1/event/get-guests", p);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        guests: res.entries?.map(trimGuest) ?? [],
        has_more: res.has_more,
        next_cursor: res.next_cursor,
      }, null, 2)
    }]
  };
});

server.tool("get_guest", "Get a specific guest", {
  event_api_id: z.string(),
  email: z.string().optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(trimGuest(await luma(k, "/v1/event/get-guest", p)), null, 2) }] };
});

server.tool("list_ticket_types", "List ticket types for an event", {
  event_api_id: z.string(),
}, async (p, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(await luma(k, "/v1/event/ticket-types/list", p), null, 2) }] };
});

server.tool("list_coupons", "List coupons for an event or calendar", {
  event_api_id: z.string().optional(),
  calendar_api_id: z.string().optional(),
}, async ({ event_api_id, calendar_api_id }, extra) => {
  const k = getKey(extra);
  const path = event_api_id ? "/v1/event/coupons" : "/v1/calendar/coupons";
  const params = event_api_id ? { event_api_id } : { calendar_api_id };
  return { content: [{ type: "text", text: JSON.stringify(await luma(k, path, params), null, 2) }] };
});

server.tool("list_org_events", "List events across all org calendars", {
  organization_api_id: z.string().optional(),
  after: z.string().optional(),
  before: z.string().optional(),
}, async (p, extra) => {
  const k = getKey(extra);
  return { content: [{ type: "text", text: JSON.stringify(await luma(k, "/v1/organizations/events/list", p), null, 2) }] };
});

// ─── Growth & trend tools ─────────────────────────────────────────────────────

server.tool("get_subscribers_over_time", "Cumulative subscriber growth as a time series. Paginates internally.", {
  calendar_api_id: z.string().optional(),
  created_before: z.string().optional().describe("Stop at this date (ISO 8601)"),
  bucket: z.enum(["day", "week", "month"]).optional().default("month"),
}, async ({ calendar_api_id, created_before, bucket }, extra) => {
  const k = getKey(extra);
  const people = await fetchAllPeople(k, { calendar_api_id, cutoff: created_before });
  const series = buildCumulativeSeries(people.map(p => p.created_at), bucket);
  return { content: [{ type: "text", text: JSON.stringify({ total: people.length, bucket, series }, null, 2) }] };
});

server.tool("get_events_over_time", "Event volume trend as a cumulative time series.", {
  calendar_api_id: z.string().optional(),
  after: z.string().optional().describe("ISO 8601"),
  before: z.string().optional().describe("ISO 8601"),
  bucket: z.enum(["day", "week", "month"]).optional().default("month"),
  date_field: z.enum(["start_at", "created_at"]).optional().default("start_at").describe("Bucket by event start date or creation date"),
}, async ({ calendar_api_id, after, before, bucket, date_field }, extra) => {
  const k = getKey(extra);
  const events = await fetchAllEvents(k, { calendar_api_id, after, before });
  const dates = events.map(e => (e.event ?? e)[date_field]).filter(Boolean);
  const series = buildCumulativeSeries(dates, bucket);
  return { content: [{ type: "text", text: JSON.stringify({ total: events.length, bucket, date_field, series }, null, 2) }] };
});

server.tool("get_revenue_over_time", "Cumulative revenue from subscribers over time, bucketed by subscriber join date.", {
  calendar_api_id: z.string().optional(),
  bucket: z.enum(["day", "week", "month"]).optional().default("month"),
}, async ({ calendar_api_id, bucket }, extra) => {
  const k = getKey(extra);
  const people = await fetchAllPeople(k, { calendar_api_id });

  const byBucket = {};
  for (const p of people) {
    const bk = bucketKey(new Date(p.created_at), bucket);
    if (!byBucket[bk]) byBucket[bk] = { new_revenue_cents: 0, new_subscribers: 0 };
    byBucket[bk].new_revenue_cents += p.revenue_usd_cents ?? 0;
    byBucket[bk].new_subscribers += 1;
  }

  const series = [];
  let cumRevenue = 0, cumSubs = 0;
  for (const [date, { new_revenue_cents, new_subscribers }] of Object.entries(byBucket).sort()) {
    cumRevenue += new_revenue_cents;
    cumSubs += new_subscribers;
    series.push({
      date,
      new_revenue_usd: (new_revenue_cents / 100).toFixed(2),
      total_revenue_usd: (cumRevenue / 100).toFixed(2),
      new_subscribers,
      total_subscribers: cumSubs,
    });
  }

  const totalRevenueCents = people.reduce((s, p) => s + (p.revenue_usd_cents ?? 0), 0);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        total_subscribers: people.length,
        total_revenue_usd: (totalRevenueCents / 100).toFixed(2),
        bucket,
        series,
      }, null, 2)
    }]
  };
});

server.tool("get_attendance_over_time", "Registrations and check-ins per time bucket across events.", {
  calendar_api_id: z.string().optional(),
  after: z.string().optional().describe("ISO 8601"),
  before: z.string().optional().describe("ISO 8601"),
  max_events: z.number().optional().default(50).describe("Max events to process (default 50)"),
  bucket: z.enum(["day", "week", "month"]).optional().default("month"),
}, async ({ calendar_api_id, after, before, max_events, bucket }, extra) => {
  const k = getKey(extra);
  const allEvents = await fetchAllEvents(k, { calendar_api_id, after, before });
  const events = allEvents.slice(0, max_events);

  const results = await Promise.all(
    events.map(async (raw) => {
      const ev = raw.event ?? raw;
      const guests = await fetchAllGuests(k, ev.id);
      const registered = guests.filter(g => g.approval_status === "approved").length;
      const checkedIn = guests.filter(g => g.event_tickets?.some(t => t.check_in_at)).length;
      return { event: trimEvent(ev), registered, checked_in: checkedIn };
    })
  );

  const byBucket = {};
  for (const { event, registered, checked_in } of results) {
    const bk = bucketKey(new Date(event.start_at), bucket);
    if (!byBucket[bk]) byBucket[bk] = { events: 0, registrations: 0, check_ins: 0 };
    byBucket[bk].events += 1;
    byBucket[bk].registrations += registered;
    byBucket[bk].check_ins += checked_in;
  }

  const series = Object.entries(byBucket).sort().map(([date, s]) => ({
    date, ...s,
    avg_registrations_per_event: s.events > 0 ? Math.round(s.registrations / s.events) : 0,
    avg_show_rate_pct: s.registrations > 0 ? Number((s.check_ins / s.registrations * 100).toFixed(1)) : 0,
  }));

  return { content: [{ type: "text", text: JSON.stringify({ events_analyzed: results.length, bucket, series }, null, 2) }] };
});

// ─── Event analysis tools ─────────────────────────────────────────────────────

server.tool("get_event_summary", "Full performance summary for one event: attendance, show rate, UTM source breakdown.", {
  event_api_id: z.string(),
}, async ({ event_api_id }, extra) => {
  const k = getKey(extra);
  const [eventRes, guests] = await Promise.all([
    luma(k, "/v1/event/get", { api_id: event_api_id }),
    fetchAllGuests(k, event_api_id),
  ]);

  const approved = guests.filter(g => g.approval_status === "approved");
  const checkedIn = guests.filter(g => g.event_tickets?.some(t => t.check_in_at));
  const showRate = approved.length > 0 ? Number((checkedIn.length / approved.length * 100).toFixed(1)) : 0;

  const utmBreakdown = {};
  for (const g of approved) {
    const src = g.utm_source ?? "(direct)";
    utmBreakdown[src] = (utmBreakdown[src] ?? 0) + 1;
  }

  const ticketBreakdown = {};
  for (const g of approved) {
    for (const t of g.event_tickets ?? []) {
      const key = t.type_id ?? "default";
      ticketBreakdown[key] = (ticketBreakdown[key] ?? 0) + 1;
    }
  }

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        event: trimEvent(eventRes),
        stats: { total_guests: guests.length, registered: approved.length, checked_in: checkedIn.length, show_rate_pct: showRate, utm_sources: utmBreakdown, ticket_types: ticketBreakdown },
      }, null, 2)
    }]
  };
});

server.tool("list_events_with_stats", "Recent events enriched with registration and check-in counts.", {
  calendar_api_id: z.string().optional(),
  after: z.string().optional().describe("ISO 8601"),
  before: z.string().optional().describe("ISO 8601"),
  limit: z.number().optional().default(20).describe("Max events to enrich (default 20)"),
}, async ({ calendar_api_id, after, before, limit }, extra) => {
  const k = getKey(extra);
  const allEvents = await fetchAllEvents(k, { calendar_api_id, after, before });
  const events = allEvents.slice(0, limit);

  const enriched = await Promise.all(
    events.map(async (raw) => {
      const ev = raw.event ?? raw;
      const guests = await fetchAllGuests(k, ev.id);
      const registered = guests.filter(g => g.approval_status === "approved").length;
      const checkedIn = guests.filter(g => g.event_tickets?.some(t => t.check_in_at)).length;
      return { ...trimEvent(ev), registered, checked_in: checkedIn, show_rate_pct: registered > 0 ? Number((checkedIn / registered * 100).toFixed(1)) : 0 };
    })
  );

  return { content: [{ type: "text", text: JSON.stringify({ total: enriched.length, events: enriched }, null, 2) }] };
});

// ─── Audience tools ───────────────────────────────────────────────────────────

server.tool("get_subscriber_breakdown", "Subscribers grouped by tag — understand your audience segments.", {
  calendar_api_id: z.string().optional(),
}, async ({ calendar_api_id }, extra) => {
  const k = getKey(extra);
  const people = await fetchAllPeople(k, { calendar_api_id });

  const byTag = {};
  let untagged = 0;
  for (const p of people) {
    if (!p.tags?.length) { untagged++; continue; }
    for (const tag of p.tags) byTag[tag.name] = (byTag[tag.name] ?? 0) + 1;
  }

  const breakdown = Object.entries(byTag).sort(([, a], [, b]) => b - a)
    .map(([tag, count]) => ({ tag, count, pct: Number((count / people.length * 100).toFixed(1)) }));

  return { content: [{ type: "text", text: JSON.stringify({ total_subscribers: people.length, untagged, breakdown }, null, 2) }] };
});

server.tool("get_repeat_attendees", "Subscribers who attended more than one event — your most engaged audience.", {
  calendar_api_id: z.string().optional(),
  min_events: z.number().optional().default(2).describe("Minimum check-ins (default 2)"),
  limit: z.number().optional().default(50),
}, async ({ calendar_api_id, min_events, limit }, extra) => {
  const k = getKey(extra);
  const people = await fetchAllPeople(k, { calendar_api_id });
  const qualified = people.filter(p => (p.event_checked_in_count ?? 0) >= min_events);
  const top = qualified.sort((a, b) => (b.event_checked_in_count ?? 0) - (a.event_checked_in_count ?? 0)).slice(0, limit).map(trimPerson);

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        total_repeat_attendees: qualified.length,
        pct_of_subscribers: Number((qualified.length / people.length * 100).toFixed(1)),
        min_events,
        attendees: top,
      }, null, 2)
    }]
  };
});

// ─── Dashboard ────────────────────────────────────────────────────────────────

server.tool("marketing_dashboard", "High-level marketing overview: subscriber totals, MoM growth, event counts, revenue. Single call.", {
  calendar_api_id: z.string().optional(),
}, async ({ calendar_api_id }, extra) => {
  const k = getKey(extra);
  const [people, events] = await Promise.all([
    fetchAllPeople(k, { calendar_api_id }),
    fetchAllEvents(k, { calendar_api_id }),
  ]);

  const now = new Date();
  const thisMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const lastMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));

  const thisMonthSubs = people.filter(p => new Date(p.created_at) >= thisMonthStart).length;
  const lastMonthSubs = people.filter(p => { const d = new Date(p.created_at); return d >= lastMonthStart && d < thisMonthStart; }).length;
  const momGrowthPct = lastMonthSubs > 0 ? Number(((thisMonthSubs - lastMonthSubs) / lastMonthSubs * 100).toFixed(1)) : null;

  const upcoming = events.filter(e => new Date((e.event ?? e).start_at) > now).length;
  const totalRevenueCents = people.reduce((s, p) => s + (p.revenue_usd_cents ?? 0), 0);
  const repeatCount = people.filter(p => (p.event_checked_in_count ?? 0) >= 2).length;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        subscribers: { total: people.length, new_this_month: thisMonthSubs, new_last_month: lastMonthSubs, mom_growth_pct: momGrowthPct, repeat_attendees: repeatCount, repeat_attendee_pct: Number((repeatCount / people.length * 100).toFixed(1)) },
        events: { total: events.length, upcoming, past: events.length - upcoming },
        revenue: { total_usd: (totalRevenueCents / 100).toFixed(2), avg_per_subscriber_usd: people.length > 0 ? (totalRevenueCents / people.length / 100).toFixed(2) : "0.00" },
      }, null, 2)
    }]
  };
});

// ─── HTTP layer ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

app.get("/", (req, res) => res.json({ name: "luma-mcp", version: "1.0.0" }));

app.post("/mcp", async (req, res) => {
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
  }
});

app.listen(PORT, () => console.log(`luma-mcp listening on port ${PORT}`));
