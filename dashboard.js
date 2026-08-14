// =============================================================================
// dashboard.js — PixelVault Photographer Dashboard
// =============================================================================
// This module handles everything inside dashboard.html:
//   1. Auth guard — redirect to index.html if not logged in as a photographer.
//   2. Navigation — single-page tab switching without a router.
//   3. Stats — load overview numbers from Supabase.
//   4. Upload — drag-and-drop → presigned URL → direct B2 upload.
//   5. My Assets — paginated table of the photographer's own uploads.
//   6. Earnings — sales history pulled from the purchases table.
// =============================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Re-use the same upload helpers exported from app.js so logic lives in one place.
import { requestPresignedUrl, uploadToB2, finalizeUpload } from './app.js';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — must match app.js exactly
// ─────────────────────────────────────────────────────────────────────────────
const SUPABASE_URL = 'https://edbydwpdyzbowcnhlzkb.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImVkYnlkd3BkeXpib3djbmhsemtiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU1Mjc0MTQsImV4cCI6MjEwMTEwMzQxNH0.Rb0porIQKtLYjfKL9qETOGqM2vXJPqwQ1Wa0pU00lu4';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON, {
    auth: { persistSession: true, autoRefreshToken: true }
});

// ─────────────────────────────────────────────────────────────────────────────
// UTILITY HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/** Escapes a string for safe innerHTML insertion — prevents XSS. */
function esc(str) {
    if (typeof str !== 'string') return '';
    return str
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

/** Formats bytes into a human-readable size string. */
function fmtBytes(bytes) {
    if (!bytes) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

/** Formats cents as a "$X.XX" string. */
function fmtMoney(cents) {
    return '$' + (cents / 100).toFixed(2);
}

/** Formats an ISO date string as "14 Jul 2026". */
function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Returns the appropriate status badge HTML for an asset or purchase status. */
function statusBadge(status) {
    const map = {
        pending: 'badge-pending',
        active: 'badge-active',
        rejected: 'badge-rejected',
        completed: 'badge-active',
        refunded: 'badge-rejected',
    };
    return `<span class="badge ${map[status] || ''}">${esc(status)}</span>`;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────────────────────
const Toast = {
    show(message, type = '', duration = 4500) {
        const container = document.getElementById('toast-container');
        const el = document.createElement('div');
        el.className = `toast ${type}`;
        el.textContent = message;
        el.setAttribute('role', 'status');
        container.appendChild(el);
        setTimeout(() => {
            el.style.opacity = '0';
            el.style.transform = 'translateY(8px)';
            el.style.transition = '300ms ease';
            setTimeout(() => el.remove(), 300);
        }, duration);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// NAV — single-page tab switching
// ─────────────────────────────────────────────────────────────────────────────
const Nav = {
    init() {
        // Every element with data-page is a nav trigger.
        document.querySelectorAll('[data-page]').forEach(trigger => {
            trigger.addEventListener('click', () => this.goTo(trigger.dataset.page));
        });
    },

    goTo(pageId) {
        // Deactivate all sections and sidebar links.
        document.querySelectorAll('.page-section').forEach(s => s.classList.remove('is-active'));
        document.querySelectorAll('.sidebar__link').forEach(l => l.classList.remove('is-active'));

        // Activate the target section.
        const section = document.getElementById(pageId + '-section');
        if (section) section.classList.add('is-active');

        // Activate the matching sidebar link.
        const link = document.querySelector(`.sidebar__link[data-page="${pageId}"]`);
        if (link) link.classList.add('is-active');

        // Lazy-load the section's data the first time it's opened.
        if (pageId === 'my-assets' && !MyAssets.loaded) MyAssets.load();
        if (pageId === 'earnings' && !Earnings.loaded) Earnings.load();
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH GUARD
//   Verifies the session, checks the profile role, and removes the loading gate.
//   If the user is not a logged-in photographer, redirects them away immediately.
// ─────────────────────────────────────────────────────────────────────────────
const AuthGuard = {
    async init() {
        const { data: { session } } = await supabase.auth.getSession();

        if (!session) {
            // No session at all — send them to the homepage where they can log in.
            window.location.href = 'index.html';
            return null;
        }

        // Fetch the profile to confirm the role.
        const { data: profile, error } = await supabase
            .from('profiles')
            .select('id, display_name, role')
            .eq('id', session.user.id)
            .single();

        if (error || !profile || profile.role !== 'photographer') {
            // Logged in but not a photographer — redirect to browse page.
            window.location.href = 'index.html';
            return null;
        }

        // Auth confirmed — reveal the dashboard and populate the header.
        document.getElementById('auth-gate').remove();
        document.getElementById('dash-user-email').textContent = session.user.email;
        document.getElementById('overview-greeting').textContent =
            `Welcome back, ${profile.display_name || session.user.email.split('@')[0]}.`;

        // Wire up the logout button.
        document.getElementById('btn-logout').addEventListener('click', async () => {
            await supabase.auth.signOut();
            window.location.href = 'index.html';
        });

        return session.user;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// OVERVIEW STATS
//   Loads aggregate numbers for the stat cards and the recent-uploads table.
// ─────────────────────────────────────────────────────────────────────────────
const Overview = {
    async load(userId) {
        // ── 1. Fetch all the photographer's assets (counts + downloads) ──
        const { data: assets, error: aErr } = await supabase
            .from('media_assets')
            .select('id, title, asset_type, price_cents, status, download_count, thumbnail_url, created_at')
            .eq('photographer_id', userId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (aErr) { console.error('Overview assets error:', aErr.message); return; }

        const total = assets.length;
        const active = assets.filter(a => a.status === 'active').length;
        const downloads = assets.reduce((sum, a) => sum + (a.download_count || 0), 0);

        // ── 2. Fetch completed purchase totals for this photographer ──
        // We join through media_assets so we only see purchases for OUR assets.
        const { data: purchases, error: pErr } = await supabase
            .from('purchases')
            .select('amount_paid_cents, asset_id, media_assets!inner(photographer_id)')
            .eq('media_assets.photographer_id', userId)
            .eq('status', 'completed');

        const earningsCents = pErr
            ? 0
            : purchases.reduce((sum, p) => sum + p.amount_paid_cents, 0);

        // ── 3. Update the stat cards ──
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('ov-total-assets', total);
        set('ov-active-assets', active);
        set('ov-total-downloads', downloads);
        set('ov-earnings', fmtMoney(earningsCents));
        // Sidebar mini-stats
        set('stat-total-assets', total);
        set('stat-total-sales', purchases?.length ?? 0);
        set('stat-earnings', fmtMoney(earningsCents));

        // ── 4. Render the recent uploads table (last 10) ──
        const tbody = document.getElementById('recent-assets-body');
        if (!assets.length) return; // Keep the empty state row

        tbody.innerHTML = assets.slice(0, 10).map(a => `
            <tr>
                <td>
                    <div class="asset-thumb-cell">
                        <img src="${esc(a.thumbnail_url || '')}" alt="" loading="lazy"
                             onerror="this.style.opacity='.2'" />
                        <div>
                            <strong>${esc(a.title)}</strong>
                            <span>${fmtDate(a.created_at)}</span>
                        </div>
                    </div>
                </td>
                <td>${esc(a.asset_type)}</td>
                <td>${a.price_cents ? fmtMoney(a.price_cents) : 'Free'}</td>
                <td>${statusBadge(a.status)}</td>
                <td>${a.download_count ?? 0}</td>
            </tr>
        `).join('');
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// MY ASSETS PAGE
//   Full list of the photographer's uploads with client-side title filtering
//   and soft-delete (hide from public gallery without destroying the B2 file).
// ─────────────────────────────────────────────────────────────────────────────
const MyAssets = {
    loaded: false,
    _all: [],       // All fetched assets — filtering happens on this array
    _userId: null,

    async load(userId) {
        this._userId = userId || this._userId;
        this.loaded = true;

        const tbody = document.getElementById('my-assets-body');
        tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--c-text-muted)">Loading…</td></tr>`;

        const { data: assets, error } = await supabase
            .from('media_assets')
            .select('id, title, asset_type, price_cents, status, download_count, thumbnail_url, created_at')
            .eq('photographer_id', this._userId)
            .eq('is_deleted', false)
            .order('created_at', { ascending: false });

        if (error) {
            console.error('My assets error:', error.message);
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:40px;color:var(--c-error)">Failed to load. Refresh to try again.</td></tr>`;
            return;
        }

        this._all = assets;
        this.render(assets);

        // Wire up the search filter (client-side, no extra DB query needed).
        document.getElementById('assets-search-input').addEventListener('input', (e) => {
            const q = e.target.value.toLowerCase();
            this.render(this._all.filter(a => a.title.toLowerCase().includes(q)));
        });
    },

    render(assets) {
        const tbody = document.getElementById('my-assets-body');

        if (!assets.length) {
            tbody.innerHTML = `
                <tr><td colspan="6">
                    <div class="empty-state">
                        <div class="empty-state__icon">⊞</div>
                        <p class="empty-state__title">No assets found</p>
                        <p class="empty-state__sub">Try a different search or upload something new.</p>
                    </div>
                </td></tr>`;
            return;
        }

        tbody.innerHTML = assets.map(a => `
            <tr>
                <td>
                    <div class="asset-thumb-cell">
                        <img src="${esc(a.thumbnail_url || '')}" alt="" loading="lazy"
                             onerror="this.style.opacity='.2'" />
                        <div>
                            <strong title="${esc(a.title)}">${esc(a.title)}</strong>
                            <span>${fmtDate(a.created_at)}</span>
                        </div>
                    </div>
                </td>
                <td>${esc(a.asset_type)}</td>
                <td>${a.price_cents ? fmtMoney(a.price_cents) : 'Free'}</td>
                <td>${statusBadge(a.status)}</td>
                <td>${a.download_count ?? 0}</td>
                <td>
                    <button
                        class="btn btn-danger"
                        style="padding:5px 10px;font-size:.72rem"
                        data-delete-id="${esc(a.id)}"
                    >Remove</button>
                </td>
            </tr>
        `).join('');

        // Wire up delete buttons for this render pass.
        tbody.querySelectorAll('[data-delete-id]').forEach(btn => {
            btn.addEventListener('click', () => this.softDelete(btn.dataset.deleteId));
        });
    },

    async softDelete(assetId) {
        if (!confirm('Remove this asset from the public gallery? The file is kept in storage.')) return;

        const { error } = await supabase
            .from('media_assets')
            .update({ is_deleted: true })
            .eq('id', assetId)
            .eq('photographer_id', this._userId); // RLS double-check

        if (error) {
            Toast.show('Could not remove asset: ' + error.message, 'error');
            return;
        }

        Toast.show('Asset removed from the gallery.', 'success');
        this._all = this._all.filter(a => a.id !== assetId);
        this.render(this._all);
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// EARNINGS PAGE
// ─────────────────────────────────────────────────────────────────────────────
const Earnings = {
    loaded: false,

    async load(userId) {
        this.loaded = true;

        const { data: rows, error } = await supabase
            .from('purchases')
            .select(`
                id,
                amount_paid_cents,
                status,
                created_at,
                media_assets!inner (
                    id,
                    title,
                    license_type,
                    photographer_id
                )
            `)
            .eq('media_assets.photographer_id', userId)
            .eq('status', 'completed')
            .order('created_at', { ascending: false });

        const tbody = document.getElementById('earnings-body');

        if (error || !rows || !rows.length) {
            tbody.innerHTML = `
                <tr><td colspan="5">
                    <div class="empty-state">
                        <div class="empty-state__icon">$</div>
                        <p class="empty-state__title">No sales yet</p>
                        <p class="empty-state__sub">Once customers buy your assets, sales appear here.</p>
                    </div>
                </td></tr>`;
            return;
        }

        const total = rows.reduce((s, r) => s + r.amount_paid_cents, 0);
        document.getElementById('earn-lifetime').textContent = fmtMoney(total);
        document.getElementById('earn-sales').textContent = rows.length;
        // "Pending payout" logic would come from your Stripe payout schedule —
        // for now we show total as a placeholder.
        document.getElementById('earn-pending').textContent = fmtMoney(total);

        tbody.innerHTML = rows.map(r => `
            <tr>
                <td>${esc(r.media_assets.title)}</td>
                <td>${esc(r.media_assets.license_type)}</td>
                <td>${fmtMoney(r.amount_paid_cents)}</td>
                <td>${fmtDate(r.created_at)}</td>
                <td>${statusBadge(r.status)}</td>
            </tr>
        `).join('');
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// TAG CHIPS INPUT
//   A lightweight pill-style multi-value input. Press Enter or comma to add.
//   Click the × on any chip to remove it.
// ─────────────────────────────────────────────────────────────────────────────
const TagInput = {
    _tags: [], // The current list of tag strings

    init() {
        const input = document.getElementById('tag-text-input');
        const wrap = document.getElementById('tag-input-wrap');

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                this.add(input.value);
                input.value = '';
            }
            // Backspace on empty input removes the last chip.
            if (e.key === 'Backspace' && !input.value && this._tags.length) {
                this._tags.pop();
                this.render();
            }
        });

        // Clicking anywhere in the wrap focuses the text input.
        wrap.addEventListener('click', () => input.focus());
    },

    add(raw) {
        // Normalise: lowercase, strip special chars, trim whitespace.
        const tag = raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!tag || this._tags.includes(tag) || this._tags.length >= 20) return;
        this._tags.push(tag);
        this.render();
    },

    remove(tag) {
        this._tags = this._tags.filter(t => t !== tag);
        this.render();
    },

    render() {
        const wrap = document.getElementById('tag-input-wrap');
        const input = document.getElementById('tag-text-input');

        // Remove all existing chips (but not the input itself).
        wrap.querySelectorAll('.tag-chip').forEach(c => c.remove());

        // Re-insert chips before the input.
        this._tags.forEach(tag => {
            const chip = document.createElement('span');
            chip.className = 'tag-chip';
            chip.innerHTML = `${esc(tag)} <button type="button" aria-label="Remove ${esc(tag)}">×</button>`;
            chip.querySelector('button').addEventListener('click', () => this.remove(tag));
            wrap.insertBefore(chip, input);
        });
    },

    get() { return [...this._tags]; },

    reset() {
        this._tags = [];
        this.render();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// UPLOADER
//   Manages the drag-and-drop zone, the upload queue UI, and coordinates the
//   three-step upload flow: presigned URL → XHR to B2 → finalize in DB.
// ─────────────────────────────────────────────────────────────────────────────
const Uploader = {
    // _queue holds objects of shape:
    // { file, id, thumbUrl, status: 'queued'|'uploading'|'done'|'error', progress }
    _queue: [],

    init() {
        const dropZone = document.getElementById('drop-zone');
        const fileInput = document.getElementById('file-input');
        const uploadBtn = document.getElementById('upload-all-btn');

        // ── Drag-and-drop events ──
        dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('is-over'); });
        dropZone.addEventListener('dragleave', () => dropZone.classList.remove('is-over'));
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('is-over');
            this.addFiles(Array.from(e.dataTransfer.files));
        });

        // ── Native file picker ──
        fileInput.addEventListener('change', () => {
            this.addFiles(Array.from(fileInput.files));
            fileInput.value = ''; // Reset so the same file can be re-added after removal
        });

        // ── Upload all button ──
        uploadBtn.addEventListener('click', () => this.uploadAll());
    },

    // Accepts a File array, validates, and adds items to the queue.
    addFiles(files) {
        const MAX_SIZE = 4 * 1024 * 1024 * 1024; // 4 GB
        const ALLOWED = new Set([
            'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/x-raw',
            'video/mp4', 'video/quicktime'
        ]);

        files.forEach(file => {
            if (!ALLOWED.has(file.type)) {
                Toast.show(`${file.name}: unsupported format.`, 'error');
                return;
            }
            if (file.size > MAX_SIZE) {
                Toast.show(`${file.name}: exceeds the 4 GB limit.`, 'error');
                return;
            }
            // Prevent duplicates by checking the file name + size fingerprint.
            const exists = this._queue.some(q => q.file.name === file.name && q.file.size === file.size);
            if (exists) {
                Toast.show(`${file.name} is already in the queue.`, '');
                return;
            }

            const id = crypto.randomUUID();
            this._queue.push({ id, file, thumbUrl: null, status: 'queued', progress: 0 });
            this.generateThumb(id, file);
        });

        this.renderQueue();
        this.toggleMetaForm();
    },

    // Generate a local thumbnail preview using a FileReader / Canvas.
    // This happens entirely in the browser — no upload needed yet.
    async generateThumb(id, file) {
        if (!file.type.startsWith('image/')) {
            // For video files, use a placeholder icon instead.
            this.updateItem(id, { thumbUrl: null });
            return;
        }

        const url = URL.createObjectURL(file);
        this.updateItem(id, { thumbUrl: url });
        // The object URL is revoked after the img element loads it in renderQueue().
    },

    // Renders every item in _queue into the #upload-queue DOM list.
    renderQueue() {
        const container = document.getElementById('upload-queue');
        container.innerHTML = ''; // Full re-render (queue is rarely > 20 items)

        this._queue.forEach(item => {
            const div = document.createElement('div');
            div.className = 'queue-item' +
                (item.status === 'done' ? ' is-done' : '') +
                (item.status === 'error' ? ' is-error' : '');
            div.id = 'qi-' + item.id;

            // Thumbnail — image preview or a generic icon for video/RAW.
            const thumbHtml = item.thumbUrl
                ? `<img class="queue-item__thumb" src="${item.thumbUrl}" alt="" />`
                : `<div class="queue-item__thumb" style="display:flex;align-items:center;justify-content:center;font-size:1.6rem;opacity:.4">▶</div>`;

            // Status label beneath the progress bar.
            const statusLabel = {
                queued: 'Waiting…',
                uploading: `${item.progress}% uploaded`,
                done: '✓ Uploaded',
                error: '✗ Upload failed — will retry',
            }[item.status];

            const barWidth = item.status === 'done' ? 100 : item.progress;

            div.innerHTML = `
                ${thumbHtml}
                <div>
                    <div class="queue-item__name" title="${esc(item.file.name)}">${esc(item.file.name)}</div>
                    <div class="queue-item__size">${fmtBytes(item.file.size)}</div>
                </div>
                ${item.status === 'queued'
                    ? `<button class="queue-item__remove" data-remove-id="${esc(item.id)}" aria-label="Remove ${esc(item.file.name)}">✕</button>`
                    : ''
                }
                <div class="queue-item__progress-wrap">
                    <div class="progress-bar">
                        <div class="progress-bar__fill" style="width:${barWidth}%"></div>
                    </div>
                    <div class="queue-item__progress-label">${statusLabel}</div>
                </div>
            `;

            container.appendChild(div);
        });

        // Wire up remove buttons.
        container.querySelectorAll('[data-remove-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                this._queue = this._queue.filter(q => q.id !== btn.dataset.removeId);
                this.renderQueue();
                this.toggleMetaForm();
            });
        });
    },

    // Updates a single queue item's data and re-renders just its progress bar
    // (more efficient than re-rendering the entire list during upload).
    updateItem(id, patch) {
        const item = this._queue.find(q => q.id === id);
        if (!item) return;
        Object.assign(item, patch);

        // If the item's DOM card exists, update it in-place.
        const card = document.getElementById('qi-' + id);
        if (card) {
            const fill = card.querySelector('.progress-bar__fill');
            const label = card.querySelector('.queue-item__progress-label');

            if (fill && patch.progress !== undefined) {
                fill.style.width = patch.progress + '%';
            }
            if (label) {
                const statusLabel = {
                    queued: 'Waiting…',
                    uploading: `${item.progress}% uploaded`,
                    done: '✓ Uploaded',
                    error: '✗ Upload failed',
                }[item.status] || '';
                label.textContent = statusLabel;
            }
            if (patch.status === 'done') { card.classList.add('is-done'); }
            if (patch.status === 'error') { card.classList.add('is-error'); }

            // Set thumbnail once object URL is generated.
            if (patch.thumbUrl) {
                const thumb = card.querySelector('.queue-item__thumb');
                if (thumb && thumb.tagName === 'IMG') thumb.src = patch.thumbUrl;
            }
        }
    },

    // Shows or hides the metadata form based on whether the queue has items.
    toggleMetaForm() {
        const metaWrap = document.getElementById('meta-form-wrap');
        metaWrap.style.display = this._queue.length > 0 ? 'block' : 'none';
    },

    // Reads form values, validates, then uploads each queued file in parallel.
    async uploadAll() {
        // ── Validate the form ──
        const title = document.getElementById('meta-title').value.trim();
        if (!title) { Toast.show('Please enter a title before uploading.', 'error'); return; }

        const priceRaw = parseFloat(document.getElementById('meta-price').value);
        if (isNaN(priceRaw) || priceRaw < 0) {
            Toast.show('Enter a valid price (0 for free).', 'error');
            return;
        }

        const queued = this._queue.filter(q => q.status === 'queued');
        if (!queued.length) { Toast.show('No files queued.', ''); return; }

        const metadata = {
            title: title,
            description: document.getElementById('meta-description').value.trim(),
            price_cents: Math.round(priceRaw * 100),
            license_type: document.getElementById('meta-license').value,
            tags: TagInput.get(),
        };

        const uploadBtn = document.getElementById('upload-all-btn');
        uploadBtn.disabled = true;
        uploadBtn.textContent = `Uploading 0 / ${queued.length}…`;

        let doneCount = 0;

        // Upload all queued files concurrently (Promise.allSettled never throws).
        await Promise.allSettled(
            queued.map(async (item) => {
                this.updateItem(item.id, { status: 'uploading', progress: 0 });

                try {
                    // ── STEP 1: Get a presigned B2 upload URL from our Edge Function ──
                    // The Edge Function validates the JWT server-side before issuing the URL,
                    // so an unauthenticated user cannot generate upload URLs.
                    const { data: { session } } = await supabase.auth.getSession();
                    const res = await fetch(`${SUPABASE_URL}/functions/v1/get-upload-url`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({
                            fileName: item.file.name,
                            fileSize: item.file.size,
                            mimeType: item.file.type,
                            title: `${metadata.title} — ${item.file.name}`,
                            description: metadata.description,
                            price_cents: metadata.price_cents,
                            license_type: metadata.license_type,
                            tags: metadata.tags,
                        }),
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        throw new Error(err.error ?? `HTTP ${res.status}`);
                    }
                    const { uploadUrl, cdnKey, assetId } = await res.json();

                    // ── STEP 2: Upload the file bytes directly to Backblaze B2 ──
                    // No bytes pass through our server. B2 receives the file straight
                    // from the user's browser via the presigned PUT URL.
                    await uploadToB2(uploadUrl, item.file, (pct) => {
                        this.updateItem(item.id, { progress: pct });
                    });

                    // ── STEP 3: Mark the asset row as pending review ──
                    // The thumbnail and preview URLs are generated by a separate
                    // post-upload Edge Function (triggered by B2 webhook). For now
                    // we pass the cdn_key so the DB row is created immediately.
                    await finalizeUpload(assetId, {
                        // These would come from your thumbnail generation service.
                        // Placeholders until the webhook fires:
                        thumbnail_url: null,
                        preview_url: null,
                    });
                    // Auto-generate thumbnail immediately after upload
                    await fetch(`${SUPABASE_URL}/functions/v1/generate-thumbnail`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${session.access_token}`,
                        },
                        body: JSON.stringify({ assetId }),
                    });

                    this.updateItem(item.id, { status: 'done', progress: 100 });
                    doneCount++;
                    uploadBtn.textContent = `Uploading ${doneCount} / ${queued.length}…`;

                } catch (err) {
                    console.error('Upload failed for', item.file.name, err);
                    this.updateItem(item.id, { status: 'error' });
                    Toast.show(`${item.file.name}: ${err.message}`, 'error');
                }
            })
        );

        // ── All done ──
        uploadBtn.disabled = false;
        uploadBtn.textContent = 'Upload all & publish for review';

        const failed = this._queue.filter(q => q.status === 'error').length;
        if (!failed) {
            Toast.show(`${doneCount} file${doneCount !== 1 ? 's' : ''} submitted for review!`, 'success');
            // Clear the queue and reset the form on full success.
            this._queue = [];
            this.renderQueue();
            this.toggleMetaForm();
            document.getElementById('meta-title').value = '';
            document.getElementById('meta-description').value = '';
            TagInput.reset();
        } else {
            Toast.show(`${doneCount} uploaded, ${failed} failed. Retry the failed ones.`, 'error');
            // Remove successful items from the queue so only failures remain.
            this._queue = this._queue.filter(q => q.status !== 'done');
            this.renderQueue();
        }

        // Reload the overview stats to reflect the new uploads.
        await Overview.load(currentUser.id);
    },
};

// ─────────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ─────────────────────────────────────────────────────────────────────────────
let currentUser = null;

async function bootstrap() {
    // 1. Verify auth first — this may redirect away if not a photographer.
    currentUser = await AuthGuard.init();
    if (!currentUser) return; // Redirected; stop execution.

    // 2. Wire up navigation.
    Nav.init();

    // 3. Load overview data.
    await Overview.load(currentUser.id);

    // 4. Initialise the upload UI.
    Uploader.init();
    TagInput.init();

    // 5. Pass userId to lazy-loaded sections for when they first open.
    const origMyAssetsLoad = MyAssets.load.bind(MyAssets);
    const origEarningsLoad = Earnings.load.bind(Earnings);
    MyAssets.load = () => origMyAssetsLoad(currentUser.id);
    Earnings.load = () => origEarningsLoad(currentUser.id);
}

bootstrap().catch(err => {
    console.error('Dashboard bootstrap error:', err);
});
