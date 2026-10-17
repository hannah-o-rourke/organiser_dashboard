import { Activity, RoomSettings } from "../types";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// a message counts as starting a conversation if nobody had posted for this long
const CONVERSATION_GAP = 3 * 60 * 60 * 1000;
const RECENT = 14 * DAY;

export type Pattern = "new" | "quiet-this-week" | "quieter" | "not-seen" | "mostly-reacts" | "starts-conversations" | "draws-responses";

export type ParticipantSummary = {
    id: string;
    name: string;
    firstSeen: number;
    joinedAt: number | null;
    lastActive: number | null;
    messages: number;
    reactions: number;
    replies: number;
    links: number;
    conversationsStarted: number;
    responsesReceived: number;
    activeDays: number;
    weekly: number[];
    patterns: Pattern[];
};

export type ResponseByType = {
    type: string;
    messages: number;
    averageResponses: number;
    shareWithResponse: number;
};

export type WeekSummary = {
    weekStart: number;
    messages: number;
    replies: number;
    reactions: number;
    links: number;
    activeParticipants: number;
    // members who joined the group that week; earlier members' join dates aren't known
    newParticipants: number;
};

export type DiscussionPoint = {
    observation: string;
    question: string;
    // practical advice from the "Getting the most out of WhatsApp groups" session
    tip?: string;
};

export type Dashboard = {
    coverage: {
        from: number;
        to: number;
        trackingSince: number;
        importedFrom: number | null;
        liveEvents: number;
        importedEvents: number;
        participants: number;
        optedOut: number;
    };
    weeks: WeekSummary[];
    participants: ParticipantSummary[];
    concentration: {
        posters: number;
        topFifthShare: number;
        peopleForHalf: number;
    };
    responsesByType: ResponseByType[];
    discussion: DiscussionPoint[];
};

// Monday 00:00 UTC of the week containing ts
export function weekStart(ts: number) {
    const date = new Date(ts);
    const day = (date.getUTCDay() + 6) % 7;
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) - day * DAY;
}

function messageType(message: Activity) {
    if (message.format === "image" || message.format === "video") return "Photo or video";
    if (message.format === "audio") return "Voice note";
    if (message.format !== "text") return "Other";
    if (message.has_link) return "Link";
    if (message.has_question) return "Question";
    if (message.length_bucket === "long") return "Long message";
    return "Short message";
}

function plural(count: number, word: string, many = `${word}s`) {
    return `${count} ${count === 1 ? word : many}`;
}

// `since` limits the view to a recent period. Joins and leaves from before it
// are kept, so people who joined earlier but were quiet in the period still show.
// Active in at least 2 of the 4 weeks before the last 7 days: someone whose
// silence this week is out of character.
function regularBeforeThisWeek(days: Set<number>, now: number) {
    const weekAgo = now - WEEK;
    const weeks = new Set<number>();
    for (const d of days) {
        const ts = d * DAY;
        if (ts < weekAgo && ts >= weekAgo - 4 * WEEK) weeks.add(Math.floor((weekAgo - ts) / WEEK));
    }
    return weeks.size >= 2;
}

export function computeDashboard(activity: Activity[], room: RoomSettings | undefined, optedOut: number, now = Date.now(), since?: number): Dashboard {
    const inPeriod = since === undefined ? activity : activity.filter(a => a.kind === "join" || a.kind === "leave" || a.ts >= since);
    const sorted = [...inPeriod].sort((a, b) => a.ts - b.ts);
    const trackingSince = room?.tracking_since ?? sorted[0]?.ts ?? now;
    const earliest = Math.min(room?.imported_from ?? trackingSince, sorted[0]?.ts ?? trackingSince);
    const from = since === undefined ? earliest : Math.max(since, earliest);

    const firstWeek = weekStart(from);
    const weekCount = Math.max(1, Math.floor((weekStart(now) - firstWeek) / WEEK) + 1);
    const weekIndex = (ts: number) => Math.min(weekCount - 1, Math.max(0, Math.floor((weekStart(ts) - firstWeek) / WEEK)));

    const messages = sorted.filter(a => a.kind === "message");
    const senderOfMessage = new Map(messages.map(m => [m.event_id, m.sender]));
    const targetOf = (a: Activity) => a.target_sender ?? (a.target_event_id ? senderOfMessage.get(a.target_event_id) : undefined);

    // responses each message received from people other than its author
    const responsesTo = new Map<string, number>();
    for (const a of sorted) {
        if (!a.target_event_id || !senderOfMessage.has(a.target_event_id))
            continue;
        if (senderOfMessage.get(a.target_event_id) === a.sender)
            continue;
        responsesTo.set(a.target_event_id, (responsesTo.get(a.target_event_id) ?? 0) + 1);
    }

    const conversationStarters = new Set<string>();
    let previousMessage = -Infinity;
    for (const m of messages) {
        if (!m.target_event_id && m.ts - previousMessage > CONVERSATION_GAP)
            conversationStarters.add(m.event_id);
        previousMessage = m.ts;
    }

    const people = new Map<string, ParticipantSummary & { days: Set<number>; weeksActive: Set<number> }>();
    for (const a of sorted) {
        let person = people.get(a.sender);
        if (!person) {
            person = {
                id: a.sender, name: a.display_name, firstSeen: a.ts, joinedAt: null, lastActive: null,
                messages: 0, reactions: 0, replies: 0, links: 0, conversationsStarted: 0, responsesReceived: 0,
                activeDays: 0, weekly: new Array(weekCount).fill(0), patterns: [],
                days: new Set(), weeksActive: new Set(),
            };
            people.set(a.sender, person);
        }
        person.name = a.display_name || person.name;

        if (a.kind === "join") person.joinedAt = a.ts;
        if (a.kind === "join" || a.kind === "leave")
            continue;

        person.lastActive = a.ts;
        person.days.add(Math.floor(a.ts / DAY));
        person.weeksActive.add(weekIndex(a.ts));
        person.weekly[weekIndex(a.ts)]++;

        if (a.kind === "reaction") {
            person.reactions++;
            continue;
        }

        person.messages++;
        if (a.target_event_id) person.replies++;
        if (a.has_link) person.links++;
        if (conversationStarters.has(a.event_id)) person.conversationsStarted++;
        person.responsesReceived += responsesTo.get(a.event_id) ?? 0;
    }

    // members who most recently left are no longer in the group
    const left = new Set<string>();
    for (const a of sorted) {
        if (a.kind === "leave") left.add(a.sender);
        if (a.kind === "join") left.delete(a.sender);
    }

    const groupResponseRate = messages.length ? [...responsesTo.values()].reduce((s, n) => s + n, 0) / messages.length : 0;
    const recentWeek = weekIndex(now - RECENT);

    const participants = [...people.values()]
        .filter(p => !left.has(p.id))
        .map(({ days, weeksActive, ...p }) => {
            const patterns: Pattern[] = [];
            const activeBeforeRecent = [...weeksActive].filter(w => w < recentWeek).length;

            if (p.joinedAt !== null && p.joinedAt > now - RECENT) patterns.push("new");
            if (p.lastActive === null) patterns.push("not-seen");
            else if (p.lastActive < now - RECENT && activeBeforeRecent >= 2) patterns.push("quieter");
            else if (p.lastActive < now - WEEK && regularBeforeThisWeek(days, now)) patterns.push("quiet-this-week");
            if (p.reactions >= 3 && p.reactions >= 2 * p.messages) patterns.push("mostly-reacts");
            if (p.conversationsStarted >= 3 && p.conversationsStarted >= 0.3 * p.messages) patterns.push("starts-conversations");
            if (p.messages >= 3 && groupResponseRate > 0 && p.responsesReceived / p.messages >= 1.5 * groupResponseRate) patterns.push("draws-responses");

            return { ...p, activeDays: days.size, patterns };
        })
        .sort((a, b) => (b.messages + b.reactions) - (a.messages + a.reactions));

    const weeks: WeekSummary[] = [];
    for (let w = 0; w < weekCount; w++) {
        const inWeek = sorted.filter(a => weekIndex(a.ts) === w && (a.kind === "message" || a.kind === "reaction"));
        const active = new Set(inWeek.map(a => a.sender));
        const joined = new Set(sorted.filter(a => a.kind === "join" && a.ts >= from && weekIndex(a.ts) === w).map(a => a.sender));
        weeks.push({
            weekStart: firstWeek + w * WEEK,
            messages: inWeek.filter(a => a.kind === "message").length,
            replies: inWeek.filter(a => a.kind === "message" && a.target_event_id).length,
            reactions: inWeek.filter(a => a.kind === "reaction").length,
            links: inWeek.filter(a => a.kind === "message" && a.has_link).length,
            activeParticipants: active.size,
            newParticipants: joined.size,
        });
    }

    const posterCounts = participants.map(p => p.messages).filter(n => n > 0).sort((a, b) => b - a);
    const totalPosted = posterCounts.reduce((s, n) => s + n, 0);
    const topFifth = posterCounts.slice(0, Math.ceil(posterCounts.length / 5)).reduce((s, n) => s + n, 0);
    let peopleForHalf = 0;
    for (let running = 0; running < totalPosted / 2; peopleForHalf++) running += posterCounts[peopleForHalf];

    const byType = new Map<string, number[]>();
    for (const m of messages) {
        const type = messageType(m);
        byType.set(type, [...(byType.get(type) ?? []), responsesTo.get(m.event_id) ?? 0]);
    }
    const responsesByType = [...byType.entries()]
        .map(([type, counts]) => ({
            type,
            messages: counts.length,
            averageResponses: counts.reduce((s, n) => s + n, 0) / counts.length,
            shareWithResponse: counts.filter(n => n > 0).length / counts.length,
        }))
        .sort((a, b) => b.averageResponses - a.averageResponses);

    const dashboard: Dashboard = {
        coverage: {
            from,
            to: now,
            trackingSince,
            importedFrom: room?.imported_from ?? null,
            liveEvents: sorted.filter(a => a.ts >= from && a.source === "live").length,
            importedEvents: sorted.filter(a => a.ts >= from && a.source === "imported").length,
            participants: participants.length,
            optedOut,
        },
        weeks,
        participants,
        concentration: {
            posters: posterCounts.length,
            topFifthShare: totalPosted ? topFifth / totalPosted : 0,
            peopleForHalf,
        },
        responsesByType,
        discussion: [],
    };

    // messages from the last two weeks that nobody replied or reacted to; the
    // last day is left out because people may not have had a chance yet
    const recent = messages.filter(m => m.ts >= now - RECENT && m.ts < now - DAY);
    const unanswered = recent.filter(m => !responsesTo.has(m.event_id)).length;

    dashboard.discussion = discussionPoints(dashboard, now, { recent: recent.length, unanswered });
    return dashboard;
}

// Turns patterns into questions for organisers to take to the group. These
// are prompts for a conversation, never conclusions about a person.
function discussionPoints(dashboard: Dashboard, now: number, replies: { recent: number; unanswered: number }): DiscussionPoint[] {
    const points: DiscussionPoint[] = [];
    const { participants, concentration, responsesByType, coverage } = dashboard;
    const count = (pattern: Pattern) => participants.filter(p => p.patterns.includes(pattern)).length;
    const has = (n: number) => n === 1 ? "hasn't" : "haven't";

    const days = Math.round((now - coverage.from) / DAY);
    if (days < 14) {
        points.push({
            observation: `This only covers ${plural(days, "day")}, so it's too early to spot changes.`,
            question: "What does a normal month look like for this group? Check back in a few weeks.",
            tip: "Routines help a group settle: a weekly round-up, welcoming new people, and sharing the dates of the next actions.",
        });
    }

    const quietWeek = count("quiet-this-week");
    if (quietWeek) {
        points.push({
            observation: `${plural(quietWeek, "person", "people")} who usually ${quietWeek === 1 ? "joins" : "join"} in ${has(quietWeek)} posted or reacted this week.`,
            question: "Could be nothing, or could be a busy week. Is it worth a quick, friendly hello?",
            tip: "A short personal message (\"Missed you this week, hope all's well!\") often works better than a group shout-out.",
        });
    }

    const quieter = count("quieter");
    if (quieter) {
        points.push({
            observation: `${plural(quieter, "person", "people")} who used to join in most weeks ${has(quieter)} posted or reacted for 2 weeks.`,
            question: "Has something changed for them, like work, shifts or caring, or are they just reading quietly? A friendly one-to-one check-in could help.",
            tip: "Specific asks work better than general ones. \"Could you help with Saturday's stall?\" gets more replies than \"Can anyone help?\"",
        });
    }

    const notSeen = count("not-seen");
    if (notSeen) {
        points.push({
            observation: `${plural(notSeen, "new member")} ${has(notSeen)} posted or reacted yet. (This can't see who's reading.)`,
            question: "Could you give them an easy way in, like a welcome message, a quick poll or a personal invite?",
            tip: "People like polls. They're the easiest way to join in for the first time.",
        });
    }

    if (concentration.posters >= 5 && concentration.topFifthShare >= 0.6) {
        points.push({
            observation: `Just ${plural(concentration.peopleForHalf, "person", "people")} wrote half of all the messages.`,
            question: "Is there room for other voices? Are some conversations happening somewhere else, like in person or in private chats?",
            tip: "Ask people by name to share how something went, and thank people when they contribute. It shows everyone their voice is welcome.",
        });
    }

    const reacters = count("mostly-reacts");
    if (reacters) {
        points.push({
            observation: `${plural(reacters, "person", "people")} mostly join in with reactions rather than messages.`,
            question: "Is that how they like to take part, or is something making it harder to post?",
            tip: "Polls turn a reaction into a contribution, and a quick one-to-one can show whether someone would like to do more.",
        });
    }

    const comparable = responsesByType.filter(r => r.messages >= 5);
    if (comparable.length >= 2) {
        const best = comparable[0];
        const rest = comparable.slice(1);
        const restAverage = rest.reduce((s, r) => s + r.averageResponses * r.messages, 0) / rest.reduce((s, r) => s + r.messages, 0);
        if (best.averageResponses > restAverage * 1.3) {
            points.push({
                observation: `${best.type} messages get the most replies and reactions: ${best.averageResponses.toFixed(1)} each on average, compared with ${restAverage.toFixed(1)} for other messages.`,
                question: `Could more ${best.type.toLowerCase()} messages help get people involved?`,
                tip: best.type === "Photo or video"
                    ? "Create a bit of FOMO: photos from the doors, the stall, or the pub afterwards get people wanting to come next time."
                    : best.type === "Link"
                        ? "Keep sharing interesting things that fit the group's purpose: articles, events, the odd meme."
                        : "Ending a message with a clear question gives people an easy reason to reply.",
            });
        }
    }

    const newcomers = count("new");
    if (newcomers) {
        points.push({
            observation: `${plural(newcomers, "person", "people")} joined in the last 2 weeks.`,
            question: "Have they been welcomed? Do they know what the group is for and how to get involved?",
            tip: "Welcome people by name 👋 and ask what brought them here. A pinned post or group description with the next action helps too.",
        });
    }

    if (replies.recent >= 5 && replies.unanswered >= 3 && replies.unanswered / replies.recent >= 0.3) {
        points.push({
            observation: `${replies.unanswered} of the ${replies.recent} messages in the last 2 weeks got no reply or reaction.`,
            question: "Were any of them questions or offers of help that got missed?",
            tip: "If no one has responded to someone, be that person! Even a quick 👍 tells people they've been heard.",
        });
    }

    // the last full week against the weeks before it
    const full = dashboard.weeks.slice(1, -1);
    if (full.length >= 4) {
        const busy = (w: WeekSummary) => w.messages + w.reactions;
        const last = full[full.length - 1];
        const before = full.slice(0, -1).reduce((sum, w) => sum + busy(w), 0) / (full.length - 1);
        if (before >= 10 && busy(last) < before * 0.4) {
            points.push({
                observation: `Last week was much quieter than usual: ${busy(last)} messages and reactions, against about ${Math.round(before)} in a normal week.`,
                question: "Was it a quiet week for a reason, like holidays or no actions planned, or has the group lost some energy?",
                tip: "Avoid tumbleweed: post a specific ask, a poll, or photos from the last action, and share what's coming up next.",
            });
        }
    }

    return points;
}
