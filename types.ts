export type MatrixEvent = {
    type: string;
    event_id: string;
    content: any;
    sender: string;
    origin_server_ts: number;
    room_id: string;
    prevEvent?: any;
    state_key?: string;
    displayname?: string;
    redacts?: string;
    unsigned?: any;
};

export type ActivityKind = "message" | "reaction" | "join" | "leave";

export type MessageFormat = "text" | "image" | "audio" | "video" | "file" | "other";

// One row per thing someone did in the group. Deliberately holds no message
// text: only what kind of thing it was and who it was in response to.
export type Activity = {
    event_id: string;
    room_id: string;
    sender: string;
    display_name: string;
    ts: number;
    kind: ActivityKind;
    format: MessageFormat | null;
    target_event_id: string | null;
    target_sender: string | null;
    has_link: boolean;
    has_question: boolean;
    length_bucket: "short" | "medium" | "long" | null;
    source: "live" | "imported";
};

export type RoomSettings = {
    room_id: string;
    tracking_since: number;
    imported_from: number | null;
};
