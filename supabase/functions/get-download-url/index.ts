// =============================================================================
// Supabase Edge Function: get-download-url
// =============================================================================
// Called by app.js when a logged-in user clicks "Download Free" or after a
// successful Stripe payment redirects them back to the site.
//
// Security model:
//   - The original high-resolution B2 file URL is NEVER embedded in any HTML.
//   - Every download requires a server-issued signed URL that expires in 5 min.
//   - For paid assets, this function checks the purchases table before signing.
//   - Signing is done using AWS SigV4 (B2's S3-compatible presigned GET URL).
//
// Deploy:  supabase functions deploy get-download-url
// Secrets: same as get-upload-url (B2_KEY_ID, B2_APP_KEY, B2_BUCKET_NAME)
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { crypto }       from 'https://deno.land/std@0.177.0/crypto/mod.ts';

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'https://yourdomain.com',
];

function corsHeaders(origin: string | null) {
    const allowed = ALLOWED_ORIGINS.includes(origin ?? '') ? origin! : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-client-info, apikey',
    };
}

// ---------------------------------------------------------------------------
// AWS SigV4 presigned GET URL for B2
// Mirrors the signing logic in get-upload-url but uses GET + Content-Disposition.
// ---------------------------------------------------------------------------
const B2_REGION = 'us-west-004';

async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(s: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
}

/**
 * Generates a presigned GET URL for downloading a B2 object.
 * The URL is valid for `expiresIn` seconds (default 300 = 5 minutes).
 *
 * @param objectKey       B2 object key (the cdn_key column from media_assets)
 * @param downloadFileName The filename the browser will suggest when saving
 * @param expiresIn       Seconds until the URL expires
 */
async function generatePresignedGetUrl(
    objectKey:        string,
    downloadFileName: string,
    expiresIn = 300
): Promise<string> {
    const keyId  = Deno.env.get('B2_KEY_ID')!;
    const appKey = Deno.env.get('B2_APP_KEY')!;
    const bucket = Deno.env.get('B2_BUCKET_NAME')!;

    const now       = new Date();
    const date      = now.toISOString().slice(0, 10).replace(/-/g, '');
    const time      = now.toISOString().slice(11, 19).replace(/:/g, '');
    const datetime  = `${date}T${time}Z`;
    const credScope = `${date}/${B2_REGION}/s3/aws4_request`;

    // response-content-disposition makes the browser download the file with
    // the correct filename instead of rendering it in a new tab.
    const disposition = `attachment; filename="${encodeURIComponent(downloadFileName)}"`;

    const qp = new URLSearchParams({
        'X-Amz-Algorithm':                   'AWS4-HMAC-SHA256',
        'X-Amz-Credential':                  `${keyId}/${credScope}`,
        'X-Amz-Date':                        datetime,
        'X-Amz-Expires':                     String(expiresIn),
        'X-Amz-SignedHeaders':               'host',
        'response-content-disposition':      disposition,
    });
    qp.sort();

    const host            = `${bucket}.s3.${B2_REGION}.backblazeb2.com`;
    const canonicalUri    = '/' + encodeURIComponent(objectKey).replace(/%2F/g, '/');
    const canonicalQS     = qp.toString();
    const canonicalHeaders= `host:${host}\n`;

    const canonicalRequest = [
        'GET', canonicalUri, canonicalQS, canonicalHeaders, 'host', 'UNSIGNED-PAYLOAD'
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256', datetime, credScope, await sha256hex(canonicalRequest)
    ].join('\n');

    const enc      = (s: string) => new TextEncoder().encode(s);
    const kSecret  = enc(`AWS4${appKey}`);
    const kDate    = await hmacSha256(kSecret,   date);
    const kRegion  = await hmacSha256(kDate,     B2_REGION);
    const kService = await hmacSha256(kRegion,   's3');
    const kSigning = await hmacSha256(kService,  'aws4_request');
    const sig      = toHex(await hmacSha256(kSigning, stringToSign));

    return `https://${host}${canonicalUri}?${canonicalQS}&X-Amz-Signature=${sig}`;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req: Request) => {
    const origin = req.headers.get('origin');
    const cors   = corsHeaders(origin);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (req.method !== 'POST')    return new Response('Method not allowed', { status: 405, headers: cors });

    const json = (data: unknown, status = 200) =>
        new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    try {
        // ── 1. Authenticate ─────────────────────────────────────────────────
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) return json({ error: 'Missing Authorization header' }, 401);

        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            { auth: { persistSession: false } }
        );
        const supabaseUser = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
        );

        const { data: { user }, error: userErr } = await supabaseUser.auth.getUser();
        if (userErr || !user) return json({ error: 'Invalid or expired token' }, 401);

        // ── 2. Parse request ─────────────────────────────────────────────────
        const { assetId } = await req.json() as { assetId: string };
        if (!assetId) return json({ error: 'assetId is required' }, 400);

        // ── 3. Fetch the asset row ───────────────────────────────────────────
        const { data: asset, error: assetErr } = await supabaseAdmin
            .from('media_assets')
            .select('id, title, cdn_key, price_cents, mime_type, status, is_deleted, photographer_id')
            .eq('id', assetId)
            .single();

        if (assetErr || !asset) return json({ error: 'Asset not found' }, 404);
        if (asset.status !== 'active') return json({ error: 'Asset is not available for download' }, 403);
        if (asset.is_deleted)          return json({ error: 'Asset has been removed' }, 404);

        // ── 4. Authorise the download ────────────────────────────────────────
        const isOwner = asset.photographer_id === user.id;
        const isFree  = asset.price_cents === 0;

        if (!isOwner && !isFree) {
            // Paid asset — verify the user has a completed purchase.
            const { data: purchase, error: purchaseErr } = await supabaseAdmin
                .from('purchases')
                .select('id, status')
                .eq('customer_id', user.id)
                .eq('asset_id', assetId)
                .eq('status', 'completed')
                .maybeSingle();

            if (purchaseErr || !purchase) {
                return json({ error: 'Purchase required to download this asset' }, 403);
            }

            // Log the download — increment counter and record timestamp.
            await supabaseAdmin
                .from('purchases')
                .update({
                    last_downloaded_at: new Date().toISOString(),
                    download_count:     purchase.download_count + 1,
                })
                .eq('id', purchase.id);
        }

        // ── 5. Increment the asset's global download_count ───────────────────
        await supabaseAdmin.rpc('increment_download_count', { asset_id: assetId });
        // Note: create this RPC in Supabase SQL editor:
        //   CREATE OR REPLACE FUNCTION increment_download_count(asset_id UUID)
        //   RETURNS VOID LANGUAGE SQL AS $$
        //     UPDATE media_assets SET download_count = download_count + 1 WHERE id = asset_id;
        //   $$;

        // ── 6. Generate a signed download URL (5-minute expiry) ──────────────
        const ext          = getExtension(asset.mime_type);
        const safeTitle    = asset.title.replace(/[^a-zA-Z0-9 ._-]/g, '').trim();
        const downloadName = `${safeTitle}.${ext}`;

        const signedUrl = await generatePresignedGetUrl(asset.cdn_key, downloadName, 300);

        return json({ signedUrl, fileName: downloadName });

    } catch (err) {
        console.error('get-download-url error:', err);
        return json({ error: 'Internal server error' }, 500);
    }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function getExtension(mime: string): string {
    const map: Record<string, string> = {
        'image/jpeg':     'jpg',
        'image/png':      'png',
        'image/webp':     'webp',
        'image/tiff':     'tif',
        'image/x-raw':    'raw',
        'video/mp4':      'mp4',
        'video/quicktime':'mov',
    };
    return map[mime] ?? 'bin';
}
