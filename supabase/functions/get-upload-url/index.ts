// =============================================================================
// Supabase Edge Function: get-upload-url (simplified debug version)
// =============================================================================

import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Max-Age':       '86400',
};

serve(async (req: Request) => {

    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { status: 200, headers: CORS_HEADERS });
    }

    // Return info on GET (useful for testing)
    if (req.method === 'GET') {
        return new Response(
            JSON.stringify({ status: 'get-upload-url is running' }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }

    try {
        // ── 1. Get the Authorization header ──────────────────────────────────
        const authHeader = req.headers.get('Authorization');

        if (!authHeader) {
            return new Response(
                JSON.stringify({ error: 'No Authorization header', step: 1 }),
                { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // ── 2. Create Supabase clients ────────────────────────────────────────
        const supabaseUrl = Deno.env.get('SUPABASE_URL');
        const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
        const anonKey     = Deno.env.get('SUPABASE_ANON_KEY');

        if (!supabaseUrl || !serviceKey) {
            return new Response(
                JSON.stringify({
                    error: 'Missing env vars',
                    hasUrl: !!supabaseUrl,
                    hasServiceKey: !!serviceKey,
                    hasAnonKey: !!anonKey,
                    step: 2
                }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // User client — to verify JWT
        const supabaseUser = createClient(supabaseUrl, anonKey!, {
            global:  { headers: { Authorization: authHeader } },
            auth:    { persistSession: false },
        });

        // Admin client — to read profiles bypassing RLS
        const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
            auth: { persistSession: false },
        });

        // ── 3. Get the authenticated user ────────────────────────────────────
        const { data: { user }, error: userError } = await supabaseUser.auth.getUser();

        if (userError || !user) {
            return new Response(
                JSON.stringify({
                    error: 'Auth failed',
                    detail: userError?.message,
                    step: 3
                }),
                { status: 401, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // ── 4. Check photographer role ────────────────────────────────────────
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role, display_name')
            .eq('id', user.id)
            .single();

        if (profileError) {
            return new Response(
                JSON.stringify({
                    error: 'Profile fetch failed',
                    detail: profileError.message,
                    userId: user.id,
                    step: 4
                }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        if (profile?.role !== 'photographer') {
            return new Response(
                JSON.stringify({
                    error: 'Only photographers can upload',
                    yourRole: profile?.role,
                    userId: user.id,
                    step: 4
                }),
                { status: 403, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // ── 5. Parse request body ─────────────────────────────────────────────
        const body = await req.json().catch(() => ({}));
        const { fileName, fileSize, mimeType, title, description, price_cents, license_type, tags } = body;

        if (!fileName || !mimeType || !title) {
            return new Response(
                JSON.stringify({
                    error: 'Missing required fields',
                    required: ['fileName', 'mimeType', 'title'],
                    received: Object.keys(body),
                    step: 5
                }),
                { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // ── 6. Generate asset UUID and B2 key ─────────────────────────────────
        const assetId  = crypto.randomUUID();
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const cdnKey   = `assets/${user.id}/${assetId}/${safeName}`;

        // ── 7. Determine asset type ───────────────────────────────────────────
        const assetType = mimeType.startsWith('video/') ? 'video'
                        : mimeType === 'image/x-raw'     ? 'raw'
                        : 'photo';

        // ── 8. Insert DB row ──────────────────────────────────────────────────
        const { error: insertError } = await supabaseAdmin
            .from('media_assets')
            .insert({
                id:              assetId,
                photographer_id: user.id,
                title:           title.slice(0, 200),
                description:     description?.slice(0, 2000) ?? null,
                asset_type:      assetType,
                mime_type:       mimeType,
                file_size_bytes: fileSize ?? 0,
                cdn_key:         cdnKey,
                price_cents:     price_cents ?? 0,
                license_type:    license_type ?? 'standard',
                status:          'pending',
            });

        if (insertError) {
            return new Response(
                JSON.stringify({
                    error: 'DB insert failed',
                    detail: insertError.message,
                    step: 8
                }),
                { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
            );
        }

        // ── 9. Handle tags ────────────────────────────────────────────────────
        if (tags && tags.length > 0) {
            const normTags = [...new Set(
                tags.map((t: string) => t.toLowerCase().trim().replace(/[^a-z0-9-]/g, '').slice(0, 50))
                    .filter(Boolean)
            )].slice(0, 20);

            const { data: tagRows } = await supabaseAdmin
                .from('tags')
                .upsert(normTags.map((name: string) => ({ name })), { onConflict: 'name' })
                .select('id');

            if (tagRows) {
                await supabaseAdmin
                    .from('asset_tags')
                    .upsert(tagRows.map((tag: { id: number }) => ({ asset_id: assetId, tag_id: tag.id })));
            }
        }

        // ── 10. Generate B2 presigned URL ─────────────────────────────────────
        // For now return a direct B2 URL — we'll add SigV4 signing in production
        const b2KeyId   = Deno.env.get('B2_KEY_ID');
        const b2AppKey  = Deno.env.get('B2_APP_KEY');
        const b2Bucket  = Deno.env.get('B2_BUCKET_NAME');
        const b2Region  = Deno.env.get('B2_REGION') ?? 'us-west-004';
        const cdnBase   = Deno.env.get('CDN_BASE_URL') ?? `https://${b2Bucket}.s3.${b2Region}.backblazeb2.com`;

        // Generate presigned URL using AWS SigV4
        const uploadUrl = await generatePresignedPutUrl({
            keyId:      b2KeyId!,
            appKey:     b2AppKey!,
            bucket:     b2Bucket!,
            region:     b2Region,
            objectKey:  cdnKey,
            mimeType,
            expiresIn:  900,
        });

        return new Response(
            JSON.stringify({
                uploadUrl,
                assetId,
                cdnKey,
                thumbnailUrl: null,
                previewUrl:   null,
            }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );

    } catch (err) {
        console.error('Unhandled error:', err);
        return new Response(
            JSON.stringify({ error: 'Internal server error', detail: (err as Error).message }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
});

// =============================================================================
// SigV4 presigned PUT URL generator (self-contained, no shared import)
// =============================================================================
async function generatePresignedPutUrl(opts: {
    keyId:     string;
    appKey:    string;
    bucket:    string;
    region:    string;
    objectKey: string;
    mimeType:  string;
    expiresIn: number;
}): Promise<string> {
    const { keyId, appKey, bucket, region, objectKey, expiresIn } = opts;

    const now       = new Date();
    const date      = now.toISOString().slice(0, 10).replace(/-/g, '');
    const timeStr   = now.toISOString().slice(11, 19).replace(/:/g, '');
    const datetime  = `${date}T${timeStr}Z`;
    const credScope = `${date}/${region}/s3/aws4_request`;
    const host      = `${bucket}.s3.${region}.backblazeb2.com`;

    const qp = new URLSearchParams({
        'X-Amz-Algorithm':   'AWS4-HMAC-SHA256',
        'X-Amz-Credential':  `${keyId}/${credScope}`,
        'X-Amz-Date':        datetime,
        'X-Amz-Expires':     String(expiresIn),
        'X-Amz-SignedHeaders': 'host',
    });
    qp.sort();

    const canonicalRequest = [
        'PUT',
        '/' + objectKey.split('/').map(encodeURIComponent).join('/'),
        qp.toString(),
        `host:${host}\n`,
        'host',
        'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
        'AWS4-HMAC-SHA256',
        datetime,
        credScope,
        await sha256hex(canonicalRequest),
    ].join('\n');

    const enc      = (s: string) => new TextEncoder().encode(s);
    const kSecret  = enc(`AWS4${appKey}`);
    const kDate    = await hmac(kSecret,                 date);
    const kRegion  = await hmac(new Uint8Array(kDate),   region);
    const kService = await hmac(new Uint8Array(kRegion), 's3');
    const kSigning = await hmac(new Uint8Array(kService),'aws4_request');
    const sig      = toHex(await hmac(new Uint8Array(kSigning), stringToSign));

    return `https://${host}/${objectKey.split('/').map(encodeURIComponent).join('/')}?${qp.toString()}&X-Amz-Signature=${sig}`;
}

async function hmac(key: Uint8Array, data: string): Promise<ArrayBuffer> {
    const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data));
}

function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256hex(str: string): Promise<string> {
    return toHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}