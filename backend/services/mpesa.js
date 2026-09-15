const axios = require("axios");
const config = require("../config/mpesaconfig");

// =============================
// Get Daraja Access Token
// =============================
async function getAccessToken() {

    if (!config.consumerKey || !config.consumerSecret) {

        console.log("Using simulated access token...");

        return "SIMULATED_ACCESS_TOKEN";
    }

    const auth = Buffer
        .from(`${config.consumerKey}:${config.consumerSecret}`)
        .toString("base64");

    const response = await axios.get(

        `${config.baseUrl}/oauth/v1/generate?grant_type=client_credentials`,

        {
            headers: {
                Authorization: `Basic ${auth}`
            }
        }

    );

    return response.data.access_token;
}

// =============================
// Generate Timestamp
// =============================
function generateTimestamp() {

    const now = new Date();

    return now.getFullYear().toString() +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0") +
        String(now.getHours()).padStart(2, "0") +
        String(now.getMinutes()).padStart(2, "0") +
        String(now.getSeconds()).padStart(2, "0");

}

// =============================
// Generate Password
// =============================
function generatePassword(timestamp) {

    if (!config.shortcode || !config.passkey) {

        return "SIMULATED_PASSWORD";

    }

    return Buffer
        .from(config.shortcode + config.passkey + timestamp)
        .toString("base64");

}

// =============================
// Initiate STK Push
// =============================
async function initiateSTKPush(phone, amount, orderId) {

    const accessToken = await getAccessToken();

    const timestamp = generateTimestamp();

    const password = generatePassword(timestamp);

    console.log("================================");
    console.log("Initiating MPESA Payment");
    console.log("================================");

    console.log({
        phone,
        amount,
        orderId,
        accessToken,
        timestamp,
        password
    });

    // Simulated response for now
    return {

        success: true,

        checkoutRequestId:
            "CHECKOUT_" + Date.now(),

        merchantRequestId:
            "MERCHANT_" + Date.now()

    };

}

module.exports = {

    initiateSTKPush,
    getAccessToken

};