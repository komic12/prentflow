const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const HOST = '127.0.0.1';
const PORT = Number(process.env.PRINT_AGENT_PORT || 17321);
const MAX_BYTES = 50 * 1024 * 1024;

function sendJson(res, status, body) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end(JSON.stringify(body));
}

async function printFile(filePath, copies = 1) {
    const count = Math.max(1, Number(copies) || 1);
    for (let copy = 0; copy < count; copy += 1) {
        if (process.platform === 'win32') {
            await new Promise((resolve, reject) => {
                execFile('powershell.exe', [
                    '-NoProfile', '-NonInteractive', '-Command',
                    `Start-Process -FilePath '${filePath.replace(/'/g, "''")}' -Verb Print -PassThru | Out-Null`
                ], error => error ? reject(error) : resolve());
            });
        } else {
            const command = process.platform === 'darwin' ? 'lp' : 'lp';
            await new Promise((resolve, reject) => {
                execFile(command, [filePath], error => error ? reject(error) : resolve());
            });
        }
    }
}

function listPrinters() {
    if (process.platform !== 'win32') return Promise.resolve([]);
    return new Promise((resolve, reject) => {
        execFile('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            "Get-Printer | Select-Object Name,PrinterStatus,Default | ConvertTo-Json -Compress"
        ], (error, stdout) => {
            if (error) return reject(error);
            if (!stdout.trim()) return resolve([]);
            const parsed = JSON.parse(stdout);
            resolve((Array.isArray(parsed) ? parsed : [parsed]).map(printer => ({
                name: printer.Name,
                status: printer.PrinterStatus,
                default: Boolean(printer.Default)
            })));
        });
    });
}

const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') return sendJson(res, 204, {});
    if (req.method === 'GET' && req.url === '/health') return sendJson(res, 200, { ok: true, printer: 'system-default' });
    if (req.method === 'GET' && req.url === '/printers') {
        return listPrinters().then(printers => sendJson(res, 200, { ok: true, printers }))
            .catch(error => sendJson(res, 500, { error: error.message || 'Could not scan printers.' }));
    }
    if (req.method !== 'POST' || req.url !== '/print') return sendJson(res, 404, { error: 'Not found.' });

    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
        size += chunk.length;
        if (size <= MAX_BYTES) chunks.push(chunk);
    });
    req.on('end', async() => {
        if (size > MAX_BYTES) return sendJson(res, 413, { error: 'Document is too large.' });
        let payload;
        try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return sendJson(res, 400, { error: 'Invalid JSON.' }); }
        if (!payload.data || !payload.fileName) return sendJson(res, 400, { error: 'data and fileName are required.' });
        const copies = Math.max(1, Number.parseInt(payload.copies, 10) || 1);

        const safeName = path.basename(payload.fileName).replace(/[^a-zA-Z0-9._-]/g, '_');
        const filePath = path.join(os.tmpdir(), `printflow-${Date.now()}-${safeName}`);
        try {
            fs.writeFileSync(filePath, Buffer.from(payload.data, 'base64'));
            await printFile(filePath, copies);
            sendJson(res, 200, { ok: true, copies, message: `Sent ${copies} ${copies === 1 ? 'copy' : 'copies'} to the system default printer.` });
        } catch (error) {
            sendJson(res, 500, { error: error.message || 'Could not print the document.' });
        } finally {
            try { fs.unlinkSync(filePath); } catch {}
        }
    });
});

server.listen(PORT, HOST, () => {
    console.log(`PrintFlow local print agent listening at http://${HOST}:${PORT}`);
});
