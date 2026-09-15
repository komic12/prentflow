const express = require("express");
const router = express.Router();

const mpesa = require("../services/mpesa");
const db = require("../db/database");
const { sendMail } = require("../lib/mailer");
const { calculateSplit } = require("../db/helpers");

async function sendPaymentConfirmationEmails(order, req) {
    const owner = await db.getUserById(order.owner_id);
    const shopName = owner?.shop_name || "the cyber shop";
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const receiptUrl = `${baseUrl}/receipt.html?order_id=${order.id}`;
    const tasks = [];

    if (order.customer_email) {
        tasks.push(sendMail({
            to: order.customer_email,
            subject: `Payment received at ${shopName}`,
            html: `<p>Hello ${order.customer_name || "Customer"},</p><p>Your payment for order <strong>${order.small_order_id || order.order_code}</strong> has been confirmed.</p><p>Receipt: <a href="${receiptUrl}">${receiptUrl}</a></p>`,
            text: `Payment confirmed for order ${order.small_order_id || order.order_code}. Receipt: ${receiptUrl}`
        }));
    }

    if (owner?.email) {
        tasks.push(sendMail({
            to: owner.email,
            subject: `Paid print order received at ${shopName}`,
            html: `<p>Hello ${owner.name || "Owner"},</p><p>Payment for order <strong>${order.small_order_id || order.order_code}</strong> has been confirmed. You may now process the print job.</p><p>Amount: <strong>KES ${Number(order.total_price).toFixed(0)}</strong></p>`,
            text: `Payment confirmed for order ${order.small_order_id || order.order_code}. You may now process the print job.`
        }));
    }

    await Promise.allSettled(tasks);
}

// ======================================
// Health Check
// ======================================
router.get("/health", (req, res) => {

    res.json({
        success: true,
        message: "Payment Service Running"
    });

});

// ======================================
// Initiate STK Push
// ======================================
router.post("/stk", async (req, res) => {

    try {

        const { phone, amount, orderId } = req.body;

        if (!phone || !amount || !orderId) {

            return res.status(400).json({
                success: false,
                message: "Missing required fields"
            });

        }

        const payment = await mpesa.initiateSTKPush(
            phone,
            amount,
            orderId
        );

        // Save transaction as pending
        await db.updateOrderStatus(orderId, {
            payment_status: "pending",
            checkout_request_id: payment.checkoutRequestId,
            merchant_request_id: payment.merchantRequestId
        });

        return res.json({
            success: true,
            message: "STK Push initiated.",
            checkoutRequestId: payment.checkoutRequestId,
            merchantRequestId: payment.merchantRequestId
        });

    } catch (err) {

        console.error(err);

        return res.status(500).json({
            success: false,
            message: err.message
        });

    }

});

// ======================================
// MPESA Callback
// ======================================
router.post("/callback", async (req, res) => {

    try {

        console.log("========== MPESA CALLBACK ==========");
        console.log(JSON.stringify(req.body, null, 2));

        const callback = req.body.Body?.stkCallback || req.body.stkCallback || req.body;
        const metadata = Object.fromEntries(
            (callback.CallbackMetadata?.Item || []).map(item => [item.Name, item.Value])
        );
        const checkoutRequestId = callback.CheckoutRequestID || req.body.checkoutRequestId;
        const resultCode = Number(callback.ResultCode ?? req.body.ResultCode ?? 1);
        const receipt = metadata.MpesaReceiptNumber || req.body.MpesaReceiptNumber;

        if (!checkoutRequestId) {
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const orders = await db.listAllOrders();
        const order = orders.find(item => item.checkout_request_id === checkoutRequestId);
        if (!order) {
            console.warn("Payment callback did not match an order:", checkoutRequestId);
            return res.json({ ResultCode: 0, ResultDesc: "Accepted" });
        }

        const callbackAmount = metadata.Amount == null ? null : Number(metadata.Amount);
        const amountMatches = callbackAmount == null || callbackAmount === Number(order.total_price);
        const paymentConfirmed = resultCode === 0 && amountMatches && Boolean(receipt);
        const split = calculateSplit(order.total_price, null, order.payment_method, order.billable_pages);
        const paymentData = paymentConfirmed
            ? { payment_status: "paid", mpesa_receipt: receipt, ...split }
            : { payment_status: "failed", payment_error: resultCode === 0 && !amountMatches ? "Payment amount did not match the order." : (callback.ResultDesc || "Payment was not completed.") };
        const updated = await db.updateOrderStatus(order.id, paymentData);
        if (paymentConfirmed && order.payment_status !== "paid") {
            await sendPaymentConfirmationEmails(updated, req);
        }

        return res.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
        });

    } catch (err) {

        console.error(err);

        return res.json({
            ResultCode: 0,
            ResultDesc: "Accepted"
        });

    }

});

module.exports = router;