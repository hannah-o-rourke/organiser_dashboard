import { createHash, randomBytes } from "node:crypto";
import { getLatestPowerLevels, getOrganiserForKey, saveOrganiserKey } from "./duckdb";
import { fetchPowerLevels } from "./hub";

// WhatsApp and Signal bridges give group admins a raised Matrix power level
const adminLevel = Number(process.env.ADMIN_POWER_LEVEL ?? 50);
const CACHE_FOR = 5 * 60 * 1000;

type PowerLevels = { users?: { [userId: string]: number }; users_default?: number };

const cache = new Map<string, { at: number; powerLevels: PowerLevels }>();

function hash(key: string) {
    return createHash("sha256").update(key).digest("hex");
}

// Asks the hub for the group's current power levels, falling back to the
// last power-levels change the tool saw in the chat (hubs without the patch).
async function powerLevels(roomId: string): Promise<PowerLevels | null> {
    const cached = cache.get(roomId);
    if (cached && Date.now() - cached.at < CACHE_FOR)
        return cached.powerLevels;

    const fetched = await fetchPowerLevels(roomId).catch(err => {
        console.log("couldn't get power levels from the hub", err);
        return null;
    });
    const found = fetched ?? await getLatestPowerLevels(roomId);
    if (found) cache.set(roomId, { at: Date.now(), powerLevels: found });
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

// Each admin gets their own key; asking again replaces the old one, so a
// forwarded link stops working once its owner asks for a new one.
export async function issueKey(roomId: string, userId: string) {
    const key = randomBytes(24).toString("base64url");
    await saveOrganiserKey(roomId, userId, hash(key));
    return key;
}

// The key must belong to this group, and its owner must still be an admin.
export async function organiserFor(roomId: string, key: string | undefined) {
    if (!roomId || !key) return null;
    const userId = await getOrganiserForKey(roomId, hash(key));
    if (!userId) return null;
    return await isAdmin(roomId, userId) ? userId : null;
}
