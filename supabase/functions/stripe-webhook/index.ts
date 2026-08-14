// =============================================================================
// Supabase Edge Function: stripe-webhook
// =============================================================================
// Receives POST requests from Stripe's webhook system and acts on payment events.
//
// Events handled:
//   checkout.session.completed  → Mark purchase 'completed', unlock download.
//   payment_intent.payment_failed → Mark purchase 'failed', notify (optional).
//   charge.refunded              → Mark purchase 'refunded', revoke download access.
//
// Security:
//   Every request is verified using the Stripe-Signature header and your
//   webhook signing secret. A forged request without the correct HMAC-SHA256
//   signature is rejected before any DB writes happen.
//
// Deploy:  supabase functions deploy stripe-webhook
// Register: Stripe Dashboard → Developers → Webhooks → Add endpoint
//   URL: https://<project-ref>.supabase.co/functions/v1/stripe-webhook
//   Events: checkout.session.completed, payment_intent.payment_failed, charge.refunded
//
// Secrets needed:
//   STRIPE_SECRET_KEY      — your Stripe secret key (sk_live_... or sk_test_...)
//   STRIPE_WEBHOOK_SECRET  — signing secret from the Stripe webhook dashboard (whsec_...)
// =============================================================================

import { serve }     from 'https://deno.land/std@0.177.0/http/server.ts';
import Stripe        from 'https://esm.sh/stripe@14.21.0?target=deno&no-check';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Stripe webhooks never need CORS — they come from Stripe's servers, not a browser.
// We respond with plain text to keep the response tiny.
function ok()  { return new Response('ok',    { status: 200 }); }
function err(msg: string, status = 400) {
    console.error(`stripe-webhook: ${msg}`);
    return new Response(msg, { status });
}

serve(async (req: Request) => {
    if (req.method !== 'POST') return err('Method not allowed', 405);

    // ── 1. Verify the Stripe signature ───────────────────────────────────────
    // This is the most important security check. Without it, anyone could POST
    // a fake "payment succeeded" event and get free downloads.
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
        apiVersion: '2024-06-20',
        httpClient: Stripe.createFetchHttpClient(),
    });

    const signature    = req.headers.get('stripe-signature');
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!;

    if (!signature) return err('Missing Stripe-Signature header', 400);

    // We must read the body as raw bytes for signature verification — once you
    // call req.json() the raw body is consumed and verification will always fail.
    const rawBody = await req.arrayBuffer();
    const bodyStr = new TextDecoder().decode(rawBody);

    let event: Stripe.Event;
    try {
        // constructEventAsync is the Deno-compatible version (uses Web Crypto API).
        event = await stripe.webhooks.constructEventAsync(bodyStr, signature, webhookSecret);
    } catch (e) {
        return err(`Webhook signature verification failed: ${(e as Error).message}`, 400);
    }

    // ── 2. Set up a service-role Supabase client ─────────────────────────────
    // The service role bypasses RLS — safe here because we're running server-side
    // code verified via Stripe's signature.
    const supabase = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { auth: { persistSession: false } }
    );

    // ── 3. Route to the correct handler ─────────────────────────────────────
    try {
        switch (event.type) {

            // ----------------------------------------------------------------
            // PAYMENT SUCCEEDED
            // This is the primary event. Stripe fires it after the customer
            // completes the checkout flow and payment is confirmed.
            // ----------------------------------------------------------------
            case 'checkout.session.completed': {
                const session = event.data.object as Stripe.Checkout.Session;

                // Pull the IDs we embedded in the session metadata during create-checkout.
                const assetId    = session.metadata?.asset_id;
                const customerId = session.metadata?.customer_id;  // Supabase user UUID
                const paymentIntentId = session.payment_intent as string;

                if (!assetId || !customerId) {
                    console.warn('checkout.session.completed missing metadata', session.id);
                    return ok(); // Return 200 so Stripe doesn't retry — this is our data issue.
                }

                // Fetch the asset price for the audit record.
                const { data: asset } = await supabase
                    .from('media_assets')
                    .select('price_cents')
                    .eq('id', assetId)
                    .single();

                // Upsert the purchase row.
                // We upsert (not insert) because create-checkout may have already
                // inserted a 'pending' row. The unique index on (customer_id, asset_id)
                // WHERE status='completed' prevents double-completion.
                const { error: upsertErr } = await supabase
                    .from('purchases')
                    .upsert(
                        {
                            customer_id:       customerId,
                            asset_id:          assetId,
                            amount_paid_cents: asset?.price_cents ?? (session.amount_total ?? 0),
                            stripe_payment_id: paymentIntentId,
                            status:            'completed',
                        },
                        {
                            // Match on these two columns to update the existing pending row.
                            onConflict:       'customer_id,asset_id',
                            ignoreDuplicates: false,
                        }
                    );

                if (upsertErr) {
                    console.error('Failed to upsert purchase:', upsertErr.message);
                    // Return 500 so Stripe retries in a few minutes.
                    return err('DB write failed', 500);
                }

                console.log(`✓ Purchase completed: customer=${customerId} asset=${assetId}`);
                break;
            }

            // ----------------------------------------------------------------
            // PAYMENT FAILED
            // The card was declined or the session expired.
            // We update the pending row to 'failed' so dashboard queries don't
            // return stale 'pending' rows forever.
            // ----------------------------------------------------------------
            case 'payment_intent.payment_failed': {
                const pi = event.data.object as Stripe.PaymentIntent;

                const { error: updateErr } = await supabase
                    .from('purchases')
                    .update({ status: 'failed' })
                    .eq('stripe_payment_id', pi.id)
                    .eq('status', 'pending');   // Only update if still pending

                if (updateErr) {
                    console.error('Failed to mark purchase as failed:', updateErr.message);
                }

                console.log(`✗ Payment failed: payment_intent=${pi.id}`);
                break;
            }

            // ----------------------------------------------------------------
            // REFUND ISSUED
            // Either via Stripe dashboard or a future /refund endpoint.
            // Marking the purchase 'refunded' causes the download check in
            // get-download-url to return 403, revoking access to the file.
            // ----------------------------------------------------------------
            case 'charge.refunded': {
                const charge = event.data.object as Stripe.Charge;
                const pi     = charge.payment_intent as string;

                if (!pi) break;

                const { error: refundErr } = await supabase
                    .from('purchases')
                    .update({ status: 'refunded' })
                    .eq('stripe_payment_id', pi)
                    .eq('status', 'completed');

                if (refundErr) {
                    console.error('Failed to mark purchase as refunded:', refundErr.message);
                }

                console.log(`↩ Refund processed: payment_intent=${pi}`);
                break;
            }

            // ----------------------------------------------------------------
            // Unhandled events — log and return 200 so Stripe stops retrying.
            // Never return a non-200 for an unrecognised event type.
            // ----------------------------------------------------------------
            default:
                console.log(`Unhandled event type: ${event.type}`);
        }

        return ok();

    } catch (handlerErr) {
        console.error('Webhook handler threw:', handlerErr);
        // Return 500 so Stripe retries — something unexpected went wrong.
        return err('Internal handler error', 500);
    }
});
