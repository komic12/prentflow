const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function getFirebaseCredentials() {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson) {
        try {
            const creds = JSON.parse(rawJson);
            if (creds.private_key) creds.private_key = creds.private_key.replace(/\\n/g, '\n');
            return creds;
        } catch (err) {
            console.warn('Invalid FIREBASE_SERVICE_ACCOUNT_JSON:', err.message);
        }
    }

    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && privateKey) {
        return {
            project_id: process.env.FIREBASE_PROJECT_ID,
            client_email: process.env.FIREBASE_CLIENT_EMAIL,
            private_key: privateKey.replace(/\\n/g, '\n'),
            private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
            client_id: process.env.FIREBASE_CLIENT_ID,
            auth_uri: process.env.FIREBASE_AUTH_URI,
            token_uri: process.env.FIREBASE_TOKEN_URI,
            auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL,
            client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL
        };
    }

    return null;
}

function initializeFirestore() {
    const creds = getFirebaseCredentials();
    if (!creds) {
        console.warn('Firebase credentials not found in environment. Firestore disabled.');
        return null;
    }

    try {
        if (!admin.apps.length) {
            admin.initializeApp({
                credential: admin.credential.cert(creds)
            });
        }
        const firestore = admin.firestore();
        console.log('Initialized Firebase Admin SDK and Firestore.');
        return firestore;
    } catch (err) {
        console.warn('Failed to initialize Firebase Admin:', err.message);
        return null;
    }
}

module.exports = {
    initializeFirestore
};