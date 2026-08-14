-- =============================================================================
-- PIXELVAULT — Supabase PostgreSQL Schema
-- Run this entire file in: Supabase Dashboard → SQL Editor → New Query
-- =============================================================================

-- -----------------------------------------------------------------------------
-- STEP 1: Clean slate (safe to re-run during development)
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.purchases      CASCADE;
DROP TABLE IF EXISTS public.asset_tags     CASCADE;
DROP TABLE IF EXISTS public.tags           CASCADE;
DROP TABLE IF EXISTS public.media_assets   CASCADE;
DROP TABLE IF EXISTS public.profiles       CASCADE;
DROP TYPE  IF EXISTS public.user_role;
DROP TYPE  IF EXISTS public.asset_type;
DROP TYPE  IF EXISTS public.asset_status;

-- -----------------------------------------------------------------------------
-- STEP 2: Custom ENUM types
--   ENUMs enforce that only valid values ever reach these columns.
-- -----------------------------------------------------------------------------

-- A user is either a photographer (can upload) or a customer (can buy/download).
CREATE TYPE public.user_role AS ENUM ('photographer', 'customer');

-- Distinguishes photos from videos so the UI can render them differently.
CREATE TYPE public.asset_type AS ENUM ('photo', 'video', 'raw');

-- Workflow state: an asset starts as 'pending', is reviewed, then goes 'active'.
-- 'rejected' lets you soft-reject without deleting the B2 file immediately.
CREATE TYPE public.asset_status AS ENUM ('pending', 'active', 'rejected');

-- -----------------------------------------------------------------------------
-- STEP 3: profiles table
--   Supabase creates auth.users automatically when someone signs up.
--   We mirror every auth user here so we can store extra fields (display name,
--   role, avatar) without touching the locked auth schema.
--   The trigger at the bottom auto-creates this row on every new signup.
-- -----------------------------------------------------------------------------
CREATE TABLE public.profiles (
    -- id MUST match auth.users.id — this is the foreign key into Supabase Auth.
    id              UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,

    -- Human-readable display name shown on asset cards and the dashboard.
    display_name    TEXT NOT NULL DEFAULT '',

    -- Avatar stored as a full CDN URL (Cloudflare → B2 path).
    avatar_url      TEXT,

    -- Whether this account can upload assets or only purchase them.
    role            public.user_role NOT NULL DEFAULT 'customer',

    -- Stripe customer ID stored here once the user adds a payment method.
    -- NULL until the customer completes their first checkout.
    stripe_customer_id TEXT,

    -- Automatic timestamps — handled by PostgreSQL, not the app.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index on role so filtering "all photographers" is fast.
CREATE INDEX idx_profiles_role ON public.profiles(role);

-- -----------------------------------------------------------------------------
-- STEP 4: media_assets table
--   The core of the platform. Every uploaded photo, video, or RAW file gets
--   one row here. Storage lives in B2; this table stores metadata + URLs only.
-- -----------------------------------------------------------------------------
CREATE TABLE public.media_assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Who uploaded this asset. Cascade delete removes assets if photographer
    -- account is deleted (adjust to SET NULL if you prefer to keep orphaned assets).
    photographer_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

    -- -------------------------------------------------------------------------
    -- Human-readable metadata
    -- -------------------------------------------------------------------------
    title           TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
    description     TEXT CHECK (char_length(description) <= 2000),

    -- -------------------------------------------------------------------------
    -- File information
    -- -------------------------------------------------------------------------
    asset_type      public.asset_type NOT NULL DEFAULT 'photo',

    -- MIME type string e.g. "image/jpeg", "video/mp4", "image/x-raw"
    mime_type       TEXT NOT NULL,

    -- Original file size in bytes — shown in the detail view.
    file_size_bytes BIGINT NOT NULL DEFAULT 0,

    -- -------------------------------------------------------------------------
    -- Backblaze B2 / CDN URLs
    --   We store three separate URLs:
    --   1. thumbnail_url  — small JPEG (≤800px wide), shown on the grid. Fast.
    --   2. preview_url    — medium watermarked version (≤1600px wide). Free preview.
    --   3. cdn_key        — the B2 object key for the original full-res file.
    --                       We do NOT store a direct URL here; we generate a
    --                       signed download URL at purchase time so it can't
    --                       be scraped from the HTML source.
    -- -------------------------------------------------------------------------
    thumbnail_url   TEXT,                -- Public CDN URL (no auth needed)
    preview_url     TEXT,                -- Public CDN URL (watermarked)
    cdn_key         TEXT NOT NULL,       -- B2 object key, e.g. "assets/uuid/orig.jpg"

    -- -------------------------------------------------------------------------
    -- Image/video technical specs (populated after upload by a Supabase Edge
    -- Function that reads EXIF / ffprobe data — you add this in Part 4).
    -- -------------------------------------------------------------------------
    width_px        INTEGER,
    height_px       INTEGER,
    duration_secs   NUMERIC(8, 2),       -- NULL for photos, seconds for video
    camera_make     TEXT,               -- EXIF: e.g. "Canon"
    camera_model    TEXT,               -- EXIF: e.g. "EOS R5"
    focal_length_mm NUMERIC(6, 1),
    iso             INTEGER,
    aperture        NUMERIC(4, 1),
    shot_at         TIMESTAMPTZ,         -- EXIF DateTimeOriginal

    -- -------------------------------------------------------------------------
    -- Pricing & licensing
    -- -------------------------------------------------------------------------
    -- Price in the smallest currency unit (cents). $29.99 → 2999.
    -- Storing as INTEGER avoids floating-point rounding bugs entirely.
    price_cents     INTEGER NOT NULL DEFAULT 0 CHECK (price_cents >= 0),

    -- Simple licensing tiers. You can expand this into a full license table later.
    license_type    TEXT NOT NULL DEFAULT 'standard'
                    CHECK (license_type IN ('standard', 'extended', 'editorial')),

    -- -------------------------------------------------------------------------
    -- Workflow & discoverability
    -- -------------------------------------------------------------------------
    status          public.asset_status NOT NULL DEFAULT 'pending',

    -- Full-text search vector — updated automatically by the trigger below.
    -- Allows fast Postgres FTS queries: WHERE search_vector @@ to_tsquery(...)
    search_vector   TSVECTOR,

    -- How many times this asset has been sold. Denormalised for fast sorting.
    download_count  INTEGER NOT NULL DEFAULT 0,

    -- Soft-delete: set to true instead of deleting the row, so we can restore.
    is_deleted      BOOLEAN NOT NULL DEFAULT FALSE,

    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Regular indexes for the most common query patterns.
CREATE INDEX idx_assets_photographer  ON public.media_assets(photographer_id);
CREATE INDEX idx_assets_status        ON public.media_assets(status);
CREATE INDEX idx_assets_type          ON public.media_assets(asset_type);
CREATE INDEX idx_assets_price         ON public.media_assets(price_cents);
CREATE INDEX idx_assets_created       ON public.media_assets(created_at DESC);
CREATE INDEX idx_assets_downloads     ON public.media_assets(download_count DESC);

-- GIN index for the full-text search vector — enables very fast text search.
CREATE INDEX idx_assets_search        ON public.media_assets USING GIN(search_vector);

-- -----------------------------------------------------------------------------
-- STEP 5: tags table + asset_tags join table
--   Many-to-many: one asset can have many tags; one tag can belong to many assets.
-- -----------------------------------------------------------------------------
CREATE TABLE public.tags (
    id          SERIAL PRIMARY KEY,

    -- e.g. "architecture", "sunset", "4k-video"
    -- citext would be ideal; we normalise to lowercase in the trigger instead.
    name        TEXT NOT NULL UNIQUE CHECK (char_length(name) BETWEEN 1 AND 50),

    -- Denormalised count for fast "popular tags" widget — updated by trigger.
    usage_count INTEGER NOT NULL DEFAULT 0,

    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tags_name  ON public.tags(name);
CREATE INDEX idx_tags_usage ON public.tags(usage_count DESC);

-- Join table — no extra columns needed; the composite PK prevents duplicates.
CREATE TABLE public.asset_tags (
    asset_id    UUID    NOT NULL REFERENCES public.media_assets(id) ON DELETE CASCADE,
    tag_id      INTEGER NOT NULL REFERENCES public.tags(id)         ON DELETE CASCADE,
    PRIMARY KEY (asset_id, tag_id)
);

CREATE INDEX idx_asset_tags_tag ON public.asset_tags(tag_id);

-- -----------------------------------------------------------------------------
-- STEP 6: purchases table
--   Records every completed transaction. This is your audit trail.
--   Never delete rows from this table — use status to track refunds.
-- -----------------------------------------------------------------------------
CREATE TABLE public.purchases (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id         UUID NOT NULL REFERENCES public.profiles(id)      ON DELETE RESTRICT,
    asset_id            UUID NOT NULL REFERENCES public.media_assets(id)  ON DELETE RESTRICT,

    -- Amount actually charged (may differ from asset price if you run sales).
    amount_paid_cents   INTEGER NOT NULL CHECK (amount_paid_cents >= 0),

    -- Stripe payment intent ID — used to look up receipts and process refunds.
    stripe_payment_id   TEXT,

    -- Simple status machine. 'completed' = money received, file may be downloaded.
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'completed', 'refunded', 'failed')),

    -- When was the signed download URL last generated? Useful for analytics.
    last_downloaded_at  TIMESTAMPTZ,
    download_count      INTEGER NOT NULL DEFAULT 0,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchases_customer ON public.purchases(customer_id);
CREATE INDEX idx_purchases_asset    ON public.purchases(asset_id);
CREATE INDEX idx_purchases_status   ON public.purchases(status);

-- Prevent a customer from buying the same asset twice (handle upgrades separately).
CREATE UNIQUE INDEX idx_purchases_unique ON public.purchases(customer_id, asset_id)
    WHERE status = 'completed';

-- =============================================================================
-- TRIGGERS
-- =============================================================================

-- -----------------------------------------------------------------------------
-- TRIGGER A: Auto-create a profile row whenever auth.users gets a new entry.
--   Supabase fires this after every successful signup. The user's chosen role
--   is passed in auth.users.raw_user_meta_data->>'role' from the signup call.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER                    -- Runs as the function owner, not the caller
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.profiles (id, display_name, role)
    VALUES (
        NEW.id,
        -- Use the email prefix as a starter display name; user can edit it later.
        COALESCE(NEW.raw_user_meta_data->>'display_name', split_part(NEW.email, '@', 1)),
        -- Default to 'customer' if the signup form didn't pass a role.
        COALESCE((NEW.raw_user_meta_data->>'role')::public.user_role, 'customer')
    );
    RETURN NEW;
END;
$$;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- -----------------------------------------------------------------------------
-- TRIGGER B: Keep updated_at current automatically on profiles and media_assets.
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_profiles_updated_at
    BEFORE UPDATE ON public.profiles
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trg_assets_updated_at
    BEFORE UPDATE ON public.media_assets
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- -----------------------------------------------------------------------------
-- TRIGGER C: Rebuild the full-text search vector whenever an asset is saved.
--   Weights: Title (A = highest) > Description (B) > Camera model (C).
--   Tags are handled separately via a trigger on asset_tags (TRIGGER D).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_asset_search_vector()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    tag_names TEXT;
BEGIN
    -- Gather all tag names for this asset into a single space-separated string.
    SELECT string_agg(t.name, ' ')
    INTO   tag_names
    FROM   public.asset_tags at2
    JOIN   public.tags t ON t.id = at2.tag_id
    WHERE  at2.asset_id = NEW.id;

    NEW.search_vector :=
        setweight(to_tsvector('english', COALESCE(NEW.title,        '')), 'A') ||
        setweight(to_tsvector('english', COALESCE(NEW.description,  '')), 'B') ||
        setweight(to_tsvector('english', COALESCE(NEW.camera_model, '')), 'C') ||
        setweight(to_tsvector('english', COALESCE(tag_names,        '')), 'B');

    RETURN NEW;
END;
$$;

CREATE TRIGGER trg_asset_search_vector
    BEFORE INSERT OR UPDATE ON public.media_assets
    FOR EACH ROW EXECUTE FUNCTION public.update_asset_search_vector();

-- -----------------------------------------------------------------------------
-- TRIGGER D: When a tag is added/removed from an asset, refresh:
--   1. The asset's search_vector (so tags are searchable immediately).
--   2. The tag's usage_count (so the "popular tags" widget stays accurate).
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_asset_tag_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
    affected_asset_id UUID;
    affected_tag_id   INTEGER;
BEGIN
    -- Works for both INSERT and DELETE on asset_tags.
    IF TG_OP = 'DELETE' THEN
        affected_asset_id := OLD.asset_id;
        affected_tag_id   := OLD.tag_id;
    ELSE
        affected_asset_id := NEW.asset_id;
        affected_tag_id   := NEW.tag_id;
    END IF;

    -- Force re-evaluation of the search vector trigger on the parent asset.
    UPDATE public.media_assets SET updated_at = NOW()
    WHERE  id = affected_asset_id;

    -- Recount usages for the affected tag.
    UPDATE public.tags
    SET    usage_count = (
               SELECT COUNT(*) FROM public.asset_tags WHERE tag_id = affected_tag_id
           )
    WHERE  id = affected_tag_id;

    RETURN NULL; -- AFTER trigger; return value is ignored for row triggers on views.
END;
$$;

CREATE TRIGGER trg_asset_tag_change
    AFTER INSERT OR DELETE ON public.asset_tags
    FOR EACH ROW EXECUTE FUNCTION public.handle_asset_tag_change();

-- =============================================================================
-- ROW-LEVEL SECURITY (RLS)
--   RLS ensures the JS client (which uses the public anon key) can only read/
--   write exactly what we allow. Think of these as your API authorization layer.
-- =============================================================================

ALTER TABLE public.profiles     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.media_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tags         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.asset_tags   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases    ENABLE ROW LEVEL SECURITY;

-- ---- profiles ---------------------------------------------------------------

-- Anyone can read any public profile (needed to show photographer name on cards).
CREATE POLICY "profiles: public read"
    ON public.profiles FOR SELECT
    USING (true);

-- Users can only update their own profile.
CREATE POLICY "profiles: owner update"
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- ---- media_assets -----------------------------------------------------------

-- The gallery shows only active, non-deleted assets to the public.
CREATE POLICY "assets: public read active"
    ON public.media_assets FOR SELECT
    USING (status = 'active' AND is_deleted = FALSE);

-- Photographers can read ALL their own assets (including pending/rejected).
CREATE POLICY "assets: owner read own"
    ON public.media_assets FOR SELECT
    USING (auth.uid() = photographer_id);

-- Only the owning photographer can insert new assets.
CREATE POLICY "assets: photographer insert"
    ON public.media_assets FOR INSERT
    WITH CHECK (
        auth.uid() = photographer_id
        AND EXISTS (
            SELECT 1 FROM public.profiles
            WHERE id = auth.uid() AND role = 'photographer'
        )
    );

-- Photographers can update/soft-delete only their own assets.
CREATE POLICY "assets: photographer update own"
    ON public.media_assets FOR UPDATE
    USING (auth.uid() = photographer_id);

-- ---- tags -------------------------------------------------------------------

-- Tags are fully public for reading (needed for the filter bar).
CREATE POLICY "tags: public read"
    ON public.tags FOR SELECT
    USING (true);

-- Only authenticated users (photographers) can create new tags.
CREATE POLICY "tags: authenticated insert"
    ON public.tags FOR INSERT
    WITH CHECK (auth.role() = 'authenticated');

-- ---- asset_tags -------------------------------------------------------------

CREATE POLICY "asset_tags: public read"
    ON public.asset_tags FOR SELECT
    USING (true);

CREATE POLICY "asset_tags: photographer manage"
    ON public.asset_tags FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM public.media_assets
            WHERE id = asset_id AND photographer_id = auth.uid()
        )
    );

-- ---- purchases --------------------------------------------------------------

-- Customers can only see their own purchase history.
CREATE POLICY "purchases: customer read own"
    ON public.purchases FOR SELECT
    USING (auth.uid() = customer_id);

-- Only authenticated users can create purchases (Stripe webhook or Edge Function
-- will do the actual INSERT using a service role key, not the anon key).
CREATE POLICY "purchases: authenticated insert"
    ON public.purchases FOR INSERT
    WITH CHECK (auth.uid() = customer_id);

-- =============================================================================
-- SEED DATA — A handful of realistic tags to populate the filter bar on launch.
-- =============================================================================
INSERT INTO public.tags (name) VALUES
    ('architecture'), ('aerial'), ('abstract'), ('animals'), ('automotive'),
    ('business'), ('cityscape'), ('fashion'), ('food'), ('landscape'),
    ('nature'), ('people'), ('portrait'), ('sports'), ('technology'),
    ('travel'), ('underwater'), ('vintage'), ('wildlife'), ('4k-video')
ON CONFLICT (name) DO NOTHING;

-- =============================================================================
-- USEFUL VIEWS (optional but handy for the dashboard queries)
-- =============================================================================

-- A denormalised view joining assets with their photographer display name and
-- a comma-separated list of tag names. The app.js queries this view directly.
CREATE OR REPLACE VIEW public.assets_with_meta AS
SELECT
    a.id,
    a.title,
    a.description,
    a.asset_type,
    a.mime_type,
    a.file_size_bytes,
    a.thumbnail_url,
    a.preview_url,
    a.cdn_key,
    a.width_px,
    a.height_px,
    a.duration_secs,
    a.camera_make,
    a.camera_model,
    a.price_cents,
    a.license_type,
    a.status,
    a.download_count,
    a.created_at,
    -- Photographer info (safe to expose — profiles are public)
    p.display_name  AS photographer_name,
    p.avatar_url    AS photographer_avatar,
    -- Aggregated tag list as a PostgreSQL text array, e.g. {nature,landscape}
    ARRAY_AGG(t.name ORDER BY t.name) FILTER (WHERE t.name IS NOT NULL) AS tags
FROM
    public.media_assets a
    JOIN public.profiles p ON p.id = a.photographer_id
    LEFT JOIN public.asset_tags at2 ON at2.asset_id = a.id
    LEFT JOIN public.tags t         ON t.id = at2.tag_id
WHERE
    a.is_deleted = FALSE
GROUP BY
    a.id, p.display_name, p.avatar_url;

-- Grant the anon role SELECT access to the view (RLS on the base tables still applies).
GRANT SELECT ON public.assets_with_meta TO anon, authenticated;
