const express = require('express');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const db = require('../db/database');

const router = express.Router();
const STATUS_FLOW = { pending: 'seen', seen: 'printing', printing: 'printed', printed: 'ready' };

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}
async function issueToken(owner) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.updateUserProfile(owner.id, {
        print_agent_token_hash: hashToken(token),
        print_agent_token_expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString()
    });
    return token;
}
function getBearer(req) {
    const value = req.headers.authorization || '';
    return value.startsWith('Bearer ') ? value.slice(7).trim() : '';
}
async function requireAgent(req, res, next) {
    const token = getBearer(req);
    if (!token) return res.status(401).json({ error: 'Agent token required.' });
    const owner = await db.findOwnerByAgentTokenHash(hashToken(token));
    if (!owner || !owner.print_agent_token_expires_at || new Date(owner.print_agent_token_expires_at).getTime() < Date.now()) return res.status(401).json({ error: 'Agent token expired. Please sign in again.' });
    if (!owner || owner.status !== 'Active') return res.status(403).json({ error: 'Owner account is not active.' });
    req.agentOwner = owner;
    req.agentToken = token;
    next();
}
function isPrintable(order) {
    return order && ['pending', 'seen'].includes(order.status) && (order.payment_status === 'paid' || order.payment_method === 'cash');
}
function toAgentJob(order) {
    const copies = Math.max(1, Number(order.copies || 1));
    return { id: order.id, orderCode: order.small_order_id || order.order_code, fileName: order.file_name || 'document', fileUrl: order.file_url || '/api/orders/' + order.id + '/file', filePath: order.file_path || null, color: String(order.color || 'B/W').toLowerCase().includes('color') ? 'color' : 'bw', pages: Number(order.page_count || order.pages || 1), copies, printCopies: copies, sided: order.sided || 'one-sided', paperSize: order.paper_size || 'A4', orientation: order.orientation || 'portrait', customer: order.customer_name || 'Walk-in customer', instructions: order.print_instructions || '', status: order.status, paymentStatus: order.payment_status, paymentMethod: order.payment_method, printable: isPrintable(order), createdAt: order.created_at, selectedPages: order.selected_pages || 'all', totalPrice: order.total_price };
}

router.post('/auth/login', async (req, res) => {
    try {
        const email = String(req.body.email || '').trim().toLowerCase();
        const password = String(req.body.password || '').trim();
        if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });
        const user = await db.getUserByEmail(email);
        const bcrypt = require('bcryptjs');
        if (!user || user.role !== 'owner' || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(401).json({ error: 'Invalid cyber owner email or password.' });
        }
        if (user.status !== 'Active') return res.status(403).json({ error: `Account is ${user.status}.` });
        const token = await issueToken(user);
        await db.updateUserProfile(user.id, {
            print_agent_connected: true,
            print_agent_last_seen: new Date().toISOString(),
            print_agent_settings: user.print_agent_settings || { autoPrint: false, colorPrinter: '', bwPrinter: '' }
        });
        res.json({ ok: true, token, owner: { id: user.id, name: user.name, email: user.email, shop_name: user.shop_name }, settings: user.print_agent_settings || { autoPrint: false, colorPrinter: '', bwPrinter: '' } });
    } catch (err) {
        console.error('Print agent login failed:', err);
        res.status(500).json({ error: 'Agent login failed.' });
    }
});

router.post('/auth/logout', requireAgent, async (req, res) => {
    await db.updateUserProfile(req.agentOwner.id, { print_agent_token_hash: null, print_agent_token_expires_at: null, print_agent_connected: false, print_agent_last_seen: new Date().toISOString() });
    res.json({ ok: true });
});

router.get('/health', requireAgent, async (req, res) => {
    await db.updateUserProfile(req.agentOwner.id, { print_agent_connected: true, print_agent_last_seen: new Date().toISOString() });
    res.json({ ok: true, connected: true, owner: { id: req.agentOwner.id, email: req.agentOwner.email, shop_name: req.agentOwner.shop_name } });
});

router.get('/settings', requireAgent, async (req, res) => {
    const owner = await db.findOwnerById(req.agentOwner.id);
    res.json({ settings: owner.print_agent_settings || { autoPrint: false, colorPrinter: '', bwPrinter: '' } });
});

router.patch('/settings', requireAgent, async (req, res) => {
    const current = req.agentOwner.print_agent_settings || {};
    const next = {
        autoPrint: Boolean(req.body.autoPrint ?? current.autoPrint),
        colorPrinter: String(req.body.colorPrinter ?? current.colorPrinter ?? ''),
        bwPrinter: String(req.body.bwPrinter ?? current.bwPrinter ?? ''),
        receiptPrinter: String(req.body.receiptPrinter ?? current.receiptPrinter ?? '')
    };
    const owner = await db.updateUserProfile(req.agentOwner.id, { print_agent_settings: next, print_agent_connected: true, print_agent_last_seen: new Date().toISOString() });
    res.json({ settings: owner.print_agent_settings });
});

router.get('/jobs', requireAgent, async (req, res) => {
    const orders = await db.listOrdersByOwner(req.agentOwner.id);
    const jobs = orders.slice(0, 100).map(toAgentJob);
    await db.updateUserProfile(req.agentOwner.id, { print_agent_connected: true, print_agent_last_seen: new Date().toISOString() });
    res.json({ jobs });
});
router.post('/jobs/:id/claim', requireAgent, async (req, res) => {
    const order = await db.getOrderById(req.params.id);
    if (!order || order.owner_id !== req.agentOwner.id) return res.status(404).json({ error: 'Print job not found.' });
    if (!isPrintable(order) && order.status !== 'printing') return res.status(409).json({ error: 'Print job is no longer available.' });
    const updated = await db.updateOrderStatus(order.id, { status: 'printing', print_agent_id: req.body.agentId || 'windows-agent', print_agent_started_at: new Date().toISOString() });
    res.json({ job: updated });
});

router.post('/jobs/:id/progress', requireAgent, async (req, res) => {
    const order = await db.getOrderById(req.params.id);
    if (!order || order.owner_id !== req.agentOwner.id) return res.status(404).json({ error: 'Print job not found.' });
    const event = String(req.body.event || 'progress');
    const allowed = ['queued', 'printing_odd', 'odd_pages_done', 'waiting_for_paper_turn', 'printing_even', 'duplex_done', 'receipt_printing', 'completed', 'failed'];
    if (!allowed.includes(event)) return res.status(400).json({ error: 'Unsupported progress event.' });
    const patch = { print_agent_last_event: event, print_agent_message: String(req.body.message || ''), print_agent_updated_at: new Date().toISOString() };
    if (event === 'completed' || event === 'duplex_done') patch.status = 'printed';
    if (event === 'failed') patch.print_agent_error = String(req.body.message || 'Printing failed.');
    const updated = await db.updateOrderStatus(order.id, patch);
    await db.createNotification(req.agentOwner.id, { title: `Print agent: ${event.replaceAll('_', ' ')}`, body: `${updated.small_order_id || updated.order_code}: ${patch.print_agent_message || event}`, order_id: updated.id });
    res.json({ ok: true, order: updated });
});

router.get('/jobs/:id/file', requireAgent, async (req, res) => {
    const order = await db.getOrderById(req.params.id);
    if (!order || order.owner_id !== req.agentOwner.id) return res.status(404).end();
    if (order.file_path) return res.sendFile(require('path').join(__dirname, '..', 'uploads', order.file_path));
    if (order.file_storage_path && order.file_url) return res.redirect(order.file_url);
    res.status(404).json({ error: 'Print file is not available.' });
});

module.exports = router;
