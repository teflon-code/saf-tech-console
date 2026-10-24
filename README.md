# SAF-TECH Operations Console

Operations console for SAF-TECH internet service: leads, customers, billing, messages, login details, goals, and marketing. Database and AI run on Supabase. The site is static HTML.

## Repository layout

```
index.html                          Console (static, deploy anywhere)
supabase/migrations/001_saftech_schema.sql   Tables, RLS policies, AI approval queue
supabase/functions/ai-assistant/index.ts     Summaries and approval-gated actions (Groq)
GROQ_API_KEY_SETUP.md               How to create and store the Groq key
```

## Connect GitHub to Supabase

1. Push this folder to a GitHub repository.
2. In the Supabase dashboard, open the project and go to **Project Settings → Integrations → GitHub** (or **Integrations** in the left menu).
3. Click **Connect** (or **Add repository**), authorize Supabase on GitHub, and select this repository.
4. Set the **Supabase directory** to `supabase`, the folder that holds `migrations` and `functions`.
5. Choose the production branch, usually `main`. Migrations in `supabase/migrations` apply automatically when you push to that branch.
6. Add the `GROQ_API_KEY` secret as described in `GROQ_API_KEY_SETUP.md`.

## Deploy the console

Netlify, Vercel, or GitHub Pages can serve `index.html` directly. For Netlify, connect the repository and leave the build command empty with the publish directory set to `/`.

## Before going live

- Replace the browser-storage data in `index.html` with calls to the Supabase tables defined in the migration. Until then, data stays in each browser.
- Add sign-in, because the AI function and the row-level security policies require an authenticated user.
- Never commit `.env` files or API keys.
