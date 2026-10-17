import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { MatrixEvent } from "../types";
import { log } from "./log";
import { isCommand } from "./classify";
import { getActivity, getAiSettings, isAiOptedOut, isOptedOut, logThemeRun, saveThemes, setAiEnabled } from "./duckdb";
import { canImportHistory, fetchHistory, sendToGroup } from "./hub";

// Haiku keeps a month's summary to around half a penny per group, so one
// hosted key can serve many organisations
const MODEL = "claude-haiku-5-5";
const MINIMUM_MESSAGES = 10;
// Haiku's price doubles above 100K input tokens; ~4 characters per token
const MAXIMUM_CHARACTERS = 360_000;

// time people get to react ❌ after summaries are switched on, before the first one
const noticeHours = Number(process.env.AI_NOTICE_HOURS ?? 48);

export const OPT_OUT_EMOJI = "❌";
// any of these on an AI message opts someone back in
export const OPT_IN_EMOJIS = ["✅", "✔", "☑"];

const reactToChoose = `React ${OPT_OUT_EMOJI} to this message to leave your messages out of AI summaries, or ✅ to be included again.`;

const ThemesSchema = z.object({
    themes: z.array(z.object({
        title: z.string(),
        summary: z.string(),
        prominence: z.enum(["major", "moderate", "minor"]),
    })),
});

export type Theme = z.infer<typeof ThemesSchema>["themes"][number];

const SYSTEM_PROMPT = `You summarise the main themes of a month of messages in a community group chat, for the group's organisers.

Describe topics, never people. Don't name, identify or characterise any participant, don't say who raised or cared about what, and don't quote messages. Speakers are labelled "Person N" only so you can tell conversations apart; don't mention those labels.

Give 3 to 6 themes, most prominent first. Each has a short title (at most six words), a one or two sentence summary of what was discussed or decided, and how prominent it was in the month. If the month was mostly logistics or small talk, say so as a theme rather than inventing substance. Write in plain British English.`;

// needs the hub too, to fetch the month's messages and tell the group
export function canFindThemes() {
    return Boolean(process.env.ANTHROPIC_API_KEY) && canImportHistory();
}

export function monthRange(month: string) {
    const match = /^(\d{4})-(\d{2})$/.exec(month);
    if (!match) throw new Error("month must look like 2026-10");
    const year = Number(match[1]);
    const index = Number(match[2]) - 1;
    return { start: Date.UTC(year, index, 1), end: Date.UTC(year, index + 1, 1) };
}

function escapeRegExp(text: string) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Strips what identifies people before anything leaves the server: quoted
// replies, Matrix ids, phone numbers, emails, and the names of known members.
export function anonymise(body: string, names: string[]) {
    let text = body.split("\n").filter(line => !line.startsWith(">")).join("\n").trim();
    text = text.replace(/@[^\s:]+:[^\s]+/g, "[someone]");
    text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[email]");
    text = text.replace(/\+?\d[\d\s()-]{7,}\d/g, "[number]");
    for (const name of names.filter(n => n.length >= 3).sort((a, b) => b.length - a.length))
        text = text.replace(new RegExp(`\\b${escapeRegExp(name)}\\b`, "gi"), "[name]");
    return text;
}

export function transcript(events: MatrixEvent[], names: string[], botUserId: string | undefined, optedOut: Set<string>, start: number, end: number) {
    const people = new Map<string, number>();
    const lines: string[] = [];

    const messages = events
        .filter(e => e.type === "m.room.message" && e.origin_server_ts >= start && e.origin_server_ts < end)
        .filter(e => ["m.text", "m.notice", "m.emote"].includes(e.content?.msgtype))
        .filter(e => e.content?.["m.relates_to"]?.rel_type !== "m.replace")
        .filter(e => e.sender !== botUserId && !optedOut.has(e.sender) && !isCommand(e))
        .sort((a, b) => a.origin_server_ts - b.origin_server_ts);

    for (const message of messages) {
        const text = anonymise(String(message.content.body ?? ""), names);
        if (!text) continue;
        if (!people.has(message.sender)) people.set(message.sender, people.size + 1);
        const date = new Date(message.origin_server_ts).toISOString().slice(0, 10);
        lines.push(`[${date}] Person ${people.get(message.sender)}: ${text}`);
    }

    return lines;
}

export function noticeEndsAt(enabledAt: number | null) {
    return (enabledAt ?? 0) + noticeHours * 60 * 60 * 1000;
}

export const aiNotice = () =>
    `📊 An organiser has switched on AI theme summaries for this group. From time to time they can ask for a month's main topics, summarised by Anthropic's Claude.\n\n` +
    `Messages are sent without names or contact details, the summary is about topics and never people, and only the summary is kept.\n\n` +
    `If you DON'T want your messages included, react ${OPT_OUT_EMOJI} to this message. If you don't react, your messages may be included, and you can react ✅ later to be included again. ` +
    `Nothing will be summarised for ${noticeHours} hours, and you can change your mind at any time.`;

// Switching on posts the opt-out notice; there's no summary without it.
export async function switchAi(roomId: string, enabled: boolean) {
    const current = await getAiSettings(roomId);
    log(`AI summaries: switch ${enabled ? "ON" : "OFF"} requested`, { room: roomId, currently: current.enabled ? "on" : "off" });
    if (current.enabled === enabled) {
        log("  already in that state, nothing to do");
        return { success: true };
    }

    const announcement = enabled
        ? await sendToGroup(roomId, aiNotice(), { engagementAiNotice: true })
        : await sendToGroup(roomId, "📊 An organiser has switched off AI theme summaries for this group. No more messages will be sent to Claude.");

    if (enabled && !announcement.success) {
        log("  couldn't post the opt-out notice, so summaries stay OFF", { error: announcement.message });
        return { success: false, message: `Couldn't post the opt-out notice in the group (${announcement.message}), so summaries stay off.` };
    }

    await setAiEnabled(roomId, enabled);
    log(`  AI summaries now ${enabled ? "ON" : "OFF"}`, enabled ? { first_summary_from: new Date(noticeEndsAt(Date.now())).toISOString() } : {});
    return { success: true };
}

// An organiser asks for a month's themes. Messages are fetched from the hub,
// anonymised, sent to Claude, and only the resulting summary is kept.
export async function findThemes(roomId: string, month: string, botUserId: string | undefined) {
    log("AI summary requested", { room: roomId, month });
    const settings = await getAiSettings(roomId);
    if (!settings.enabled)
        throw new Error("AI theme summaries are switched off for this group.");
    const availableFrom = noticeEndsAt(settings.enabledAt);
    if (availableFrom > Date.now())
        throw new Error(`To give people time to opt out, the first summary can run from ${new Date(availableFrom).toUTCString()}.`);

    const { start, end } = monthRange(month);

    log("  1/4 asking the hub for the month's messages");
    const events = await fetchHistory(roomId, start);
    log("  hub sent events", { total: events.length, messages: events.filter(e => e.type === "m.room.message").length });

    const names = new Set<string>();
    const senders = new Set<string>();
    for (const row of await getActivity(roomId)) names.add(row.display_name);
    for (const event of events) {
        senders.add(event.sender);
        if (event.type === "m.room.member" && event.content?.displayname) names.add(event.content.displayname);
    }

    const optedOut = new Set<string>();
    for (const sender of senders)
        if (await isOptedOut(roomId, sender) || await isAiOptedOut(roomId, sender)) optedOut.add(sender);

    const lines = transcript(events, [...names], botUserId, optedOut, start, end);
    log("  2/4 messages left after removing opted-out people, the bot and commands", { usable: lines.length, opted_out_people: optedOut.size, bot_known: Boolean(botUserId) });
    if (lines.length < MINIMUM_MESSAGES)
        throw new Error(`Only ${lines.length} messages that month, which is too few to find themes in.`);
    if (lines.join("\n").length > MAXIMUM_CHARACTERS)
        throw new Error(`${lines.length} messages is more than one summary can cover. Ask the tool's host to raise the limit.`);

    log("  3/4 sending to Claude", { model: MODEL, characters: lines.join("\n").length });
    // keys that aren't scoped to a workspace have to name one on every request
    const workspace = process.env.ANTHROPIC_WORKSPACE_ID;
    const client = new Anthropic(workspace ? { defaultHeaders: { "anthropic-workspace-id": workspace } } : {});
    const response = await client.messages.parse({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        output_config: { effort: "low", format: zodOutputFormat(ThemesSchema) },
        messages: [{ role: "user", content: `Messages from ${month}:\n\n${lines.join("\n")}` }],
    });

    // logged whatever the outcome, since a declined request is still billed
    await logThemeRun(roomId, response.usage.input_tokens, response.usage.output_tokens);
    log("  Claude replied", { stop_reason: response.stop_reason, input_tokens: response.usage.input_tokens, output_tokens: response.usage.output_tokens, parsed: Boolean(response.parsed_output) });

    if (response.stop_reason === "refusal")
        throw new Error("Claude declined to summarise these messages.");
    if (!response.parsed_output)
        throw new Error(`Claude's answer couldn't be read (stopped because: ${response.stop_reason}).`);

    const themes = response.parsed_output.themes;
    await saveThemes(roomId, month, lines.length, themes);
    log("  4/4 saved the summary", { themes: themes.length });

    // sent with the AI notice context, so ❌ and ✅ reactions to it work too
    const announcement = await sendToGroup(roomId,
        `📊 An organiser asked for the main themes in this group for ${month}. ${lines.length} messages were sent, without names, to Anthropic's Claude to summarise. ` +
        `Only the summary of topics is kept, never the messages or who said what.\n\n${reactToChoose}`,
        { engagementAiNotice: true });

    return { themes, messageCount: lines.length, announced: announcement.success, announcementError: announcement.message };
}
