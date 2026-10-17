import { MatrixEvent } from "../types";
import { classify } from "./classify";
import { getActivity, getRoom, insertActivity, insertRoom, isOptedOut, setImportedFrom } from "./duckdb";
import { fetchHistory, sendToGroup } from "./hub";

const DAY = 24 * 60 * 60 * 1000;

// Pulls earlier messages from the tool hub so the dashboard covers time before
// the tool was switched on. It's an explicit organiser action and is announced
// in the group, because those messages were sent before anyone was told.
export async function importHistory(roomId: string, days: number, botUserId?: string) {
    const since = Date.now() - days * DAY;
    const events = await fetchHistory(roomId, since);

    // history comes straight from Matrix, without the display names and
    // replied-to events the hub adds to live events
    const names = new Map<string, string>();
    for (const row of await getActivity(roomId)) names.set(row.sender, row.display_name);
    for (const event of events) {
        if (event.type === "m.room.member" && event.state_key && event.content?.displayname)
            names.set(event.state_key, event.content.displayname);
    }

    let imported = 0;
    for (const event of events) {
        event.room_id = roomId;
        event.displayname = names.get(event.sender);

        const activity = classify(event, botUserId, "imported");
        if (!activity || await isOptedOut(roomId, activity.sender))
            continue;

        await insertActivity(activity);
        imported++;
    }

    await insertRoom(roomId, Date.now());
    const room = await getRoom(roomId);
    if (!room?.imported_from || since < room.imported_from)
        await setImportedFrom(roomId, since);

    const announcement = await sendToGroup(roomId,
        `📊 An admin has added the last ${days} days of this group's activity to the Engagement dashboard (${imported} posts, reactions and joins). ` +
        "As before, only timings are stored, never what was written. Send !engagement optout to remove yourself, or !engagement to see what's tracked.");

    return { imported, announced: announcement.success, announcementError: announcement.message };
}
