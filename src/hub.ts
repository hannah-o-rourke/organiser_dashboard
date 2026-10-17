import { MatrixEvent } from "../types";

const { hub_url, engagement_secret } = process.env;

export const TOOL_ID = "engagement";

export function dashboardLink(roomId: string, key: string) {
    return hub_url ? `${hub_url}/${TOOL_ID}/?roomId=${encodeURIComponent(roomId)}&key=${key}` : null;
}

// Needs the tool hub's /api/room/power-levels endpoint (tool-hub-power-levels.patch).
export async function fetchPowerLevels(roomId: string) {
    if (!hub_url) return null;
    const params = new URLSearchParams({ roomId, toolId: TOOL_ID, secret: engagement_secret ?? "" });
    const response = await fetch(`${hub_url}/api/room/power-levels?${params}`);
    if (!response.ok)
        throw new Error(`tool hub returned ${response.status} for power levels`);

    return await response.json() as { users?: { [userId: string]: number }; users_default?: number };
}

export function canImportHistory() {
    return Boolean(hub_url && engagement_secret);
}

export async function fetchHistory(roomId: string, since: number) {
    const params = new URLSearchParams({ roomId, since: new Date(since).toISOString() });
    const response = await fetch(`${hub_url}/api/room/history?${params}`);
    if (!response.ok)
        throw new Error(`tool hub returned ${response.status} for room history`);

    const { events } = await response.json() as { events: MatrixEvent[] };
    return events;
}

// Only works while the tool is switched on in that room. With a context the
// message goes as a raw event, so reactions to it come back carrying that
// context (the hub's plain messages have none).
export async function sendToGroup(roomId: string, message: string, context?: object) {
    const params = new URLSearchParams({ roomId, toolId: TOOL_ID, secret: engagement_secret ?? "" });
    const response = await fetch(`${hub_url}/api/send?${params}`, {
        method: "POST",
        body: JSON.stringify(context
            ? { event: { type: "m.room.message", msgtype: "m.text", body: message, context: { moduleEvent: true, ...context } } }
            : { message }),
        headers: { "Content-type": "application/json" },
    });
    return await response.json() as { success: boolean; message?: string };
}
