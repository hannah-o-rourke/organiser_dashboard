import { MatrixEvent } from "../types";
import { commandArgs } from "./classify";
import { aiOptIn, aiOptOut, forgetRoom, getActivity, getAiSettings, getRoom, isAiOptedOut, isOptedOut, optIn, optOut } from "./duckdb";
import { isAdmin, issueKey } from "./access";
import { dashboardLink } from "./hub";
import { computeDashboard } from "./metrics";
import { requestByChat } from "./organisers";
import { OPT_OUT_EMOJI } from "./themes";

export const FORGET_EMOJI = "🗑️";

export type Reply = string | { message: string; context?: object; recipient?: string };

export const whatIsTracked =
    "📊 The Engagement tool keeps a record of *when* people post, react, reply and join or leave this group, so the group's organisers can see how participation changes over time.\n\n" +
    "It does NOT store what anyone writes, read receipts, or anything from private chats. Only the group's organisers can see the dashboard, and it's for asking better questions and checking in with people, not rating anyone. Anyone can see what's held about themselves.\n\n" +
    "AI theme summaries are off unless an organiser switches them on. If they do, the tool posts here first, and anyone can keep their messages out by reacting " + "❌" + " to that message or sending !engagement ai optout.\n\n" +
    "Commands:\n" +
    "• !engagement me: get a private message with what's held about you\n" +
    "• !engagement optout: stop tracking you here and delete what's held\n" +
    "• !engagement optin: start tracking you again\n" +
    "• !engagement ai optout / ai optin: keep your messages out of AI summaries, or include them again\n" +
    "• !engagement email name@example.org: organisers get the dashboard link by email";

const askForEmail =
    "\n\n👋 Organisers: send !engagement email your@address to get the dashboard link by email. " +
    "The first address is set up straight away; after that, new ones need an existing organiser to approve them.";

const notAdmin = "Only this group's organisers can open the Engagement dashboard. Send !engagement me to see what's held about you.";
const adminsUnknown = "Organisers get the Engagement dashboard by email: send !engagement email your@address.";

// Admins get a personal link by DM; the group is told one was sent, so it's
// visible who is looking at the dashboard.
async function sendDashboardLink(event: MatrixEvent): Promise<Reply[] | Reply> {
    const admin = await isAdmin(event.room_id, event.sender);
    if (admin === null) return adminsUnknown;
    if (!admin) return notAdmin;

    const link = dashboardLink(event.room_id, await issueKey(event.room_id, event.sender));
    if (!link) return "The dashboard link isn't set up on this server (hub_url is missing).";

    return [
        { message: `Sent ${event.displayname ?? "you"} a private link to the Engagement dashboard.` },
        { recipient: event.sender, message: `Here's your link to the Engagement dashboard for that group. It's personal, so please don't share it, and it stops working if you stop being an admin or ask for a new one:\n${link}` },
    ];
}

function count(n: number, word: string) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function day(ts: number | null) {
    return ts ? new Date(ts).toISOString().slice(0, 10) : "never";
}

async function aiStatus(event: MatrixEvent) {
    if (await isAiOptedOut(event.room_id, event.sender))
        return "Your messages are kept out of AI theme summaries (!engagement ai optin to include them).";
    const { enabled } = await getAiSettings(event.room_id);
    return enabled
        ? "AI theme summaries are on in that group and your messages may be included (!engagement ai optout to keep them out)."
        : "AI theme summaries are off in that group.";
}

async function describeMe(event: MatrixEvent): Promise<Reply> {
    if (await isOptedOut(event.room_id, event.sender)) {
        return {
            recipient: event.sender,
            message: "You've opted out of the Engagement tool in that group, so nothing is held about you there. Send !engagement optin in the group if you change your mind.",
        };
    }

    const dashboard = computeDashboard(await getActivity(event.room_id), await getRoom(event.room_id), 0);
    const me = dashboard.participants.find(p => p.id === event.sender);

    const summary = me
        ? `Since ${day(dashboard.coverage.from)} it has counted ${count(me.messages, "message")} (${me.replies} of them replies), ${count(me.reactions, "reaction")}, and ${me.responsesReceived} replies or reactions from others to your messages. You were last active on ${day(me.lastActive)}.`
        : "It hasn't recorded any activity from you yet.";

    return {
        recipient: event.sender,
        message: `Here's what the Engagement tool holds about you in that group. ${summary}\n\n${await aiStatus(event)}\n\nIt never stores what you write. Send !engagement optout in the group to delete this and stop tracking.`,
    };
}

export async function handleCommand(event: MatrixEvent): Promise<Reply | Reply[]> {
    const args = commandArgs(event);
    const roomId = event.room_id;

    if (args === "me")
        return await describeMe(event);

    if (args === "optout" || args === "opt out") {
        await optOut(roomId, event.sender);
        return `Done, ${event.displayname ?? "you"} won't be tracked by the Engagement tool here, and what was held has been deleted.`;
    }

    if (args === "optin" || args === "opt in") {
        await optIn(roomId, event.sender);
        return `Thanks, ${event.displayname ?? "you"} will be included from now on.`;
    }

    if (args === "ai optout" || args === "ai opt out") {
        await aiOptOut(roomId, event.sender, null);
        return `Done, ${event.displayname ?? "your"}${event.displayname ? "'s" : ""} messages will be left out of AI theme summaries here. (!engagement ai optin to include them again.)`;
    }

    if (args === "ai optin" || args === "ai opt in") {
        await aiOptIn(roomId, event.sender);
        return `Thanks, ${event.displayname ?? "your"}${event.displayname ? "'s" : ""} messages may be included in AI theme summaries here.`;
    }

    if (args === "email" || args.startsWith("email "))
        return await requestByChat(event, args.slice("email".length));

    if (args === "dashboard" || args === "organiser" || args === "organizer")
        return await sendDashboardLink(event);

    if (args === "forget") {
        const admin = await isAdmin(roomId, event.sender);
        if (!admin) return admin === null
            ? "Organisers can delete everything held for this group from the dashboard."
            : "Only this group's admins can delete the group's data. Send !engagement optout to delete your own.";

        return {
            message: `React to this message with ${FORGET_EMOJI} to delete everything the Engagement tool holds for this group. Tracking starts afresh afterwards unless the tool is also removed (⚙️, then 🙏).`,
            context: { engagementConfirm: "forget" },
        };
    }

    return whatIsTracked;
}

export async function handleConfirmation(event: MatrixEvent): Promise<Reply | undefined> {
    const confirming = event.prevEvent?.content?.context?.engagementConfirm;
    const emoji = event.content?.["m.relates_to"]?.key ?? "";

    // ❌ on the notice posted when AI summaries were switched on
    if (event.prevEvent?.content?.context?.engagementAiNotice && emoji.includes(OPT_OUT_EMOJI)) {
        await aiOptOut(event.room_id, event.sender, event.event_id);
        return {
            recipient: event.sender,
            message: `Your messages will be left out of AI theme summaries in that group. Remove your ${OPT_OUT_EMOJI} (or send !engagement ai optin there) to be included again.`,
        };
    }

    if (confirming === "forget" && emoji.includes(FORGET_EMOJI.replace("️", ""))) {
        if (!await isAdmin(event.room_id, event.sender))
            return "Only this group's admins can delete the group's data.";

        await forgetRoom(event.room_id);
        return "Everything the Engagement tool held for this group has been deleted.";
    }

    return undefined;
}

export function firstContactNotice() {
    return whatIsTracked + askForEmail;
}
