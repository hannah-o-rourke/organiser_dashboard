import { MatrixEvent } from "../types";
import { log } from "./log";
import { commandArgs } from "./classify";
import { aiOptIn, aiOptOut, forgetRoom, getActivity, getAiSettings, getRoom, isAiOptedOut, isOptedOut, optIn, optOut } from "./duckdb";
import { isAdmin, issueKey } from "./access";
import { dashboardLink } from "./hub";
import { computeDashboard } from "./metrics";
import { requestByChat } from "./organisers";
import { OPT_IN_EMOJIS, OPT_OUT_EMOJI } from "./themes";

export const FORGET_EMOJI = "🗑️";

export type Reply = string | { message: string; context?: object; recipient?: string };

export const whatIsTracked =
    "📊 *This group uses the Engagement tool*\n\n" +
    "It helps the organisers see how lively the group is, like who's joining in and who's gone quiet, so they can check in with people.\n\n" +
    "✅ It counts *when* people send messages, replies, reactions and links, and when people join or leave.\n" +
    "🚫 It never saves what anyone writes. It can't see who reads messages, or anything in private chats.\n" +
    "🔒 Only the group's organisers can see the results.\n" +
    "🤖 If organisers turn on AI summaries, you'll get a message first and can say no by reacting ❌.\n\n" +
    "*What you can do:*\n" +
    "• Send *!engagement me* to see what's been counted for you\n" +
    "• Send *!engagement optout* to stop being counted and delete your data\n" +
    "• Send *!engagement optin* to be counted again";

const askForEmail =
    "\n\n👋 *Organisers:* to see the dashboard, send *!engagement email* followed by your email address, and you'll be emailed a private link.";

const notAdmin = "Sorry, only the group's organisers can see the dashboard. You can still send *!engagement me* to see what's been counted for you.";
const adminsUnknown = "To get the dashboard, organisers can send *!engagement email* followed by their email address.";

// Admins get a personal link by DM; the group is told one was sent, so it's
// visible who is looking at the dashboard.
async function sendDashboardLink(event: MatrixEvent): Promise<Reply[] | Reply> {
    const admin = await isAdmin(event.room_id, event.sender);
    if (admin === null) return adminsUnknown;
    if (!admin) return notAdmin;

    const link = dashboardLink(event.room_id, await issueKey(event.room_id, event.sender));
    if (!link) return "The dashboard link isn't set up on this server (hub_url is missing).";

    return [
        { message: `📧 Sent ${event.displayname ?? "you"} a private link to the dashboard.` },
        { recipient: event.sender, message: `Here's your private link to the Engagement dashboard. Please don't share it:\n${link}` },
    ];
}

function count(n: number, word: string) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

// "today", "yesterday" or "17 Oct", which reads better in a chat than a date stamp
function day(ts: number | null) {
    if (!ts) return "never";
    const days = Math.floor((Date.now() - ts) / (24 * 60 * 60 * 1000));
    if (days <= 0) return "today";
    if (days === 1) return "yesterday";
    return new Date(ts).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

async function aiStatus(event: MatrixEvent) {
    if (await isAiOptedOut(event.room_id, event.sender))
        return "🤖 Your messages are left out of AI summaries. React ✅ to any AI summary message to change that.";
    const { enabled } = await getAiSettings(event.room_id);
    return enabled
        ? "🤖 AI summaries are on, and your messages may be included. React ❌ to any AI summary message to leave them out."
        : "🤖 AI summaries are off in this group.";
}

// Replies in the group rather than privately, because private messages from
// the bot don't reliably reach WhatsApp and Signal. It's counts only, never
// anything anyone wrote.
async function describeMe(event: MatrixEvent): Promise<Reply> {
    const name = event.displayname ?? "you";

    if (await isOptedOut(event.room_id, event.sender))
        return `📊 ${name}, you've opted out, so nothing is being counted for you. Send *!engagement optin* if you'd like to be counted again.`;

    const dashboard = computeDashboard(await getActivity(event.room_id), await getRoom(event.room_id), 0);
    const me = dashboard.participants.find(p => p.id === event.sender);

    const counts = me
        ? `💬 ${count(me.messages, "message")}${me.replies ? ` (${me.replies} of them ${me.replies === 1 ? "a reply" : "replies"})` : ""}\n` +
          `👍 ${count(me.reactions, "reaction")}\n` +
          `🔗 ${count(me.links, "link")} shared\n` +
          `🔥 ${me.responsesReceived} replies and reactions from others\n` +
          `🕒 Last active: ${day(me.lastActive)}`
        : "Nothing counted for you yet.";

    return `📊 *Here's what's been counted for ${name}* (since ${day(dashboard.coverage.from)})\n\n${counts}\n\n${await aiStatus(event)}\n\n` +
        "The tool never saves what anyone writes. Send *!engagement optout* to stop being counted and delete this.";
}

export async function handleCommand(event: MatrixEvent): Promise<Reply | Reply[]> {
    const args = commandArgs(event);
    const roomId = event.room_id;
    // just the command word: "!engagement email ..." would otherwise log the address
    log("  command", { name: args.split(" ")[0] || "(help)" });

    if (args === "me")
        return await describeMe(event);

    if (args === "optout" || args === "opt out") {
        await optOut(roomId, event.sender);
        return `✅ Done, ${event.displayname ?? "you"}. You won't be counted any more, and your data has been deleted. Send *!engagement optin* if you change your mind.`;
    }

    if (args === "optin" || args === "opt in") {
        await optIn(roomId, event.sender);
        return `✅ Thanks, ${event.displayname ?? "you"}! You'll be counted again from now on.`;
    }

    if (args === "ai optout" || args === "ai opt out") {
        await aiOptOut(roomId, event.sender, null);
        return `✅ Done, ${event.displayname ?? "you"}. Your messages will be left out of AI summaries.`;
    }

    if (args === "ai optin" || args === "ai opt in") {
        await aiOptIn(roomId, event.sender);
        return `✅ Thanks, ${event.displayname ?? "you"}. Your messages may be included in AI summaries again.`;
    }

    if (args === "email" || args.startsWith("email "))
        return await requestByChat(event, args.slice("email".length));

    if (args === "dashboard" || args === "organiser" || args === "organizer")
        return await sendDashboardLink(event);

    if (args === "forget") {
        const admin = await isAdmin(roomId, event.sender);
        if (!admin) return admin === null
            ? "Organisers can delete all the group's data from the dashboard, under Settings & privacy."
            : "Sorry, only the group's admins can do that. To delete just your own data, send *!engagement optout*.";

        return {
            message: `⚠️ React ${FORGET_EMOJI} to this message to delete everything the tool has counted for this group. This can't be undone.`,
            context: { engagementConfirm: "forget" },
        };
    }

    return whatIsTracked;
}

export async function handleConfirmation(event: MatrixEvent): Promise<Reply | undefined> {
    const confirming = event.prevEvent?.content?.context?.engagementConfirm;
    const emoji = event.content?.["m.relates_to"]?.key ?? "";

    // ❌ / ✅ on any of the tool's AI messages: the switch-on notice or a summary announcement.
    // Confirmed in the group, because private messages don't reliably reach WhatsApp or Signal.
    if (event.prevEvent?.content?.context?.engagementAiNotice) {
        const name = event.displayname ?? "you";

        if (emoji.includes(OPT_OUT_EMOJI)) {
            await aiOptOut(event.room_id, event.sender, event.event_id);
            return `👍 Got it, ${name}. Your messages will be left out of AI summaries. If you change your mind, react ✅ to any AI summary message.`;
        }

        if (OPT_IN_EMOJIS.some(tick => emoji.includes(tick))) {
            if (!await isAiOptedOut(event.room_id, event.sender)) return undefined;
            await aiOptIn(event.room_id, event.sender);
            return `👍 Thanks, ${name}. Your messages may be included in AI summaries again.`;
        }
    }

    if (confirming === "forget" && emoji.includes(FORGET_EMOJI.replace("️", ""))) {
        if (!await isAdmin(event.room_id, event.sender))
            return "Sorry, only the group's admins can do that.";

        await forgetRoom(event.room_id);
        return "🗑️ Done. Everything the tool had counted for this group has been deleted.";
    }

    return undefined;
}

export function firstContactNotice() {
    return whatIsTracked + askForEmail;
}
