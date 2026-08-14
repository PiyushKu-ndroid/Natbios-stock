// =============================================================================
// Supabase Edge Function: get-upload-url
// =============================================================================
// Called by dashboard.js before each file upload.
//
// What this function does (in order):
//   1. Authenticates the caller using the Supabase JWT in the Authorization header.
//   2. Confirms the caller's profile role is 'photographer'.
//   3. Requests a presigned PUT URL from Backblaze B2's S3-compatible API.
//   4. INSERTs a 'pending' media_assets row in Postgres so the DB record exists
//      before bytes start flowing to B2.
//   5. Returns the presigned URL + the new asset UUID to the browser.
//
// The browser then PUTs the raw file bytes directly to B2 — this function
// never buffers the file, so it runs well within Deno's memory limits even
// for 4 GB uploads.
//
// Deploy:  supabase functions deploy get-upload-url
// Secrets: supabase secrets set B2_KEY_ID=... B2_APP_KEY=... B2_BUCKET_ID=...
//          B2_BUCKET_NAME=... CDN_BASE_URL=...
// =============================================================================

import { createClient }    from 'https://esm.sh/@supabase/supabase-js@2';
import { serve }           from 'https://deno.land/std@0.177.0/http/server.ts';
import { crypto }          from 'https://deno.land/std@0.177.0/crypto/mod.ts';

// ---------------------------------------------------------------------------
// CORS headers — allow requests from your production domain AND localhost.
// Adjust ALLOWED_ORIGINS for your real domain before going live.
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = [
    'http://localhost:3000',
    'http://127.0.0.1:3000',
    'http://localhost:5500',         // VS Code Live Server default
    'http://127.0.0.1:5500',
    'https://yourdomain.com',        // ← Replace with your real domain
];

function corsHeaders(origin: string | null): Record<string, string> {
    const allowed = ALLOWED_ORIGINS.includes(origin ?? '') ? origin! : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age':       '86400',
    };
}

// ---------------------------------------------------------------------------
// B2 S3-Compatible presigned URL generator
//
// Backblaze B2 supports the AWS Signature Version 4 signing process on its
// S3-compatible endpoint. We implement the signing manually here because there
// is no official AWS SDK for Deno, and the signing algorithm is straightforward
// enough to implement directly.
//
// Reference: https://www.backblaze.com/docs/cloud-storage-s3-compatible-api
// ---------------------------------------------------------------------------

const B2_REGION      = 'us-west-004';    // Your B2 bucket's region
const B2_ENDPOINT    = `https://s3.${B2_REGION}.backblazeb2.com`;

/** Returns a hex-encoded SHA-256 HMAC of `data` using `key`. */
async function hmacSha256(key: ArrayBuffer, data: string): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

/** Returns hex string from an ArrayBuffer. */
function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** Returns SHA-256 hex hash of a string. */
async function sha256hex(str: string): Promise<string> {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return toHex(buf);
}

/**
 * Generates a presigned PUT URL valid for 15 minutes.
 * The browser POSTs this URL with the raw file bytes — no auth header needed
 * because the credentials are embedded in the query string by the signature.
 *
 * @param objectKey    - B2 object key, e.g. "assets/uuid/original.jpg"
 * @param contentType  - MIME type of the file
 * @param expiresIn    - Seconds the URL remains valid (max 604800 = 7 days)
 */
async function generatePresignedPutUrl(
    objectKey:   string,
    contentType: string,
    expiresIn = 900          // 15 minutes — enough for a 4 GB upload on a fast line
): Promise<string> {
    const keyId     = Deno.env.get('B2_KEY_ID')!;
    const appKey    = Deno.env.get('B2_APP_KEY')!;
    const bucket    = Deno.env.get('B2_BUCKET_NAME')!;

    const now    = new Date();
    const date   = now.toISOString().slice(0, 10).replace(/-/g, '');    // YYYYMMDD
    const time   = now.toISOString().slice(11, 19).replace(/:/g, '');   // HHmmss
    const datetime = `${date}T${time}Z`;

    const credentialScope = `${date}/${B2_REGION}/s3/aws4_request`;
    const credential      = `${keyId}/${credentialScope}`;

    // Build the canonical query string (parameters MUST be sorted alphabetically).
    const queryParams = new URLSearchParams({
        'X-Amz-Algorithm':     'AWS4-HMAC-SHA256',
        'X-Amz-Credential':    credential,
        'X-Amz-Date':          datetime,
        'X-Amz-Expires':       String(expiresIn),
        'X-Amz-SignedHeaders': 'host',
    });

    // Sort is required by the spec.
    queryParams.sort();
    const canonicalQueryString = queryParams.toString();

    const host             = `${bucket}.s3.${B2_REGION}.backblazeb2.com`;
    const canonicalUri     = '/' + encodeURIComponent(objectKey).replace(/%2F/g, '/');
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders    = 'host';

    // For presigned URLs, the payload hash is always this literal string.
    const payloadHash = 'UNSIGNED-PAYLOAD';

    const canonicalRequest = [
        'PUT',
        canonicalUri,
        canonicalQueryString,
        canonicalHeaders,
        signedHeaders,
        payloadHash,
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        datetime,
        credentialScope,
        await sha256hex(canonicalRequest),
    ].join('\n');

    // Derive the signing key using the standard AWS SigV4 key derivation.
    const enc     = (s: string) => new TextEncoder().encode(s);
    const kSecret  = enc(`AWS4${appKey}`);
    const kDate    = await hmacSha256(kSecret,                    date);
    const kRegion  = await hmacSha256(kDate,                      B2_REGION);
    const kService = await hmacSha256(kRegion,                    's3');
    const kSigning = await hmacSha256(kService,                   'aws4_request');
    const signature = toHex(await hmacSha256(kSigning,            stringToSign));

    return [
        `${B2_ENDPOINT}/${bucket}/${canonicalUri}`,
        '?',
        canonicalQueryString,
        `&X-Amz-Signature=${signature}`,
    ].join('');
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------
serve(async (req: Request) => {
    const origin = req.headers.get('origin');
    const cors   = corsHeaders(origin);

    // Handle CORS preflight (browser sends OPTIONS before the real POST).
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: cors });
    }

    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405, headers: cors });
    }

    try {
        // ── 1. Authenticate the caller ──────────────────────────────────────
        // The browser sends its Supabase session JWT in the Authorization header.
        const authHeader = req.headers.get('Authorization');
        if (!authHeader) {
            return new Response(JSON.stringify({ error: 'Missing Authorization header' }),
                { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // Create a Supabase client using the SERVICE ROLE key so we can write to
        // media_assets without being blocked by RLS (the insert policy requires
        // the JWT user to be a photographer, but we want to do extra validation
        // server-side first).
        const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
            { auth: { persistSession: false } }
        );

        // Use the ANON client with the user's JWT to resolve their identity.
        const supabaseUser = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
        );

        const { data: { user }, error: userError } = await supabaseUser.auth.getUser();
        if (userError || !user) {
            return new Response(JSON.stringify({ error: 'Invalid or expired token' }),
                { status: 401, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // ── 2. Confirm the user is a photographer ───────────────────────────
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role')
            .eq('id', user.id)
            .single();

        if (profileError || profile?.role !== 'photographer') {
            return new Response(JSON.stringify({ error: 'Only photographers can upload.' }),
                { status: 403, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // ── 3. Parse and validate the request body ──────────────────────────
        const body = await req.json() as {
            fileName:     string;
            fileSize:     number;
            mimeType:     string;
            title:        string;
            description?: string;
            price_cents:  number;
            license_type: string;
            tags?:        string[];
        };

        const { fileName, fileSize, mimeType, title, description, price_cents, license_type, tags } = body;

        if (!fileName || !mimeType || !title) {
            return new Response(JSON.stringify({ error: 'fileName, mimeType, and title are required.' }),
                { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // Enforce a 4 GB file size ceiling server-side.
        const MAX_BYTES = 4 * 1024 * 1024 * 1024;
        if (fileSize > MAX_BYTES) {
            return new Response(JSON.stringify({ error: 'File exceeds the 4 GB limit.' }),
                { status: 400, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // Derive the asset_type enum from the MIME type.
        const assetType = mimeType.startsWith('video/')      ? 'video'
                        : mimeType === 'image/x-raw'          ? 'raw'
                        : 'photo';

        // ── 4. Generate a unique object key for B2 ──────────────────────────
        // Pattern: assets/<photographer_id>/<uuid>/<sanitised_filename>
        // Nesting under photographer_id makes per-user B2 lifecycle rules easy.
        const assetId      = crypto.randomUUID();
        const safeName     = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const cdnKey       = `assets/${user.id}/${assetId}/${safeName}`;
        const cdnBase      = Deno.env.get('CDN_BASE_URL')!;

        // ── 5. Generate the presigned PUT URL ───────────────────────────────
        const uploadUrl = await generatePresignedPutUrl(cdnKey, mimeType, 900);

        // ── 6. Create the media_assets DB row immediately ───────────────────
        // We create it NOW (before upload) so:
        //   a) The asset UUID is stable regardless of upload outcome.
        //   b) A crashed upload leaves a 'pending' row we can detect and clean up.
        //   c) Tags can be inserted in the same transaction via the join table.
        const { error: insertError } = await supabaseAdmin
            .from('media_assets')
            .insert({
                id:              assetId,
                photographer_id: user.id,
                title:           title.slice(0, 200),
                description:     description?.slice(0, 2000),
                asset_type:      assetType,
                mime_type:       mimeType,
                file_size_bytes: fileSize,
                cdn_key:         cdnKey,
                price_cents:     price_cents ?? 0,
                license_type:    license_type ?? 'standard',
                status:          'pending',
            });

        if (insertError) {
            console.error('DB insert error:', insertError);
            return new Response(JSON.stringify({ error: 'Failed to create asset record.' }),
                { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
        }

        // ── 7. Upsert tags and create the join rows ─────────────────────────
        if (tags && tags.length > 0) {
            // Normalise tags: lowercase, alphanumeric + hyphens only.
            const normalisedTags = [...new Set(
                tags.map(t => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 50))
                    .filter(Boolean)
            )].slice(0, 20); // Cap at 20 tags per asset

            // Upsert the tags (create if not exists, ignore if duplicate).
            const { data: tagRows, error: tagUpsertError } = await supabaseAdmin
                .from('tags')
                .upsert(
                    normalisedTags.map(name => ({ name })),
                    { onConflict: 'name', ignoreDuplicates: false }
                )
                .select('id, name');

            if (!tagUpsertError && tagRows) {
                // Insert the join table rows linking asset ↔ tags.
                await supabaseAdmin
                    .from('asset_tags')
                    .upsert(
                        tagRows.map(tag => ({ asset_id: assetId, tag_id: tag.id })),
                        { onConflict: 'asset_id,tag_id', ignoreDuplicates: true }
                    );
            }
        }

        // ── 8. Return the presigned URL and asset ID to the browser ─────────
        return new Response(
            JSON.stringify({
                uploadUrl,                          // Browser PUTs file bytes here
                assetId,                            // UUID to reference in finalizeUpload()
                cdnKey,                             // B2 object key (not directly exposed)
                // Thumbnail URL will be null until the post-upload webhook fires.
                // The webhook (see stripe-webhook/index.ts for the pattern) calls
                // a Cloudflare Worker or B2 lifecycle rule to generate the thumb.
                thumbnailUrl: null,
                previewUrl:   null,
            }),
            { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }
        );

    } catch (err) {
        console.error('get-upload-url unhandled error:', err);
        return new Response(
            JSON.stringify({ error: 'Internal server error.' }),
            { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } }
        );
    }
});
