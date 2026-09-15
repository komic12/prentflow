require("dotenv").config();

const config = {

    environment: process.env.MPESA_ENV || "sandbox",

    consumerKey: process.env.MPESA_CONSUMER_KEY,

    consumerSecret: process.env.MPESA_CONSUMER_SECRET,

    shortcode: process.env.MPESA_SHORTCODE,

    passkey: process.env.MPESA_PASSKEY,

    callbackUrl: process.env.MPESA_CALLBACK_URL,

    baseUrl:
        process.env.MPESA_ENV === "production"
            ? "https://api.safaricom.co.ke"
            : "https://sandbox.safaricom.co.ke"

};

module.exports = config;