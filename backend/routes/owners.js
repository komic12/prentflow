const express = require('express');
const db = require('../db/database');

const router = express.Router();

// ── Owner: get notifications (requires owner session) ──────────────
router.get('/:id/notifications', async(req, res) => {
    try {
        const owner = await db.findOwnerById(req.params.id);
        if (!owner) return res.status(404).json({ error: 'Owner not found.' });
        const notes = await db.getNotificationsByOwner(owner.id);
        res.json({ notifications: notes });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load notifications.' });
    }
});

// ── Owner: notifications server-sent events stream (owner must be logged in) ─
router.get('/notifications/stream', async(req, res) => {
    try {
        if (!req.session || !req.session.user || req.session.user.role !== 'owner') {
            return res.status(401).end();
        }
        const ownerId = req.session.user.id;
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });
        res.write('\n');

        let unsub = null;
        try {
            const admin = require('firebase-admin');
            if (admin && admin.apps && admin.apps.length) {
                const firestore = admin.firestore();
                unsub = firestore.collection('notifications').where('owner_id', '==', ownerId).orderBy('created_at', 'desc')
                    .onSnapshot(snapshot => {
                        snapshot.docChanges().forEach(change => {
                            if (change.type === 'added' || change.type === 'modified') {
                                const data = { id: change.doc.id, ...change.doc.data() };
                                res.write(`event: notification\ndata: ${JSON.stringify(data)}\n\n`);
                            }
                        });
                    }, err => {
                        console.warn('SSE snapshot error:', err && err.message ? err.message : err);
                        res.write(`event: error\ndata: ${JSON.stringify({ message: 'Snapshot error' })}\n\n`);
                    });
            } else {
                // fallback: poll every 5s
                let lastTs = null;
                const poll = async() => {
                    const notes = await db.getNotificationsByOwner(ownerId);
                    const newNotes = notes.filter(n => !lastTs || (n.created_at && n.created_at > lastTs));
                    newNotes.forEach(n => res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`));
                    if (notes.length) lastTs = notes[0].created_at;
                };
                const iv = setInterval(poll, 5000);
                unsub = () => clearInterval(iv);
            }
        } catch (err) {
            console.warn('Failed to open firestore listener, falling back to poll:', err && err.message ? err.message : err);
            let lastTs = null;
            const poll = async() => {
                const notes = await db.getNotificationsByOwner(ownerId);
                const newNotes = notes.filter(n => !lastTs || (n.created_at && n.created_at > lastTs));
                newNotes.forEach(n => res.write(`event: notification\ndata: ${JSON.stringify(n)}\n\n`));
                if (notes.length) lastTs = notes[0].created_at;
            };
            const iv = setInterval(poll, 5000);
            unsub = () => clearInterval(iv);
        }

        req.on('close', () => {
            if (unsub) try { unsub(); } catch (_) {}
        });
    } catch (err) {
        console.error('SSE failed:', err);
        res.status(500).end();
    }
});

// ── Public: get one cafe's public info (customer-order.html) ────────
router.get('/:id', async(req, res) => {
    const owner = await db.getOwnerPublicById(req.params.id);
    if (!owner) return res.status(404).json({ error: 'Store not found.' });
    res.json({ owner });
});

// ── Public: search active cafes by name/location (scan.html finder) ─
router.get('/', async(req, res) => {
    const owners = await db.searchActiveOwners(req.query.q);
    res.json({ owners });
});

module.exports = router;