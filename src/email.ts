import { Resend } from "resend";

const { RESEND_API_KEY } = process.env;

const EMAIL_FROM = "Chat Hackers <engagement@dashboard.chathackers.uk>";

const emailPattern = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

export function canEmail() {
    return Boolean(RESEND_API_KEY);
}

export function normaliseEmail(text: string) {
    const email = text.trim().replace(/^mailto:/i, "").toLowerCase();
    return emailPattern.test(email) ? email : null;
}

// h•••@campaignlab.uk: enough for the group to recognise, not enough to harvest
export function maskEmail(email: string) {
    const [name, domain] = email.split("@");
    return `${name[0]}•••@${domain}`;
}

function escapeHtml(text: string) {
    return text.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export async function sendDashboardEmail(to: string, link: string, requestedBy: string) {
    const resend = new Resend(RESEND_API_KEY);

    const text =
        `Here's your link to the Engagement dashboard for your Chat Hackers group, requested by ${requestedBy}:\n\n${link}\n\n` +
        "The dashboard shows how participation in the group changes over time. It never shows what anyone wrote.\n\n" +
        "This link is personal, so please don't forward it. If you didn't ask for it, you can ignore this email, " +
        "and another organiser can remove your access from the dashboard.";

    const html =
        `<p>Here's your link to the Engagement dashboard for your Chat Hackers group, requested by ${escapeHtml(requestedBy)}:</p>` +
        `<p><a href="${escapeHtml(link)}">Open the Engagement dashboard</a></p>` +
        "<p>The dashboard shows how participation in the group changes over time. It never shows what anyone wrote.</p>" +
        "<p>This link is personal, so please don't forward it. If you didn't ask for it, you can ignore this email, " +
        "and another organiser can remove your access from the dashboard.</p>";

    const { error } = await resend.emails.send({
        from: EMAIL_FROM,
        to,
        subject: "Your Engagement dashboard link",
        text,
        html,
    });

    if (error) throw new Error(`couldn't send the email: ${error.message}`);
}
