import { DuckDBConnection, DuckDBInstance, DuckDBValue } from "@duckdb/node-api";
import path from "node:path";
import { Activity, RoomSettings } from "../types";
import type { Theme } from "./themes";

let connection: DuckDBConnection;
let instance: DuckDBInstance;

async function rows(sql: string, values: DuckDBValue[] = []) {
    const reader = await connection.runAndReadAll(sql, values);
    return reader.getRowObjectsJS();
}

export async function startDuckDB(fileName = "engagement_duckdb.db") {
    const dataDir = process.env.DUCKDB_DATA_DIR ?? path.resolve(__dirname, "../..");
    const dbPath = fileName === ":memory:" ? fileName : path.join(dataDir, fileName);

    instance = await DuckDBInstance.create(dbPath);
    connection = await instance.connect();

    // timestamps are DOUBLE rather than BIGINT so they come back as plain JS numbers.
    // They're bound as strings and cast, because a bound JS number is taken as a
    // 32-bit INTEGER and millisecond timestamps overflow it.
    await connection.run(`CREATE TABLE IF NOT EXISTS Activity (
        event_id VARCHAR,
        room_id VARCHAR,
        sender VARCHAR,
        display_name VARCHAR,
        ts DOUBLE,
        kind VARCHAR,
        format VARCHAR,
        target_event_id VARCHAR,
        target_sender VARCHAR,
        has_link BOOLEAN,
        has_question BOOLEAN,
        length_bucket VARCHAR,
        source VARCHAR,
        PRIMARY KEY (room_id, event_id)
    );`);
    await connection.run(`CREATE TABLE IF NOT EXISTS Rooms (
        room_id VARCHAR PRIMARY KEY,
        tracking_since DOUBLE,
        imported_from DOUBLE
    );`);
    // only the summary Claude returns is kept, never the messages it was made from
    await connection.run(`CREATE TABLE IF NOT EXISTS Themes (
        room_id VARCHAR,
        month VARCHAR,
        generated_at DOUBLE,
        message_count INTEGER,
        themes VARCHAR,
        PRIMARY KEY (room_id, month)
    );`);
    // one row per request to Claude, for the usage limits and the hosting bill;
    // kept through !engagement forget so forgetting can't reset a group's limit
    await connection.run(`CREATE TABLE IF NOT EXISTS ThemeRuns (
        room_id VARCHAR,
        run_at DOUBLE,
        input_tokens INTEGER,
        output_tokens INTEGER
    );`);
    // AI theme summaries are off until an admin switches them on, which posts
    // an opt-out notice; enabled_at starts the notice period
    await connection.run(`CREATE TABLE IF NOT EXISTS AiSettings (
        room_id VARCHAR PRIMARY KEY,
        enabled BOOLEAN,
        enabled_at DOUBLE
    );`);
    // people who keep their messages out of AI summaries; via_event_id is the
    // ❌ reaction that opted them out, so removing the reaction opts them back in
    await connection.run(`CREATE TABLE IF NOT EXISTS AiOptOuts (
        room_id VARCHAR,
        sender VARCHAR,
        via_event_id VARCHAR,
        PRIMARY KEY (room_id, sender)
    );`);
    // only a hash of each admin's dashboard key is stored
    await connection.run(`CREATE TABLE IF NOT EXISTS OrganiserKeys (
        room_id VARCHAR,
        user_id VARCHAR,
        key_hash VARCHAR,
        created_at DOUBLE,
        PRIMARY KEY (room_id, user_id)
    );`);
    // organisers who get the dashboard by email; 'pending' until an existing
    // organiser approves. key_hash is null until a link has been sent.
    await connection.run(`CREATE TABLE IF NOT EXISTS OrganiserEmails (
        room_id VARCHAR,
        email VARCHAR,
        status VARCHAR,
        key_hash VARCHAR,
        requested_by VARCHAR,
        created_at DOUBLE,
        PRIMARY KEY (room_id, email)
    );`);
    await connection.run(`CREATE TABLE IF NOT EXISTS PowerLevels (
        room_id VARCHAR PRIMARY KEY,
        content VARCHAR
    );`);
    await connection.run(`CREATE TABLE IF NOT EXISTS OptOuts (
        room_id VARCHAR,
        sender VARCHAR,
        PRIMARY KEY (room_id, sender)
    );`);
}

export async function insertActivity(activity: Activity) {
    await connection.run(
        `INSERT OR IGNORE INTO Activity VALUES ($1, $2, $3, $4, $5::DOUBLE, $6, $7, $8, $9, $10, $11, $12, $13);`,
        [
            activity.event_id, activity.room_id, activity.sender, activity.display_name, String(activity.ts),
            activity.kind, activity.format, activity.target_event_id, activity.target_sender,
            activity.has_link, activity.has_question, activity.length_bucket, activity.source,
        ]
    );
}

export async function getActivity(roomId: string) {
    return await rows(`SELECT * FROM Activity WHERE room_id = $1 ORDER BY ts;`, [roomId]) as Activity[];
}

export async function deleteActivityEvent(roomId: string, eventId: string) {
    await connection.run(`DELETE FROM Activity WHERE room_id = $1 AND event_id = $2;`, [roomId, eventId]);
}

export async function getRoom(roomId: string) {
    const [room] = await rows(`SELECT * FROM Rooms WHERE room_id = $1;`, [roomId]);
    return room as RoomSettings | undefined;
}

export async function insertRoom(roomId: string, trackingSince: number) {
    await connection.run(`INSERT OR IGNORE INTO Rooms VALUES ($1, $2::DOUBLE, NULL);`, [roomId, String(trackingSince)]);
}

export async function setImportedFrom(roomId: string, importedFrom: number) {
    await connection.run(`UPDATE Rooms SET imported_from = $2::DOUBLE WHERE room_id = $1;`, [roomId, String(importedFrom)]);
}

export async function isOptedOut(roomId: string, sender: string) {
    const found = await rows(`SELECT 1 FROM OptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
    return found.length > 0;
}

export async function getOptOutCount(roomId: string) {
    const [{ count }] = await rows(`SELECT COUNT(*)::INTEGER AS count FROM OptOuts WHERE room_id = $1;`, [roomId]);
    return count as number;
}

// Opting out removes everything already held about that person in this group,
// including their name on other people's replies and reactions to them.
export async function optOut(roomId: string, sender: string) {
    await connection.run(`INSERT OR IGNORE INTO OptOuts VALUES ($1, $2);`, [roomId, sender]);
    await connection.run(`DELETE FROM Activity WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
    await connection.run(`UPDATE Activity SET target_sender = NULL WHERE room_id = $1 AND target_sender = $2;`, [roomId, sender]);
}

export async function optIn(roomId: string, sender: string) {
    await connection.run(`DELETE FROM OptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
}

// deletes what's held about the group's members; who can open the dashboard stays
export async function forgetRoom(roomId: string) {
    await connection.run(`DELETE FROM Activity WHERE room_id = $1;`, [roomId]);
    await connection.run(`DELETE FROM Themes WHERE room_id = $1;`, [roomId]);
    await connection.run(`DELETE FROM Rooms WHERE room_id = $1;`, [roomId]);
}

export async function saveThemes(roomId: string, month: string, messageCount: number, themes: Theme[]) {
    await connection.run(
        `INSERT OR REPLACE INTO Themes VALUES ($1, $2, $3::DOUBLE, $4::INTEGER, $5);`,
        [roomId, month, String(Date.now()), String(messageCount), JSON.stringify(themes)]
    );
}

export async function getThemes(roomId: string) {
    const found = await rows(`SELECT * FROM Themes WHERE room_id = $1 ORDER BY month DESC;`, [roomId]);
    return found.map(row => ({
        month: row.month as string,
        generatedAt: row.generated_at as number,
        messageCount: row.message_count as number,
        themes: JSON.parse(row.themes as string) as Theme[],
    }));
}

// both survive !engagement forget, like individual opt-outs
export async function getAiSettings(roomId: string) {
    const [found] = await rows(`SELECT enabled, enabled_at FROM AiSettings WHERE room_id = $1;`, [roomId]);
    return { enabled: Boolean(found?.enabled), enabledAt: (found?.enabled_at as number | null) ?? null };
}

export async function setAiEnabled(roomId: string, enabled: boolean) {
    await connection.run(
        `INSERT OR REPLACE INTO AiSettings VALUES ($1, $2, $3::DOUBLE);`,
        [roomId, enabled, enabled ? String(Date.now()) : null]
    );
}

export async function aiOptOut(roomId: string, sender: string, viaEventId: string | null) {
    await connection.run(`INSERT OR REPLACE INTO AiOptOuts VALUES ($1, $2, $3);`, [roomId, sender, viaEventId]);
}

export async function aiOptIn(roomId: string, sender: string) {
    await connection.run(`DELETE FROM AiOptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
}

// a removed ❌ reaction arrives as a redaction of the reaction event
export async function aiOptInByReaction(roomId: string, reactionEventId: string) {
    const [found] = await rows(`SELECT sender FROM AiOptOuts WHERE room_id = $1 AND via_event_id = $2;`, [roomId, reactionEventId]);
    if (!found) return null;
    await aiOptIn(roomId, found.sender as string);
    return found.sender as string;
}

export async function isAiOptedOut(roomId: string, sender: string) {
    const found = await rows(`SELECT 1 FROM AiOptOuts WHERE room_id = $1 AND sender = $2;`, [roomId, sender]);
    return found.length > 0;
}

export async function getAiOptOutCount(roomId: string) {
    const [{ count }] = await rows(`SELECT COUNT(*)::INTEGER AS count FROM AiOptOuts WHERE room_id = $1;`, [roomId]);
    return count as number;
}

export async function logThemeRun(roomId: string, inputTokens: number, outputTokens: number) {
    await connection.run(
        `INSERT INTO ThemeRuns VALUES ($1, $2::DOUBLE, $3::INTEGER, $4::INTEGER);`,
        [roomId, String(Date.now()), String(inputTokens), String(outputTokens)]
    );
}

export async function saveOrganiserKey(roomId: string, userId: string, keyHash: string) {
    await connection.run(
        `INSERT OR REPLACE INTO OrganiserKeys VALUES ($1, $2, $3, $4::DOUBLE);`,
        [roomId, userId, keyHash, String(Date.now())]
    );
}

export async function getOrganiserForKey(roomId: string, keyHash: string) {
    const [found] = await rows(`SELECT user_id FROM OrganiserKeys WHERE room_id = $1 AND key_hash = $2;`, [roomId, keyHash]);
    return found?.user_id as string | undefined;
}

export async function savePowerLevels(roomId: string, content: object) {
    await connection.run(`INSERT OR REPLACE INTO PowerLevels VALUES ($1, $2);`, [roomId, JSON.stringify(content)]);
}

export async function getLatestPowerLevels(roomId: string) {
    const [found] = await rows(`SELECT content FROM PowerLevels WHERE room_id = $1;`, [roomId]);
    return found ? JSON.parse(found.content as string) : null;
}

export type OrganiserEmail = { email: string; status: "active" | "pending"; requestedBy: string; createdAt: number };

export async function getOrganiserEmails(roomId: string) {
    const found = await rows(`SELECT email, status, requested_by, created_at FROM OrganiserEmails WHERE room_id = $1 ORDER BY created_at;`, [roomId]);
    return found.map(row => ({
        email: row.email as string,
        status: row.status as OrganiserEmail["status"],
        requestedBy: row.requested_by as string,
        createdAt: row.created_at as number,
    }));
}

export async function saveOrganiserEmail(roomId: string, email: string, status: OrganiserEmail["status"], keyHash: string | null, requestedBy: string) {
    await connection.run(
        `INSERT OR REPLACE INTO OrganiserEmails VALUES ($1, $2, $3, $4, $5, $6::DOUBLE);`,
        [roomId, email, status, keyHash, requestedBy, String(Date.now())]
    );
}

export async function removeOrganiserEmail(roomId: string, email: string) {
    await connection.run(`DELETE FROM OrganiserEmails WHERE room_id = $1 AND email = $2;`, [roomId, email]);
}

export async function getEmailForKey(roomId: string, keyHash: string) {
    const [found] = await rows(`SELECT email FROM OrganiserEmails WHERE room_id = $1 AND key_hash = $2 AND status = 'active';`, [roomId, keyHash]);
    return found?.email as string | undefined;
}
