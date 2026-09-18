const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const admin = require('firebase-admin');
const db = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { processDocumentUpload, extractSelectedPages, createThumbnailSvg, getSignedUrlForPath, uploadBufferToFirebase, downloadBufferFromStorage } = require('../services/documentService');

const router = express.Router();
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents', 'incoming');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
    filename: (_req, file, cb) => {
        const safe = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
        cb(null, safe);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        const allowed = /\.(pdf|doc|docx|jpg|jpeg|png)$/i;
        if (!allowed.test(file.originalname)) return cb(new Error('Unsupported file type.'));
        cb(null, true);
    }
});

function authorizeDocumentOwner(req, res, next) {
    const document = req.document;
    if (!document) return res.status(404).json({ error: 'Document not found.' });
    if (req.user.role !== 'admin' && document.ownerId !== req.user.id) {
        return res.status(403).json({ error: 'Forbidden. You do not own this document.' });
    }
    next();
}

router.post('/', requireAuth, upload.single('file'), async(req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        const ownerId = req.user.id;
        const { document, pages } = await processDocumentUpload(req.file, ownerId);
        res.json({ document, pages });
    } catch (err) {
        console.error('Document upload failed:', err);
        res.status(500).json({ error: err.message || 'Could not process upload.' });
    }
});

router.get('/:id', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});
        const pages = await db.listPagesByDocumentId(document.id);
        res.json({ document, pages });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load document.' });
    }
});

router.get('/:id/pages', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});
        const pages = await db.listPagesByDocumentId(document.id);
        res.json({ pages });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load pages.' });
    }
});

router.get('/:id/pages/:pageNumber/thumbnail', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).send('Not found');
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});
        const pageNumber = Number(req.params.pageNumber);
        res.setHeader('Content-Type', 'image/svg+xml');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        res.send(createThumbnailSvg(document.fileName, pageNumber));
    } catch (err) {
        console.error(err);
        res.status(500).send('Cannot render thumbnail');
    }
});

router.get('/:id/pages/:pageNumber/pdf', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).send('Not found');
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});

        const pageNumber = Number(req.params.pageNumber);
        const pages = await db.listPagesByDocumentId(document.id);
        const page = pages.find(p => Number(p.pageNumber) === pageNumber);
        if (!page || !page.pageStoragePath) return res.status(404).send('Page not found');

        const signedUrl = await getSignedUrlForPath(page.pageStoragePath);
        return res.redirect(signedUrl);
    } catch (err) {
        console.error(err);
        res.status(500).send('Cannot load page PDF');
    }
});

router.get('/:id/download', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});
        const signedUrl = await getSignedUrlForPath(document.storagePath);
        res.json({ url: signedUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not create download URL.' });
    }
});

router.post('/:id/extract', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});
        const selectedPages = Array.isArray(req.body.selectedPages) ? req.body.selectedPages : [];
        if (!selectedPages.length) return res.status(400).json({ error: 'No pages selected.' });

        const buffer = await downloadBufferFromStorage(document.storagePath);
        const extractedPdf = await extractSelectedPages(buffer, selectedPages);

        if (req.query.download === '1') {
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${document.fileName || 'extracted'}.pdf"`);
            return res.send(Buffer.from(extractedPdf));
        }

        res.json({ message: 'Extracted document ready' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not extract selected pages.' });
    }
});

router.post('/:id/submit', requireAuth, async(req, res) => {
    try {
        const document = await db.getDocumentById(req.params.id);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        req.document = document;
        authorizeDocumentOwner(req, res, () => {});

        const selectedPages = Array.isArray(req.body.selectedPages) ? req.body.selectedPages : [];
        if (!selectedPages.length) return res.status(400).json({ error: 'No pages selected.' });

        const buffer = await downloadBufferFromStorage(document.storagePath);
        const extractedPdf = await extractSelectedPages(buffer, selectedPages);

        const submission = await db.createSubmission({
            documentId: document.id,
            extractedDocumentId: `extracted_${document.id}_${Date.now()}`,
            selectedPages,
            totalSelectedPages: selectedPages.length,
            submittedBy: req.user.id,
            submittedAt: new Date().toISOString(),
            status: 'pending'
        });

        const submissionPath = `submissions/${document.ownerId}/${submission.id}/extracted.pdf`;
        const uploadResult = await uploadBufferToFirebase(Buffer.from(extractedPdf), submissionPath, 'application/pdf');
        await db.updateSubmission(submission.id, {
            extractedDocumentStoragePath: uploadResult.storagePath,
            extractedDocumentUrl: uploadResult.signedUrl
        });

        await db.logEvent(req.user.id, 'document_submission', {
            documentId: document.id,
            submissionId: submission.id,
            selectedPages: submission.selectedPages
        });

        res.json({ submission: await db.getSubmissionById(submission.id), url: uploadResult.signedUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: err.message || 'Could not submit extracted document.' });
    }
});

router.get('/submissions/:submissionId', requireAuth, async(req, res) => {
    try {
        const submission = await db.getSubmissionById(req.params.submissionId);
        if (!submission) return res.status(404).json({ error: 'Submission not found.' });
        const document = await db.getDocumentById(submission.documentId);
        if (!document) return res.status(404).json({ error: 'Document not found.' });
        if (req.user.role !== 'admin' && document.ownerId !== req.user.id) {
            return res.status(403).json({ error: 'Forbidden.' });
        }
        const signedUrl = submission.extractedDocumentStoragePath ? await getSignedUrlForPath(submission.extractedDocumentStoragePath) : null;
        res.json({ submission: {...submission, extractedDocumentUrl: signedUrl } });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load submission.' });
    }
});

module.exports = router;