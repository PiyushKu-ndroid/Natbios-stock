// =============================================================================
// app.js — PixelVault Core Application
// =============================================================================
// Architecture overview:
//   1. Import Supabase from the official ESM CDN (no build step needed).
//   2. Initialize one global Supabase client — shared across all modules.
//   3. Module: Auth   — sign up, login, logout, session sync.
//   4. Module: Tags   — fetch + render the filter bar.
//   5. Module: Grid   — paginated fetch, masonry render, search, tag filter.
//   6. Module: Modal  — detail view, watermark, buy button.
//   7. Module: Toast  — lightweight notification system.
//   8. Bootstrap      — wires everything together on DOMContentLoaded.
// =============================================================================


// -----------------------------------------------------------------------------
// 1. IMPORT SUPABASE CLIENT
//    The @supabase/supabase-js package is available as an ES module on esm.sh.
//    We pin to v2 so a major version bump never silently breaks the site.
//    The named export `createClient` is the only function we need from the SDK.
// -----------------------------------------------------------------------------
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';


// =============================================================================
// 2. CONFIGURATION
//    Replace these two values with your own from:
//    Supabase Dashboard → Project Settings → API
//
//    IMPORTANT: The anon key is safe to expose in frontend code — it is
//    intentionally public. Row-Level Security policies (in schema.sql) control
//    what this key can actually read or write.
// =============================================================================
const SUPABASE_URL  = 'https://edbydwpdyzbowcnhlzkb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkYnlkd3BkeXpib3djbmhsemtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1Mjc0MTQsImV4cCI6MjEwMTEwMzQxNH0.Rb0porIQKtLYjfKL9qETOGqM2vXJPqwQ1Wa0pU00lu4';

// Backblaze B2 — base URL for your public/CDN bucket.
// Format: https://<your-bucket-name>.YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
// OR if behind Cloudflare: https://cdn.yourdomain.com
const CDN_BASE_URL  = 'https://cdn.yourdomain.com';

// How many assets to load per "page" of the grid.
const PAGE_SIZE = 24;


// -----------------------------------------------------------------------------
// Create the single shared Supabase client.
// Every database query in this file goes through this one object.
// -----------------------------------------------------------------------------
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: {
        // Persist the session in localStorage so the user stays logged in
        // across page refreshes without re-entering credentials.
        persistSession:    true,
        // Automatically refresh the JWT access token before it expires.
        autoRefreshToken:  true,
        // Detect the OAuth callback hash (#access_token=...) that Supabase
        // appends to the URL after email confirmation.
        detectSessionInUrl: true,
    }
});


// =============================================================================
// 3. AUTH MODULE
//    Handles: sign up, login, logout, and keeping the nav in sync with the
//    current Supabase session state.
// =============================================================================
const Auth = (() => {

    // ---- Internal state ------------------------------------------------
    let _currentUser = null;   // The Supabase User object (or null if logged out)
    let _isSignUpMode = false; // Toggles the auth modal between login / sign-up

    // ---- DOM references ------------------------------------------------
    const signedOutEl   = document.getElementById('nav-auth-signed-out');
    const signedInEl    = document.getElementById('nav-auth-signed-in');
    const userEmailEl   = document.getElementById('nav-user-email');

    const authModal     = document.getElementById('auth-modal');
    const authTitle     = document.getElementById('auth-modal-title');
    const authSubtitle  = document.getElementById('auth-modal-subtitle');
    const authToggle    = document.getElementById('auth-toggle-link');
    const signupFields  = document.getElementById('signup-fields');
    const emailInput    = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const displayInput  = document.getElementById('auth-display-name');
    const roleSelect    = document.getElementById('auth-role');
    const submitBtn     = document.getElementById('auth-submit-btn');
    const cancelBtn     = document.getElementById('auth-cancel-btn');
    const errorEl       = document.getElementById('auth-error');

    // ---- Private helpers -----------------------------------------------

    /** Updates the nav bar to reflect the signed-in or signed-out state. */
    function syncNavUI(user) {
        if (user) {
            // User is logged in — show their email and the dashboard link.
            signedOutEl.style.display = 'none';
            signedInEl.style.display  = 'flex';
            userEmailEl.textContent   = user.email;
        } else {
            // No active session — show the login/signup buttons.
            signedOutEl.style.display = 'flex';
            signedInEl.style.display  = 'none';
            userEmailEl.textContent   = '';
        }
    }

    /** Clears the auth form inputs and error message. */
    function resetForm() {
        emailInput.value    = '';
        passwordInput.value = '';
        displayInput.value  = '';
        errorEl.textContent = '';
    }

    /** Switches the auth modal between "Log in" and "Sign up" states. */
    function setMode(isSignUp) {
        _isSignUpMode = isSignUp;
        if (isSignUp) {
            authTitle.textContent       = 'Create account';
            authSubtitle.innerHTML      = 'Already have one? <a id="auth-toggle-link">Log in</a>';
            signupFields.style.display  = 'block';
            submitBtn.textContent       = 'Create account';
        } else {
            authTitle.textContent       = 'Log in';
            authSubtitle.innerHTML      = 'New here? <a id="auth-toggle-link">Create an account</a>';
            signupFields.style.display  = 'none';
            submitBtn.textContent       = 'Log in';
        }
        // Re-attach the click listener because innerHTML replaced the element.
        document.getElementById('auth-toggle-link')
                .addEventListener('click', () => setMode(!_isSignUpMode));
    }

    /** Shows the auth modal with an optional pre-selected mode. */
    function openModal(signUp = false) {
        resetForm();
        setMode(signUp);
        authModal.classList.add('is-open');
        emailInput.focus();
    }

    /** Hides the auth modal. */
    function closeModal() {
        authModal.classList.remove('is-open');
        resetForm();
    }

    /** Handles the form submit — calls Supabase signUp or signInWithPassword. */
    async function handleSubmit() {
        const email    = emailInput.value.trim();
        const password = passwordInput.value;
        errorEl.textContent = '';

        // Basic client-side validation before we hit the network.
        if (!email || !password) {
            errorEl.textContent = 'Please fill in all fields.';
            return;
        }
        if (password.length < 8) {
            errorEl.textContent = 'Password must be at least 8 characters.';
            return;
        }

        submitBtn.disabled    = true;
        submitBtn.textContent = 'Please wait…';

        try {
            if (_isSignUpMode) {
                // Sign up — we pass extra metadata that our DB trigger reads to
                // create the profiles row with the correct display_name and role.
                const { error } = await supabase.auth.signUp({
                    email,
                    password,
                    options: {
                        data: {
                            display_name: displayInput.value.trim() || email.split('@')[0],
                            role:         roleSelect.value,   // 'customer' | 'photographer'
                        }
                    }
                });

                if (error) throw error;

                // Supabase sends a confirmation email by default.
                Toast.show('Check your email to confirm your account!', 'success');
                closeModal();

            } else {
                // Log in with email + password.
                const { error } = await supabase.auth.signInWithPassword({ email, password });

                if (error) throw error;

                // onAuthStateChange (below) handles the nav update automatically.
                Toast.show('Welcome back!', 'success');
                closeModal();
            }

        } catch (err) {
            // Supabase error messages are already user-friendly.
            errorEl.textContent = err.message || 'Something went wrong. Try again.';
        } finally {
            submitBtn.disabled    = false;
            submitBtn.textContent = _isSignUpMode ? 'Create account' : 'Log in';
        }
    }

    // ---- Public API ----------------------------------------------------
    return {
        /** Call once on startup to wire up listeners and restore any saved session. */
        async init() {
            // Restore session from localStorage (if the user was previously logged in).
            const { data: { session } } = await supabase.auth.getSession();
            _currentUser = session?.user ?? null;
            syncNavUI(_currentUser);

            // Listen for any future auth state changes (login, logout, token refresh).
            // This fires immediately with the current session on first call.
            supabase.auth.onAuthStateChange((_event, session) => {
                _currentUser = session?.user ?? null;
                syncNavUI(_currentUser);
            });

            // Nav buttons
            document.getElementById('btn-open-login') .addEventListener('click', () => openModal(false));
            document.getElementById('btn-open-signup').addEventListener('click', () => openModal(true));
            document.getElementById('btn-logout').addEventListener('click', async () => {
                await supabase.auth.signOut();
                Toast.show('You have been signed out.', 'success');
            });

            // Auth modal buttons
            authToggle .addEventListener('click', () => setMode(!_isSignUpMode));
            submitBtn  .addEventListener('click', handleSubmit);
            cancelBtn  .addEventListener('click', closeModal);

            // Close modal on backdrop click
            authModal.addEventListener('click', (e) => {
                if (e.target === authModal) closeModal();
            });

            // Submit on Enter key
            [emailInput, passwordInput, displayInput].forEach(el => {
                el.addEventListener('keydown', (e) => { if (e.key === 'Enter') handleSubmit(); });
            });
        },

        /** Returns the currently authenticated Supabase User or null. */
        getUser() { return _currentUser; },

        /** Opens the login modal — useful when the buy button needs auth. */
        promptLogin() { openModal(false); },
    };

})(); // IIFE — the module is self-contained


// =============================================================================
// 4. TAGS MODULE
//    Fetches all tags from Supabase and renders the horizontal filter bar.
//    Clicking a tag filters the grid to show only matching assets.
// =============================================================================
const Tags = (() => {

    const tagBar = document.getElementById('tag-bar');
    let _activeTag = null; // Name of the currently selected tag, or null for "All"

    return {
        /** Fetches tags ordered by usage_count and renders them as pills. */
        async init(onTagSelect) {
            // Query the tags table — return top 30 by usage so the bar doesn't overflow.
            const { data: tags, error } = await supabase
                .from('tags')
                .select('id, name, usage_count')
                .order('usage_count', { ascending: false })
                .limit(30);

            if (error) {
                console.error('Tags fetch failed:', error.message);
                return;
            }

            // Prepend an "All" pill that clears any active tag filter.
            const allPill = createPill('All', true);
            allPill.addEventListener('click', () => {
                _activeTag = null;
                updateActive(allPill);
                onTagSelect(null);
            });
            tagBar.appendChild(allPill);

            // Render one pill per tag.
            tags.forEach(tag => {
                const pill = createPill(tag.name);
                pill.setAttribute('role', 'listitem');
                pill.addEventListener('click', () => {
                    _activeTag = tag.name;
                    updateActive(pill);
                    onTagSelect(tag.name);
                });
                tagBar.appendChild(pill);
            });
        },

        getActive() { return _activeTag; },
    };

    /** Creates and returns a single tag pill button element. */
    function createPill(label, isActive = false) {
        const btn = document.createElement('button');
        btn.className   = 'tag-pill' + (isActive ? ' is-active' : '');
        btn.textContent = label;
        btn.setAttribute('role', 'listitem');
        return btn;
    }

    /** Removes the active class from all pills and adds it to `activePill`. */
    function updateActive(activePill) {
        tagBar.querySelectorAll('.tag-pill').forEach(p => p.classList.remove('is-active'));
        activePill.classList.add('is-active');
    }

})();


// =============================================================================
// 5. GRID MODULE
//    Core gallery: fetches paginated asset data from the `assets_with_meta`
//    view in Supabase and renders masonry cards. Handles search + tag filters.
// =============================================================================
const Grid = (() => {

    // DOM references
    const gridEl       = document.getElementById('masonry-grid');
    const statusEl     = document.getElementById('grid-status');
    const searchForm   = document.getElementById('search-form');
    const searchInput  = document.getElementById('search-input');
    const loadMoreWrap = document.getElementById('load-more-wrap');
    const loadMoreBtn  = document.getElementById('load-more-btn');

    // Pagination & filter state
    let _page        = 0;       // Current page offset (0-indexed)
    let _searchQuery = '';      // Active search string
    let _activeTag   = null;    // Active tag name or null
    let _hasMore     = true;    // Whether there are more assets to fetch
    let _loading     = false;   // Prevents concurrent fetches

    // ---- Data fetching -------------------------------------------------

    /**
     * Builds and executes a Supabase query against our `assets_with_meta` view.
     *
     * The view already joins profiles (for photographer_name) and tags
     * (as a Postgres array), so one query gives us everything the card needs.
     *
     * Filtering strategy:
     *   - Full-text search: uses the search_vector column via textSearch().
     *   - Tag filter:       uses the `cs` (contains) operator on the `tags` array.
     *   - Pagination:       .range(from, to) translates to SQL LIMIT / OFFSET.
     */
    async function fetchAssets() {
        if (_loading || !_hasMore) return;
        _loading = true;

        const from = _page * PAGE_SIZE;
        const to   = from + PAGE_SIZE - 1;

        // Start building the query.
        let query = supabase
            .from('assets_with_meta')      // Our pre-built denormalised view
            .select('*')                   // All columns (thumbnail_url, tags[], etc.)
            .eq('status', 'active')        // Only show approved assets
            .order('created_at', { ascending: false })
            .range(from, to);

        // Apply full-text search if the user typed something.
        // to_tsquery requires words separated by & (AND) or | (OR).
        // We convert the user's string to a phrase search automatically.
        if (_searchQuery) {
            // Replace spaces with ' & ' to build an AND full-text query.
            const tsQuery = _searchQuery.trim().split(/\s+/).join(' & ');
            query = query.textSearch('search_vector', tsQuery, {
                type:   'websearch',    // Postgres websearch_to_tsquery — handles phrases
                config: 'english',
            });
        }

        // Apply tag filter if one is active.
        // The `tags` column in the view is a Postgres TEXT[] array.
        // `cs` = "contains" — checks if the array contains our tag string.
        if (_activeTag) {
            query = query.contains('tags', [_activeTag]);
        }

        const { data: assets, error } = await query;

        _loading = false;

        if (error) {
            console.error('Grid fetch error:', error.message);
            statusEl.textContent = 'Failed to load assets. Please refresh.';
            return;
        }

        // If we got fewer results than PAGE_SIZE, we've hit the end.
        _hasMore = assets.length === PAGE_SIZE;
        loadMoreWrap.style.display = _hasMore ? 'block' : 'none';

        return assets;
    }

    // ---- Rendering -----------------------------------------------------

    /**
     * Renders an array of asset objects as masonry cards and appends them
     * to the grid container. Each card is a <article> element with:
     *   - A lazy-loaded <img> thumbnail
     *   - A hover overlay with title, photographer, and price
     *   - A click handler that opens the detail modal
     */
    function renderCards(assets) {
        if (!assets || assets.length === 0) return;

        assets.forEach(asset => {
            const card = document.createElement('article');
            card.className          = 'asset-card';
            card.setAttribute('role', 'button');
            card.setAttribute('tabindex', '0');
            card.setAttribute('aria-label', `View ${asset.title}`);

            // Format the price from cents to a readable string.
            // e.g. 2999 → "$29.99" or 0 → "Free"
            const priceDisplay = asset.price_cents > 0
                ? '$' + (asset.price_cents / 100).toFixed(2)
                : 'Free';

            card.innerHTML = `
                ${asset.asset_type === 'video' ? '<span class="asset-card__badge">4K Video</span>' : ''}
                <img
                    class="asset-card__thumb"
                    src="${escapeHtml(asset.thumbnail_url || '')}"
                    alt="${escapeHtml(asset.title)}"
                    loading="lazy"
                    decoding="async"
                />
                <div class="asset-card__overlay">
                    <p class="asset-card__title">${escapeHtml(asset.title)}</p>
                    <div class="asset-card__meta">
                        <span class="asset-card__photographer">${escapeHtml(asset.photographer_name || '')}</span>
                        <span class="asset-card__price">${priceDisplay}</span>
                    </div>
                </div>
            `;

            // Add the skeleton shimmer animation when image loads successfully.
            const img = card.querySelector('.asset-card__thumb');
            img.addEventListener('load',  () => img.classList.add('loaded'));
            img.addEventListener('error', () => {
                // If the thumbnail fails to load, show a subtle placeholder.
                img.style.minHeight = '180px';
                img.classList.add('loaded');
            });

            // Open the detail modal when the card is clicked or activated via keyboard.
            const openDetail = () => Modal.open(asset);
            card.addEventListener('click',   openDetail);
            card.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') openDetail(); });

            gridEl.appendChild(card);
        });
    }

    // ---- Public API ----------------------------------------------------

    return {
        /** Initial load — called once on page boot. */
        async init() {
            const assets = await fetchAssets();

            statusEl.style.display = 'none'; // Hide "Loading…" message

            if (!assets || assets.length === 0) {
                statusEl.textContent  = 'No assets yet. Check back soon!';
                statusEl.style.display = 'block';
                return;
            }

            renderCards(assets);
            _page++;

            // Wire up the "Load more" button.
            loadMoreBtn.addEventListener('click', async () => {
                loadMoreBtn.textContent = 'Loading…';
                loadMoreBtn.disabled    = true;
                const more = await fetchAssets();
                renderCards(more);
                _page++;
                loadMoreBtn.textContent = 'Load more';
                loadMoreBtn.disabled    = false;
            });
        },

        /**
         * Resets the grid and re-fetches from page 0 with the given filters.
         * Called by the search form and the tag bar.
         */
        async reset(searchQuery, activeTag) {
            _page        = 0;
            _hasMore     = true;
            _searchQuery = searchQuery ?? _searchQuery;
            _activeTag   = activeTag !== undefined ? activeTag : _activeTag;

            // Clear existing cards.
            gridEl.innerHTML        = '';
            statusEl.style.display  = 'block';
            statusEl.textContent    = 'Searching…';
            loadMoreWrap.style.display = 'none';

            const assets = await fetchAssets();
            statusEl.style.display = 'none';

            if (!assets || assets.length === 0) {
                statusEl.textContent  = 'No results found. Try a different search.';
                statusEl.style.display = 'block';
                return;
            }

            renderCards(assets);
            _page++;
        },

        /** Called by the Tags module when a tag pill is clicked. */
        onTagSelect(tagName) {
            this.reset(_searchQuery, tagName);
        },
    };

})();


// =============================================================================
// 6. MODAL MODULE
//    Opens a full-detail view for a single asset. Shows the watermarked preview,
//    all metadata, and the Buy / Download button.
// =============================================================================
const Modal = (() => {

    const backdrop   = document.getElementById('detail-modal');
    const previewImg = document.getElementById('modal-preview-img');
    const titleEl    = document.getElementById('modal-title');
    const photogEl   = document.getElementById('modal-photographer');
    const tagsEl     = document.getElementById('modal-tags');
    const specsEl    = document.getElementById('modal-specs');
    const priceEl    = document.getElementById('modal-price');
    const licenseEl  = document.getElementById('modal-license');
    const buyBtn     = document.getElementById('modal-buy-btn');
    const closeBtn   = document.getElementById('modal-close-btn');

    let _currentAsset = null;

    // ---- Helpers -------------------------------------------------------

    /** Formats a file size in bytes into a human-readable string. */
    function formatBytes(bytes) {
        if (!bytes) return '—';
        if (bytes < 1024)        return bytes + ' B';
        if (bytes < 1048576)     return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1073741824)  return (bytes / 1048576).toFixed(1) + ' MB';
        return (bytes / 1073741824).toFixed(2) + ' GB';
    }

    /** Formats a price in cents as a display string. */
    function formatPrice(cents) {
        if (!cents || cents === 0) return 'Free';
        return '$' + (cents / 100).toFixed(2);
    }

    /** Renders a single spec item into the specs grid. */
    function specItem(label, value) {
        if (!value) return '';
        return `
            <div class="modal__spec-item">
                <span class="modal__spec-label">${escapeHtml(label)}</span>
                <span class="modal__spec-value">${escapeHtml(String(value))}</span>
            </div>
        `;
    }

    // ---- Buy button logic ----------------------------------------------

    /**
     * Handles the "Buy & Download" button click.
     *
     * Flow:
     *   1. If not logged in → open auth modal.
     *   2. If the asset is free → generate a signed download URL via a
     *      Supabase Edge Function and trigger the download immediately.
     *   3. If the asset is paid → redirect to the Stripe Checkout page
     *      (the Stripe session is created server-side in a Supabase Edge Function).
     *
     * The signed URL approach is critical: we NEVER embed a direct link to the
     * original B2 file in the HTML. This prevents right-click → save attacks.
     */
    async function handleBuy() {
        // Step 1: Require authentication.
        const user = Auth.getUser();
        if (!user) {
            Auth.promptLogin();
            return;
        }

        buyBtn.disabled    = true;
        buyBtn.textContent = 'Processing…';

        try {
            if (_currentAsset.price_cents === 0) {
                // FREE asset — generate a signed Backblaze B2 download URL.
                // This calls a Supabase Edge Function (you create this in Part 4).
                // The function verifies the user's JWT, logs the download, and
                // returns a time-limited (5-minute) signed URL.
                const { data, error } = await supabase.functions.invoke('get-download-url', {
                    body: { assetId: _currentAsset.id }
                });

                if (error) throw error;

                // Trigger the browser's native file download using a hidden anchor.
                const link = document.createElement('a');
                link.href     = data.signedUrl;
                link.download = _currentAsset.title + '.' + getExtension(_currentAsset.mime_type);
                document.body.appendChild(link);
                link.click();
                document.body.removeChild(link);

                Toast.show('Download started!', 'success');

            } else {
                // PAID asset — call the Stripe checkout Edge Function.
                const { data, error } = await supabase.functions.invoke('create-checkout', {
                    body: { assetId: _currentAsset.id }
                });

                if (error) throw error;

                // Redirect to the Stripe-hosted checkout page.
                window.location.href = data.checkoutUrl;
            }

        } catch (err) {
            console.error('Buy error:', err);
            Toast.show('Something went wrong. Please try again.', 'error');
        } finally {
            buyBtn.disabled    = false;
            buyBtn.textContent = 'Buy & Download';
        }
    }

    /** Returns a file extension from a MIME type string. */
    function getExtension(mime) {
        const map = {
            'image/jpeg':  'jpg',
            'image/png':   'png',
            'image/webp':  'webp',
            'image/tiff':  'tif',
            'image/x-raw': 'raw',
            'video/mp4':   'mp4',
            'video/mov':   'mov',
        };
        return map[mime] || 'bin';
    }

    // ---- Public API ----------------------------------------------------

    return {
        init() {
            closeBtn.addEventListener('click', () => this.close());
            backdrop .addEventListener('click', (e) => { if (e.target === backdrop) this.close(); });
            buyBtn   .addEventListener('click', handleBuy);

            // Close on Escape key.
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') this.close();
            });
        },

        /**
         * Opens the modal and populates it with the given asset's data.
         * @param {Object} asset — A row from the `assets_with_meta` view.
         */
        open(asset) {
            _currentAsset = asset;

            // Set the watermarked preview image.
            // preview_url is the medium-size, watermarked version — never the original.
            previewImg.src = asset.preview_url || asset.thumbnail_url || '';
            previewImg.alt = asset.title;

            // Title and photographer
            titleEl  .textContent = asset.title;
            photogEl .textContent = asset.photographer_name || 'Unknown';

            // Tags — each one is clickable to start a new search.
            tagsEl.innerHTML = '';
            if (asset.tags && asset.tags.length > 0) {
                asset.tags.forEach(tag => {
                    const span = document.createElement('span');
                    span.className   = 'modal__tag';
                    span.textContent = tag;
                    span.addEventListener('click', () => {
                        this.close();
                        Grid.reset('', tag);
                    });
                    tagsEl.appendChild(span);
                });
            }

            // Technical specs grid — only show rows where we have a value.
            specsEl.innerHTML = [
                specItem('Dimensions',  asset.width_px && asset.height_px
                    ? `${asset.width_px} × ${asset.height_px} px` : null),
                specItem('File size',   formatBytes(asset.file_size_bytes)),
                specItem('Type',        asset.asset_type?.toUpperCase()),
                specItem('Camera',      [asset.camera_make, asset.camera_model].filter(Boolean).join(' ')),
                specItem('Focal length', asset.focal_length_mm ? asset.focal_length_mm + ' mm' : null),
                specItem('ISO',         asset.iso),
                specItem('Aperture',    asset.aperture ? 'f/' + asset.aperture : null),
                specItem('Duration',    asset.duration_secs ? asset.duration_secs + 's' : null),
            ].join('');

            // Price and license
            priceEl  .textContent = formatPrice(asset.price_cents);
            licenseEl.textContent = asset.license_type ? `${asset.license_type} license` : '';

            // Buy button label
            buyBtn.textContent = asset.price_cents > 0
                ? `Buy for ${formatPrice(asset.price_cents)}`
                : 'Download Free';

            // Open the modal with a CSS transition.
            backdrop.classList.add('is-open');
            document.body.style.overflow = 'hidden'; // Prevent background scroll
        },

        close() {
            backdrop.classList.remove('is-open');
            document.body.style.overflow = '';
            _currentAsset = null;
            previewImg.src = ''; // Release the image from memory
        },
    };

})();


// =============================================================================
// 7. TOAST MODULE
//    Lightweight, auto-dismissing notification system.
//    Usage: Toast.show('Your message', 'success' | 'error')
// =============================================================================
const Toast = (() => {

    const container = document.getElementById('toast-container');

    return {
        /**
         * Shows a toast notification.
         * @param {string} message — The text to display.
         * @param {'success'|'error'|''} type — Colours the left border.
         * @param {number} duration — Auto-dismiss delay in milliseconds.
         */
        show(message, type = '', duration = 4000) {
            const toast = document.createElement('div');
            toast.className   = `toast ${type}`;
            toast.textContent = message;
            toast.setAttribute('role', 'status');

            container.appendChild(toast);

            // Auto-remove after `duration` ms.
            setTimeout(() => {
                toast.style.opacity   = '0';
                toast.style.transform = 'translateY(8px)';
                toast.style.transition = '300ms ease';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        }
    };

})();


// =============================================================================
// 8. PRESIGNED UPLOAD MODULE
//    This function is used by dashboard.html (the photographer upload page).
//    It is exported as a named function so dashboard.js can import it.
//
//    Flow:
//      1. Photographer selects files via drag-and-drop.
//      2. dashboard.js calls requestPresignedUrl() for each file.
//      3. A Supabase Edge Function validates the JWT (ensuring the user is a
//         photographer), then calls the B2 API to generate a presigned PUT URL.
//      4. The browser uploads directly to B2 — zero bytes pass through our server.
//      5. On success, we INSERT a row into media_assets with status='pending'.
// =============================================================================

/**
 * Requests a presigned Backblaze B2 upload URL for a single file.
 *
 * @param {File}   file     — The File object from the drag-and-drop event.
 * @param {Object} metadata — { title, description, tags, price_cents, license_type }
 * @returns {Promise<{uploadUrl: string, cdnKey: string, assetId: string}>}
 *
 * IMPORTANT: This function requires the user to be authenticated as a photographer.
 * The Edge Function on the server side validates the JWT before issuing the URL.
 */
export async function requestPresignedUrl(file, metadata) {
    const { data: { session } } = await supabase.auth.getSession();
    
    const response = await fetch(
        `${SUPABASE_URL}/functions/v1/get-upload-url`,
        {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({
                fileName:    file.name,
                fileSize:    file.size,
                mimeType:    file.type,
                ...metadata,
            }),
        }
    );

    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error ?? `HTTP ${response.status}`);
    }

    return response.json();
}

/**
 * Uploads a file directly to Backblaze B2 using a presigned URL.
 * The upload goes browser → B2 with no server in the middle.
 *
 * @param {string}   presignedUrl  — The PUT URL returned by requestPresignedUrl.
 * @param {File}     file          — The File to upload.
 * @param {Function} onProgress    — Called with a 0–100 percentage as the upload proceeds.
 */
export async function uploadToB2(presignedUrl, file, onProgress) {
    return new Promise((resolve, reject) => {
        // XHR gives us upload progress events; fetch() does not (yet).
        const xhr = new XMLHttpRequest();

        // Track upload progress and call the callback with a 0–100 number.
        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable && onProgress) {
                onProgress(Math.round((e.loaded / e.total) * 100));
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status >= 200 && xhr.status < 300) {
                resolve();
            } else {
                reject(new Error(`B2 upload failed: HTTP ${xhr.status}`));
            }
        });

        xhr.addEventListener('error', () => reject(new Error('Network error during upload.')));
        xhr.addEventListener('abort', () => reject(new Error('Upload was cancelled.')));

        // Backblaze B2 presigned PUT URLs expect the Content-Type header.
        xhr.open('PUT', presignedUrl);
        xhr.setRequestHeader('Content-Type', file.type);
        xhr.send(file); // The file bytes go straight to B2's servers.
    });
}

/**
 * Marks an uploaded asset as 'pending' review by inserting / updating its DB row.
 * Called after a successful uploadToB2().
 *
 * @param {string} assetId  — The UUID returned by requestPresignedUrl.
 * @param {Object} updates  — { thumbnail_url, preview_url } generated after upload.
 */
export async function finalizeUpload(assetId, updates) {
    const { error } = await supabase
        .from('media_assets')
        .update({
            status:        'pending', // Admin reviews before it goes 'active'
            thumbnail_url: updates.thumbnail_url,
            preview_url:   updates.preview_url,
        })
        .eq('id', assetId);

    if (error) throw new Error(`Failed to finalize upload: ${error.message}`);
}


// =============================================================================
// 9. UTILITIES
// =============================================================================

/**
 * Escapes HTML special characters to prevent XSS when injecting user-controlled
 * strings into innerHTML. Always use this for any string that came from the DB.
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}


// =============================================================================
// 10. BOOTSTRAP — Wire everything together
//     This runs once the HTML is fully parsed (guaranteed because this script
//     tag has type="module", which defers execution automatically).
// =============================================================================
async function bootstrap() {
    // Initialise auth first — we need the session before anything else.
    await Auth.init();

    // Initialise the detail modal (just attaches event listeners).
    Modal.init();

    // Load and render the tag filter bar.
    // Pass a callback so tag clicks can reset the grid.
    await Tags.init((tagName) => Grid.onTagSelect(tagName));

    // Load the first page of the asset grid.
    await Grid.init();

    // Wire up the search form.
    document.getElementById('search-form').addEventListener('submit', (e) => {
        e.preventDefault(); // Prevent full page reload
        const query = document.getElementById('search-input').value.trim();
        Grid.reset(query, undefined);
    });
}

// Kick everything off.
bootstrap().catch(err => {
    console.error('PixelVault bootstrap failed:', err);
});
