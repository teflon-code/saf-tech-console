// SAF-TECH AI agent
//
// Actions:
//   chat    -> the owner sends a message. The model may call tools in a loop.
//              Read tools run immediately. Write tools only create a pending
//              approval in ai_actions; nothing changes until the owner approves.
//   decide  -> approve or reject a pending action. Approval runs the change.
//
// Every turn is written to ai_chats, so the full conversation is kept.
//
// Secrets: GROQ_API_KEY
// Provided automatically: SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const OWNER_ID = "d3e8ee83-ab03-4b4a-a97e-8fc2112864c2";
// Fast and low cost on Groq, with tool calling. Check https://console.groq.com/docs/models if this name changes.
const MODEL = "openai/gpt-oss-20b";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const MAX_STEPS = 4;

const WRITE_TOOLS = ["cancel_subscriptions", "pause_subscriptions", "resume_subscriptions", "send_message", "reply_to_complaint", "create_invoices", "mark_paid"];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const TOOLS = [
  {
    type: "function",
    function: {
      name: "find_customers",
      description: "Find customers by account number or name. Read only.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    },
  },
  {
    type: "function",
    function: {
      name: "payments_summary",
      description: "Totals of billed, collected and outstanding amounts, optionally for one billing month such as 'Oct 2026', with a per-month breakdown and payment methods. Read only.",
      parameters: { type: "object", properties: { billing_month: { type: ["string", "null"], description: "Optional. Omit or pass null for all months." } } },
    },
  },
  {
    type: "function",
    function: {
      name: "business_snapshot",
      description: "Analytics: customer counts, recurring revenue, package and stage mix, churn, customers with unpaid invoices, complaints and marketing cost per customer. Read only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_complaints",
      description: "List complaints with the customer name and account number. Read only.",
      parameters: { type: "object", properties: { status: { type: "string", enum: ["open", "responded", "resolved", "all"] } } },
    },
  },
  {
    type: "function",
    function: {
      name: "cancel_subscriptions",
      description: "Propose cancelling subscriptions for one or more account numbers. Needs owner approval.",
      parameters: {
        type: "object",
        properties: {
          account_nos: { type: "array", items: { type: "string" } },
          reason: { type: "string" },
        },
        required: ["account_nos", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "pause_subscriptions",
      description: "Propose pausing service for one or more account numbers (service suspended, billing stops). Needs owner approval.",
      parameters: {
        type: "object",
        properties: { account_nos: { type: "array", items: { type: "string" } }, reason: { type: "string" } },
        required: ["account_nos", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "resume_subscriptions",
      description: "Propose resuming paused subscriptions for one or more account numbers. Needs owner approval.",
      parameters: {
        type: "object",
        properties: { account_nos: { type: "array", items: { type: "string" } } },
        required: ["account_nos"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_message",
      description: "Propose sending a message to customers. Give account_nos, or audience 'all' or 'unpaid'. Needs owner approval.",
      parameters: {
        type: "object",
        properties: {
          account_nos: { type: "array", items: { type: "string" } },
          audience: { type: "string", enum: ["all", "unpaid"] },
          channel: { type: "string", enum: ["SMS", "WhatsApp"] },
          body: { type: "string" },
        },
        required: ["channel", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reply_to_complaint",
      description: "Propose a reply to a complaint. The reply is sent to the customer and the complaint is marked responded. Needs owner approval.",
      parameters: {
        type: "object",
        properties: { complaint_id: { type: "number" }, body: { type: "string" } },
        required: ["complaint_id", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_invoices",
      description: "Propose creating invoices for all active customers for a billing month such as 'Nov 2026'. Needs owner approval.",
      parameters: { type: "object", properties: { billing_month: { type: "string" } }, required: ["billing_month"] },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_paid",
      description: "Propose recording a payment for a customer account and billing month. Blank amount means the full balance. Needs owner approval.",
      parameters: {
        type: "object",
        properties: {
          account_no: { type: "string" },
          billing_month: { type: "string" },
          amount: { type: "number" },
          method: { type: "string", enum: ["Mobile money", "Cash", "Bank transfer"] },
        },
        required: ["account_no", "billing_month"],
      },
    },
  },
];

const SYSTEM = `You are the operations agent for SAF-TECH, an internet service provider in Kenya. You work for the owner.
Amounts are in KSh. Customers are identified by account number such as SAF-0001.
Use tools to look up facts. Never invent customers, amounts or dates.
Read tools run at once. Write tools (cancel_subscriptions, pause_subscriptions, resume_subscriptions, send_message, reply_to_complaint, create_invoices, mark_paid) only queue a proposal for the owner to approve. Say so plainly, and do not claim the change has happened.
When asked for a summary or analytics, call the relevant read tools and then write a clear, concise answer with figures.
For complaints, draft a polite, specific reply in the same language the customer used (English or Swahili), then propose it with reply_to_complaint.
If an instruction is ambiguous about which customers are meant, ask one short question instead of guessing.`;

async function askModel(messages: unknown[]) {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new Error("GROQ_API_KEY is not set");
  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages, tools: TOOLS, tool_choice: "auto", temperature: 0.2, max_tokens: 1200 }),
  });
  if (!res.ok) throw new Error(`Model request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices[0].message;
}

const money = (n: number) => "KSh " + Math.round(n || 0).toLocaleString("en-US");

function paidMap(payments: any[]) {
  const m: Record<number, number> = {};
  (payments ?? []).forEach((p: any) => { m[p.invoice_id] = (m[p.invoice_id] ?? 0) + p.amount; });
  return m;
}

async function readTool(db: SupabaseClient, name: string, args: any): Promise<unknown> {
  switch (name) {
    case "find_customers": {
      const q = String(args.query ?? "").trim().replace(/[%,]/g, "");
      const { data, error } = await db.from("customers")
        .select("account_no,name,phone,package,service,stage,status")
        .or(`account_no.ilike.%${q}%,name.ilike.%${q}%`).limit(10);
      if (error) throw error;
      return data;
    }
    case "payments_summary": {
      const [{ data: pk }, { data: cu }, { data: iv }, { data: pa }] = await Promise.all([
        db.from("packages").select("name,monthly_price"),
        db.from("customers").select("id,package"),
        db.from("invoices").select("id,customer_id,billing_month"),
        db.from("payments").select("id,invoice_id,amount,method,paid_on"),
      ]);
      const price: Record<string, number> = Object.fromEntries((pk ?? []).map((p: any) => [p.name, p.monthly_price]));
      const pkgOf: Record<number, string> = Object.fromEntries((cu ?? []).map((c: any) => [c.id, c.package]));
      const paid = paidMap(pa ?? []);
      const month = typeof args.billing_month === "string" && args.billing_month ? args.billing_month : null;
      const invs = (iv ?? []).filter((i: any) => !month || i.billing_month === month);
      const months: Record<string, { billed: number; collected: number; invoices: number }> = {};
      let billed = 0, collected = 0;
      invs.forEach((i: any) => {
        const b = price[pkgOf[i.customer_id]] ?? 0;
        const c = Math.min(b, paid[i.id] ?? 0);
        const m = (months[i.billing_month] ??= { billed: 0, collected: 0, invoices: 0 });
        m.billed += b; m.collected += c; m.invoices += 1;
        billed += b; collected += c;
      });
      const invIds = new Set(invs.map((i: any) => i.id));
      const payments = (pa ?? []).filter((p: any) => invIds.has(p.invoice_id));
      const byMethod: Record<string, number> = {};
      payments.forEach((p: any) => { byMethod[p.method] = (byMethod[p.method] ?? 0) + p.amount; });
      return {
        totals: { billed: money(billed), collected: money(collected), outstanding: money(billed - collected) },
        by_month: Object.fromEntries(Object.entries(months).map(([k, v]) => [k, { billed: money(v.billed), collected: money(v.collected), invoices: v.invoices }])),
        payments_count: payments.length,
        payments_total: money(payments.reduce((a: number, p: any) => a + p.amount, 0)),
        by_method: Object.fromEntries(Object.entries(byMethod).map(([k, v]) => [k, money(v)])),
        payments: payments.slice(-50).map((p: any) => ({ paid_on: p.paid_on, amount: money(p.amount), method: p.method })),
      };
    }
    case "business_snapshot": {
      const [{ data: pk }, { data: cu }, { data: iv }, { data: pa }, { data: cp }, { data: mk }] = await Promise.all([
        db.from("packages").select("name,monthly_price"),
        db.from("customers").select("id,package,stage,status"),
        db.from("invoices").select("id,customer_id"),
        db.from("payments").select("invoice_id,amount"),
        db.from("complaints").select("status"),
        db.from("marketing_channels").select("name,spend,customers"),
      ]);
      const price: Record<string, number> = Object.fromEntries((pk ?? []).map((p: any) => [p.name, p.monthly_price]));
      const customers = cu ?? [];
      const active = customers.filter((c: any) => c.status === "active");
      const paid = paidMap(pa ?? []);
      const unpaidIds = new Set<number>();
      (iv ?? []).forEach((i: any) => {
        const c = customers.find((x: any) => x.id === i.customer_id);
        if (c && (paid[i.id] ?? 0) < (price[c.package] ?? 0)) unpaidIds.add(c.id);
      });
      const countBy = (arr: any[], key: string) => arr.reduce((a: Record<string, number>, x: any) => { a[x[key]] = (a[x[key]] ?? 0) + 1; return a; }, {});
      const cancelled = customers.length - active.length;
      const mrr = active.reduce((a: number, c: any) => a + (price[c.package] ?? 0), 0);
      return {
        customers_total: customers.length,
        customers_active: active.length,
        customers_cancelled: cancelled,
        churn_percent: customers.length ? Math.round((cancelled / customers.length) * 1000) / 10 : 0,
        monthly_recurring_revenue: money(mrr),
        active_by_package: countBy(active, "package"),
        active_by_stage: countBy(active, "stage"),
        customers_with_unpaid_invoices: unpaidIds.size,
        complaints_by_status: countBy(cp ?? [], "status"),
        marketing: (mk ?? []).map((m: any) => ({
          channel: m.name,
          spend: money(m.spend),
          customers_won: m.customers,
          cost_per_customer: m.customers ? money(m.spend / m.customers) : "n/a",
        })),
      };
    }
    case "list_complaints": {
      let q = db.from("complaints").select("id,summary,status,response,created_at,customers(account_no,name)").order("created_at", { ascending: false }).limit(25);
      if (args.status && args.status !== "all") q = q.eq("status", args.status);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    }
  }
  throw new Error("Unknown read tool " + name);
}

async function resolveAccounts(db: SupabaseClient, args: any): Promise<any[]> {
  if (args.audience === "all") {
    const { data } = await db.from("customers").select("id,account_no,name,phone,package").eq("status", "active");
    return data ?? [];
  }
  if (args.audience === "unpaid") {
    const { data: cu } = await db.from("customers").select("id,account_no,name,phone,package").eq("status", "active");
    const { data: iv } = await db.from("invoices").select("id,customer_id");
    const { data: pa } = await db.from("payments").select("invoice_id,amount");
    const paid = paidMap(pa ?? []);
    const unpaid = new Set((iv ?? []).filter((i: any) => (paid[i.id] ?? 0) === 0).map((i: any) => i.customer_id));
    return (cu ?? []).filter((c: any) => unpaid.has(c.id));
  }
  const nos: string[] = (args.account_nos ?? []).map(String);
  const { data } = await db.from("customers").select("id,account_no,name,phone,package").in("account_no", nos);
  return data ?? [];
}

// Plain description of a write action, shown to the owner for approval.
async function describeWrite(db: SupabaseClient, name: string, args: any): Promise<string> {
  switch (name) {
    case "pause_subscriptions": {
      const { data } = await db.from("customers").select("account_no,name").in("account_no", args.account_nos ?? []);
      return `Pause service for ${(data ?? []).length} account(s): ` + (data ?? []).map((c: any) => `${c.account_no} ${c.name}`).join(", ") + `. Reason: ${args.reason ?? ""}`;
    }
    case "resume_subscriptions": {
      const { data } = await db.from("customers").select("account_no,name").in("account_no", args.account_nos ?? []);
      return `Resume service for ${(data ?? []).length} account(s): ` + (data ?? []).map((c: any) => `${c.account_no} ${c.name}`).join(", ");
    }
    case "cancel_subscriptions": {
      const { data } = await db.from("customers").select("account_no,name").in("account_no", args.account_nos ?? []);
      return `Cancel ${(data ?? []).length} subscription(s): ` + (data ?? []).map((c: any) => `${c.account_no} ${c.name}`).join(", ") + `. Reason: ${args.reason ?? ""}`;
    }
    case "send_message": {
      const r = await resolveAccounts(db, args);
      return `Send ${args.channel} to ${r.length} customer(s): ` + r.slice(0, 8).map((c: any) => c.name).join(", ") + (r.length > 8 ? "..." : "");
    }
    case "reply_to_complaint": {
      const { data } = await db.from("complaints").select("summary,customers(name,account_no)").eq("id", args.complaint_id).single();
      const c: any = data;
      return c ? `Reply to ${c.customers?.name} (${c.customers?.account_no}) about: ${c.summary}` : "Reply to complaint";
    }
    case "create_invoices":
      return `Create invoices for all active customers for ${args.billing_month}`;
    case "mark_paid":
      return `Record ${args.amount ? money(args.amount) : "full balance"} paid by ${args.account_no} for ${args.billing_month}`;
  }
  return name;
}

async function executeWrite(db: SupabaseClient, name: string, args: any): Promise<unknown> {
  switch (name) {
    case "cancel_subscriptions": {
      const { data, error } = await db.from("customers")
        .update({ status: "cancelled", cancelled_at: new Date().toISOString(), cancel_reason: String(args.reason ?? "") })
        .in("account_no", args.account_nos ?? []).select("account_no");
      if (error) throw error;
      return { cancelled: (data ?? []).map((c: any) => c.account_no) };
    }
    case "pause_subscriptions": {
      const { data, error } = await db.from("customers")
        .update({ status: "paused", paused_at: new Date().toISOString(), pause_reason: String(args.reason ?? "") })
        .in("account_no", args.account_nos ?? []).neq("status", "cancelled").select("account_no");
      if (error) throw error;
      return { paused: (data ?? []).map((c: any) => c.account_no) };
    }
    case "resume_subscriptions": {
      const { data, error } = await db.from("customers")
        .update({ status: "active", paused_at: null, pause_reason: null })
        .in("account_no", args.account_nos ?? []).eq("status", "paused").select("account_no");
      if (error) throw error;
      return { resumed: (data ?? []).map((c: any) => c.account_no) };
    }
    case "send_message": {
      const r = await resolveAccounts(db, args);
      const { error } = await db.from("messages").insert({
        channel: args.channel,
        audience: args.audience ?? (args.account_nos ?? []).join(", "),
        recipient_count: r.length,
        body: String(args.body).slice(0, 1000),
      });
      if (error) throw error;
      // Automatic SMS and WhatsApp delivery is not connected yet. Return the
      // numbers so the message can be sent from a phone.
      return { logged_for: r.length, numbers: r.map((c: any) => ({ account_no: c.account_no, phone: c.phone })) };
    }
    case "reply_to_complaint": {
      const { data: cp, error: e1 } = await db.from("complaints").select("id,customer_id,customers(name,phone,account_no)").eq("id", args.complaint_id).single();
      if (e1 || !cp) throw new Error("Complaint not found");
      const c: any = cp;
      const { error: e2 } = await db.from("messages").insert({
        channel: "SMS", audience: c.customers?.account_no ?? "customer", recipient_count: 1, body: String(args.body).slice(0, 1000),
      });
      if (e2) throw e2;
      const { error: e3 } = await db.from("complaints").update({ status: "responded", response: args.body, responded_at: new Date().toISOString() }).eq("id", args.complaint_id);
      if (e3) throw e3;
      return { replied_to: c.customers?.account_no, phone: c.customers?.phone };
    }
    case "create_invoices": {
      if (!/^[A-Z][a-z]{2} \d{4}$/.test(args.billing_month)) throw new Error("Billing month must look like 'Nov 2026'");
      const { data: cs, error: e1 } = await db.from("customers").select("id").eq("status", "active");
      if (e1) throw e1;
      const rows = (cs ?? []).map((c: any) => ({ customer_id: c.id, billing_month: args.billing_month, status: "Due" }));
      const { data, error } = await db.from("invoices").upsert(rows, { onConflict: "customer_id,billing_month", ignoreDuplicates: true }).select("id");
      if (error) throw error;
      return { created: (data ?? []).length };
    }
    case "mark_paid": {
      const { data: c, error: e1 } = await db.from("customers").select("id,package,account_no").eq("account_no", args.account_no).single();
      if (e1 || !c) throw new Error("Account not found");
      const cust: any = c;
      const { data: pk } = await db.from("packages").select("monthly_price").eq("name", cust.package).single();
      let { data: inv } = await db.from("invoices").select("id").eq("customer_id", cust.id).eq("billing_month", args.billing_month).maybeSingle();
      if (!inv) {
        const r = await db.from("invoices").insert({ customer_id: cust.id, billing_month: args.billing_month, status: "Due" }).select("id").single();
        if (r.error) throw r.error;
        inv = r.data;
      }
      const { data: pays } = await db.from("payments").select("amount").eq("invoice_id", (inv as any).id);
      const paid = (pays ?? []).reduce((a: number, p: any) => a + p.amount, 0);
      const price = (pk as any)?.monthly_price ?? 0;
      const amount = args.amount > 0 ? Math.round(args.amount) : Math.max(0, price - paid);
      if (amount <= 0) throw new Error("Already paid in full");
      const { error } = await db.from("payments").insert({
        invoice_id: (inv as any).id, amount, method: args.method ?? "Mobile money", paid_on: new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      return { recorded: amount, account_no: cust.account_no };
    }
  }
  throw new Error("Unknown write tool " + name);
}

async function handleChat(db: SupabaseClient, sessionId: string, message: string) {
  const { data: history } = await db.from("ai_chats").select("role,content")
    .eq("session_id", sessionId).in("role", ["user", "assistant"]).order("created_at", { ascending: false }).limit(20);
  const past = (history ?? []).reverse().map((h: any) => ({ role: h.role, content: h.content }));

  await db.from("ai_chats").insert({ session_id: sessionId, role: "user", content: message });

  const convo: any[] = [{ role: "system", content: SYSTEM }, ...past, { role: "user", content: message }];
  const pending: unknown[] = [];
  let reply = "";

  for (let step = 0; step < MAX_STEPS; step++) {
    const msg = await askModel(convo);
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      reply = msg.content ?? "";
      break;
    }
    convo.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const call of msg.tool_calls) {
      const name: string = call.function.name;
      let args: any = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
      let result: unknown;
      try {
        if (WRITE_TOOLS.includes(name)) {
          const summary = await describeWrite(db, name, args);
          const { data: row, error } = await db.from("ai_actions").insert({
            action_type: name, payload: args, rationale: summary, status: "pending", requested_by: OWNER_ID,
          }).select("id,action_type,rationale").single();
          if (error) throw error;
          pending.push(row);
          result = { status: "pending_owner_approval", action_id: row.id, will_do: summary };
        } else {
          result = await readTool(db, name, args);
        }
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) };
      }
      const text = JSON.stringify(result);
      await db.from("ai_chats").insert({ session_id: sessionId, role: "tool", content: text.slice(0, 4000), tool_name: name, tool_input: args, tool_result: result as any });
      convo.push({ role: "tool", tool_call_id: call.id, content: text.slice(0, 8000) });
    }
  }
  if (!reply) reply = "I could not finish that request. Please try again with a shorter instruction.";

  await db.from("ai_chats").insert({ session_id: sessionId, role: "assistant", content: reply });
  return { reply, pending, session_id: sessionId };
}

async function handleDecide(db: SupabaseClient, approve: boolean, id: number) {
  const { data: row, error } = await db.from("ai_actions").select("*").eq("id", id).single();
  if (error || !row) throw new Error("Action not found");
  if (row.status !== "pending") throw new Error(`Action is already ${row.status}`);
  const now = new Date().toISOString();
  if (!approve) {
    await db.from("ai_actions").update({ status: "rejected", decided_by: OWNER_ID, decided_at: now }).eq("id", id);
    await db.from("audit_log").insert({ actor: OWNER_ID, event: "ai.reject", detail: { id, action: row.action_type } });
    return { status: "rejected" };
  }
  try {
    const result = await executeWrite(db, row.action_type, row.payload);
    await db.from("ai_actions").update({ status: "approved", decided_by: OWNER_ID, decided_at: now, result }).eq("id", id);
    await db.from("audit_log").insert({ actor: OWNER_ID, event: "ai.approve", detail: { id, action: row.action_type, result } });
    return { status: "approved", result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("ai_actions").update({ status: "failed", decided_by: OWNER_ID, decided_at: now, result: { error: message } }).eq("id", id);
    await db.from("audit_log").insert({ actor: OWNER_ID, event: "ai.fail", detail: { id, error: message } });
    return { status: "failed", error: message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, { global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } } });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData.user) return json({ error: "Sign in required" }, 401);
  if (userData.user.id !== OWNER_ID) return json({ error: "This account is not allowed" }, 403);

  const db = createClient(url, service);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

  try {
    if (body.action === "chat") {
      const message = String(body.message ?? "").trim().slice(0, 4000);
      if (!message) return json({ error: "Message is empty" }, 400);
      const sessionId = typeof body.session_id === "string" && body.session_id ? body.session_id : crypto.randomUUID();
      return json(await handleChat(db, sessionId, message));
    }
    if (body.action === "decide") {
      return json(await handleDecide(db, body.approve === true, Number(body.id)));
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
