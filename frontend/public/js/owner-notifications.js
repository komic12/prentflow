// Owner notifications SSE listener
(function() {
    function showNotification(n) {
        let container = document.getElementById('owner-notif-container');
        if (!container) {
            container = document.createElement('div');
            container.id = 'owner-notif-container';
            container.style.position = 'fixed';
            container.style.right = '20px';
            container.style.top = '80px';
            container.style.zIndex = 99999;
            document.body.appendChild(container);
        }
        const el = document.createElement('div');
        el.style.background = '#1e293b';
        el.style.color = '#fff';
        el.style.padding = '12px 16px';
        el.style.marginTop = '10px';
        el.style.borderRadius = '10px';
        el.style.boxShadow = '0 8px 24px rgba(15,23,42,0.12)';
        el.innerHTML = `<div style="font-weight:700;margin-bottom:4px">${n.title}</div><div style="font-size:13px">${n.body}</div><div style="margin-top:8px;font-size:12px"><a href="${n.link||'#'}" style="color:#60a5fa;">Open</a></div>`;
        container.prepend(el);
        setTimeout(() => { el.style.opacity = '0';
            el.style.transition = 'opacity .5s';
            setTimeout(() => el.remove(), 500); }, 10000);
    }

    function startSSE() {
        if (!window.EventSource) return;
        const apiUrl = window.PRINTFLOW_API_URL || window.location.origin;
        const es = new EventSource(`${apiUrl.replace(/\/$/, '')}/api/owners/notifications/stream`, { withCredentials: true });
        es.addEventListener('notification', e => {
            try {
                const data = JSON.parse(e.data);
                showNotification(data);
            } catch (err) { console.warn('Malformed notification', err); }
        });
        es.addEventListener('error', e => {
            console.warn('Notification stream error', e);
        });
        window.addEventListener('beforeunload', () => es.close());
    }

    document.addEventListener('DOMContentLoaded', startSSE);
})();