// =============================================================================
// supabase/functions/_shared/b2-sign.ts
// =============================================================================
// AWS Signature Version 4 helpers for Backblaze B2's S3-compatible API.
// Imported by: get-upload-url, get-download-url, generate-thumbnail.
//
// Why SigV4 instead of the native B2 API?
//   B2's S3-compatible endpoint lets us use standard AWS signing, which means
//   we never need the B2 SDK. Deno's built-in crypto.subtle handles everything.
// =============================================================================

export const B2_REGION = Deno.env.get('B2_REGION') ?? 'us-west-004';

// ---------------------------------------------------------------------------
// Low-level crypto helpers
// ---------------------------------------------------------------------------

/** HMAC-SHA256: returns raw ArrayBuffer. */
export async function hmacSha256(
    key:  ArrayBuffer | Uint8Array,
    data: string
): Promise<ArrayBuffer> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        key instanceof Uint8Array ? key.buffer : key,
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );
    return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

/** Converts an ArrayBuffer to a lowercase hex string. */
export function toHex(buf: ArrayBuffer): string {
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/** SHA-256 of a UTF-8 string, returned as a hex string. */
export async function sha256Hex(str: string): Promise<string> {
    const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str)
    );
    return toHex(buf);
}

// ---------------------------------------------------------------------------
// SigV4 signing key derivation
// ---------------------------------------------------------------------------

/**
 * Derives the SigV4 signing key for a given date, region, and service.
 * The key changes daily — cache it per Lambda/Edge Function invocation if
 * you're signing many URLs in a single request (rare in our use case).
 */
export async function deriveSigV4Key(
    secretKey: string,
    date:      string,    // YYYYMMDD
    region:    string,
    service:   string
): Promise<ArrayBuffer> {
    const enc      = (s: string) => new TextEncoder().encode(s);
    const kSecret  = enc(`AWS4${secretKey}`);
    const kDate    = await hmacSha256(kSecret,   date);
    const kRegion  = await hmacSha256(kDate,     region);
    const kService = await hmacSha256(kRegion,   service);
    const kSigning = await hmacSha256(kService,  'aws4_request');
    return kSigning;
}

// ---------------------------------------------------------------------------
// Presigned URL builder — works for any HTTP method (PUT, GET, DELETE…)
// ---------------------------------------------------------------------------

export interface PresignedUrlOptions {
    method:          string;          // 'PUT' | 'GET' | 'DELETE'
    objectKey:       string;          // B2 object key (path inside bucket)
    mimeType?:       string;          // Only needed for PUT
    expiresIn?:      number;          // Seconds, default 900
    extraQueryParams?: Record<string, string>;  // e.g. response-content-disposition
}

/**
 * Generates a presigned S3-compatible URL for Backblaze B2.
 *
 * The credentials are embedded in the URL query string using AWS SigV4, so
 * the recipient can use the URL without any Authorization header.
 *
 * @returns Full presigned URL as a string.
 */
export async function generatePresignedUrl(opts: PresignedUrlOptions): Promise<string> {
    const {
        method,
        objectKey,
        expiresIn    = 900,
        extraQueryParams = {},
    } = opts;

    const keyId    = Deno.env.get('B2_KEY_ID')!;
    const appKey   = Deno.env.get('B2_APP_KEY')!;
    const bucket   = Deno.env.get('B2_BUCKET_NAME')!;
    const region   = B2_REGION;

    // ── Timestamps ──────────────────────────────────────────────────────────
    const now      = new Date();
    const date     = now.toISOString().slice(0, 10).replace(/-/g, '');       // YYYYMMDD
    const timeOnly = now.toISOString().slice(11, 19).replace(/:/g, '');      // HHmmss
    const datetime = `${date}T${timeOnly}Z`;

    // ── Credential scope ────────────────────────────────────────────────────
    const credScope  = `${date}/${region}/s3/aws4_request`;
    const credential = `${keyId}/${credScope}`;

    // ── Canonical URI ───────────────────────────────────────────────────────
    // Each path segment is percent-encoded, but forward slashes between
    // segments must NOT be double-encoded.
    const canonicalUri = '/' + objectKey
        .split('/')
        .map(seg => encodeURIComponent(seg))
        .join('/');

    // ── Query string (must be sorted alphabetically per SigV4 spec) ─────────
    const qp = new URLSearchParams({
        'X-Amz-Algorithm':   'AWS4-HMAC-SHA256',
        'X-Amz-Credential':  credential,
        'X-Amz-Date':        datetime,
        'X-Amz-Expires':     String(expiresIn),
        'X-Amz-SignedHeaders': 'host',
        ...extraQueryParams,
    });
    qp.sort(); // Alphabetical order is required.
    const canonicalQS = qp.toString();

    // ── Canonical headers (only `host` for presigned URLs) ──────────────────
    const host             = `${bucket}.s3.${region}.backblazeb2.com`;
    const canonicalHeaders = `host:${host}\n`;
    const signedHeaders    = 'host';

    // ── Canonical request ────────────────────────────────────────────────────
    // For presigned URLs the payload is always UNSIGNED-PAYLOAD.
    const canonicalRequest = [
        method,
        canonicalUri,
        canonicalQS,
        canonicalHeaders,
        signedHeaders,
        'UNSIGNED-PAYLOAD',
    ].join('\n');

    // ── String to sign ───────────────────────────────────────────────────────
    const stringToSign = [
        'AWS4-HMAC-SHA256',
        datetime,
        credScope,
        await sha256Hex(canonicalRequest),
    ].join('\n');

    // ── Signature ────────────────────────────────────────────────────────────
    const signingKey = await deriveSigV4Key(appKey, date, region, 's3');
    const signature  = toHex(await hmacSha256(signingKey, stringToSign));

    // ── Assemble final URL ───────────────────────────────────────────────────
    return `https://${host}${canonicalUri}?${canonicalQS}&X-Amz-Signature=${signature}`;
}

// ---------------------------------------------------------------------------
// CORS helper — shared across all functions
// ---------------------------------------------------------------------------

const ALLOWED_ORIGINS = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .concat([
        'http://localhost:3000',
        'http://127.0.0.1:3000',
        'http://localhost:5500',
        'http://127.0.0.1:5500',
    ]);

export function corsHeaders(origin: string | null): Record<string, string> {
    const allowed = ALLOWED_ORIGINS.includes(origin ?? '') ? origin! : ALLOWED_ORIGINS[0];
    return {
        'Access-Control-Allow-Origin':  allowed,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, x-client-info, apikey',
        'Access-Control-Max-Age':       '86400',
    };
}

/** Returns a JSON Response with CORS headers. */
export function jsonResponse(
    data:    unknown,
    status = 200,
    origin:  string | null = null
): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders(origin),
            'Content-Type': 'application/json',
        },
    });
}

// ---------------------------------------------------------------------------
// Auth helper — shared across all functions
// ---------------------------------------------------------------------------

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

/**
 * Verifies the Authorization header and returns the authenticated Supabase user.
 * Throws a Response (ready to return) if auth fails.
 */
export async function requireAuth(
    req:    Request,
    origin: string | null
): Promise<{ user: { id: string; email: string }; supabaseAdmin: SupabaseClient }> {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
        throw jsonResponse({ error: 'Missing Authorization header' }, 401, origin);
    }

    const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { auth: { persistSession: false } }
    );

    const supabaseUser = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_ANON_KEY')!,
        {
            global:  { headers: { Authorization: authHeader } },
            auth:    { persistSession: false },
        }
    );

    const { data: { user }, error } = await supabaseUser.auth.getUser();
    if (error || !user) {
        throw jsonResponse({ error: 'Invalid or expired token' }, 401, origin);
    }

    return { user: { id: user.id, email: user.email! }, supabaseAdmin };
}

// ---------------------------------------------------------------------------
// File extension helper
// ---------------------------------------------------------------------------
export function mimeToExtension(mime: string): string {
    const map: Record<string, string> = {
        'image/jpeg':      'jpg',
        'image/png':       'png',
        'image/webp':      'webp',
        'image/tiff':      'tif',
        'image/x-raw':     'raw',
        'video/mp4':       'mp4',
        'video/quicktime': 'mov',
    };
    return map[mime] ?? 'bin';
}
