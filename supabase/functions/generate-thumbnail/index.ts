import { serve }        from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
};

serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { status: 200, headers: CORS_HEADERS });

    const webhookSecret = req.headers.get('X-Webhook-Secret');
    const authHeader    = req.headers.get('Authorization');

    const supabaseAdmin = createClient(
        Deno.env.get('SUPABASE_URL')!,
        Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
        { auth: { persistSession: false } }
    );

    // Auth check
    if (webhookSecret) {
        if (webhookSecret !== Deno.env.get('THUMBNAIL_WEBHOOK_SECRET')) {
            return new Response(JSON.stringify({ error: 'Invalid secret' }), { status: 401, headers: CORS_HEADERS });
        }
    } else if (authHeader) {
        const supabaseUser = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_ANON_KEY')!,
            { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } }
        );
        const { data: { user }, error } = await supabaseUser.auth.getUser();
        if (error || !user) {
            return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: CORS_HEADERS });
        }
    } else {
        return new Response(JSON.stringify({ error: 'No auth' }), { status: 401, headers: CORS_HEADERS });
    }

    try {
        const body = await req.json() as { assetId?: string };
        const assetId = body.assetId;
        if (!assetId) return new Response(JSON.stringify({ error: 'assetId required' }), { status: 400, headers: CORS_HEADERS });

        // Fetch asset
        const { data: asset, error: assetErr } = await supabaseAdmin
            .from('media_assets')
            .select('id, cdn_key, mime_type, asset_type')
            .eq('id', assetId)
            .single();

        if (assetErr || !asset) {
            return new Response(JSON.stringify({ error: 'Asset not found' }), { status: 404, headers: CORS_HEADERS });
        }

        // Build the public B2 download URL using the friendly URL format
        const b2Bucket = Deno.env.get('B2_BUCKET_NAME')!;
        const b2Region = Deno.env.get('B2_REGION') ?? 'us-west-004';

        // Download original from B2 using presigned URL
        const { generatePresignedUrl } = await import('../_shared/b2-sign.ts');
        const downloadUrl = await generatePresignedUrl({
            method:    'GET',
            objectKey: asset.cdn_key,
            expiresIn: 300,
        });

        // Fetch the file from B2
        const fileRes = await fetch(downloadUrl);
        if (!fileRes.ok) throw new Error(`B2 download failed: ${fileRes.status}`);
        const fileBytes = await fileRes.arrayBuffer();

        // Upload to Supabase Storage (public bucket = public URL)
        const fileName = asset.cdn_key.split('/').pop()!;
        const storagePath = `${assetId}/${fileName}`;

        const { error: uploadErr } = await supabaseAdmin.storage
            .from('thumbnails')
            .upload(storagePath, fileBytes, {
                contentType: asset.mime_type,
                upsert: true,
            });

        if (uploadErr) throw new Error(`Storage upload failed: ${uploadErr.message}`);

        // Get the public URL
        const { data: { publicUrl } } = supabaseAdmin.storage
            .from('thumbnails')
            .getPublicUrl(storagePath);

        // Update the DB row
        const { error: updateErr } = await supabaseAdmin
            .from('media_assets')
            .update({
                thumbnail_url: publicUrl,
                preview_url:   publicUrl,
                status:        'active',
            })
            .eq('id', assetId);

        if (updateErr) throw new Error(`DB update failed: ${updateErr.message}`);

        return new Response(
            JSON.stringify({ success: true, assetId, thumbnailUrl: publicUrl, previewUrl: publicUrl }),
            { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );

    } catch (err) {
        console.error('generate-thumbnail error:', err);
        return new Response(
            JSON.stringify({ error: (err as Error).message }),
            { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
        );
    }
});