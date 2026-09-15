require("dotenv").config();

module.exports = {
    enabled: process.env.BUNI_ENABLED === "true",
    apiKey: process.env.BUNI_API_KEY,
    baseUrl: process.env.BUNI_BASE_URL || "https://sandbox.buni.kcbgroup.com",
    mpesaExpressPath: process.env.BUNI_MPESA_EXPRESS_PATH || "/mm/api/request/1.0.0",
    fundsTransferPath: process.env.BUNI_FUNDS_TRANSFER_PATH || "/fundstransfer/1.0.0",
    tillNumber: process.env.BUNI_TILL_NUMBER,
    sharedShortCode: process.env.BUNI_SHARED_SHORT_CODE !== "false",
    orgShortCode: process.env.BUNI_ORG_SHORT_CODE || "",
    orgPassKey: process.env.BUNI_ORG_PASS_KEY || "",
    transactionDescription: process.env.BUNI_TRANSACTION_DESCRIPTION || "PrintFlow payment",
    consumerKey: process.env.BUNI_CONSUMER_KEY,
    consumerSecret: process.env.BUNI_CONSUMER_SECRET,
    tokenUrl: process.env.BUNI_TOKEN_URL || "https://uat.buni.kcbgroup.com/token?grant_type=client_credentials",
    revokeUrl: process.env.BUNI_REVOKE_URL || "https://accounts.buni.kcbgroup.com/oauth2/revoke",
    paymentUrl: process.env.BUNI_PAYMENT_URL,
    callbackUrl: process.env.BUNI_CALLBACK_URL
};