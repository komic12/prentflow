const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER || 'printflow205@gmail.com',
        pass: process.env.EMAIL_PASS || 'txmh aklm tjfi eemq'
    }
});

async function sendMail({ to, subject, html, text }) {
    if (!to) return null;
    const info = await transporter.sendMail({
        from: process.env.EMAIL_FROM || 'PrintFlow <printflow205@gmail.com>',
        to,
        subject,
        text: text || 'PrintFlow notification',
        html: html || text || ''
    });
    return info;
}

module.exports = { sendMail };