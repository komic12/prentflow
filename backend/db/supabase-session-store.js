const session = require('express-session');
const { supabase, supabaseConfigured, sessionTable } = require('./supabase');

class SupabaseSessionStore extends session.Store {
    constructor(options = {}) {
        super(options);
        this.table = options.table || sessionTable;
    }

    get(sid, callback) {
        supabase.from(this.table).select('sess,expire').eq('sid', sid).maybeSingle()
            .then(({ data, error }) => {
                if (error) return callback(error);
                if (!data || new Date(data.expire).getTime() <= Date.now()) return callback(null, null);
                callback(null, data.sess || null);
            })
            .catch(callback);
    }

    set(sid, sess, callback) {
        const expire = new Date(sess.cookie && sess.cookie.expires || Date.now() + 86400000).toISOString();
        supabase.from(this.table).upsert({ sid, sess, expire }, { onConflict: 'sid' })
            .then(({ error }) => callback(error || null))
            .catch(callback);
    }

    destroy(sid, callback) {
        supabase.from(this.table).delete().eq('sid', sid)
            .then(({ error }) => callback(error || null))
            .catch(callback);
    }

    touch(sid, sess, callback) {
        const expire = new Date(sess.cookie && sess.cookie.expires || Date.now() + 86400000).toISOString();
        supabase.from(this.table).update({ sess, expire }).eq('sid', sid)
            .then(({ error }) => callback(error || null))
            .catch(callback);
    }
}

function createSessionStore() {
    return supabaseConfigured && process.env.SUPABASE_ENABLED !== 'false'
        ? new SupabaseSessionStore()
        : undefined;
}

module.exports = { SupabaseSessionStore, createSessionStore };
