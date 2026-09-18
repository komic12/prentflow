require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const { supabase, supabaseConfigured, dataTable } = require('./supabase');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SERVICES_FILE = path.join(DATA_DIR, 'services.json');
const ORDERS_FILE = path.join(DATA_DIR, 'orders.json');
const DOCUMENTS_FILE = path.join(DATA_DIR, 'documents.json');
const PAGES_FILE = path.join(DATA_DIR, 'pages.json');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'submissions.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');

let firestore = null;
let useFirestore = false;
let useSupabase = false;

function getFirebaseCredentials() {
    const rawJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (rawJson) {
        try {
            const creds = JSON.parse(rawJson);
            if (creds.private_key) {
                creds.private_key = creds.private_key.replace(/\\n/g, '\n');
            }
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

function getCollectionFile(collectionName) {
    switch (collectionName) {
        case 'users':
            return USERS_FILE;
        case 'services':
            return SERVICES_FILE;
        case 'orders':
            return ORDERS_FILE;
        case 'documents':
            return DOCUMENTS_FILE;
        case 'pages':
            return PAGES_FILE;
        case 'submissions':
            return SUBMISSIONS_FILE;
        case 'events':
            return EVENTS_FILE;
        default:
            return path.join(DATA_DIR, `${collectionName}.json`);
    }
}

function normalizeFirestoreDoc(doc) {
    const data = doc.data() || {};
    return {
        id: doc.id,
        ...data
    };
}

async function readCollection(collectionName) {
    if (useSupabase) {
        const { data, error } = await supabase
            .from(dataTable)
            .select('id,data')
            .eq('collection', collectionName);
        if (error) throw error;
        return (data || []).map(row => row.data || {}).filter(row => row.id);
    }
    if (useFirestore && firestore) {
        const snapshot = await firestore.collection(collectionName).get();
        return snapshot.docs.map(normalizeFirestoreDoc);
    }
    return readJson(getCollectionFile(collectionName));
}

async function writeCollection(collectionName, docs) {
    if (useSupabase) {
        const { error: deleteError } = await supabase
            .from(dataTable)
            .delete()
            .eq('collection', collectionName);
        if (deleteError) throw deleteError;
        if (!docs.length) return;
        const rows = docs.filter(doc => doc && doc.id).map(doc => ({
            collection: collectionName,
            id: String(doc.id),
            data: doc
        }));
        const { error } = await supabase.from(dataTable).insert(rows);
        if (error) throw error;
        return;
    }
    if (useFirestore && firestore) {
        const batch = firestore.batch();
        const col = firestore.collection(collectionName);
        docs.forEach(doc => {
            if (!doc.id) return;
            batch.set(col.doc(String(doc.id)), doc);
        });
        await batch.commit();
        return;
    }
    writeJson(getCollectionFile(collectionName), docs);
}

async function readData(collectionName) {
    if (useFirestore && firestore) {
        return await readCollection(collectionName);
    }
    return readJson(getCollectionFile(collectionName));
}

async function writeData(collectionName, docs) {
    if (useFirestore && firestore) {
        return writeCollection(collectionName, docs);
    }
    return writeJson(getCollectionFile(collectionName), docs);
}

async function initFirestore() {
    if (process.env.FIREBASE_ENABLED === 'false') {
        console.warn('Firebase disabled by configuration; using local JSON storage.');
        return;
    }

    const creds = getFirebaseCredentials();
    if (!creds) {
        console.warn('Firebase credentials not found; using local JSON storage.');
        return;
    }

    try {
        const initOptions = { credential: admin.credential.cert(creds) };
        // Prefer explicit env var for storage bucket, fall back to service account project id
        if (process.env.FIREBASE_STORAGE_BUCKET) {
            initOptions.storageBucket = process.env.FIREBASE_STORAGE_BUCKET;
        } else if (creds.project_id) {
            initOptions.storageBucket = `${creds.project_id}.appspot.com`;
        }
        admin.initializeApp(initOptions);
        firestore = admin.firestore();
        useFirestore = true;
        console.log('Firebase Admin initialized. Firestore is enabled.');
    } catch (err) {
        console.warn('Firebase initialization failed:', err.message);
        useFirestore = false;
    }
}

function initSupabase() {
    if (process.env.SUPABASE_ENABLED === 'false') return false;
    if (!supabaseConfigured) return false;
    useSupabase = true;
    console.log(`Supabase database enabled (${dataTable}).`);
    return true;
}

function ensureDataFile(filePath, initialValue) {
    if (!fs.existsSync(filePath)) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify(initialValue, null, 2));
    }
}

function readJson(filePath) {
    ensureDataFile(filePath, []);
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function makeId(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeRow(row) {
    if (!row) return null;
    return {
        ...row,
        subscription_active: !!row.subscription_active,
        enabled: !!row.enabled
    };
}

function normalizeOtp(value) {
    return String(value ?? '').replace(/\D/g, '').slice(-6).padStart(6, '0');
}

async function initialize() {
    if (!initSupabase()) await initFirestore();

    if (!useFirestore && !useSupabase) {
        ensureDataFile(USERS_FILE, []);
        ensureDataFile(SERVICES_FILE, []);
        ensureDataFile(ORDERS_FILE, []);
        ensureDataFile(DOCUMENTS_FILE, []);
        ensureDataFile(PAGES_FILE, []);
        ensureDataFile(SUBMISSIONS_FILE, []);
        ensureDataFile(EVENTS_FILE, []);
    }

    const adminEmail = (process.env.ADMIN_EMAIL || 'printflow205@gmail.com').toLowerCase();
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';

    const users = await readCollection('users');
    const existingAdmin = users.find(user => user.role === 'admin');
    if (existingAdmin) {
        let passwordMatches = false;
        try {
            passwordMatches = !!existingAdmin.password_hash && bcrypt.compareSync(adminPass, existingAdmin.password_hash);
        } catch (_) {}

        const needsSync = (existingAdmin.email || '').toLowerCase() !== adminEmail || !passwordMatches;
        if (needsSync) {
            existingAdmin.email = adminEmail;
            existingAdmin.email_lower = adminEmail;
            existingAdmin.password_hash = bcrypt.hashSync(adminPass, 10);
            existingAdmin.name = existingAdmin.name || 'Super Admin';
            existingAdmin.role = 'admin';
            existingAdmin.status = existingAdmin.status || 'Active';
            existingAdmin.shop_name = existingAdmin.shop_name || 'PrintFlow HQ';
            const updatedUsers = users.map(user => user.id === existingAdmin.id ? existingAdmin : user);
            await writeCollection('users', updatedUsers);
            console.log(`Synced super admin credentials -> ${adminEmail}`);
        }
    } else {
        const adminUser = {
            id: makeId('admin'),
            name: 'Super Admin',
            email: adminEmail,
            email_lower: adminEmail,
            password_hash: bcrypt.hashSync(adminPass, 10),
            role: 'admin',
            shop_name: 'PrintFlow HQ',
            phone: '',
            location: '',
            status: 'Active',
            subscription_plan: 'Plan_B',
            subscription_active: true,
            subscription_expiry: null,
            created_at: new Date().toISOString()
        };
        users.push(adminUser);
        await writeCollection('users', users);
        console.log(`Seeded super admin -> ${adminEmail} / ${adminPass} (change this password after first login)`);
    }
}

async function getUserByEmail(email) {
    if (!email) return null;
    const users = await readCollection('users');
    const row = users.find(user => user.email && user.email.toLowerCase() === String(email).toLowerCase());
    return normalizeRow(row || null);
}

async function getUserById(id) {
    if (!id) return null;
    const users = await readCollection('users');
    const row = users.find(user => user.id === id);
    return normalizeRow(row || null);
}

async function updateUserPassword(id, passwordHash) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index].password_hash = passwordHash;
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function setPasswordResetToken(id, token, expiresAt) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index].reset_token = token;
        users[index].reset_expires_at = expiresAt;
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function findUserByResetToken(token) {
    if (!token) return null;
    const users = await readCollection('users');
    const row = users.find(user => user.reset_token === token);
    return normalizeRow(row || null);
}

async function clearPasswordResetToken(id) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        delete users[index].reset_token;
        delete users[index].reset_expires_at;
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function setLoginOtp(id, otp, expiresAt) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index].otp_code = normalizeOtp(otp);
        users[index].otp_expires_at = expiresAt;
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function clearLoginOtp(id) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        delete users[index].otp_code;
        delete users[index].otp_expires_at;
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function verifyLoginOtp(id, otp) {
    const user = await getUserById(id);
    if (!user) return false;
    if (!user.otp_code || !user.otp_expires_at) return false;
    const normalizedStored = normalizeOtp(user.otp_code);
    const normalizedInput = normalizeOtp(otp);
    if (normalizedStored !== normalizedInput) return false;
    if (new Date(user.otp_expires_at).getTime() < Date.now()) return false;
    return true;
}

async function createOwner(data) {
    const users = await readCollection('users');
    const id = data.id || makeId('usr');
    const owner = {
        id,
        name: data.name || '',
        email: data.email || '',
        password_hash: data.password_hash || '',
        role: data.role || 'owner',
        shop_name: data.shop_name || '',
        phone: data.phone || '',
        location: data.location || '',
        profile_image: data.profile_image || null,
        passcode_hash: data.passcode_hash || null,
        passcode_enabled: !!data.passcode_enabled,
        biometric_enabled: !!data.biometric_enabled,
        status: data.status || 'Active',
        subscription_plan: data.subscription_plan || 'Plan_A',
        subscription_active: !!data.subscription_active,
        subscription_expiry: data.subscription_expiry || null,
        rating_avg: 0,
        rating_count: 0,
        created_at: data.created_at || new Date().toISOString()
    };
    users.push(owner);
    await writeCollection('users', users);
    return getUserById(id);
}

async function updateUserProfile(id, data) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index] = {...users[index], ...data };
        await writeCollection('users', users);
    }
    return getUserById(id);
}

async function findOwnerById(id) {
    const owner = await getUserById(id);
    return owner && owner.role === 'owner' ? owner : null;
}

async function getOwnerPublicById(id) {
    const owner = await findOwnerById(id);
    if (!owner) return null;
    return {
        id: owner.id,
        name: owner.name,
        shop_name: owner.shop_name,
        location: owner.location,
        phone: owner.phone,
        status: owner.status,
        rating_avg: Number(owner.rating_avg || 0),
        rating_count: Number(owner.rating_count || 0)
    };
}

async function searchActiveOwners(query) {
    const q = (query || '').trim().toLowerCase();
    const users = await readCollection('users');
    return users
        .filter(user => user.role === 'owner' && user.status === 'Active')
        .filter(owner => !q || (owner.shop_name || '').toLowerCase().includes(q) || (owner.location || '').toLowerCase().includes(q))
        .map(owner => ({ id: owner.id, shop_name: owner.shop_name, location: owner.location, phone: owner.phone }))
        .sort((a, b) => (b.shop_name || '').localeCompare(a.shop_name || ''));
}

async function listOwners() {
    const users = await readCollection('users');
    return users.filter(user => user.role === 'owner').sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '')).map(normalizeRow);
}

async function updateOwnerStatus(id, status) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index].status = status;
        await writeCollection('users', users);
    }
}

async function updateOwnerSubscription(id, plan, active, expiry) {
    const users = await readCollection('users');
    const index = users.findIndex(user => user.id === id);
    if (index >= 0) {
        users[index].subscription_plan = plan;
        users[index].subscription_active = !!active;
        users[index].subscription_expiry = expiry || null;
        await writeCollection('users', users);
    }
}

async function deleteOwner(id) {
    const users = (await readCollection('users')).filter(user => user.id !== id);
    await writeCollection('users', users);
    const services = (await readCollection('services')).filter(service => service.owner_id !== id);
    await writeCollection('services', services);
    const orders = (await readCollection('orders')).filter(order => order.owner_id !== id);
    await writeCollection('orders', orders);
}

async function getServicesByOwner(ownerId, options = {}) {
    const services = (await readCollection('services')).filter(service => service.owner_id === ownerId);
    return services
        .filter(service => !options.enabledOnly || service.enabled === true)
        .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''))
        .map(normalizeRow);
}

async function getServiceById(id) {
    if (!id) return null;
    const service = (await readCollection('services')).find(service => service.id === id);
    return normalizeRow(service || null);
}

async function createService(ownerId, name, price_per_page) {
    const services = await readCollection('services');
    const service = {
        id: makeId('svc'),
        owner_id: ownerId,
        name,
        price_per_page: +price_per_page,
        enabled: true,
        created_at: new Date().toISOString()
    };
    services.push(service);
    await writeCollection('services', services);
    return getServiceById(service.id);
}

async function updateService(id, data) {
    const services = await readCollection('services');
    const index = services.findIndex(service => service.id === id);
    if (index >= 0) {
        services[index] = {...services[index], ...data, enabled: data.enabled != null ? !!data.enabled : !!services[index].enabled };
        await writeCollection('services', services);
    }
    return getServiceById(id);
}

async function deleteService(id) {
    const services = (await readCollection('services')).filter(service => service.id !== id);
    await writeCollection('services', services);
}

async function countOrdersForOwnerToday(ownerId) {
    const today = new Date().toISOString().slice(0, 10);
    const orders = await readCollection('orders');
    return orders.filter(order => order.owner_id === ownerId && order.created_at_date === today).length;
}

async function createOrder(data) {
    const orders = await readCollection('orders');
    const now = new Date();
    const order = {
        id: data.id || makeId('ord'),
        ...data,
        created_at: now.toISOString(),
        created_at_date: now.toISOString().slice(0, 10),
        updated_at: now.toISOString()
    };
    orders.push(order);
    await writeCollection('orders', orders);
    return getOrderById(order.id);
}

async function getOrderById(id) {
    if (!id) return null;
    const order = (await readCollection('orders')).find(order => order.id === id);
    return order || null;
}

async function listOrdersByOwner(ownerId) {
    const orders = (await readCollection('orders')).filter(order => order.owner_id === ownerId);
    return orders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

async function listAllOrders() {
    const orders = await readCollection('orders');
    return orders.sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

async function updateOrderStatus(id, data) {
    const orders = await readCollection('orders');
    const index = orders.findIndex(order => order.id === id);
    if (index >= 0) {
        orders[index] = {...orders[index], ...data, updated_at: new Date().toISOString() };
        await writeCollection('orders', orders);
    }
    return getOrderById(id);
}

async function setOrderRating(id, rating) {
    const orders = await readCollection('orders');
    const index = orders.findIndex(order => order.id === id);
    if (index >= 0) {
        orders[index] = {
            ...orders[index],
            owner_rating: Number(rating),
            rating_submitted_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };
        await writeCollection('orders', orders);
    }

    const order = await getOrderById(id);
    if (order && order.owner_id) {
        const ownerOrders = (await readCollection('orders')).filter(entry => entry.owner_id === order.owner_id && Number.isFinite(Number(entry.owner_rating)));
        const ratings = ownerOrders.map(entry => Number(entry.owner_rating)).filter(Boolean);
        const ratingCount = ratings.length;
        const ratingAvg = ratingCount ? +(ratings.reduce((sum, value) => sum + value, 0) / ratingCount).toFixed(1) : 0;
        const users = await readCollection('users');
        const userIndex = users.findIndex(user => user.id === order.owner_id);
        if (userIndex >= 0) {
            users[userIndex].rating_avg = ratingAvg;
            users[userIndex].rating_count = ratingCount;
            await writeCollection('users', users);
        }
    }
    return order;
}

async function getOwnerStats(ownerId) {
    const orders = (await readCollection('orders')).filter(order => order.owner_id === ownerId);
    return orders.reduce((acc, order) => {
        acc.order_count += 1;
        if (order.payment_status === 'paid') {
            acc.fees += parseFloat(order.platform_fee || 0);
            acc.payout += parseFloat(order.owner_payout || 0);
        }
        return acc;
    }, { order_count: 0, fees: 0, payout: 0 });
}

async function getOwnersByIds(ids) {
    if (!ids || !ids.length) return {};
    const users = await readCollection('users');
    return ids.reduce((acc, id) => {
        const user = users.find(entry => entry.id === id);
        if (user) acc[id] = normalizeRow(user);
        return acc;
    }, {});
}

async function getNotificationsByOwner(ownerId) {
    const notes = await readCollection('notifications');
    return notes.filter(n => n.owner_id === ownerId).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
}

// Create a notification for an owner (stored in 'notifications' collection/file)
async function createNotification(ownerId, data) {
    const notes = await readCollection('notifications');
    const note = {
        id: makeId('note'),
        owner_id: ownerId,
        title: data.title || '',
        body: data.body || '',
        link: data.link || null,
        order_id: data.order_id || null,
        read: data.read ? !!data.read : false,
        created_at: new Date().toISOString()
    };
    notes.push(note);
    await writeCollection('notifications', notes);
    return note;
}

async function getDocumentById(id) {
    if (!id) return null;
    const documents = await readCollection('documents');
    return documents.find(doc => doc.id === id) || null;
}

async function listDocumentsByOwner(ownerId) {
    const documents = await readCollection('documents');
    return documents
        .filter(doc => doc.ownerId === ownerId)
        .sort((a, b) => (b.uploadedAt || '').localeCompare(a.uploadedAt || ''));
}

async function createDocument(data) {
    const documents = await readCollection('documents');
    const now = new Date();
    const document = {
        id: data.id || makeId('doc'),
        fileName: data.fileName || '',
        ownerId: data.ownerId || '',
        totalPages: Number(data.totalPages) || 0,
        fileType: data.fileType || '',
        storagePath: data.storagePath || '',
        uploadedAt: data.uploadedAt || now.toISOString(),
        status: data.status || 'uploaded',
        updatedAt: data.uploadedAt || now.toISOString()
    };
    documents.push(document);
    await writeCollection('documents', documents);
    return getDocumentById(document.id);
}

async function listPagesByDocumentId(documentId) {
    const pages = await readCollection('pages');
    return pages
        .filter(page => page.documentId === documentId)
        .sort((a, b) => Number(a.pageNumber) - Number(b.pageNumber));
}

async function createPage(data) {
    const pages = await readCollection('pages');
    const now = new Date();
    const page = {
        id: data.pageId || makeId('page'),
        pageId: data.pageId || makeId('page'),
        documentId: data.documentId || '',
        pageNumber: Number(data.pageNumber) || 0,
        thumbnailUrl: data.thumbnailUrl || '',
        extractedText: data.extractedText || '',
        pageStoragePath: data.pageStoragePath || '',
        createdAt: data.createdAt || now.toISOString(),
        updatedAt: data.updatedAt || now.toISOString()
    };
    pages.push(page);
    await writeCollection('pages', pages);
    return page;
}

async function createSubmission(data) {
    const submissions = await readCollection('submissions');
    const now = new Date();
    const submission = {
        id: data.id || makeId('sub'),
        documentId: data.documentId || '',
        extractedDocumentId: data.extractedDocumentId || '',
        selectedPages: Array.isArray(data.selectedPages) ? data.selectedPages : [],
        totalSelectedPages: Number(data.totalSelectedPages) || 0,
        submittedBy: data.submittedBy || '',
        submittedAt: data.submittedAt || now.toISOString(),
        status: data.status || 'pending',
        extractedDocumentStoragePath: data.extractedDocumentStoragePath || null,
        extractedDocumentUrl: data.extractedDocumentUrl || null,
        updatedAt: data.submittedAt || now.toISOString()
    };
    submissions.push(submission);
    await writeCollection('submissions', submissions);
    return getSubmissionById(submission.id);
}

async function updateSubmission(id, data) {
    const submissions = await readCollection('submissions');
    const index = submissions.findIndex(item => item.id === id);
    if (index >= 0) {
        submissions[index] = {
            ...submissions[index],
            ...data,
            updatedAt: new Date().toISOString()
        };
        await writeCollection('submissions', submissions);
    }
    return getSubmissionById(id);
}

async function getSubmissionById(id) {
    if (!id) return null;
    const submissions = await readCollection('submissions');
    return submissions.find(item => item.id === id) || null;
}

async function logEvent(userId, eventType, payload) {
    const events = await readCollection('events');
    const event = {
        id: makeId('evt'),
        userId: userId || null,
        type: eventType || 'event',
        payload: payload || {},
        createdAt: new Date().toISOString()
    };
    events.push(event);
    await writeCollection('events', events);
    return event;
}

module.exports = {
    initialize,
    getUserByEmail,
    getUserById,
    updateUserPassword,
    setPasswordResetToken,
    findUserByResetToken,
    clearPasswordResetToken,
    setLoginOtp,
    clearLoginOtp,
    verifyLoginOtp,
    createOwner,
    updateUserProfile,
    findOwnerById,
    getOwnerPublicById,
    searchActiveOwners,
    listOwners,
    updateOwnerStatus,
    updateOwnerSubscription,
    deleteOwner,
    getServicesByOwner,
    getServiceById,
    createService,
    updateService,
    deleteService,
    countOrdersForOwnerToday,
    createOrder,
    getOrderById,
    listOrdersByOwner,
    listAllOrders,
    updateOrderStatus,
    setOrderRating,
    getOwnerStats,
    getOwnersByIds,
    createNotification,
    getNotificationsByOwner
};