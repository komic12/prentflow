const session = require('express-session');
const { supabase, supabaseConfigured } = require('./supabase');

class SupabaseSessionStore extends session.Store {
    constructor(options = {}) {
        super(options);
        this.table = options.table || 'printflow_records';
    }

    get(sid, callback) {
        supabase.from(this.table).select('data').eq('collection', '_sessions').eq('id', sid).maybeSingle()
            .then(({ data, error }) => {
                if (error) return callback(error);
                const sessionData = data && data.data;
                if (!sessionData || new Date(sessionData.expire).getTime() <= Date.now()) return callback(null, null);
                callback(null, sessionData.sess || null);
            })
            .catch(callback);
    }

    set(sid, sess, callback) {
        const expire = new Date(sess.cookie && sess.cookie.expires || Date.now() + 86400000).toISOString();
        supabase.from(this.table).upsert({ collection: '_sessions', id: sid, data: { sess, expire } }, { onConflict: 'collection,id' })
            .then(({ error }) => callback(error || null))
            .catch(callback);
    }

    destroy(sid, callback) {
        supabase.from(this.table).delete().eq('collection', '_sessions').eq('id', sid)
            .then(({ error }) => callback(error || null))
            .catch(callback);
    }

    touch(sid, sess, callback) {
        const expire = new Date(sess.cookie && sess.cookie.expires || Date.now() + 86400000).toISOString();
        supabase.from(this.table).update({ data: { sess, expire } }).eq('collection', '_sessions').eq('id', sid)
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
