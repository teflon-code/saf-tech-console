// SAF-TECH AI assistant
// Actions:
//   summarize  -> reads operational data, returns a summary, stores it in ai_summaries
//   propose    -> asks the model for ONE allowed action, stores it as pending in ai_actions
//   decide     -> staff approve or reject a pending action; only approved actions execute
//
// The model never writes business data. Writes happen only in `decide`,
// after a signed-in staff member approves the stored proposal.
//
// Required secrets (set in Supabase dashboard or via CLI):
//   GROQ_API_KEY   (from console.groq.com, starts with "gsk_")
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// Groq model. Check https://console.groq.com/docs/models for the current name.
const MODEL = "llama-3.3-70b-versatile";
const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";
const ALLOWED_ACTIONS = ["send_message", "set_stage", "mark_paid", "create_invoices"] as const;
type ActionType = typeof ALLOWED_ACTIONS[number];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

async function askModel(system: string, user: string, maxTokens = 800): Promise<string> {
  const key = Deno.env.get("GROQ_API_KEY");
  if (!key) throw new Error("GROQ_API_KEY is not set");

  const res = await fetch(GROQ_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!res.ok) throw new Error(`Model request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content ?? "";
}

// Pull a compact snapshot of operations data. Only what the model needs.
async function snapshot(db: SupabaseClient) {
  const [customers, invoices, payments, leads] = await Promise.all([
    db.from("customers").select("id,name,package,service,stage,last_contact"),
    db.from("invoices").select("id,customer_id,billing_month,status"),
    db.from("payments").select("invoice_id,amount,paid_on"),
    db.from("leads").select("name,stage,source,package"),
  ]);
  if (customers.error || invoices.error || payments.error || leads.error) {
    throw new Error("Could not read operations data");
  }
  return {
    customers: customers.data,
    invoices: invoices.data,
    payments: payments.data,
    leads: leads.data,
  };
}

async function handleSummarize(db: SupabaseClient, userEmail: string, scope: string) {
  const data = await snapshot(db);
  const system =
    "You are an operations analyst for SAF-TECH, an internet service provider in Kenya. " +
    "Write a short, plain-English summary for the operations manager. Amounts are in KSh. " +
    "Name specific customers only when they need action. Do not invent figures.";
  const content = await askModel(system, `Scope: ${scope}\n\nData:\n${JSON.stringify(data)}`, 700);

  const { data: row, error } = await db
    .from("ai_summaries")
    .insert({ scope, content })
    .select()
    .single();
  if (error) throw error;

  await db.from("audit_log").insert({ actor: userEmail, event: "ai.summarize", detail: { scope, id: row.id } });
  return row;
}

async function handlePropose(db: SupabaseClient, userEmail: string, instruction: string) {
  const data = await snapshot(db);
  const system =
    "You propose ONE operational action for SAF-TECH staff to approve. You cannot execute it. " +
    "Reply with JSON only, no preamble, no code fences. Shape: " +
    '{"action_type": one of ' + JSON.stringify(ALLOWED_ACTIONS) + ', ' +
    '"payload": object, "rationale": "one or two sentences"}. ' +
    "Payload shapes: send_message {audience, channel: SMS|WhatsApp, body}; " +
    "set_stage {customer_id, stage}; mark_paid {invoice_id, amount, method}; " +
    'create_invoices {billing_month}. If no action is appropriate, use action_type "none".';
  const raw = await askModel(system, `Instruction: ${instruction}\n\nData:\n${JSON.stringify(data)}`, 500);

  let proposal: { action_type: string; payload: unknown; rationale: string };
  try {
    proposal = JSON.parse(raw.trim());
  } catch {
    throw new Error("Model did not return valid JSON");
  }
  if (!ALLOWED_ACTIONS.includes(proposal.action_type as ActionType)) {
    return { proposed: false, reason: "No allowed action fits this instruction." };
  }

  const { data: row, error } = await db
    .from("ai_actions")
    .insert({
      action_type: proposal.action_type,
      payload: proposal.payload,
      rationale: proposal.rationale,
      requested_by: userEmail,
      status: "pending",
    })
    .select()
    .single();
  if (error) throw error;

  await db.from("audit_log").insert({ actor: userEmail, event: "ai.propose", detail: { id: row.id, action_type: row.action_type } });
  return { proposed: true, action: row };
}

// Executes an approved action. Each branch validates its payload before writing.
async function execute(db: SupabaseClient, type: ActionType, p: any): Promise<unknown> {
  switch (type) {
    case "send_message": {
      // Records the message. Actual SMS or WhatsApp delivery needs a gateway,
      // which the console does not have yet.
      const { error } = await db.from("messages").insert({
        channel: p.channel,
        audience: p.audience,
        recipient_count: Number(p.recipient_count ?? 0),
        body: String(p.body).slice(0, 1000),
      });
      if (error) throw error;
      return { logged: true };
    }
    case "set_stage": {
      if (!["Onboarding", "Active", "Upsell", "At risk"].includes(p.stage)) throw new Error("Invalid stage");
      const { error } = await db.from("customers").update({ stage: p.stage }).eq("id", Number(p.customer_id));
      if (error) throw error;
      return { updated: true };
    }
    case "mark_paid": {
      const amount = Number(p.amount);
      if (!(amount > 0)) throw new Error("Amount must be positive");
      const { error } = await db.from("payments").insert({
        invoice_id: Number(p.invoice_id),
        amount,
        method: p.method,
        paid_on: new Date().toISOString().slice(0, 10),
      });
      if (error) throw error;
      return { recorded: true };
    }
    case "create_invoices": {
      if (!/^[A-Z][a-z]{2} \d{4}$/.test(p.billing_month)) throw new Error("Invalid billing month");
      const { data: customers, error: cErr } = await db.from("customers").select("id");
      if (cErr) throw cErr;
      const rows = (customers ?? []).map((c: { id: number }) => ({
        customer_id: c.id,
        billing_month: p.billing_month,
        status: "Due",
      }));
      const { data, error } = await db
        .from("invoices")
        .upsert(rows, { onConflict: "customer_id,billing_month", ignoreDuplicates: true })
        .select();
      if (error) throw error;
      return { created: data?.length ?? 0 };
    }
  }
}

async function handleDecide(db: SupabaseClient, userId: string, userEmail: string, id: number, approve: boolean) {
  const { data: row, error } = await db.from("ai_actions").select("*").eq("id", id).single();
  if (error || !row) throw new Error("Action not found");
  if (row.status !== "pending") throw new Error(`Action is already ${row.status}`);

  if (!approve) {
    await db.from("ai_actions").update({ status: "rejected", decided_by: userId, decided_at: new Date().toISOString() }).eq("id", id);
    await db.from("audit_log").insert({ actor: userEmail, event: "ai.reject", detail: { id } });
    return { status: "rejected" };
  }

  try {
    const result = await execute(db, row.action_type as ActionType, row.payload);
    await db.from("ai_actions").update({
      status: "approved",
      decided_by: userId,
      decided_at: new Date().toISOString(),
      result,
    }).eq("id", id);
    await db.from("audit_log").insert({ actor: userEmail, event: "ai.approve", detail: { id, action_type: row.action_type, result } });
    return { status: "approved", result };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await db.from("ai_actions").update({ status: "failed", decided_by: userId, decided_at: new Date().toISOString(), result: { error: message } }).eq("id", id);
    await db.from("audit_log").insert({ actor: userEmail, event: "ai.fail", detail: { id, error: message } });
    return { status: "failed", error: message };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Identify the caller with their own token. Only signed-in staff get through.
  const authHeader = req.headers.get("Authorization") ?? "";
  const url = Deno.env.get("SUPABASE_URL")!;
  const anon = Deno.env.get("SUPABASE_ANON_KEY")!;
  const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: userData, error: authErr } = await userClient.auth.getUser();
  if (authErr || !userData.user) return json({ error: "Sign in required" }, 401);

  // Business reads and writes use the service role, after the check above.
  const db = createClient(url, service);
  const userEmail = userData.user.email ?? userData.user.id;

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  try {
    switch (body.action) {
      case "summarize":
        return json(await handleSummarize(db, userEmail, String(body.scope ?? "Overall operations")));
      case "propose":
        return json(await handlePropose(db, userEmail, String(body.instruction ?? "").slice(0, 500)));
      case "decide":
        return json(await handleDecide(db, userData.user.id, userEmail, Number(body.id), body.approve === true));
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return json({ error: message }, 500);
  }
});
