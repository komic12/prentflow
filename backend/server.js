require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const db = require('./db/database');
const { createSessionStore } = require('./db/supabase-session-store');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');

app.use((req, res, next) => {
    const allowedOrigin = process.env.FRONTEND_URL || req.headers.origin;
    if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
});

async function cleanupExpiredDocuments() {
    try {
        const now = Date.now();
        const orders = await db.listAllOrders();
        for (const order of orders) {
            if (!['printed', 'ready', 'picked'].includes(order.status) || !order.file_path) continue;
            const updatedAt = new Date(order.updated_at || order.created_at || 0).getTime();
            if (now - updatedAt < 2 * 24 * 60 * 60 * 1000) continue;
            const filePath = path.join(UPLOAD_DIR, order.file_path);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            await db.updateOrderStatus(order.id, { file_path: null, file_name: '' });
        }
    } catch (err) {
        console.error('Document cleanup failed:', err);
    }
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.set('trust proxy', 1);
app.use(session({
    secret: process.env.SESSION_SECRET || 'printflow-dev-secret-change-me',
    store: createSessionStore(),
    resave: false,
    saveUninitialized: false,
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000,
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: process.env.NODE_ENV === 'production' ? 'none' : 'lax',
    }
}));

async function initializeApp() {
    try {
        await db.initialize();
    } catch (err) {
        console.warn('Firebase initialization warning:', err.message);
    }

    cleanupExpiredDocuments();
    if (require.main === module) {
        setInterval(() => {
            cleanupExpiredDocuments();
        }, 6 * 60 * 60 * 1000);
    }
}

const initialization = initializeApp();
app.use((req, res, next) => {
    initialization.then(() => next()).catch(next);
});

// ── API routes ───────────────────────────────────────────────────────
app.use('/api/auth', require('./routes/auth'));
app.use('/api/services', require('./routes/services'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/owners', require('./routes/owners'));
app.use('/api/print-agent', require('./routes/print-agent'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/payment', require('./routes/payment'));

// ── Static frontend ──────────────────────────────────────────────────
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
const localFrontendDir = path.join(__dirname, '..', 'frontend', 'public');
const publicDir = fs.existsSync(path.join(__dirname, 'public'))
    ? path.join(__dirname, 'public')
    : localFrontendDir;
app.get('/', (req, res) => {
    if (fs.existsSync(path.join(publicDir, 'index.html'))) {
        return res.sendFile(path.join(publicDir, 'index.html'));
    }
    res.json({ ok: true, service: 'PrintFlow API' });
});
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// Basic error handler for multer / JSON parse errors
app.use((err, req, res, next) => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.message || 'Server error.' });
});

if (require.main === module) {
    initialization.then(() => {
    app.listen(PORT, () => {
        console.log(`PrintFlow server running at http://localhost:${PORT}`);
    });
    });
}

module.exports = app;