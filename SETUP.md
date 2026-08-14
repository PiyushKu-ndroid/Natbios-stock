# PixelVault — Complete Deployment Guide

Follow every step in order. Estimated time: **90 minutes** for a first deployment.

---

## Prerequisites

| Tool | Install command | Purpose |
|---|---|---|
| Node.js 18+ | https://nodejs.org | Required by Supabase CLI |
| Supabase CLI | `npm install -g supabase` | Deploy DB schema + Edge Functions |
| A Supabase account | https://supabase.com | Database + Auth + Edge Functions |
| A Backblaze account | https://www.backblaze.com | File storage (20 TB for ~$115/month) |
| A Cloudflare account (free) | https://cloudflare.com | CDN + zero egress fees from B2 |
| A Stripe account | https://stripe.com | Payment processing |
| A domain name | Any registrar | Required for Cloudflare |

---

## Step 1 — Supabase project setup

1. Go to https://supabase.com/dashboard → **New project**.
2. Choose a name (e.g. `pixelvault`), set a strong database password, pick the region
   **closest to your majority user base** (affects DB query latency).
3. Wait ~2 minutes for provisioning.
4. Go to **Settings → API** and copy:
   - `Project URL`  → this is your `SUPABASE_URL`
   - `anon / public` key → `SUPABASE_ANON_KEY`
   - `service_role / secret` key → `SUPABASE_SERVICE_ROLE_KEY`

   > ⚠️ The service role key bypasses Row-Level Security. Never put it in frontend code.

5. Open `app.js`, `dashboard.js`, and `success.html` and replace:
   ```
   https://YOUR_PROJECT_REF.supabase.co  →  your Project URL
   YOUR_SUPABASE_ANON_KEY                →  your anon key
   ```

---

## Step 2 — Run the database schema

1. In the Supabase dashboard, go to **SQL Editor → New query**.
2. Open `schema.sql` from this project, copy the entire contents, paste, and click **Run**.
3. You should see: `Success. No rows returned.`
4. Verify in **Table Editor** that these tables exist:
   - `profiles`, `media_assets`, `tags`, `asset_tags`, `purchases`
5. Also run this small helper function (paste into a new SQL query):

```sql
-- Required by get-download-url to safely increment download counts.
CREATE OR REPLACE FUNCTION increment_download_count(asset_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER AS $$
    UPDATE public.media_assets
    SET download_count = download_count + 1
    WHERE id = asset_id;
$$;

-- Required by create-checkout for the upsert on conflict clause.
-- The unique index in schema.sql covers (customer_id, asset_id) WHERE completed,
-- but we also need a plain index for the upsert to work:
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_customer_asset
    ON public.purchases(customer_id, asset_id);
```

---

## Step 3 — Backblaze B2 setup

### 3a. Create a bucket

1. Log into https://www.backblaze.com/b2/buckets.html → **Create a Bucket**.
2. Name: `pixelvault-assets` (or anything — record it as `B2_BUCKET_NAME`).
3. **Files in Bucket**: Private ✓ (presigned URLs handle access — never make it public).
4. Click **Create a Bucket**.

### 3b. Enable S3-Compatible API

1. In B2, go to **Account → App Keys → Add a New Application Key**.
2. Settings:
   - Name: `pixelvault-server`
   - Bucket: Select your bucket (restrict to one bucket for security)
   - Permissions: `Read and Write`
   - File name prefix: leave blank
3. Click **Create New Key** — **copy both values immediately** (the key is shown only once):
   - `keyID` → `B2_KEY_ID`
   - `applicationKey` → `B2_APP_KEY`
4. Note your bucket's **Endpoint** (shown on the Buckets page):
   - It looks like `s3.us-west-004.backblazeb2.com`
   - The region portion (`us-west-004`) → `B2_REGION`

### 3c. Configure CORS on the bucket

B2 requires CORS to be set so browsers can PUT files directly.
Run this from your terminal (replace values):

```bash
# Install the B2 CLI if you don't have it:
pip install b2

# Authorise:
b2 authorize-account <B2_KEY_ID> <B2_APP_KEY>

# Set CORS rules (allows PUT from any origin — tighten in production):
b2 bucket update pixelvault-assets --cors-rules '[
  {
    "corsRuleName":      "allowUploadFromBrowser",
    "allowedOrigins":    ["*"],
    "allowedHeaders":    ["*"],
    "allowedOperations": ["s3_put"],
    "maxAgeSeconds":     3600
  },
  {
    "corsRuleName":      "allowDownloadFromBrowser",
    "allowedOrigins":    ["*"],
    "allowedHeaders":    ["*"],
    "allowedOperations": ["s3_get", "s3_head"],
    "maxAgeSeconds":     3600
  }
]'
```

---

## Step 4 — Cloudflare CDN setup (eliminates B2 egress fees)

Backblaze B2 charges zero egress fees when traffic goes through Cloudflare.
This is critical — without it, serving 20 TB costs ~$1,000/month in egress.

### 4a. Add your domain to Cloudflare

1. In Cloudflare dashboard → **Add a site** → enter your domain.
2. Select the **Free plan** → follow the nameserver change instructions at your registrar.
3. Wait for DNS propagation (up to 48 hours, usually < 1 hour).

### 4b. Create a CNAME for your CDN subdomain

1. In Cloudflare → **DNS → Add record**:
   - Type: `CNAME`
   - Name: `cdn` (creates `cdn.yourdomain.com`)
   - Target: `pixelvault-assets.s3.us-west-004.backblazeb2.com`
   - Proxy status: **Proxied** (orange cloud — this is what eliminates egress fees)
2. Click **Save**.

### 4c. Update CDN_BASE_URL

In `generate-thumbnail/index.ts` (and set as an Edge Function secret):
```
CDN_BASE_URL = https://cdn.yourdomain.com
```

### 4d. Optional: Cloudflare Cache Rules

In Cloudflare → **Caching → Cache Rules → Create rule**:
- Rule name: `Cache B2 assets`
- When: `hostname equals cdn.yourdomain.com`
- Cache status: **Eligible for cache**
- Edge TTL: **1 month** (thumbnails never change after upload)

---

## Step 5 — Stripe setup

### 5a. Get your Stripe keys

1. Log into https://dashboard.stripe.com → **Developers → API Keys**.
2. Copy:
   - **Publishable key** → not needed (we use server-side Checkout)
   - **Secret key** → `STRIPE_SECRET_KEY`

> Use **test mode** keys (`sk_test_...`) during development.
> Switch to live keys (`sk_live_...`) only when ready to charge real money.

### 5b. Register the webhook

1. In Stripe → **Developers → Webhooks → Add endpoint**.
2. Endpoint URL:
   ```
   https://<your-project-ref>.supabase.co/functions/v1/stripe-webhook
   ```
3. Events to listen to (click **Select events**):
   - `checkout.session.completed`
   - `payment_intent.payment_failed`
   - `charge.refunded`
4. Click **Add endpoint** → copy the **Signing secret** → `STRIPE_WEBHOOK_SECRET`

---

## Step 6 — Deploy Edge Functions

### 6a. Link the Supabase CLI to your project

```bash
# In the project root (where supabase/config.toml lives):
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

Your project ref is the subdomain of your Supabase URL:
`https://abcdefghijklm.supabase.co` → ref is `abcdefghijklm`

### 6b. Set all secrets

These are environment variables available inside your Edge Functions.
Run each command in your terminal:

```bash
supabase secrets set SUPABASE_URL="https://YOUR_PROJECT_REF.supabase.co"
supabase secrets set SUPABASE_ANON_KEY="your-anon-key"
supabase secrets set SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

supabase secrets set B2_KEY_ID="your-b2-key-id"
supabase secrets set B2_APP_KEY="your-b2-application-key"
supabase secrets set B2_BUCKET_NAME="pixelvault-assets"
supabase secrets set B2_REGION="us-west-004"

supabase secrets set CDN_BASE_URL="https://cdn.yourdomain.com"
supabase secrets set APP_URL="https://yourdomain.com"
supabase secrets set ALLOWED_ORIGINS="https://yourdomain.com,https://www.yourdomain.com"

supabase secrets set STRIPE_SECRET_KEY="sk_test_..."
supabase secrets set STRIPE_WEBHOOK_SECRET="whsec_..."

# A random secret string for B2 webhook authentication.
# Generate one: openssl rand -hex 32
supabase secrets set THUMBNAIL_WEBHOOK_SECRET="your-random-secret-here"

# Placeholder images for video/RAW files (upload these to your CDN first):
supabase secrets set VIDEO_PLACEHOLDER_URL="https://cdn.yourdomain.com/static/video-placeholder.jpg"
supabase secrets set RAW_PLACEHOLDER_URL="https://cdn.yourdomain.com/static/raw-placeholder.jpg"
```

Verify all secrets are set:
```bash
supabase secrets list
```

### 6c. Deploy all functions

```bash
supabase functions deploy get-upload-url
supabase functions deploy get-download-url
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook
supabase functions deploy generate-thumbnail
```

Or deploy all at once:
```bash
supabase functions deploy
```

---

## Step 7 — Configure Supabase Auth

1. In Supabase dashboard → **Authentication → URL Configuration**:
   - **Site URL**: `https://yourdomain.com`
   - **Redirect URLs**: Add `https://yourdomain.com/success.html`
2. **Authentication → Email Templates**: Customise the confirmation email
   to match your brand (optional but recommended).
3. **Authentication → Providers**: Email is enabled by default. Enable Google/GitHub
   OAuth later if desired (requires extra setup).

---

## Step 8 — Deploy the frontend

The frontend is 100% static HTML/CSS/JS — it can be hosted anywhere:

### Option A: Cloudflare Pages (recommended — free, fast, CDN-native)

```bash
# Install Wrangler:
npm install -g wrangler

# From your project root:
wrangler pages project create pixelvault
wrangler pages deploy . --project-name=pixelvault
```

### Option B: Any static host (Netlify, Vercel, GitHub Pages, S3)

Upload these files:
- `index.html`
- `app.js`
- `dashboard.html`
- `dashboard.js`
- `success.html`

No build step needed — they run as-is in the browser.

---

## Step 9 — B2 Event Notifications for thumbnail generation

This makes thumbnails generate automatically the moment an upload completes.

1. In B2 → **Buckets → pixelvault-assets → Event Notifications → Add Rule**:
   - Rule name: `generate-thumbnail-on-upload`
   - Event types: `b2:ObjectCreated:*`
   - Prefix filter: `assets/`
   - Target URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/generate-thumbnail`
   - Custom headers: `X-Webhook-Secret: <your THUMBNAIL_WEBHOOK_SECRET>`
2. Click **Save Rule**.

> Until B2 Event Notifications are configured, you can also trigger thumbnail
> generation manually from `dashboard.js` by calling the Edge Function directly
> after `uploadToB2()` completes. See the comment in `dashboard.js` → `uploadAll()`.

---

## Step 10 — Admin: Approving uploaded assets

Assets start with `status = 'pending'` and are invisible to the public gallery
until approved. You have two options:

### Option A: Manual approval via Supabase SQL Editor

```sql
-- Approve a specific asset:
UPDATE public.media_assets SET status = 'active' WHERE id = 'asset-uuid-here';

-- Approve all pending assets from a trusted photographer:
UPDATE public.media_assets
SET status = 'active'
WHERE photographer_id = 'photographer-uuid-here' AND status = 'pending';
```

### Option B: Auto-approve for testing (change in generate-thumbnail/index.ts)

Find this line in `generate-thumbnail/index.ts`:
```typescript
status: 'pending',
```
Change it to:
```typescript
status: 'active',
```
Then redeploy: `supabase functions deploy generate-thumbnail`

> Revert to `'pending'` before going live to prevent unreviewed content from appearing.

---

## Environment Variables Quick Reference

| Variable | Where it's used | Where to get it |
|---|---|---|
| `SUPABASE_URL` | All Edge Functions + frontend | Supabase Dashboard → Settings → API |
| `SUPABASE_ANON_KEY` | Frontend JS files | Supabase Dashboard → Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Functions only | Supabase Dashboard → Settings → API |
| `B2_KEY_ID` | get-upload-url, get-download-url, generate-thumbnail | B2 → App Keys |
| `B2_APP_KEY` | Same as above | B2 → App Keys (shown once on creation) |
| `B2_BUCKET_NAME` | Same as above | B2 → Buckets |
| `B2_REGION` | Same as above | B2 → Buckets endpoint URL |
| `CDN_BASE_URL` | generate-thumbnail, app.js | Your Cloudflare CDN subdomain |
| `APP_URL` | create-checkout (Stripe redirect URLs) | Your deployed frontend URL |
| `ALLOWED_ORIGINS` | _shared/b2-sign.ts CORS | Your frontend domain(s) |
| `STRIPE_SECRET_KEY` | create-checkout | Stripe Dashboard → Developers |
| `STRIPE_WEBHOOK_SECRET` | stripe-webhook | Stripe Dashboard → Webhooks |
| `THUMBNAIL_WEBHOOK_SECRET` | generate-thumbnail | Generate with: `openssl rand -hex 32` |
| `VIDEO_PLACEHOLDER_URL` | generate-thumbnail | Upload a placeholder image to your CDN |
| `RAW_PLACEHOLDER_URL` | generate-thumbnail | Upload a placeholder image to your CDN |

---

## File Structure Reference

```
pixelvault/
├── index.html                          # Public gallery homepage
├── app.js                              # Core app: auth, grid, modal, upload helpers
├── dashboard.html                      # Photographer dashboard
├── dashboard.js                        # Dashboard logic: upload, stats, assets table
├── success.html                        # Post-Stripe-payment download page
├── schema.sql                          # Run once in Supabase SQL Editor
└── supabase/
    ├── config.toml                     # Supabase CLI config
    └── functions/
        ├── _shared/
        │   └── b2-sign.ts             # Shared SigV4 signing + auth helpers
        ├── get-upload-url/
        │   └── index.ts               # Issues presigned B2 PUT URLs
        ├── get-download-url/
        │   └── index.ts               # Issues presigned B2 GET URLs after auth check
        ├── create-checkout/
        │   └── index.ts               # Creates Stripe Checkout sessions
        ├── stripe-webhook/
        │   └── index.ts               # Handles Stripe payment events
        └── generate-thumbnail/
            └── index.ts               # Resizes + watermarks images after upload
```

---

## Testing Checklist

Before going live, verify each flow works end-to-end:

### Auth
- [ ] Sign up as a Customer → confirmation email arrives → can log in
- [ ] Sign up as a Photographer → can access dashboard
- [ ] Log out → nav switches back to logged-out state
- [ ] Refresh page → session persists (stays logged in)

### Upload flow
- [ ] Photographer can drag a JPEG onto the drop zone → appears in queue
- [ ] Metadata form appears after file is queued
- [ ] "Upload all" triggers presigned URL request → progress bar moves → done
- [ ] Asset appears in "My Assets" table with status `pending`
- [ ] Approve the asset in SQL Editor → it appears on the homepage grid
- [ ] Thumbnail loads in the grid (confirm B2 event notification fired)

### Purchase flow (use Stripe test card: 4242 4242 4242 4242)
- [ ] Click "Buy" on a paid asset → redirected to Stripe Checkout
- [ ] Complete payment → redirected to success.html
- [ ] success.html shows "Payment successful" → download starts automatically
- [ ] File downloads correctly and opens in the appropriate app

### Free download
- [ ] Click "Download Free" on a $0 asset while logged in → download starts
- [ ] Click "Download Free" while NOT logged in → auth modal appears

### Security
- [ ] Try to access `cdn.yourdomain.com/assets/.../original.jpg` directly → should fail (403)
  (Only presigned URLs with expiry work — direct access is blocked by B2 bucket being private)
- [ ] Try to call `get-upload-url` without a JWT → 401
- [ ] Try to call `get-download-url` for a paid asset you haven't bought → 403

---

## Cost Estimate at 20 TB scale

| Service | Cost |
|---|---|
| Backblaze B2 storage (20 TB) | ~$115/month |
| Backblaze B2 egress via Cloudflare | $0/month (Bandwidth Alliance) |
| Supabase Pro (required for Edge Functions in prod) | $25/month |
| Cloudflare Free tier | $0/month |
| Stripe | 2.9% + $0.30 per transaction |
| **Total fixed costs** | **~$140/month** |

Compare: AWS S3 + CloudFront for 20 TB = ~$1,800/month in storage + egress.

---

## Common Issues

**"CORS error when uploading"**
→ Check the B2 CORS rules in Step 3c. The `allowedOrigins` must include your
frontend URL, or use `["*"]` during development.

**"Thumbnail not appearing after upload"**
→ Check the B2 Event Notifications are set up (Step 9). Alternatively, call
`generate-thumbnail` manually from your browser console:
```js
await supabase.functions.invoke('generate-thumbnail', { body: { assetId: 'your-uuid' } });
```

**"Stripe webhook returning 400"**
→ The most common cause is a wrong `STRIPE_WEBHOOK_SECRET`. Stripe CLI lets you
test webhooks locally: `stripe listen --forward-to localhost:54321/functions/v1/stripe-webhook`

**"Asset stuck in pending"**
→ Run the SQL in Step 10 to manually approve it, or check that generate-thumbnail
ran successfully (look in Supabase → Edge Functions → Logs).

**"Sign up succeeds but profile row doesn't appear"**
→ The `on_auth_user_created` trigger may have failed. Check Supabase →
Database → Triggers to confirm `on_auth_user_created` exists on `auth.users`.
