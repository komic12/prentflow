require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_STORAGE_BUCKET = process.env.SUPABASE_STORAGE_BUCKET;
const SUPABASE_DATA_TABLE = process.env.SUPABASE_DATA_TABLE || 'printflow_records';
const SUPABASE_SESSION_TABLE = process.env.SUPABASE_SESSION_TABLE || 'printflow_sessions';

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !SUPABASE_STORAGE_BUCKET) {
    console.warn('Supabase storage is not fully configured. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_STORAGE_BUCKET.');
}

const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false }
    })
    : null;

const supabaseConfigured = Boolean(supabase);

module.exports = {
    supabase,
    supabaseConfigured,
    storageBucket: SUPABASE_STORAGE_BUCKET,
    dataTable: SUPABASE_DATA_TABLE,
    sessionTable: SUPABASE_SESSION_TABLE
};