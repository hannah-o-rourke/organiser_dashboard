import { Activity, RoomSettings } from "../types";

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
// a message counts as starting a conversation if nobody had posted for this long
const CONVERSATION_GAP = 3 * 60 * 60 * 1000;
const RECENT = 14 * DAY;

export type Pattern = "new" | "quieter" | "not-seen" | "mostly-reacts" | "starts-conversations" | "draws-responses";

export type ParticipantSummary = {
    id: string;
    name: string;
    firstSeen: number;
    joinedAt: number | null;
    lastActive: number | null;
    messages: number;
    reactions: number;
    replies: number;
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
    reactions: number;
    activeParticipants: number;
    // members who joined the group that week; earlier members' join dates aren't known
    newParticipants: number;
};

export type DiscussionPoint = {
    observation: string;
    question: string;
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

function percent(share: number) {
    return `${Math.round(share * 100)}%`;
}

function plural(count: number, word: string, many = `${word}s`) {
    return `${count} ${count === 1 ? word : many}`;
}

// `since` limits the view to a recent period. Joins and leaves from before it
// are kept, so people who joined earlier but were quiet in the period still show.
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
                messages: 0, reactions: 0, replies: 0, conversationsStarted: 0, responsesReceived: 0,
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
            reactions: inWeek.filter(a => a.kind === "reaction").length,
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

    dashboard.discussion = discussionPoints(dashboard, now);
    return dashboard;
}

// Turns patterns into questions for organisers to take to the group. These
// are prompts for a conversation, never conclusions about a person.
function discussionPoints(dashboard: Dashboard, now: number): DiscussionPoint[] {
    const points: DiscussionPoint[] = [];
    const { participants, concentration, responsesByType, coverage } = dashboard;
    const count = (pattern: Pattern) => participants.filter(p => p.patterns.includes(pattern)).length;

    const days = Math.round((now - coverage.from) / DAY);
    if (days < 14) {
        points.push({
            observation: `This view covers ${plural(days, "day")}, which is too short to show change over time.`,
            question: "What would a typical month look like for this group, and what should we wait to see before reading much into these numbers?",
        });
    }

    const quieter = count("quieter");
    if (quieter) {
        points.push({
            observation: `${plural(quieter, "person", "people")} who used to post or react across several weeks ${quieter === 1 ? "hasn't" : "haven't"} done either in the last two weeks.`,
            question: "Has something changed for them, such as timing, topics, other commitments, or simply reading rather than replying? Would a friendly one-to-one check-in be welcome?",
        });
    }

    const notSeen = count("not-seen");
    if (notSeen) {
        points.push({
            observation: `${plural(notSeen, "member")} joined while the tool was on but ${notSeen === 1 ? "hasn't" : "haven't"} posted or reacted. Reading isn't visible to this tool.`,
            question: "Are they following along quietly? Would a lower-stakes way in, like a reaction poll, a direct invitation, or a newcomer thread, make it easier to take part?",
        });
    }

    if (concentration.posters >= 5 && concentration.topFifthShare >= 0.6) {
        points.push({
            observation: `The most active fifth of posters wrote ${percent(concentration.topFifthShare)} of messages. ${plural(concentration.peopleForHalf, "person", "people")} ${concentration.peopleForHalf === 1 ? "accounts" : "account"} for half.`,
            question: "Does the group feel like it has room for other voices? Are some conversations happening elsewhere, such as in person, in DMs, or in other groups?",
        });
    }

    const reacters = count("mostly-reacts");
    if (reacters) {
        points.push({
            observation: `${plural(reacters, "person", "people")} mostly ${reacters === 1 ? "takes" : "take"} part by reacting rather than posting.`,
            question: "Is reacting the level of involvement people want, or is something making it harder to post?",
        });
    }

    const comparable = responsesByType.filter(r => r.messages >= 5);
    if (comparable.length >= 2) {
        const best = comparable[0];
        const rest = comparable.slice(1);
        const restAverage = rest.reduce((s, r) => s + r.averageResponses * r.messages, 0) / rest.reduce((s, r) => s + r.messages, 0);
        if (best.averageResponses > restAverage * 1.3) {
            points.push({
                observation: `${best.type} messages got ${best.averageResponses.toFixed(1)} replies or reactions on average, against ${restAverage.toFixed(1)} for other kinds of message.`,
                question: `Is that something about ${best.type.toLowerCase()} messages, or about who tends to send them and when? Would trying more of them help people join in?`,
            });
        }
    }

    const newcomers = count("new");
    if (newcomers) {
        points.push({
            observation: `${plural(newcomers, "person", "people")} joined in the last two weeks.`,
            question: "What did they see when they arrived? Did anyone welcome them, and do they know what the group is for?",
        });
    }

    return points;
}
