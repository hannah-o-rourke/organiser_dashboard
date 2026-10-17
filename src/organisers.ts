import { MatrixEvent } from "../types";
import { log } from "./log";
import { isAdmin, newKey } from "./access";
import { getOrganiserEmails, removeOrganiserEmail, saveOrganiserEmail } from "./duckdb";
import { canEmail, maskEmail, normaliseEmail, sendDashboardEmail } from "./email";
import { dashboardLink, sendToGroup } from "./hub";

// stops the email command being used to spam an address from a busy group
const EMAILS_PER_HOUR = 5;
const recentEmails = new Map<string, number[]>();

function underLimit(roomId: string) {
    const hourAgo = Date.now() - 60 * 60 * 1000;
    const recent = (recentEmails.get(roomId) ?? []).filter(t => t > hourAgo);
    recentEmails.set(roomId, recent);
    if (recent.length >= EMAILS_PER_HOUR) return false;
    recent.push(Date.now());
    return true;
}

// A fresh key each time, so a resent link replaces the old one.
async function sendLink(roomId: string, email: string, requestedBy: string) {
    const { key, keyHash } = newKey();
    const link = dashboardLink(roomId, key);
    if (!link) throw new Error("hub_url isn't set on this server");

    log("  emailing a dashboard link", { to: maskEmail(email) });
    await sendDashboardEmail(email, link, requestedBy);
    await saveOrganiserEmail(roomId, email, "active", keyHash, requestedBy);
    log("  email sent", { to: maskEmail(email) });
}

// `!engagement email name@example.org` in the group. The first organiser is
// trusted straight away; after that, new emails wait for an existing organiser
// to approve them, unless the sender is a group admin (once the hub can say so).
export async function requestByChat(event: MatrixEvent, text: string) {
    const roomId = event.room_id;
    const name = event.displayname ?? "someone";

    if (!canEmail()) return "Sorry, dashboard emails aren't set up yet.";

    const email = normaliseEmail(text);
    if (!email) return "Hmm, that doesn't look like an email address. Try: *!engagement email name@example.org*";

    if (!underLimit(roomId)) return "Too many requests in the last hour. Please try again a bit later.";

    const organisers = await getOrganiserEmails(roomId);
    const existing = organisers.find(o => o.email === email);
    const hasOrganisers = organisers.some(o => o.status === "active");
    const admin = await isAdmin(roomId, event.sender);

    if (admin === false && !hasOrganisers)
        return "Sorry, only the group's admins can set up the dashboard.";

    if (existing?.status === "active" || !hasOrganisers || admin === true) {
        try {
            await sendLink(roomId, email, name);
        } catch (err) {
            log("  email FAILED", { error: err instanceof Error ? err.message : String(err) });
            return "Sorry, the email couldn't be sent. Please check the address and try again.";
        }
        return `📧 Sent a private dashboard link to ${maskEmail(email)}.\n\nTip: you can delete your message now, so your email address isn't left in the chat.`;
    }

    await saveOrganiserEmail(roomId, email, "pending", null, name);
    log("  email request waiting for an organiser to approve", { email: maskEmail(email) });
    return `📧 Thanks! An organiser needs to approve ${maskEmail(email)} first. Once they do, the link will be emailed.\n\nTip: you can delete your message now, so your email address isn't left in the chat.`;
}

export async function listOrganisers(roomId: string) {
    return await getOrganiserEmails(roomId);
}

// An organiser on the dashboard approves a request or adds someone directly.
// The group is told, so it's visible who can see the dashboard.
export async function grantAccess(roomId: string, email: string, grantedBy: string) {
    const address = normaliseEmail(email);
    if (!address) return { success: false, message: "That doesn't look like an email address." };
    if (!canEmail()) return { success: false, message: "Email isn't set up on this server." };

    try {
        await sendLink(roomId, address, grantedBy);
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) };
    }

    await sendToGroup(roomId, `📊 ${maskEmail(address)} can now see the dashboard (added by an organiser).`);
    return { success: true };
}

export async function removeAccess(roomId: string, email: string) {
    await removeOrganiserEmail(roomId, email);
    return { success: true };
}
