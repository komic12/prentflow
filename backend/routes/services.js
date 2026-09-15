const express = require('express');
const db = require('../db/database');
const { publicService } = require('../db/helpers');
const { requireRole } = require('../middleware/auth');
const router = express.Router();

// ── Owner: list own services (including disabled) ──────────────────
router.get('/mine', requireRole('owner'), async(req, res) => {
    try {
        const rows = await db.getServicesByOwner(req.session.user.id);
        res.json({ services: rows.map(publicService) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load services.' });
    }
});

// ── Public: enabled services for a given owner (customer order page) ─
router.get('/by-owner/:ownerId', async(req, res) => {
    try {
        const rows = await db.getServicesByOwner(req.params.ownerId, { enabledOnly: true });
        res.json({ services: rows.map(publicService) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load services.' });
    }
});

// ── Owner: add a service ────────────────────────────────────────────
router.post('/', requireRole('owner'), async(req, res) => {
    try {
        const { name, price_per_page } = req.body;
        if (!name || price_per_page == null || isNaN(price_per_page)) {
            return res.status(400).json({ error: 'Service name and price are required.' });
        }

        const svc = await db.createService(req.session.user.id, name.trim(), +price_per_page);
        res.json({ service: publicService(svc) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create service.' });
    }
});

// ── Owner: update a service (name / price / enabled) ───────────────
router.patch('/:id', requireRole('owner'), async(req, res) => {
    try {
        const svc = await db.getServiceById(req.params.id);
        if (!svc || svc.owner_id !== req.session.user.id) {
            return res.status(404).json({ error: 'Service not found.' });
        }

        const name = req.body.name != null ? req.body.name.trim() : svc.name;
        const price = req.body.price_per_page != null ? +req.body.price_per_page : svc.price_per_page;
        const enabled = req.body.enabled != null ? !!req.body.enabled : !!svc.enabled;

        const updated = await db.updateService(req.params.id, {
            name,
            price_per_page: price,
            enabled
        });
        res.json({ service: publicService(updated) });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update service.' });
    }
});

// ── Owner: delete a service ──────────────────────────────────────────
router.delete('/:id', requireRole('owner'), async(req, res) => {
    try {
        const svc = await db.getServiceById(req.params.id);
        if (!svc || svc.owner_id !== req.session.user.id) {
            return res.status(404).json({ error: 'Service not found.' });
        }
        await db.deleteService(req.params.id);
        res.json({ ok: true });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not delete service.' });
    }
});

module.exports = router;