// ══════════════════════════════════════════════════════════════════
// PrintFlow — API client
// Talks to the real Express/SQLite backend instead of localStorage.
// Kept as a small helper object (API.*) so page scripts stay simple.
// ══════════════════════════════════════════════════════════════════

const API = window.API = {
    async _req(method, url, body, isForm) {
        const opts = { method, headers: {}, credentials: 'include' };
        if (body && isForm) {
            opts.body = body; // FormData - browser sets multipart headers
        } else if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const apiUrl = window.PRINTFLOW_API_URL || window.location.origin;
        const res = await fetch(`${apiUrl.replace(/\/$/, '')}${url}`, opts);
        let data = {};
        try { data = await res.json(); } catch { /* no body */ }
        if (!res.ok) throw new Error(data.error || 'Request failed.');
        return data;
    },

    get(url) { return this._req('GET', url); },
    post(url, body) { return this._req('POST', url, body); },
    postForm(url, form) { return this._req('POST', url, form, true); },
    patch(url, body) { return this._req('PATCH', url, body); },
    del(url) { return this._req('DELETE', url); },

    // ── Auth ────────────────────────────────────────────────────────
    me() { return this.get('/api/auth/me'); },
    login(email, password) { return this.post('/api/auth/login', { email, password }); },
    loginVerify(email, otp) { return this.post('/api/auth/login/verify', { email, otp }); },
    forgotPassword(email) { return this.post('/api/auth/forgot-password', { email }); },
    resetPassword(token, password, confirmPassword) { return this.post('/api/auth/reset-password', { token, password, confirmPassword }); },
    register(payload) { return this.post('/api/auth/register', payload); },
    logout() { return this.post('/api/auth/logout'); },
    updateProfile(payload, file = null) {
        if (file) {
            const form = new FormData();
            Object.entries(payload || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null) form.append(key, value);
            });
            form.append('profile_image', file);
            return this._req('PATCH', '/api/auth/profile', form, true);
        }
        return this.patch('/api/auth/profile', payload);
    },


    // ── Services ────────────────────────────────────────────────────
    myServices() { return this.get('/api/services/mine'); },
    servicesByOwner(ownerId) { return this.get(`/api/services/by-owner/${ownerId}`); },
    addService(payload) { return this.post('/api/services', payload); },
    updateService(id, payload) { return this.patch(`/api/services/${id}`, payload); },
    deleteService(id) { return this.del(`/api/services/${id}`); },

    // ── Owners (public) ─────────────────────────────────────────────
    getOwner(id) { return this.get(`/api/owners/${id}`); },
    searchOwners(q) { return this.get(`/api/owners?q=${encodeURIComponent(q || '')}`); },

    // ── Orders ──────────────────────────────────────────────────────
    placeOrder(formData) { return this.postForm('/api/orders', formData); },
    previewUpload(file) {
        const form = new FormData();
        form.append('file', file);
        return this._req('POST', '/api/orders/preview', form, true);
    },
    getOrder(id) { return this.get(`/api/orders/${id}`); },
    rateOrder(id, rating) { return this.post(`/api/orders/${id}/rate`, { rating }); },
    myOrders() { return this.get('/api/orders'); },
    orderPreview(id) { return this.get(`/api/orders/${id}/file/preview`); },
    advanceOrderStatus(id, status) { return this.patch(`/api/orders/${id}/status`, { status }); },
    markOrderPaid(id) { return this.patch(`/api/orders/${id}/mark-paid`); },
    stkPush(id, phone) { return this.post(`/api/orders/${id}/mpesa/stk`, phone ? { phone } : undefined); },
    setPaymentMethod(id, paymentMethod) { return this.post(`/api/orders/${id}/payment-method`, { payment_method: paymentMethod }); },
    paymentStatus(id) { return this.get(`/api/orders/${id}/payment-status`); },
        orderFileUrl(id) { return `${window.PRINTFLOW_API_URL || window.location.origin}/api/orders/${id}/file`; },
        orderPagesUrl(id, pages) { return `${window.PRINTFLOW_API_URL || window.location.origin}/api/orders/${id}/file/pages?pages=${encodeURIComponent(pages || 'all')}`; },

    // ── Admin ───────────────────────────────────────────────────────
    adminOwners() { return this.get('/api/admin/owners'); },
    adminSetOwnerStatus(id, status) { return this.patch(`/api/admin/owners/${id}/status`, { status }); },
    adminSetSubscription(id, plan, active, expiry) {
        return this.patch(`/api/admin/owners/${id}/subscription`, { plan, active, expiry });
    },
    adminDeleteOwner(id) { return this.del(`/api/admin/owners/${id}`); },
    adminOrders() { return this.get('/api/admin/orders'); },
    adminNotifyOwners(subject, message) { return this.post('/api/admin/notify-owners', { subject, message }); }
};

// ── Small shared helpers used across pages ───────────────────────────
function showToast(msg, isError = false) {
    let t = document.getElementById('toast');
    if (!t) {
        t = document.createElement('div');
        t.id = 'toast';
        t.style.cssText = 'position:fixed;bottom:20px;right:20px;left:20px;z-index:9999;transition:opacity .3s;display:flex;justify-content:center;pointer-events:none;';
        document.body.appendChild(t);
    }
    t.innerHTML = `<div style="background:${isError ? '#ef4444' : '#1e293b'};color:#fff;padding:12px 20px;border-radius:12px;
    box-shadow:0 4px 20px rgba(0,0,0,.25);display:flex;align-items:center;gap:10px;font-size:14px;font-weight:600;max-width:420px;">
    <i class="fas fa-${isError ? 'circle-exclamation' : 'circle-check'}" style="color:${isError ? '#fca5a5' : '#4ade80'}"></i>${msg}</div>`;
    t.style.opacity = '1';
    clearTimeout(t._hideTimer);
    t._hideTimer = setTimeout(() => { t.style.opacity = '0'; }, 3000);
}

// Redirects unauthenticated / wrong-role users. Call and await at top of protected pages.
async function requireAuth(role) {
    try {
        const { user } = await API.me();
        if (!user) { window.location.href = 'index.html'; return null; }
        if (role && user.role !== role) {
            window.location.href = user.role === 'admin' ? 'admin-dashboard.html' : 'owner-dashboard.html';
            return null;
        }
        return user;
    } catch {
        window.location.href = 'index.html';
        return null;
    }
}

function money(n) { return 'KES ' + Math.round(n || 0).toLocaleString(); }