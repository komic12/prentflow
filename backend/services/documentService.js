const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { PDFDocument } = require('pdf-lib');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const admin = require('firebase-admin');
const db = require('../db/database');

const TEMP_DIR = path.join(__dirname, '..', 'uploads', 'document-processing');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

function ensureBucket() {
    const bucket = admin.storage().bucket();
    if (!bucket) throw new Error('Firebase Storage bucket is not configured.');
    return bucket;
}

async function uploadBufferToFirebase(buffer, destinationPath, contentType = 'application/pdf') {
    const bucket = ensureBucket();
    const file = bucket.file(destinationPath);
    await file.save(buffer, {
        contentType,
        resumable: false,
        metadata: {
            cacheControl: 'public, max-age=3600'
        }
    });
    await file.makePrivate();
    const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
    });
    return { storagePath: destinationPath, signedUrl };
}

async function countPdfPages(pdfBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
    const pdf = await loadingTask.promise;
    return pdf.numPages || 0;
}

async function extractTextByPage(pdfBuffer) {
    const loadingTask = pdfjsLib.getDocument({ data: pdfBuffer });
    const pdf = await loadingTask.promise;
    const texts = [];

    for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
        const page = await pdf.getPage(pageIndex);
        const content = await page.getTextContent();
        const text = content.items.map(item => item.str).join(' ');
        texts.push(text || '');
    }

    return texts;
}

async function splitPdfIntoPageBuffers(pdfBuffer) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const total = pdfDoc.getPageCount();
    const pages = [];

    for (let index = 0; index < total; index += 1) {
        const newPdf = await PDFDocument.create();
        const [copiedPage] = await newPdf.copyPages(pdfDoc, [index]);
        newPdf.addPage(copiedPage);
        const buffer = await newPdf.save();
        pages.push(buffer);
    }

    return pages;
}

async function extractSelectedPages(pdfBuffer, selectedPageNumbers) {
    const pdfDoc = await PDFDocument.load(pdfBuffer);
    const output = await PDFDocument.create();
    const validIndexes = Array.from(new Set(selectedPageNumbers.map(n => Number(n) - 1))).filter(n => Number.isInteger(n) && n >= 0 && n < pdfDoc.getPageCount());
    if (!validIndexes.length) throw new Error('No valid page numbers provided.');
    const copiedPages = await output.copyPages(pdfDoc, validIndexes);
    copiedPages.forEach(page => output.addPage(page));
    return await output.save();
}

function sanitizeFileName(name) {
    return name.replace(/[^a-zA-Z0-9-_\. ]+/g, '-').trim();
}

function createThumbnailSvg(documentName, pageNumber) {
    const title = documentName || 'Page';
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="320" viewBox="0 0 240 320">
  <rect width="240" height="320" rx="20" ry="20" fill="#f8fafc" stroke="#cbd5e1" stroke-width="4" />
  <text x="50%" y="38%" text-anchor="middle" fill="#334155" font-family="Arial, sans-serif" font-size="24" font-weight="700">${title}</text>
  <text x="50%" y="54%" text-anchor="middle" fill="#64748b" font-family="Arial, sans-serif" font-size="18">Page ${pageNumber}</text>
  <text x="50%" y="70%" text-anchor="middle" fill="#94a3b8" font-family="Arial, sans-serif" font-size="14">Extracted Thumbnail</text>
</svg>`;
}

async function convertOfficeToPdf(sourcePath, outDir) {
    const outputName = `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`;
    const outputPath = path.join(outDir, outputName);
    await fs.promises.unlink(outputPath).catch(() => {});
    const soffice = process.platform === 'win32' ? 'soffice.exe' : 'soffice';

    return new Promise((resolve, reject) => {
        const child = spawn(soffice, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, sourcePath], {
            stdio: 'ignore'
        });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('LibreOffice conversion timed out.'));
        }, 30000);

        child.on('error', err => {
            clearTimeout(timeout);
            reject(err);
        });

        child.on('exit', code => {
            clearTimeout(timeout);
            if (code === 0 && fs.existsSync(outputPath)) {
                resolve(outputPath);
            } else {
                reject(new Error(`LibreOffice conversion failed with code ${code}.`));
            }
        });
    });
}

async function processDocumentUpload(file, ownerId) {
    const ext = path.extname(file.originalname).toLowerCase();
    const fileName = sanitizeFileName(file.originalname);
    const originalBuffer = fs.readFileSync(file.path);
    const originalStoragePath = `documents/${ownerId}/${Date.now()}-${fileName}`;
    const originalUpload = await uploadBufferToFirebase(originalBuffer, originalStoragePath, file.mimetype || 'application/octet-stream');

    let pdfBuffer = originalBuffer;
    if (ext === '.doc' || ext === '.docx') {
        const convertedPdfPath = await convertOfficeToPdf(file.path, path.dirname(file.path));
        pdfBuffer = fs.readFileSync(convertedPdfPath);
    }

    const totalPages = await countPdfPages(pdfBuffer);
    const pageTexts = await extractTextByPage(pdfBuffer);
    const pageBuffers = await splitPdfIntoPageBuffers(pdfBuffer);

    const document = await db.createDocument({
        fileName,
        ownerId,
        totalPages,
        fileType: ext.replace('.', ''),
        storagePath: originalUpload.storagePath,
        uploadedAt: new Date().toISOString(),
        status: 'uploaded'
    });

    const pages = [];
    for (let pageIndex = 0; pageIndex < pageBuffers.length; pageIndex += 1) {
        const pageNumber = pageIndex + 1;
        const pageId = `page_${document.id}_${pageNumber}`;
        const pagePath = `documents/${ownerId}/${document.id}/pages/page_${pageNumber}.pdf`;
        await uploadBufferToFirebase(pageBuffers[pageIndex], pagePath, 'application/pdf');
        const thumbnailUrl = `/api/documents/${document.id}/pages/${pageNumber}/thumbnail`;

        const page = await db.createPage({
            pageId,
            documentId: document.id,
            pageNumber,
            thumbnailUrl,
            extractedText: pageTexts[pageIndex] || '',
            pageStoragePath: pagePath,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        pages.push(page);
    }

    await db.logEvent(ownerId, 'document_upload', {
        documentId: document.id,
        fileName,
        totalPages,
        storagePath: originalUpload.storagePath
    });

    return { document, pages };
}

async function getSignedUrlForPath(storagePath) {
    const bucket = ensureBucket();
    const file = bucket.file(storagePath);
    const [signedUrl] = await file.getSignedUrl({
        action: 'read',
        expires: Date.now() + 7 * 24 * 60 * 60 * 1000
    });
    return signedUrl;
}

module.exports = {
    processDocumentUpload,
    extractSelectedPages,
    createThumbnailSvg,
    getSignedUrlForPath,
    uploadBufferToFirebase,
    convertOfficeToPdf,
    countPdfPages
};