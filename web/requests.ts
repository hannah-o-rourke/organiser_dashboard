const { origin, pathname } = window.location;
const BASE_URL = `${origin}${pathname}`.replace(/\/$/, "");

// The personal key arrives in the link an organiser was emailed. It's moved out
// of the address bar so it doesn't end up in screenshots or screen shares, and
// remembered in this browser for this group, so a bookmark of the page works.
function readKey() {
    const params = new URLSearchParams(window.location.search);
    const fromLink = params.get("key");
    const storageKey = `engagement.key.${params.get("roomId") ?? ""}`;
    let key = fromLink;

    try {
        if (fromLink) localStorage.setItem(storageKey, fromLink);
        else key = localStorage.getItem(storageKey);
    } catch { }

    if (fromLink) {
        params.delete("key");
        window.history.replaceState(null, "", `${pathname}?${params}`);
    }
    return key ?? "";
}

const key = readKey();

export class NotAllowed extends Error { }

async function call(path: string, roomId: string, body?: object, query = "") {
    const response = await fetch(`${BASE_URL}${path}?roomId=${encodeURIComponent(roomId)}${query}`, {
        method: body ? "POST" : "GET",
        body: body ? JSON.stringify(body) : undefined,
        headers: {
            "Content-type": "application/json",
            "x-engagement-key": key,
        }
    });
    const result = await response.json();
    if (response.status === 401) throw new NotAllowed(result.message);
    return result;
}

// days: only the last so many days; 0 for everything
export async function getDashboard(roomId: string, days: number) {
    return await call("/api/dashboard", roomId, undefined, days ? `&days=${days}` : "");
}

export async function importHistory(roomId: string, days: number) {
    return await call("/api/import", roomId, { days });
}

export async function getThemes(roomId: string) {
    return await call("/api/themes", roomId);
}

export async function findThemes(roomId: string, month: string) {
    return await call("/api/themes", roomId, { month });
}

export async function switchAi(roomId: string, enabled: boolean) {
    return await call("/api/themes/switch", roomId, { enabled });
}

export async function getOrganisers(roomId: string) {
    return await call("/api/organisers", roomId);
}

export async function addOrganiser(roomId: string, email: string) {
    return await call("/api/organisers", roomId, { email });
}

export async function removeOrganiser(roomId: string, email: string) {
    return await call("/api/organisers/remove", roomId, { email });
}

export async function forgetGroup(roomId: string) {
    return await call("/api/forget", roomId, {});
}
