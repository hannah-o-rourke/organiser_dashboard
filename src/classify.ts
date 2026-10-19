import { Activity, MatrixEvent, MessageFormat } from "../types";

const COMMAND_PREFIX = "!engagement";

const linkPattern = /(https?:\/\/|www\.)\S+/i;

const formats: { [msgtype: string]: MessageFormat } = {
    "m.text": "text",
    "m.notice": "text",
    "m.emote": "text",
    "m.image": "image",
    "m.audio": "audio",
    "m.video": "video",
    "m.file": "file",
};

// A message that's nothing but 🏆 (one or more) is a quick way to ask for your
// own stats, the same as "!engagement me".
const TROPHY_ONLY = /^(\u{1F3C6}[\u{FE0F}\u{1F3FB}-\u{1F3FF}]?\s*)+$/u;

function isTrophy(body: string) {
    return TROPHY_ONLY.test(body.trim());
}

export function isCommand(event: MatrixEvent) {
    const body = event.content?.body;
    if (event.type !== "m.room.message" || typeof body !== "string") return false;
    return body.trim().toLowerCase().startsWith(COMMAND_PREFIX) || isTrophy(body);
}

export function commandArgs(event: MatrixEvent) {
    if (isTrophy(event.content.body)) return "me";
    return event.content.body.trim().slice(COMMAND_PREFIX.length).trim().toLowerCase();
}

function lengthBucket(body: string) {
    const words = body.trim().split(/\s+/).filter(Boolean).length;
    if (words <= 5) return "short";
    if (words <= 40) return "medium";
    return "long";
}

// Replies quote the message they answer above the reply itself. Strip that so
// a question mark or link in the quoted message isn't counted against the reply.
function ownText(body: string) {
    return body.split("\n").filter(line => !line.startsWith(">")).join("\n");
}

function displayNameFor(event: MatrixEvent) {
    return event.displayname || event.sender.replace(/^@/, "").split(":")[0];
}

// Turns a Matrix event into an Activity row, or null if it isn't something a
// participant did (edits, the bot itself, commands to this tool, state noise).
// The message body is read here to set a few flags and is then discarded.
export function classify(event: MatrixEvent, botUserId: string | undefined, source: Activity["source"]): Activity | null {
    if (!event.sender || event.sender === botUserId)
        return null;

    const base = {
        event_id: event.event_id,
        room_id: event.room_id,
        sender: event.sender,
        display_name: displayNameFor(event),
        ts: event.origin_server_ts,
        format: null,
        target_event_id: null,
        target_sender: null,
        has_link: false,
        has_question: false,
        length_bucket: null,
        source,
    };

    if (event.type === "m.reaction") {
        const relation = event.content?.["m.relates_to"];
        // reactions to the bot's own messages are people using a tool, not talking to each other
        if (!relation?.event_id || event.prevEvent?.sender === botUserId)
            return null;

        return {
            ...base,
            kind: "reaction",
            target_event_id: relation.event_id,
            target_sender: event.prevEvent?.sender ?? null,
        };
    }

    if (event.type === "m.room.message") {
        const relation = event.content?.["m.relates_to"];

        // redacted messages come back from history with their content emptied
        if (!event.content?.msgtype || relation?.rel_type === "m.replace" || isCommand(event))
            return null;

        const body: string = typeof event.content?.body === "string" ? event.content.body : "";
        const format = formats[event.content?.msgtype] ?? "other";
        const text = ownText(body);
        const replyTo = relation?.["m.in_reply_to"]?.event_id ?? null;

        return {
            ...base,
            kind: "message",
            format,
            target_event_id: replyTo,
            target_sender: replyTo ? event.prevEvent?.sender ?? null : null,
            has_link: format === "text" && linkPattern.test(text),
            has_question: format === "text" && text.includes("?"),
            length_bucket: format === "text" ? lengthBucket(text) : null,
        };
    }

    if (event.type === "m.room.member" && event.state_key) {
        const membership = event.content?.membership;
        const previous = event.unsigned?.prev_content?.membership;

        if (membership !== "join" && membership !== "leave")
            return null;

        // profile changes also arrive as join events; only count real arrivals
        if (membership === "join" && previous === "join")
            return null;

        if (event.state_key === botUserId)
            return null;

        return {
            ...base,
            sender: event.state_key,
            display_name: event.content?.displayname || event.state_key.replace(/^@/, "").split(":")[0],
            kind: membership,
        };
    }

    return null;
}
