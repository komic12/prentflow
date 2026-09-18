const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('../db/database');
const { publicUser } = require('../db/helpers');
const { sendMail } = require('../lib/mailer');
const { supabase, supabaseConfigured, storageBucket } = require('../db/supabase');

const router = express.Router();
const PROFILE_UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'profiles');
if (!fs.existsSync(PROFILE_UPLOAD_DIR)) fs.mkdirSync(PROFILE_UPLOAD_DIR, { recursive: true });

const profileUpload = multer({
    storage: supabaseConfigured && process.env.SUPABASE_ENABLED !== 'false' ? multer.memoryStorage() : multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, PROFILE_UPLOAD_DIR),
        filename: (_req, file, cb) => {
            const ext = path.extname(file.originalname) || '.jpg';
            cb(null, `profile-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
        }
    }),
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Only image files are allowed.'))
});

const DEFAULT_SERVICES = [
    { name: 'B/W Print', price_per_page: 5 },
    { name: 'Color Print', price_per_page: 25 },
    { name: 'Spiral Binding', price_per_page: 150 },
    { name: 'Lamination', price_per_page: 50 }
];

async function trySendMail(message) {
    try {
        await sendMail(message);
        return true;
    } catch (error) {
        console.warn('Email notification skipped:', error.message || error);
        return false;
    }
}

// ── Register (cafe owner sign-up) ───────────────────────────────────
router.post('/register', async(req, res) => {
    try {
        let { name, shop_name, email, phone, location, password } = req.body;
        name = (name || '').trim();
        shop_name = (shop_name || '').trim();
        email = (email || '').trim().toLowerCase();
        password = (password || '').trim();

        if (!name || !shop_name || !email || !password) {
            return res.status(400).json({ error: 'Name, shop, email and password are required.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }

        const existing = await db.getUserByEmail(email);
        if (existing) return res.status(409).json({ error: 'Email already registered.' });

        let authUser = null;
        if (supabaseConfigured && process.env.SUPABASE_ENABLED !== 'false') {
            const { data, error } = await supabase.auth.admin.createUser({
                email,
                password,
                email_confirm: process.env.SUPABASE_AUTO_CONFIRM_EMAIL !== 'false',
                user_metadata: { name, shop_name, phone: phone || '', location: location || '' }
            });
            if (error) return res.status(error.status === 422 ? 409 : 400).json({ error: error.message });
            authUser = data.user;
        }

        const owner = await db.createOwner({
            id: authUser ? authUser.id : undefined,
            name,
            email,
            password_hash: authUser ? '' : bcrypt.hashSync(password, 10),
            role: 'owner',
            shop_name,
            phone: phone || '',
            location: location || '',
            status: 'Active',
            subscription_plan: 'Plan_A',
            subscription_active: false,
            subscription_expiry: null,
            created_at: new Date().toISOString()
        });

        for (const service of DEFAULT_SERVICES) {
            await db.createService(owner.id, service.name, service.price_per_page);
        }

        await trySendMail({
            to: owner.email,
            subject: 'Welcome to PrintFlow',
            html: `<p>Hi ${name},</p><p>Thank you for registering your cyber cafe on PrintFlow. Your store is ready to receive print orders.</p><p>Regards,<br/>PrintFlow Team</p>`
        });

        res.json({ ok: true, message: 'Registration successful! You can now sign in.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Registration failed.' });
    }
});

// ── Login (owner or admin) ──────────────────────────────────────────
router.post('/login', async(req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const password = (req.body.password || '').trim();

        if (!email || !password) {
            return res.status(400).json({ error: 'Please fill in all fields.' });
        }

        const user = await db.getUserByEmail(email);
        const envAdminEmail = (process.env.ADMIN_EMAIL || 'printflow205@gmail.com').trim().toLowerCase();
        const envAdminPassword = (process.env.ADMIN_PASSWORD || 'admin123').trim();
        let passwordValid = !!user && !!user.password_hash && bcrypt.compareSync(password, user.password_hash);
        if (user && user.role !== 'admin' && supabaseConfigured && process.env.SUPABASE_ENABLED !== 'false') {
            const { error } = await supabase.auth.signInWithPassword({ email, password });
            passwordValid = !error;
        }
        const envAdminValid = email === envAdminEmail && password === envAdminPassword;
        if (!user || (!passwordValid && !envAdminValid)) {
            return res.status(401).json({ error: 'Invalid email or password.' });
        }
        if (user.status !== 'Active') {
            return res.status(403).json({ error: `Account is ${user.status}. Contact admin.` });
        }

        if (user.role === 'admin' || envAdminValid) {
            req.session.user = { id: user.id, role: user.role, email: user.email };
            return res.json({ ok: true, requiresOtp: false, user: publicUser(user) });
        }

        const otp = String(Math.floor(100000 + Math.random() * 900000)).padStart(6, '0');
        const expiresAt = new Date(Date.now() + 2 * 60 * 1000).toISOString();
        await db.clearLoginOtp(user.id);
        await db.setLoginOtp(user.id, otp, expiresAt);
        const otpSent = await trySendMail({
            to: user.email,
            subject: 'PrintFlow sign-in verification code',
            html: `<p>Hello ${user.name || 'there'},</p><p>Your one-time password is <strong>${otp}</strong>. It expires in 2 minutes.</p><p>Use it to complete sign in.</p>`
        });

        if (!otpSent) {
            req.session.user = { id: user.id, role: user.role, email: user.email };
            return res.json({ ok: true, requiresOtp: false, user: publicUser(user), warning: 'Email verification was unavailable; signed in with your password.' });
        }

        res.json({ ok: true, requiresOtp: true, email: user.email });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Login failed.' });
    }
});

router.post('/login/verify', async(req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        const otp = (req.body.otp || '').trim();
        if (!email || !otp) return res.status(400).json({ error: 'OTP is required.' });
        const user = await db.getUserByEmail(email);
        if (!user) return res.status(401).json({ error: 'Invalid request.' });
        const valid = await db.verifyLoginOtp(user.id, otp);
        if (!valid) return res.status(401).json({ error: 'Invalid or expired OTP.' });
        await db.clearLoginOtp(user.id);
        req.session.user = { id: user.id, role: user.role, email: user.email };
        res.json({ ok: true, user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'OTP verification failed.' });
    }
});

// ── Logout ───────────────────────────────────────────────────────────
router.post('/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

// ── Current session ──────────────────────────────────────────────────
router.get('/me', async(req, res) => {
    try {
        if (!req.session.user) return res.json({ user: null });
        const user = await db.getUserById(req.session.user.id);
        if (!user || user.status !== 'Active') {
            req.session.destroy(() => {});
            return res.json({ user: null });
        }
        res.json({ user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load user.' });
    }
});

// ── Request password reset link ────────────────────────────────────
router.post('/forgot-password', async(req, res) => {
    try {
        const email = (req.body.email || '').trim().toLowerCase();
        if (!email) return res.status(400).json({ error: 'Email is required.' });
        const user = await db.getUserByEmail(email);
        if (!user) return res.status(200).json({ ok: true, message: 'If that account exists, a reset link has been emailed.' });
        const token = crypto.randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
        await db.setPasswordResetToken(user.id, token, expiresAt);
        const resetUrl = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password.html?token=${token}`;
        await sendMail({
            to: user.email,
            subject: 'Reset your PrintFlow password',
            html: `<p>Hello ${user.name || 'there'},</p><p>Use the link below to reset your password.</p><p><a href="${resetUrl}">${resetUrl}</a></p><p>This link expires in 1 hour.</p>`
        });
        res.json({ ok: true, message: 'If that account exists, a reset link has been emailed.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not process password reset.' });
    }
});

router.post('/reset-password', async(req, res) => {
    try {
        const { token, password, confirmPassword } = req.body;
        if (!token || !password || !confirmPassword) return res.status(400).json({ error: 'All fields are required.' });
        if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        if (password !== confirmPassword) return res.status(400).json({ error: 'Passwords do not match.' });
        const user = await db.findUserByResetToken(token);
        if (!user || !user.reset_expires_at || new Date(user.reset_expires_at).getTime() < Date.now()) {
            return res.status(400).json({ error: 'Reset link is invalid or expired.' });
        }
        await db.updateUserPassword(user.id, bcrypt.hashSync(password, 10));
        await db.clearPasswordResetToken(user.id);
        res.json({ ok: true, message: 'Password updated successfully.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not reset password.' });
    }
});

// ── Print agent status for the signed-in owner ───────────────────────
router.get('/agent-status', async (req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
        const owner = await db.findOwnerById(req.session.user.id);
        if (!owner) return res.status(403).json({ error: 'Owner account required.' });
        const lastSeen = owner.print_agent_last_seen ? new Date(owner.print_agent_last_seen).getTime() : 0;
        const connected = Boolean(owner.print_agent_connected) && lastSeen > Date.now() - 90000;
        res.json({ connected, owner: { id: owner.id, name: owner.name, email: owner.email, shop_name: owner.shop_name }, lastSeen: owner.print_agent_last_seen || null, settings: owner.print_agent_settings || { autoPrint: false, colorPrinter: '', bwPrinter: '', receiptPrinter: '' } });
    } catch (err) { res.status(500).json({ error: 'Could not read print agent status.' }); }
});

// ── Update own profile (owner) ──────────────────────────────────────
router.patch('/profile', profileUpload.single('profile_image'), async(req, res) => {
    try {
        if (!req.session.user) return res.status(401).json({ error: 'Not authenticated' });
        const { name, shop_name, phone, location } = req.body;
        const updates = {
            name: (name || '').trim(),
            shop_name: (shop_name || '').trim(),
            phone: (phone || '').trim(),
            location: (location || '').trim()
        };
        if (req.file) {
            if (supabaseConfigured && process.env.SUPABASE_ENABLED !== 'false') {
                const storagePath = `profiles/${req.session.user.id}/${Date.now()}${path.extname(req.file.originalname) || '.jpg'}`;
                const { error } = await supabase.storage.from(storageBucket).upload(storagePath, req.file.buffer, {
                    contentType: req.file.mimetype,
                    upsert: true
                });
                if (error) throw error;
                const { data, error: signedError } = await supabase.storage.from(storageBucket).createSignedUrl(storagePath, 7 * 24 * 60 * 60);
                if (signedError) throw signedError;
                updates.profile_image = data.signedUrl;
            } else {
                updates.profile_image = req.file.filename;
            }
        }

        const user = await db.updateUserProfile(req.session.user.id, updates);
        res.json({ user: publicUser(user) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update profile.' });
    }
});

module.exports = router;