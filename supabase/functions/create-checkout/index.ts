// =============================================================================
// Supabase Edge Function: create-checkout
// =============================================================================
// Called by app.js when a logged-in user clicks "Buy" on a paid asset.
//
// Flow:
//   1. Authenticate the caller (must be logged in, any role).
//   2. Fetch the asset from DB — confirm it's active and has a price > 0.
//   3. Check the customer hasn't already bought this asset (idempotency).
//   4. Create (or retrieve) a Stripe Customer object tied to profiles.stripe_customer_id.
//   5. Create a Stripe Checkout Session in "payment" mode.
//   6. Insert a 'pending' purchase row so we can match the webhook later.
//   7. Return the Stripe-hosted checkout URL to the browser.
//
// The browser redirects to Stripe's hosted page — we never handle card data.
// After payment Stripe redirects to /success.html?session_id=... and fires
// a webhook to our stripe-webhook Edge Function which marks the purchase complete.
//
// Deploy:  supabase functions deploy create-checkout
// Secrets: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (set in Supabase dashboard)
// =============================================================================

import { serve }     from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe        from 'https://esm.sh/stripe@14.21.0?target=deno&no-check';
import { corsHeaders, jsonResponse, requireAuth } from '../_shared/b2-sign.ts';

serve(async (req: Request) => {
    const origin = req.headers.get('origin');

    // CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (req.method !== 'POST') {
        return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }

    try {
        // ── 1. Authenticate ──────────────────────────────────────────────────
        const { user, supabaseAdmin } = await requireAuth(req, origin);

        // ── 2. Parse request body ────────────────────────────────────────────
        const { assetId } = await req.json() as { assetId: string };
        if (!assetId) return jsonResponse({ error: 'assetId is required' }, 400, origin);

        // ── 3. Fetch the asset ───────────────────────────────────────────────
        const { data: asset, error: assetErr } = await supabaseAdmin
            .from('media_assets')
            .select('id, title, price_cents, thumbnail_url, status, is_deleted, license_type')
            .eq('id', assetId)
            .single();

        if (assetErr || !asset) {
            return jsonResponse({ error: 'Asset not found' }, 404, origin);
        }
        if (asset.status !== 'active' || asset.is_deleted) {
            return jsonResponse({ error: 'Asset is not available for purchase' }, 403, origin);
        }
        if (asset.price_cents <= 0) {
            return jsonResponse({ error: 'This asset is free — use the download endpoint instead' }, 400, origin);
        }

        // ── 4. Idempotency check — don't create a second session for the same purchase ──
        const { data: existingPurchase } = await supabaseAdmin
            .from('purchases')
            .select('id, status, stripe_payment_id')
            .eq('customer_id', user.id)
            .eq('asset_id', assetId)
            .eq('status', 'completed')
            .maybeSingle();

        if (existingPurchase) {
            // Already purchased — send them straight to the download.
            return jsonResponse({
                alreadyPurchased: true,
                message:          'You already own this asset.',
            }, 200, origin);
        }

        // ── 5. Fetch / create the Stripe Customer ────────────────────────────
        const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
            apiVersion: '2024-06-20',
            httpClient: Stripe.createFetchHttpClient(),
        });

        // Fetch the profile to get the existing stripe_customer_id (if any).
        const { data: profile } = await supabaseAdmin
            .from('profiles')
            .select('stripe_customer_id, display_name')
            .eq('id', user.id)
            .single();

        let stripeCustomerId = profile?.stripe_customer_id;

        if (!stripeCustomerId) {
            // First time checkout — create a Stripe Customer so receipts and
            // future purchases are linked to the same customer object.
            const customer = await stripe.customers.create({
                email:    user.email,
                name:     profile?.display_name ?? undefined,
                metadata: { supabase_user_id: user.id },
            });
            stripeCustomerId = customer.id;

            // Persist the Stripe Customer ID so we reuse it next time.
            await supabaseAdmin
                .from('profiles')
                .update({ stripe_customer_id: stripeCustomerId })
                .eq('id', user.id);
        }

        // ── 6. Create the Stripe Checkout Session ────────────────────────────
        const appUrl = Deno.env.get('APP_URL') ?? 'http://localhost:5500';

        const session = await stripe.checkout.sessions.create({
            customer:    stripeCustomerId,
            mode:        'payment',
            line_items: [{
                quantity: 1,
                price_data: {
                    currency:     'usd',
                    unit_amount:  asset.price_cents,   // Already in cents
                    product_data: {
                        name:        asset.title,
                        description: `${asset.license_type} license`,
                        // Show the asset thumbnail inside Stripe's checkout page.
                        images: asset.thumbnail_url ? [asset.thumbnail_url] : [],
                        metadata: { asset_id: asset.id },
                    },
                },
            }],
            // Stripe appends ?session_id={CHECKOUT_SESSION_ID} automatically.
            success_url: `${appUrl}/success.html?session_id={CHECKOUT_SESSION_ID}&asset_id=${asset.id}`,
            cancel_url:  `${appUrl}/index.html?cancelled=1`,
            // Allow the customer to save their card for future purchases.
            payment_intent_data: {
                metadata: {
                    asset_id:    asset.id,
                    customer_id: user.id,       // Supabase user UUID — used by webhook
                },
            },
            metadata: {
                asset_id:    asset.id,
                customer_id: user.id,
            },
            // Automatically apply tax rates based on buyer location (requires
            // Stripe Tax to be enabled in the dashboard — safe to remove if not set up).
            automatic_tax: { enabled: false },
        });

        // ── 7. Pre-create a 'pending' purchase row ───────────────────────────
        // We create it now rather than waiting for the webhook so there's a
        // record even if the webhook is delayed. The webhook updates status to
        // 'completed'. A nightly cleanup job can delete rows stuck in 'pending'
        // for > 24 hours (implement as a pg_cron job in Supabase).
        const { error: purchaseErr } = await supabaseAdmin
            .from('purchases')
            .insert({
                customer_id:        user.id,
                asset_id:           asset.id,
                amount_paid_cents:  asset.price_cents,
                stripe_payment_id:  session.payment_intent as string,
                status:             'pending',
            });

        if (purchaseErr) {
            // Non-fatal — the webhook will upsert the row anyway.
            console.warn('Pre-insert purchase row failed:', purchaseErr.message);
        }

        // ── 8. Return the hosted checkout URL ────────────────────────────────
        return jsonResponse({ checkoutUrl: session.url }, 200, origin);

    } catch (err) {
        console.error('create-checkout error:', err);
        // Don't expose raw Stripe errors to the client.
        return jsonResponse({ error: 'Could not create checkout session. Please try again.' }, 500, origin);
    }
});
