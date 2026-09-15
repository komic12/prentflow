const axios = require("axios");
const config = require("../config/buniConfig");

function apiHeaders(accessToken) {
    const token = accessToken || config.apiKey;
    if (!token) throw new Error("Buni API key or access token is not configured.");
    return {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
    };
}

async function postPayment(path, payload, accessToken) {
    const response = await axios.post(
        new URL(path, config.baseUrl).toString(),
        payload,
        { headers: apiHeaders(accessToken), timeout: 20000 }
    );
    return response.data;
}

async function initiateMpesaExpress({ phone, amount, orderCode, callbackUrl }) {
    const accessToken = config.apiKey || await getAccessToken();
    return postPayment(config.mpesaExpressPath, {
        phoneNumber: phone,
        amount: String(Math.round(Number(amount))),
        invoiceNumber: `${config.tillNumber || "KCBTILLNO"}-${orderCode}`.slice(0, 30),
        sharedShortCode: config.sharedShortCode,
        orgShortCode: config.orgShortCode,
        orgPassKey: config.orgPassKey,
        transactionDescription: config.transactionDescription,
        callbackUrl: callbackUrl || config.callbackUrl
    }, accessToken);
}

async function getAccessToken() {
    if (!config.consumerKey || !config.consumerSecret) {
        throw new Error("Buni credentials are not configured.");
    }

    const credentials = Buffer
        .from(`${config.consumerKey}:${config.consumerSecret}`)
        .toString("base64");

    const response = await axios.post(
        config.tokenUrl,
        new URLSearchParams({ grant_type: "client_credentials" }).toString(),
        {
            headers: {
                Authorization: `Basic ${credentials}`,
                "Content-Type": "application/x-www-form-urlencoded"
            },
            timeout: 15000
        }
    );

    if (!response.data.access_token) {
        throw new Error("Buni token response did not contain access_token.");
    }

    return response.data.access_token;
}

module.exports = {
    getAccessToken,
    initiateMpesaExpress,
    postMpesaExpress(payload, accessToken) {
        return postPayment(config.mpesaExpressPath, payload, accessToken);
    },
    postFundsTransfer(payload, accessToken) {
        return postPayment(config.fundsTransferPath, payload, accessToken);
    }
};