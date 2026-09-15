const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const multer = require('multer');
const mammoth = require('mammoth');
let PDFParse;
function getPDFParse() { if (!PDFParse) PDFParse = require('pdf-parse').PDFParse; return PDFParse; }
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const db = require('../db/database');
const { supabase, storageBucket } = require('../db/supabase');
const { requireRole } = require('../middleware/auth');
const { generateOrderCode, generateSmallId, calculateSplit } = require('../db/helpers');
const { sendMail } = require('../lib/mailer');
const mpesa = require("../services/mpesa");
const buni = require("../services/buni");
const buniConfig = require("../config/buniConfig");
const router = express.Router();

function calculateServiceSubtotal(pages, copies, pricePerPage) {
    const basePageTotal = pages * pricePerPage;
    return +(basePageTotal * copies).toFixed(2);
}

async function parsePdfBuffer(buffer) {
    const [document, parser] = await Promise.all([
        PDFDocument.load(buffer),
        Promise.resolve(new (getPDFParse())({ data: buffer }))
    ]);
    const textResult = await parser.getText();
    if (typeof parser.destroy === 'function') await parser.destroy();
    return {
        text: textResult.text || '',
        numpages: document.getPageCount()
    };
}

// ── File upload config ──────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const safe = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
        cb(null, safe);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
    fileFilter: (req, file, cb) => {
        const allowed = /\.(pdf|doc|docx|jpg|jpeg|png|ppt|pptx|xls|xlsx|txt)$/i;
        if (!allowed.test(file.originalname)) return cb(new Error('Unsupported file type.'));
        cb(null, true);
    }
});

const previewStorage = multer.diskStorage({
    destination: (req, file, cb) => {
        const previewDir = path.join(UPLOAD_DIR, 'previews');
        if (!fs.existsSync(previewDir)) fs.mkdirSync(previewDir, { recursive: true });
        cb(null, previewDir);
    },
    filename: (req, file, cb) => {
        const safe = Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname);
        cb(null, safe);
    }
});
const previewUpload = multer({
    storage: previewStorage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = /\.(pdf|doc|docx|jpg|jpeg|png|ppt|pptx|xls|xlsx|txt)$/i;
        if (!allowed.test(file.originalname)) return cb(new Error('Unsupported file type.'));
        cb(null, true);
    }
});

async function uploadToSupabase(localPath, dest, contentType) {
    if (!storageBucket) throw new Error('Supabase storage bucket is not configured.');
    const fileBuffer = fs.readFileSync(localPath);
    const { data, error } = await supabase.storage.from(storageBucket).upload(dest, fileBuffer, {
        contentType,
        upsert: true
    });
    if (error) throw error;
    const signedExpiry = 7 * 24 * 60 * 60;
    const { data: signedData, error: signedError } = await supabase.storage.from(storageBucket).createSignedUrl(dest, signedExpiry);
    if (signedError) {
        console.warn('Supabase upload succeeded but signed URL creation failed:', signedError.message || signedError);
    }
    return { storagePath: dest, fileUrl: (signedData && signedData.signedUrl) || '' };
}

async function fetchSupabaseFileBuffer(storagePath) {
    if (!storageBucket) throw new Error('Supabase storage bucket is not configured.');
    const { data, error } = await supabase.storage.from(storageBucket).createSignedUrl(storagePath, 60);
    if (error || !data || !data.signedUrl) throw error || new Error('Could not create signed URL for preview.');
    const response = await fetch(data.signedUrl);
    if (!response.ok) throw new Error('Could not download remote preview file.');
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
}

async function getOrderLocalFilePath(order) {
    if (!order) return null;
    if (order.file_path) {
        const localPath = path.join(UPLOAD_DIR, order.file_path);
        if (fs.existsSync(localPath)) return localPath;
    }
    return null;
}

async function getRemoteOrderFileUrl(order) {
    if (!order || !order.file_storage_path) return null;
    if (!storageBucket) return null;
    const { data, error } = await supabase.storage.from(storageBucket).createSignedUrl(order.file_storage_path, 7 * 24 * 60 * 60);
    if (error) throw error;
    return (data && data.signedUrl) || null;
}

async function getOrderFileBuffer(order) {
    const local = await getOrderLocalFilePath(order);
    if (local) return fs.readFileSync(local);
    if (order.file_storage_path) return await fetchSupabaseFileBuffer(order.file_storage_path);
    throw new Error('No file available for preview.');
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

const STATUS_FLOW = { pending: 'seen', seen: 'printing', printing: 'printed', printed: 'ready', ready: 'picked' };

// ── Public: create a previewable temp copy of the uploaded file ─────
router.post('/preview', previewUpload.single('file'), async(req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });
        const filePath = req.file.path;
        const ext = path.extname(req.file.originalname).toLowerCase();
        const fileName = req.file.originalname;
        const relativePath = path.posix.join('/uploads/previews', path.basename(filePath));
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const fileUrl = `${baseUrl}${relativePath}`;

        if (ext === '.pdf') {
            const buffer = fs.readFileSync(filePath);
            const pdfData = await parsePdfBuffer(buffer);
            return res.json({ kind: 'pdf', fileName, fileUrl, ext, pages: pdfData.numpages || 1, viewUrl: fileUrl });
        }

        if (ext === '.docx' || ext === '.doc') {
            try {
                const pdfPath = await convertOfficeToPdf(filePath, path.dirname(filePath));
                const pdfUrl = `${baseUrl}${path.posix.join('/uploads/previews', path.basename(pdfPath))}`;
                const pdfBuf = fs.readFileSync(pdfPath);
                    const pdfData = await parsePdfBuffer(pdfBuf);
                return res.json({ kind: 'pdf', fileName, fileUrl: pdfUrl, ext: '.pdf', pages: pdfData.numpages || 1, viewUrl: pdfUrl });
            } catch (conversionError) {
                console.error('Document conversion failed:', conversionError);
                if (ext === '.docx') {
                    const { value } = await mammoth.extractRawText({ path: filePath });
                    return res.json({ kind: 'text', fileName, fileUrl, ext, content: value || '', pages: 1, viewUrl: fileUrl });
                }
                const viewUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`;
                return res.json({ kind: 'office', fileName, fileUrl, ext, pages: 1, viewUrl });
            }
        }

        if (ext === '.txt') {
            const content = fs.readFileSync(filePath, 'utf8');
            return res.json({ kind: 'text', fileName, fileUrl, ext, content, pages: 1, viewUrl: fileUrl });
        }

        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
            return res.json({ kind: 'image', fileName, fileUrl, ext, pages: 1, viewUrl: fileUrl });
        }

        if (['.ppt', '.pptx', '.xls', '.xlsx'].includes(ext)) {
            const viewUrl = `https://view.officeapps.live.com/op/embed.aspx?src=${encodeURIComponent(fileUrl)}`;
            return res.json({ kind: 'office', fileName, fileUrl, ext, pages: 1, viewUrl });
        }

        return res.json({ kind: 'unsupported', fileName, fileUrl, ext, pages: 1, viewUrl: fileUrl });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not preview document.' });
    }
});

router.post('/', upload.single('file'), async(req, res) => {
    try {
        const ownerId = (req.body.owner_id || '').trim();
        const owner = await db.findOwnerById(ownerId);
        if (!owner) return res.status(404).json({ error: 'Store not found.' });
        if (owner.status !== 'Active') return res.status(403).json({ error: `This store is currently ${owner.status}.` });

        let services;
        try { services = JSON.parse(req.body.services_json || '[]'); } catch { services = []; }
        if (!Array.isArray(services) || services.length === 0) {
            return res.status(400).json({ error: 'At least one service must be selected.' });
        }

        const enabledServices = await db.getServicesByOwner(ownerId, { enabledOnly: true });
        const svcById = Object.fromEntries(enabledServices.map(s => [String(s.id), s]));

        const servicesArr = services.map(s => {
            const real = svcById[String(s.id)];
            if (!real) throw new Error('One of the selected services is no longer available.');
            const pages = Math.max(1, parseInt(s.pages, 10) || 1);
            const copies = Math.max(1, parseInt(s.copies, 10) || 1);
            const subtotal = calculateServiceSubtotal(pages, copies, real.price_per_page);
            return { id: real.id, name: real.name, price: real.price_per_page, pages, copies, color: s.color || 'B/W', subtotal };
        });

        const totalPrice = +servicesArr.reduce((a, item) => a + item.subtotal, 0).toFixed(2);
        const paymentMethod = req.body.payment_method === 'cash' ? 'cash' : 'mpesa';
        const printedPages = servicesArr.reduce((sum, service) => sum + (service.pages * service.copies), 0);
        const orderCode = generateOrderCode();
        const smallId = await generateSmallId(ownerId, db);
        const mainSvc = servicesArr[0] || {};
        // determine page count from uploaded file when possible
        let computedPageCount = parseInt(req.body.page_count, 10) || 1;
        try {
            if (req.file) {
                const actualPath = path.join(UPLOAD_DIR, req.file.filename);
                const ext2 = path.extname(req.file.originalname || '').toLowerCase();
                if (ext2 === '.pdf') {
                    const buf = fs.readFileSync(actualPath);
                    const pdfData2 = await parsePdfBuffer(buf);
                    computedPageCount = pdfData2.numpages || computedPageCount;
                } else if (ext2 === '.doc' || ext2 === '.docx') {
                    try {
                        const pdfPath2 = await convertOfficeToPdf(actualPath, path.dirname(actualPath));
                        const pdfBuf2 = fs.readFileSync(pdfPath2);
                        const pdfData2 = await parsePdfBuffer(pdfBuf2);
                        computedPageCount = pdfData2.numpages || computedPageCount;
                    } catch (_) {
                        // ignore conversion failures and keep fallback
                    }
                } else if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext2)) {
                    computedPageCount = 1;
                }
            }
        } catch (err) {
            console.warn('Could not compute page count:', err && err.message ? err.message : err);
        }

        const order = await db.createOrder({
            order_code: orderCode,
            small_order_id: smallId,
            owner_id: ownerId,
            customer_phone: (req.body.customer_phone || '').trim(),
            customer_email: (req.body.customer_email || '').trim(),
            customer_name: (req.body.customer_name || '').trim(),
            file_name: req.file ? req.file.originalname : (req.body.file_name || ''),
            file_path: req.file ? req.file.filename : null,
            pages: mainSvc.pages || 1,
            copies: mainSvc.copies || 1,
            color: mainSvc.color || 'B/W',
            services_json: JSON.stringify(servicesArr),
            total_price: totalPrice,
            platform_fee: 0,
            transaction_fee: 0,
            owner_payout: totalPrice,
            billable_pages: printedPages,
            payment_method: paymentMethod,
            payment_status: 'pending',
            status: 'pending',
            orientation: (req.body.orientation || 'portrait').trim(),
            paper_size: (req.body.paper_size || 'A4').trim(),
            sided: (req.body.sided || 'one-sided').trim(),
            allow_edit: (req.body.allow_edit || 'no').trim(),
            selected_pages: (req.body.selected_pages || 'all').trim(),
            page_count: computedPageCount
        });

        // if we have a locally uploaded file, upload it to Supabase Storage and attach signed URL
        if (req.file) {
            const localPath = path.join(UPLOAD_DIR, req.file.filename);
            try {
                const dest = `orders/${order.id}/${req.file.filename}`;
                const contentType = req.file.mimetype || 'application/octet-stream';
                const { fileUrl, storagePath } = await uploadToSupabase(localPath, dest, contentType);
                await db.updateOrderStatus(order.id, {
                    file_url: fileUrl,
                    file_storage_path: storagePath,
                    file_path: null
                });
                order.file_url = fileUrl;
                order.file_storage_path = storagePath;
                fs.unlinkSync(localPath);
            } catch (err) {
                console.error('Storage upload failed:', err && err.message ? err.message : err);
                console.warn('Keeping the uploaded file locally because remote storage is unavailable.');
                await db.updateOrderStatus(order.id, {
                    file_path: req.file.filename,
                    file_url: null,
                    file_storage_path: null
                });
                order.file_path = req.file.filename;
                order.file_url = null;
                order.file_storage_path = null;
            }
        }

        if (order.payment_status === 'paid' && order.customer_email) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            sendMail({
                to: order.customer_email,
                subject: `Your order is received at ${owner.shop_name}`,
                html: `<p>Hello ${order.customer_name || 'Customer'},</p>
                      <p>Your order <strong>${order.small_order_id || order.order_code}</strong> has been received by <strong>${owner.shop_name}</strong>.</p>
                      <p>Amount: <strong>KES ${order.total_price.toFixed(0)}</strong></p>
                      <p>Selected pages: <strong>${order.selected_pages || 'All'}</strong></p>
                      <p>Orientation: <strong>${order.orientation}</strong><br>Print sides: <strong>${order.sided === 'two-sided' ? 'Double-sided' : 'One-sided'}</strong><br>Edit permission: <strong>${order.allow_edit === 'yes' ? 'Allowed' : 'Not allowed'}</strong></p>
                      <p>Track your order: <a href="${baseUrl}/receipt.html?order_id=${order.id}">${baseUrl}/receipt.html?order_id=${order.id}</a></p>
                      <p>Thank you for choosing ${owner.shop_name}.</p>`,
                text: `Your order ${order.small_order_id || order.order_code} has been received by ${owner.shop_name}. Visit ${baseUrl}/receipt.html?order_id=${order.id}`
            }).catch(err => console.error('Order confirmation email failed:', err));
        }

        if (order.payment_status === 'paid' && owner.email) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const mailOptions = {
                to: owner.email,
                subject: `New print order received at ${owner.shop_name}`,
                html: `<p>Hello ${owner.name || 'Owner'},</p>
                      <p>A new print order has just been placed for your shop <strong>${owner.shop_name}</strong>.</p>
                      <p>Order ID: <strong>${order.small_order_id || order.order_code}</strong></p>
                      <p>Customer: <strong>${order.customer_name || 'Unknown'}</strong><br>
                      Phone: <strong>${order.customer_phone || 'N/A'}</strong><br>
                      Email: <strong>${order.customer_email || 'N/A'}</strong></p>
                      <p>Total: <strong>KES ${order.total_price.toFixed(0)}</strong></p>
                      <p>File: <strong>${order.file_name || 'No file name'}</strong></p>
                      <p>Review orders: <a href="${baseUrl}/owner-dashboard.html">${baseUrl}/owner-dashboard.html</a></p>`,
                text: `New print order ${order.small_order_id || order.order_code} has been placed for ${owner.shop_name}. Customer: ${order.customer_name || 'Unknown'}, Phone: ${order.customer_phone || 'N/A'}, Email: ${order.customer_email || 'N/A'}. Total: KES ${order.total_price.toFixed(0)}.`
            };

            // Do not include file download links in owner emails for security.
            // Send a simple summary email and surface the full document via the
            // dashboard notification (SSE) which contains a secure signed URL.
            sendMail(mailOptions).catch(err => console.error('Owner notification email failed:', err));

            if (order.payment_status === 'paid') {
                try {
                    const notifLink = order.file_url || `/api/orders/${order.id}/file`;
                    const pages = order.page_count || order.pages || 1;
                    await db.createNotification(owner.id, {
                        order_id: order.id,
                        title: `New order: ${order.small_order_id || order.order_code}`,
                        body: `${order.customer_name || 'Customer'} placed an order (${order.total_price.toFixed(0)} KES) — ${pages} pages`,
                        link: notifLink,
                        read: false
                    });
                } catch (err) {
                    console.warn('Failed to create owner notification:', err.message || err);
                }
            }
        }

        res.json({ order });
    } catch (err) {
        console.error(err);
        res.status(400).json({ error: err.message || 'Could not place order.' });
    }
});

// ── Public: simulate M-Pesa STK push for an order ───────────────────
// NOTE: This is a SIMULATION so the app is fully demoable without live
// Safaricom Daraja credentials. To go live, swap the body of this
// handler for a real STK Push request to the Daraja API and let the
// Daraja callback route (below) flip payment_status to 'paid'.
router.post('/:id/mpesa/stk', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.payment_status === 'paid') return res.json({ ok: true, already_paid: true });

        const phone = String(req.body.phone || order.customer_phone || '').trim();
        if (!/^254\d{9}$/.test(phone)) {
            return res.status(400).json({ error: 'Enter a valid phone number in 254XXXXXXXXX format.' });
        }
        await db.updateOrderStatus(order.id, { customer_phone: phone, payment_status: 'pending', payment_error: null });

        if (buniConfig.enabled) {
            const callbackUrl = buniConfig.callbackUrl || `${req.protocol}://${req.get('host')}/api/payment/callback`;
            const response = await buni.initiateMpesaExpress({
                phone,
                amount: order.total_price,
                orderCode: order.order_code,
                callbackUrl
            });
            const buniResponse = response.response || response;
            const checkoutRequestId = buniResponse.CheckoutRequestID || response.checkoutRequestId || response.checkoutRequestID || response.transactionId || response.reference;
            await db.updateOrderStatus(order.id, {
                payment_status: 'pending',
                checkout_request_id: checkoutRequestId || null,
                merchant_request_id: buniResponse.MerchantRequestID || response.merchantRequestId || response.merchantRequestID || null,
                payment_provider: 'kcb_buni'
            });
            return res.json({
                ok: true,
                message: 'Buni STK push sent. Awaiting confirmation.',
                checkoutRequestId,
                providerResponse: response
            });
        }

        const checkoutRequestId = 'CHECKOUT_' + Date.now();
        const merchantRequestId = 'MERCHANT_' + Date.now();
        await db.updateOrderStatus(order.id, {
            payment_status: 'pending',
            checkout_request_id: checkoutRequestId,
            merchant_request_id: merchantRequestId
        });

        setTimeout(async() => {
            try {
                const receipt = 'S' + Math.random().toString(36).slice(2, 10).toUpperCase();
                const updated = await db.updateOrderStatus(order.id, {
                    payment_status: 'paid',
                    mpesa_receipt: receipt,
                    checkout_request_id: checkoutRequestId,
                    merchant_request_id: merchantRequestId
                });
                const owner = await db.getUserById(updated.owner_id);
                if (updated.customer_email) {
                    const baseUrl = `${req.protocol}://${req.get('host')}`;
                    const shopName = owner && owner.shop_name ? owner.shop_name : 'the cyber shop';
                    await sendMail({
                        to: updated.customer_email,
                        subject: `Payment received at ${shopName}`,
                        html: `<p>Hello ${updated.customer_name || 'Customer'},</p>
                               <p>Your payment for order <strong>${updated.small_order_id || updated.order_code}</strong> has been received at <strong>${shopName}</strong>.</p>
                               <p>View your receipt here: <a href="${baseUrl}/receipt.html?order_id=${updated.id}">${baseUrl}/receipt.html?order_id=${updated.id}</a></p>`,
                        text: `Your payment for order ${updated.small_order_id || updated.order_code} has been received at ${shopName}. View receipt: ${baseUrl}/receipt.html?order_id=${updated.id}`
                    });
                }
            } catch (err) {
                console.error('Failed to update simulated payment:', err);
            }
        }, 1500);

        res.json({ ok: true, message: 'STK push sent. Awaiting confirmation.' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not simulate payment.' });
    }
});

// Allow a customer to change an unpaid order to cash after a failed STK attempt.
router.post('/:id/payment-method', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        if (order.payment_status === 'paid') return res.status(409).json({ error: 'This order is already paid.' });
        const paymentMethod = req.body.payment_method === 'cash' ? 'cash' : null;
        if (!paymentMethod) return res.status(400).json({ error: 'Unsupported payment method.' });
        const updated = await db.updateOrderStatus(order.id, {
            payment_method: paymentMethod,
            payment_status: 'pending',
            payment_error: null
        });
        res.json({ order: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not change payment method.' });
    }
});

// ── Public: poll payment status ─────────────────────────────────
router.get('/:id/payment-status', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        res.json({ payment_status: order.payment_status, mpesa_receipt: order.mpesa_receipt });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not fetch payment status.' });
    }
});

// ── Public: submit owner rating from the receipt page ─────────────
router.post('/:id/rate', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        const rating = Number(req.body.rating);
        if (!Number.isFinite(rating) || rating < 1 || rating > 5) {
            return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
        }
        const updated = await db.setOrderRating(order.id, rating);
        const owner = await db.getOwnerPublicById(updated.owner_id);
        res.json({ order: updated, owner });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not submit rating.' });
    }
});

// ── Public: get single order (receipt page) ─────────────────────────
router.get('/:id', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order) return res.status(404).json({ error: 'Order not found.' });
        const owner = await db.getOwnerPublicById(order.owner_id);
        res.json({ order, owner });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load order.' });
    }
});

// ── Owner: list own orders ──────────────────────────────────────────
router.get('/', requireRole('owner'), async(req, res) => {
    try {
        const rows = await db.listOrdersByOwner(req.session.user.id);
        res.json({ orders: rows });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not load orders.' });
    }
});

// ── Owner: advance an order's print-queue status ────────────────────
router.patch('/:id/status', requireRole('owner'), async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order || order.owner_id !== req.session.user.id) {
            return res.status(404).json({ error: 'Order not found.' });
        }

        const requested = req.body.status;
        const validNext = STATUS_FLOW[order.status];
        const status = requested && Object.values(STATUS_FLOW).includes(requested) ? requested : validNext;
        if (!status) return res.status(400).json({ error: 'Order already at final status.' });

        const updated = await db.updateOrderStatus(order.id, { status });
        const owner = await db.getUserById(order.owner_id);
        if (updated.customer_email && updated.payment_status === 'paid') {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const shopName = owner && owner.shop_name ? owner.shop_name : 'the cyber shop';
            const readyMessage = status === 'ready'
                ? 'Your printout is ready. Please visit the cyber cafe and collect it using your order code.'
                : `Your order is now ${status}.`;
            sendMail({
                to: updated.customer_email,
                subject: status === 'ready' ? `${shopName}: your printout is ready` : `${shopName} update: ${status}`,
                html: `<p>Hello ${updated.customer_name || 'Customer'},</p>
                      <p>${readyMessage}</p><p>Order code: <strong>${updated.small_order_id || updated.order_code}</strong></p>
                      <p>Track it here: <a href="${baseUrl}/receipt.html?order_id=${updated.id}">${baseUrl}/receipt.html?order_id=${updated.id}</a></p>`,
                text: `${readyMessage} Order code: ${updated.small_order_id || updated.order_code}. Track here: ${baseUrl}/receipt.html?order_id=${updated.id}`
            }).catch(err => console.error('Customer status email failed:', err));
        }
        res.json({ order: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not update order status.' });
    }
});

// ── Owner: mark a cash order as paid ─────────────────────────────────
router.patch('/:id/mark-paid', requireRole('owner'), async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order || order.owner_id !== req.session.user.id) {
            return res.status(404).json({ error: 'Order not found.' });
        }
        const updated = await db.updateOrderStatus(order.id, { payment_status: 'paid' });
        const owner = await db.getUserById(updated.owner_id);
        if (updated.customer_email) {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            const shopName = owner && owner.shop_name ? owner.shop_name : 'the cyber shop';
            sendMail({
                to: updated.customer_email,
                subject: `Payment received at ${shopName}`,
                html: `<p>Hello ${updated.customer_name || 'Customer'},</p>
                       <p>Your payment for order <strong>${updated.small_order_id || updated.order_code}</strong> has been received at <strong>${shopName}</strong>.</p>
                       <p>Receipt: <a href="${baseUrl}/receipt.html?order_id=${updated.id}">${baseUrl}/receipt.html?order_id=${updated.id}</a></p>`,
                text: `Your payment for order ${updated.small_order_id || updated.order_code} has been received at ${shopName}. View receipt: ${baseUrl}/receipt.html?order_id=${updated.id}`
            }).catch(err => console.error('Payment notification email failed:', err));
        }
        res.json({ order: updated });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not mark order as paid.' });
    }
});

// ── Owner or receipt page: preview the uploaded print file as text or image ───────
router.get('/:id/file/preview', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        const isOwner = !!(req.session && req.session.user && order && req.session.user.id === order.owner_id);
        if (isOwner && order.payment_status !== 'paid') return res.status(403).json({ error: 'Document is available after payment confirmation.' });
        if (!order || (!order.file_path && !order.file_storage_path) || (!isOwner && req.session && req.session.user)) {
            return res.status(404).json({ error: 'File not found.' });
        }

        const ext = path.extname(order.file_name || '').toLowerCase();
        const fileUrl = order.file_url || `/api/orders/${req.params.id}/file`;
        let buffer = null;

        if (order.file_storage_path) {
            buffer = await getOrderFileBuffer(order);
        } else {
            const filePath = path.join(UPLOAD_DIR, order.file_path);
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
            buffer = fs.readFileSync(filePath);
        }

        if (ext === '.docx') {
            const tempPath = order.file_storage_path ? path.join(UPLOAD_DIR, 'temp', `${req.params.id}-${order.file_name}`) : path.join(UPLOAD_DIR, order.file_path);
            if (order.file_storage_path) {
                fs.mkdirSync(path.dirname(tempPath), { recursive: true });
                fs.writeFileSync(tempPath, buffer);
            }
            const { value } = await mammoth.extractRawText({ path: tempPath });
            if (order.file_storage_path) fs.unlinkSync(tempPath);
            return res.json({ kind: 'text', content: value || '', fileName: order.file_name, fileUrl, ext });
        }

        if (ext === '.txt') {
            return res.json({ kind: 'text', content: buffer.toString('utf8'), fileName: order.file_name, fileUrl, ext });
        }

        if (ext === '.pdf') {
            const pdfData = await parsePdfBuffer(buffer);
            return res.json({ kind: 'pdf', content: pdfData.text || '', fileName: order.file_name, fileUrl, ext });
        }

        if (['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(ext)) {
            return res.json({ kind: 'image', fileName: order.file_name, fileUrl, ext });
        }

        return res.json({ kind: 'unsupported', content: '', fileName: order.file_name, fileUrl, ext });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not preview file.' });
    }
});

// ── Owner or receipt page: download the customer's uploaded print file ──────────────
router.get('/:id/file', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        if (!order || (!order.file_path && !order.file_storage_path)) {
            return res.status(404).json({ error: 'File not found.' });
        }
        const isOwner = !!(req.session && req.session.user && req.session.user.id === order.owner_id);
        if (isOwner && order.payment_status !== 'paid') return res.status(403).json({ error: 'Document is available after payment confirmation.' });

        if (order.file_storage_path) {
            const url = await getRemoteOrderFileUrl(order);
            if (!url) return res.status(404).json({ error: 'File not found.' });
            return res.redirect(url);
        }

        const filePath = path.join(UPLOAD_DIR, order.file_path);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
        res.sendFile(filePath);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not download file.' });
    }
});

// ── Owner: extract and serve only selected pages from a PDF ──────────────────
// GET /api/orders/:id/file/pages?pages=1-3,5
router.get('/:id/file/pages', async(req, res) => {
    try {
        const order = await db.getOrderById(req.params.id);
        const isOwner = !!(req.session && req.session.user && order && req.session.user.id === order.owner_id);
        if (!order || (!order.file_path && !order.file_storage_path) || !isOwner) {
            return res.status(403).json({ error: 'Not authorised or file not found.' });
        }
        if (order.payment_status !== 'paid') return res.status(403).json({ error: 'Document is available after payment confirmation.' });

        const ext = path.extname(order.file_name || '').toLowerCase();
        if (ext !== '.pdf') {
            // For non-PDF files just serve the whole file
            if (order.file_storage_path) {
                const url = await getRemoteOrderFileUrl(order);
                if (!url) return res.status(404).json({ error: 'File not found.' });
                return res.redirect(url);
            }
            const filePath = path.join(UPLOAD_DIR, order.file_path);
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
            return res.sendFile(filePath);
        }

        // Parse requested page list
        const pagesParam = (req.query.pages || '').trim();
        let selectedPages = [];
        if (pagesParam && pagesParam !== 'all') {
            pagesParam.split(',').forEach(part => {
                const p = part.trim();
                if (p.includes('-')) {
                    const [s, e] = p.split('-').map(Number);
                    if (!isNaN(s) && !isNaN(e)) {
                        for (let i = Math.min(s, e); i <= Math.max(s, e); i++) selectedPages.push(i);
                    }
                } else {
                    const n = Number(p);
                    if (!isNaN(n) && n > 0) selectedPages.push(n);
                }
            });
            selectedPages = [...new Set(selectedPages)].sort((a, b) => a - b);
        }

        // Get file buffer
        let buffer;
        if (order.file_storage_path) {
            buffer = await getOrderFileBuffer(order);
        } else {
            const filePath = path.join(UPLOAD_DIR, order.file_path);
            if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found.' });
            buffer = fs.readFileSync(filePath);
        }

        const source = await PDFDocument.load(buffer);
        const output = await PDFDocument.create();
        const pagesToPrint = selectedPages.length ? selectedPages : Array.from({ length: source.getPageCount() }, (_, index) => index + 1);
        const indexes = pagesToPrint.map(page => page - 1).filter(index => index >= 0 && index < source.getPageCount());
        const copiedPages = await output.copyPages(source, indexes);
        const font = await output.embedFont(StandardFonts.Helvetica);
        copiedPages.forEach(page => {
            output.addPage(page);
            page.drawText(String(order.small_order_id || order.order_code || order.id), {
                x: Math.max(8, page.getWidth() - 70),
                y: Math.max(8, page.getHeight() - 14),
                size: 6,
                font,
                color: rgb(0.35, 0.35, 0.35)
            });
        });
        const outBuf = Buffer.from(await output.save());
        const pageArg = pagesToPrint.join(',');
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `inline; filename="pages-${pageArg}-${order.file_name || 'document.pdf'}"`);
        res.send(outBuf);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Could not extract pages.' });
    }
});

module.exports = router;