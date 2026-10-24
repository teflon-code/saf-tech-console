# Groq API Key Setup for the SAF-TECH AI Functions

The AI functions call Groq from the server. The key is stored as a Supabase secret, never in the HTML files, so customers and browsers never see it.

## Step 1: Create a Groq key

1. Go to https://console.groq.com and sign in.
2. Open **API Keys** in the left menu.
3. Click **Create API Key**, give it a name such as `saf-tech-console`, and click **Submit**.
4. Copy the key now. It starts with `gsk_` and Groq will not show it again.

## Step 2: Add the key to your Supabase project

Do this after the project has been created.

1. Open the Supabase dashboard and select the `saf-tech-console` project.
2. Go to **Project Settings**, then **Edge Functions**, then **Secrets**. Some dashboard versions show this under **Edge Functions** directly.
3. Click **Add new secret**.
4. Name: `GROQ_API_KEY`
5. Value: paste the `gsk_...` key.
6. Save.

Or from a terminal, with the Supabase CLI installed and logged in:

```bash
supabase secrets set GROQ_API_KEY=gsk_your_key_here --project-ref YOUR_PROJECT_REF
```

`YOUR_PROJECT_REF` is the short ID shown in the project URL, for example `abcdefghijklmnop`.

## Step 3: Deploy the function

```bash
supabase functions deploy ai-assistant --project-ref YOUR_PROJECT_REF
```

Keep JWT verification on (the default). The function also checks the signed-in user itself.

## Step 4: Test the key

Replace the placeholders. You need a signed-in user's access token, which the console will supply once login is added.

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/ai-assistant" \
  -H "Authorization: Bearer USER_ACCESS_TOKEN" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"action":"summarize","scope":"Overall operations"}'
```

A successful response contains a `content` field with the summary. If you see `GROQ_API_KEY is not set`, the secret wasn't saved or the function wasn't redeployed after saving it.

## Rules to keep

- Never paste the key into `saf-tech-console.html`, a Netlify environment variable that the browser can read, or a chat message.
- If a key is exposed, revoke it in the Groq console and create a new one, then update the Supabase secret.
- Groq model names change over time. If you get a "model not found" error, check https://console.groq.com/docs/models and update `MODEL` in `supabase/functions/ai-assistant/index.ts`, then redeploy.
