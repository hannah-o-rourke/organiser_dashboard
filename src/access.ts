import { createHash, randomBytes } from "node:crypto";
import { getEmailForKey, getLatestPowerLevels, getOrganiserForKey, saveOrganiserKey } from "./duckdb";
import { fetchPowerLevels } from "./hub";
import { log } from "./log";

// WhatsApp and Signal bridges give group admins a raised Matrix power level
const adminLevel = Number(process.env.ADMIN_POWER_LEVEL ?? 50);
const CACHE_FOR = 5 * 60 * 1000;

type PowerLevels = { users?: { [userId: string]: number }; users_default?: number };

const cache = new Map<string, { at: number; powerLevels: PowerLevels | null }>();

function hash(key: string) {
    return createHash("sha256").update(key).digest("hex");
}

// Asks the hub for the group's current power levels, falling back to the
// last power-levels change the tool saw in the chat (hubs without the patch).
async function powerLevels(roomId: string): Promise<PowerLevels | null> {
    const cached = cache.get(roomId);
    if (cached && Date.now() - cached.at < CACHE_FOR)
        return cached.powerLevels;

    const fetched = await fetchPowerLevels(roomId).catch(() => {
        log("  hub can't say who the group admins are (expected until the hub is patched), using organiser emails");
        return null;
    });
    // "unknown" is cached too, so a hub without the endpoint isn't asked every time
    const found = fetched ?? await getLatestPowerLevels(roomId);
    cache.set(roomId, { at: Date.now(), powerLevels: found });
    return found;
}

export function forgetCachedPowerLevels(roomId: string) {
    cache.delete(roomId);
}

export async function isAdmin(roomId: string, userId: string) {
    const levels = await powerLevels(roomId);
    if (!levels) return null;
    return (levels.users?.[userId] ?? levels.users_default ?? 0) >= adminLevel;
}

export function newKey() {
    const key = randomBytes(24).toString("base64url");
    return { key, keyHash: hash(key) };
}

// Each admin gets their own key; asking again replaces the old one, so a
// forwarded link stops working once its owner asks for a new one.
export async function issueKey(roomId: string, userId: string) {
    const { key, keyHash } = newKey();
    await saveOrganiserKey(roomId, userId, keyHash);
    return key;
}

// A key is either an emailed organiser's, valid until another organiser
// removes them, or a group admin's, valid while they're still an admin.
export async function organiserFor(roomId: string, key: string | undefined) {
    if (!roomId || !key) return null;

    const email = await getEmailForKey(roomId, hash(key));
    if (email) return email;

    const userId = await getOrganiserForKey(roomId, hash(key));
    if (!userId) return null;
    return await isAdmin(roomId, userId) ? userId : null;
}
