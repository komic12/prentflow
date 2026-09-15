// ══════════════════════════════════════════════════════════════════
// Shared business logic — kept identical to the original PrintFlow
// rules, but now runs on the server so it can't be tampered with
// from the browser (e.g. a customer editing localStorage to change
// a total price).
// ══════════════════════════════════════════════════════════════════

function generateOrderCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    return 'PF-' + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function generateSmallId(ownerId, db) {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    const letter = letters[ownerId.charCodeAt(0) % letters.length];
    const count = await db.countOrdersForOwnerToday(ownerId);
    return `${letter}-${String(count + 1).padStart(2, '00')}`;
}

function calculateSplit(total, _owner, paymentMethod = 'cash', printedPages = 0) {
    const fee = paymentMethod === 'mpesa' ? Math.max(0, Number(printedPages) || 0) : 0;
    return {
        platform_fee: +fee.toFixed(2),
        transaction_fee: 0,
        owner_payout: +(total - fee).toFixed(2)
    };
}

// Public-safe view of a user (never send password_hash to the client)
function publicUser(u) {
    if (!u) return null;
    const { password_hash, passcode_hash, passcode_enabled, biometric_enabled, ...rest } = u;
    return {
        ...rest,
        subscription_active: !!rest.subscription_active,
        profile_image: rest.profile_image ? (String(rest.profile_image).startsWith('http') ? rest.profile_image : `/uploads/profiles/${rest.profile_image}`) : null
    };
}

function publicService(s) {
    return {...s, enabled: !!s.enabled };
}

module.exports = { generateOrderCode, generateSmallId, calculateSplit, publicUser, publicService };