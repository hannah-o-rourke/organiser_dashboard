import "./App.css";
import { useSearchParams } from "react-router";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Dashboard, ParticipantSummary, Pattern, WeekSummary } from "../src/metrics";
import type { Theme } from "../src/themes";
import { addOrganiser, findThemes, forgetGroup, getDashboard, getOrganisers, getThemes, importHistory, NotAllowed, removeOrganiser, switchAi } from "./requests";

type DashboardResult = Dashboard & { canImportHistory: boolean };

type Tip = { x: number; y: number; text: string } | null;

type ThemesResult = {
  months: { month: string; generatedAt: number; messageCount: number; themes: Theme[] }[];
  canFindThemes: boolean;
  enabled: boolean;
  availableFrom: number | null;
  aiOptOuts: number;
};

function monthKey(offset: number) {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1)).toISOString().slice(0, 7);
}

function monthName(month: string) {
  return new Date(`${month}-01T00:00:00Z`).toLocaleDateString(undefined, { month: "long", year: "numeric", timeZone: "UTC" });
}

type Organiser = { email: string; status: "active" | "pending"; requestedBy: string; createdAt: number };

function Organisers({ roomId }: { roomId: string }) {
  const [organisers, setOrganisers] = useState<Organiser[] | null>(null);
  const [you, setYou] = useState("");
  const [newEmail, setNewEmail] = useState("");
  const [status, setStatus] = useState("");

  async function load() {
    const result = await getOrganisers(roomId).catch(() => null);
    if (result) {
      setOrganisers(result.organisers);
      setYou(result.you);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function grant(email: string) {
    setStatus(`Emailing ${email}…`);
    const result = await addOrganiser(roomId, email).catch(err => ({ success: false, message: err.message }));
    setStatus(result.success ? `✅ Sent a dashboard link to ${email}. The group has been told.` : result.message);
    setNewEmail("");
    load();
  }

  async function remove(email: string, pending: boolean) {
    if (!confirm(pending ? `Decline the request for ${email}?` : `Remove ${email}'s access? Their link will stop working.`)) return;
    await removeOrganiser(roomId, email).catch(() => null);
    setStatus(pending ? `Declined ${email}.` : `Removed ${email}.`);
    load();
  }

  async function forget() {
    if (!confirm("Delete everything the dashboard has recorded for this group? This can't be undone, and the group will be told.")) return;
    await forgetGroup(roomId).catch(() => null);
    window.location.reload();
  }

  if (!organisers) return <p className="note">Loading…</p>;

  const pending = organisers.filter(o => o.status === "pending");
  const active = organisers.filter(o => o.status === "active");

  return (
    <>
      {pending.length > 0 && (
        <>
          <h3>⏳ Waiting for you to approve</h3>
          <ul className="organisers">
            {pending.map(o => (
              <li key={o.email}>
                <span><strong>{o.email}</strong> <small>asked by {o.requestedBy} on {day(o.createdAt)}</small></span>
                <span className="actions">
                  <button onClick={() => grant(o.email)}>Approve</button>
                  <button className="secondary" onClick={() => remove(o.email, true)}>Decline</button>
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>🔑 Organisers who can see this</h3>
      <ul className="organisers">
        {active.map(o => (
          <li key={o.email}>
            <span><strong>{o.email}</strong>{o.email === you && <small> (you)</small>}</span>
            <span className="actions"><button className="secondary" onClick={() => remove(o.email, false)}>Remove</button></span>
          </li>
        ))}
        {active.length === 0 && <li className="note">No one yet.</li>}
      </ul>
      <form className="import" onSubmit={e => { e.preventDefault(); grant(newEmail); }}>
        <input type="email" required placeholder="name@example.org" value={newEmail} onChange={e => setNewEmail(e.target.value)} aria-label="Organiser's email" />
        <button type="submit">Invite organiser</button>
      </form>
      {status && <p className="note">{status}</p>}
      <details>
        <summary>🗑️ Delete this group's data</summary>
        <p className="note">Wipes everything the dashboard has recorded for this group and starts again. Organisers keep access, and anyone who opted out stays opted out.</p>
        <button className="danger" onClick={forget}>Delete everything</button>
      </details>
    </>
  );
}

function Themes({ roomId }: { roomId: string }) {
  const [result, setResult] = useState<ThemesResult | null>(null);
  const [month, setMonth] = useState(monthKey(0));
  const [status, setStatus] = useState("");

  async function load() {
    setResult(await getThemes(roomId).catch(() => null));
  }

  useEffect(() => {
    load();
  }, []);

  async function run() {
    if (!confirm(`Summarise what people talked about in ${monthName(month)}? Messages are sent to Claude (an AI) without names, leaving out anyone who opted out. Only the summary is kept, and the group will be told.`)) return;

    setStatus("🧠 Reading the month's messages… this can take a minute.");
    const response = await findThemes(roomId, month).catch(err => ({ success: false, message: err.message }));
    setStatus(response.success
      ? `✅ Summarised ${response.messageCount} messages.${response.announced ? " The group has been told." : ` Couldn't post a message to the group (${response.announcementError}), so please let them know yourself.`}`
      : response.message);
    load();
  }

  async function toggle() {
    if (!result) return;
    const turningOn = !result.enabled;
    if (turningOn && !confirm("Turn on AI summaries? A message will go to the group explaining them. Anyone who reacts ❌ to it is left out, and ✅ brings them back. Everyone gets time to reply before the first summary.")) return;
    if (!turningOn && !confirm("Turn off AI summaries? The group will be told. Summaries you've already made stay here.")) return;

    const response = await switchAi(roomId, turningOn).catch(err => ({ success: false, message: err.message }));
    setStatus(response.success ? (turningOn ? "✅ Turned on. A message has gone to the group so people can opt out." : "Turned off. The group has been told.") : response.message);
    load();
  }

  if (!result) return <p className="note">Loading…</p>;

  const ready = result.enabled && result.availableFrom !== null && result.availableFrom <= Date.now();

  return (
    <>
      <p className="note">
        An AI reads the group's messages and pulls out the main topics. It's about topics, never people: no names are sent, and it never says who said what.
      </p>
      {!result.canFindThemes && <p className="note">AI summaries aren't set up on this server yet.</p>}
      {result.canFindThemes && (
        <div className="switch-row">
          <label className="switch">
            <input type="checkbox" role="switch" checked={result.enabled} onChange={toggle} />
            <span>AI summaries are <strong>{result.enabled ? "on" : "off"}</strong></span>
          </label>
          {result.enabled && <span className="pill">❌ {result.aiOptOuts} {result.aiOptOuts === 1 ? "person" : "people"} opted out</span>}
        </div>
      )}
      {result.canFindThemes && !result.enabled && (
        <p className="note">Turning this on sends a message to the group. Anyone who doesn't want to be included can react ❌, and ✅ to come back in.</p>
      )}
      {result.enabled && !ready && result.availableFrom && (
        <p className="note">⏳ Giving people time to opt out. You can make your first summary from <strong>{new Date(result.availableFrom).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</strong>.</p>
      )}
      {ready && (
        <div className="import">
          <select value={month} onChange={e => setMonth(e.target.value)}>
            {[0, -1, -2].map(offset => <option key={offset} value={monthKey(offset)}>{monthName(monthKey(offset))}</option>)}
          </select>
          <button onClick={run}>✨ Summarise</button>
        </div>
      )}
      {status && <p className="note">{status}</p>}
      {result.months.map(entry => (
        <div key={entry.month} className="themes-month">
          <h3>{monthName(entry.month)} <small>{entry.messageCount} messages · updated {day(entry.generatedAt)}</small></h3>
          <ul className="themes">
            {entry.themes.map(theme => (
              <li key={theme.title}>
                <span className={`prominence ${theme.prominence}`}>{({ major: "Big topic", moderate: "Came up a lot", minor: "Mentioned" } as const)[theme.prominence]}</span>
                <strong>{theme.title}</strong>
                <p>{theme.summary}</p>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

const patternInfo: { [pattern in Pattern]: { label: string; detail: string } } = {
  "new": { label: "👋 New", detail: "Joined in the last 2 weeks." },
  "back": { label: "🌱 Back again", detail: "Joined in this week after more than 4 weeks away." },
  "quiet-this-week": { label: "💤 Quiet this week", detail: "Usually joins in, but nothing in the last 7 days." },
  "quieter": { label: "🌙 Gone quiet", detail: "Used to join in most weeks, but nothing for 2 weeks." },
  "long-quiet": { label: "🕰️ Quiet for 4+ weeks", detail: "Has joined in before, but nothing for more than 4 weeks. That's OK: people drift in and out." },
  "not-seen": { label: "👀 Not heard from yet", detail: "Hasn't posted or reacted yet. They may still be reading." },
  "mostly-reacts": { label: "👍 Mostly reacts", detail: "Joins in with reactions more than messages." },
  "starts-conversations": { label: "🚀 Gets things going", detail: "Often the first to post after a quiet spell." },
  "draws-responses": { label: "🔥 Gets people talking", detail: "Their messages get lots of replies and reactions." },
};

const typeEmoji: { [type: string]: string } = {
  "Question": "❓", "Link": "🔗", "Photo or video": "📷", "Voice note": "🎤",
  "Long message": "📝", "Short message": "💬", "Other": "📎",
};

const notCaptured = [
  "👀 Who's reading. Someone who reads everything but never posts looks the same as someone who's muted the group.",
  "✍️ What people write. Messages themselves are never stored, just when they were sent.",
  "🤝 Anything outside this chat: meetings, doorstep chats, private messages, or the actual work people do.",
  "⏮️ Anything from before the dashboard was turned on (unless you import it below).",
  "🙅 Anyone who opted out. They're left out of every number.",
];

// from Campaign Lab's "Getting the most out of WhatsApp Groups" session
const groupTips: [string, string, string][] = [
  ["🎯", "Agree what the group is for", "A clear purpose keeps chat on track and makes it easy to say what belongs somewhere else."],
  ["📌", "Pin the next action", "Use the group description and pinned messages for key info, and make them about doing: the next meeting, the next ask."],
  ["👋", "Welcome everyone", "Greet new people by name and ask what brought them here."],
  ["📱", "QR codes are your friend", "Add people straight after meetings, stalls and door-knocking with a QR code invite."],
  ["🔁", "Build routines", "Weekly round-ups, upcoming dates and thank-yous. If no one has responded to someone, be that person!"],
  ["📊", "People like polls", "Quick to answer, and a great first step for quieter members."],
  ["📸", "Create a bit of FOMO", "Share photos from the doors, the stall or the pub afterwards: \"Great to see everyone out today!\""],
  ["🏆", "Celebrate wins", "Share the results: doors knocked, sign-ups, the person who went the extra mile."],
  ["🙋", "Make specific asks", "\"Can you help on Saturday at 10?\" works better than \"Can anyone help?\" A one-to-one works even better."],
  ["🤝", "Share the load", "Have at least three admins so no one carries it alone, and agree a simple code of conduct."],
  ["💬", "Give off-topic chat a home", "A separate chat for off-topic conversation keeps the main group focused."],
  ["🛡️", "Keep people safe", "Remind people their number is visible to everyone in the group, and take care before adding under-18s."],
];

const memberQuestions = [
  "What makes it easy or hard to post in this group?",
  "Is there a time of day that works best for you?",
  "Would you rather get involved another way, like a poll, a call or a chat in person?",
  "When you joined, did you know what the group was for?",
  "Is the group too busy, too quiet, or about right?",
];

function day(ts: number | null) {
  return ts ? new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" }) : "–";
}

function daysAgo(ts: number | null) {
  if (!ts) return "never";
  const days = Math.floor((Date.now() - ts) / 86400000);
  return days === 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`;
}

function heatStep(count: number) {
  if (count === 0) return 0;
  if (count === 1) return 1;
  if (count <= 3) return 2;
  if (count <= 7) return 3;
  return 4;
}

const periods: [number, string][] = [
  [7, "Last 7 days"],
  [30, "Last 30 days"],
  [90, "Last 3 months"],
  [365, "Last year"],
  [0, "All time"],
];

function readStoredNumber(key: string, fallback: number) {
  try {
    const stored = Number(localStorage.getItem(key));
    return periods.some(([value]) => value === stored) && localStorage.getItem(key) !== null ? stored : fallback;
  } catch {
    return fallback;
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

function WeeklyChart({ weeks, onTip }: { weeks: WeekSummary[]; onTip: (tip: Tip) => void }) {
  const height = 160;
  const barWidth = 28;
  const gap = 10;
  const width = Math.max(weeks.length * (barWidth + gap), 200);
  const max = Math.max(1, ...weeks.map(w => w.messages + w.reactions));
  const scale = (n: number) => (n / max) * (height - 8);
  const labelEvery = Math.ceil(weeks.length / 8);

  return (
    <div className="chart-scroll">
      <svg viewBox={`0 0 ${width} ${height + 22}`} style={{ width: "100%", maxWidth: width, height: "auto" }} role="img" aria-label="Messages and reactions per week">
        <line x1={0} x2={width} y1={height} y2={height} className="axis" />
        {weeks.map((week, i) => {
          const x = i * (barWidth + gap) + gap / 2;
          const messageHeight = scale(week.messages);
          const reactionHeight = scale(week.reactions);
          const tip = `Week of ${day(week.weekStart)}: ${week.messages} messages, ${week.reactions} reactions, ${week.activeParticipants} people joined in${week.newParticipants ? `, ${week.newParticipants} new` : ""}`;
          return (
            <g key={week.weekStart}
              onMouseMove={e => onTip({ x: e.clientX, y: e.clientY, text: tip })}
              onMouseLeave={() => onTip(null)}>
              <rect x={x - gap / 2} y={0} width={barWidth + gap} height={height} className="hit" />
              {week.messages > 0 && <rect x={x} y={height - messageHeight} width={barWidth} height={messageHeight} rx={3} className="series-1" />}
              {week.reactions > 0 && <rect x={x} y={height - messageHeight - reactionHeight} width={barWidth} height={Math.max(0, reactionHeight - 2)} rx={3} className="series-2" />}
              {i % labelEvery === 0 && <text x={x + barWidth / 2} y={height + 15} className="tick">{day(week.weekStart)}</text>}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

type Filter = "all" | "check-in" | Pattern;

// the people an organiser might want to reach out to this week
// people who've been quiet for 4+ weeks are left out on purpose: check-ins work
// best early, and sometimes people step back and that's fine
const checkInPatterns: Pattern[] = ["quiet-this-week", "quieter", "not-seen", "new"];

function matchesFilter(person: ParticipantSummary, filter: Filter) {
  if (filter === "all") return true;
  if (filter === "check-in") return person.patterns.some(p => checkInPatterns.includes(p));
  return person.patterns.includes(filter);
}

function filterLabel(filter: Filter) {
  if (filter === "all") return "Everyone";
  if (filter === "check-in") return "💌 Worth a check-in";
  return patternInfo[filter].label;
}

function Participants({ participants, weeks, hideNames, onTip }: { participants: ParticipantSummary[]; weeks: WeekSummary[]; hideNames: boolean; onTip: (tip: Tip) => void }) {
  const [sortKey, setSortKey] = useState<keyof ParticipantSummary>("messages");
  const [filter, setFilter] = useState<Filter>("all");

  // anonymous labels follow join order, so they don't change when sorting
  const labels = useMemo(() => {
    const byFirstSeen = [...participants].sort((a, b) => a.firstSeen - b.firstSeen);
    return new Map(byFirstSeen.map((p, i) => [p.id, `Member ${i + 1}`]));
  }, [participants]);

  const shown = participants.filter(p => matchesFilter(p, filter));
  const sorted = [...shown].sort((a, b) => {
    if (sortKey === "name") return (hideNames ? labels.get(a.id)! : a.name).localeCompare(hideNames ? labels.get(b.id)! : b.name);
    return (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0);
  });

  const columns: [keyof ParticipantSummary, string][] = [
    ["messages", "💬 Messages"],
    ["replies", "↩️ Replies"],
    ["reactions", "👍 Reactions"],
    ["links", "🔗 Links"],
    ["responsesReceived", "🔥 Responses"],
    ["lastActive", "🕒 Last seen"],
  ];

  const count = (f: Filter) => participants.filter(p => matchesFilter(p, f)).length;
  const filters: Filter[] = ["all", "check-in", ...(Object.keys(patternInfo) as Pattern[])];

  return (
    <>
    <div className="filters" role="group" aria-label="Show">
      {filters.filter(f => f === "all" || count(f) > 0).map(f => (
        <button key={f} className={`filter ${filter === f ? "on" : ""} ${f === "check-in" ? "check-in" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
          {filterLabel(f)} <span className="filter-count">{count(f)}</span>
        </button>
      ))}
    </div>
    {filter === "check-in" && <p className="note">People who might appreciate a friendly hello before they drift away: quiet this week, gone quiet, not heard from yet, or new.</p>}
    {filter !== "all" && filter !== "check-in" && <p className="note">{patternInfo[filter].detail}</p>}
    <div className="table-scroll">
      <table className="people">
        <thead>
          <tr>
            <th><button className="sort" onClick={() => setSortKey("name")}>Name</button></th>
            <th>Each week</th>
            {columns.map(([key, label]) => (
              <th key={key} className="num">
                <button className={`sort ${sortKey === key ? "active" : ""}`} onClick={() => setSortKey(key)}>{label}</button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(person => (
            <tr key={person.id}>
              <td className="name">
                {hideNames ? labels.get(person.id) : person.name}
                {person.patterns.length > 0 && (
                  <div className="badges">
                    {person.patterns.map(pattern => (
                      <span key={pattern} className={`chip chip-${pattern}`} title={patternInfo[pattern].detail}>{patternInfo[pattern].label}</span>
                    ))}
                  </div>
                )}
              </td>
              <td>
                <div className="heat" style={{ gridTemplateColumns: `repeat(${person.weekly.length}, 12px)` }}>
                  {person.weekly.map((count, i) => (
                    <span key={i} className={`cell step-${heatStep(count)}`}
                      onMouseMove={e => onTip({ x: e.clientX, y: e.clientY, text: `Week of ${day(weeks[i]?.weekStart)}: ${count} messages and reactions` })}
                      onMouseLeave={() => onTip(null)} />
                  ))}
                </div>
              </td>
              <td className="num">{person.messages}</td>
              <td className="num">{person.replies}</td>
              <td className="num">{person.reactions}</td>
              <td className="num">{person.links}</td>
              <td className="num">{person.responsesReceived}</td>
              <td className="num">{daysAgo(person.lastActive)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {sorted.length === 0 && <p className="empty">No one here right now. 🎉</p>}
    </>
  );
}

export default function App() {
  const [searchParams] = useSearchParams();
  const roomId = searchParams.get("roomId");
  const [dashboard, setDashboard] = useState<DashboardResult | null>(null);
  const [error, setError] = useState("");
  const [hideNames, setHideNames] = useState(() => readStoredBoolean("engagement.hideNames", false));
  const [importDays, setImportDays] = useState(30);
  const [importStatus, setImportStatus] = useState("");
  const [tip, setTip] = useState<Tip>(null);
  const [days, setDays] = useState(() => readStoredNumber("engagement.days", 0));

  async function loadDashboard(roomId: string, period = days) {
    try {
      setDashboard(await getDashboard(roomId, period));
    } catch (err) {
      setError(err instanceof NotAllowed ? err.message : "Couldn't load the dashboard. Is the tool running?");
    }
  }

  useEffect(() => {
    if (roomId) {
      loadDashboard(roomId);
    }
  }, []);

  function choosePeriod(period: number) {
    setDays(period);
    try {
      localStorage.setItem("engagement.days", String(period));
    } catch { }
    if (roomId) loadDashboard(roomId, period);
  }

  function toggleNames() {
    setHideNames(!hideNames);
    try {
      localStorage.setItem("engagement.hideNames", String(!hideNames));
    } catch { }
  }

  async function runImport() {
    if (!roomId) return;
    if (!confirm(`Add the last ${importDays} days of messages? The group will be told.`)) return;

    setImportStatus("Adding…");
    const result = await importHistory(roomId, importDays).catch(err => ({ success: false, message: err.message }));
    setImportStatus(result.success
      ? `✅ Added ${result.imported} messages, reactions and joins.${result.announced ? " The group has been told." : ` Couldn't post a message to the group (${result.announcementError}), so please let them know yourself.`}`
      : `Something went wrong: ${result.message}`);
    loadDashboard(roomId);
  }

  if (!roomId)
    return <main><Banner /><p className="empty">Organisers can get a link to this page by sending <code>!engagement email your@address</code> in the group.</p></main>;

  if (error)
    return <main><Banner /><p className="empty">{error}</p></main>;

  if (!dashboard)
    return <main><Banner /><p className="empty">Loading…</p></main>;

  const { coverage, weeks, participants, concentration, responsesByType, discussion } = dashboard;
  const maxResponses = Math.max(0.1, ...responsesByType.map(r => r.averageResponses));
  const coverageDays = Math.max(1, Math.round((coverage.to - coverage.from) / 86400000));
  const total = (key: "messages" | "replies" | "reactions" | "links" | "newParticipants") => weeks.reduce((sum, w) => sum + w[key], 0);
  const joinedIn = participants.filter(p => p.messages + p.reactions > 0).length;

  return (
    <main>
      <Banner>
        <div className="controls">
          <label className="period">
            Showing
            <select value={days} onChange={e => choosePeriod(Number(e.target.value))}>
              {periods.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="toggle">
            <input type="checkbox" checked={hideNames} onChange={toggleNames} /> Hide names
          </label>
        </div>
      </Banner>

      <section>
        <h2>✨ At a glance</h2>
        <div className="tiles">
          <div className="tile tile-people"><span className="icon">🙋</span><span className="value">{joinedIn}</span><span className="label">{joinedIn === 1 ? "person joined in" : "people joined in"}</span></div>
          <div className="tile tile-messages"><span className="icon">💬</span><span className="value">{total("messages")}</span><span className="label">messages</span></div>
          <div className="tile tile-replies"><span className="icon">↩️</span><span className="value">{total("replies")}</span><span className="label">replies</span></div>
          <div className="tile tile-reactions"><span className="icon">👍</span><span className="value">{total("reactions")}</span><span className="label">reactions</span></div>
          <div className="tile tile-links"><span className="icon">🔗</span><span className="value">{total("links")}</span><span className="label">links shared</span></div>
          <div className="tile tile-new"><span className="icon">👋</span><span className="value">{total("newParticipants")}</span><span className="label">new members</span></div>
        </div>
        <p className="note">
          Over {coverageDays === 1 ? "the last day" : `${coverageDays} days`}, since {day(coverage.from)}.
          {coverage.optedOut > 0 && ` ${coverage.optedOut} ${coverage.optedOut === 1 ? "person has" : "people have"} opted out and ${coverage.optedOut === 1 ? "isn't" : "aren't"} counted.`}
        </p>
      </section>

      <section className="highlight">
        <h2>💡 Things to think about</h2>
        {discussion.length ? (
          <ul className="discussion">
            {discussion.map(point => (
              <li key={point.question}>
                <p className="observed">{point.observation}</p>
                <p className="ask"><strong>Try asking:</strong> {point.question}</p>
                {point.tip && <p className="tip"><span aria-hidden="true">🧰</span> <strong>Tip:</strong> {point.tip}</p>}
              </li>
            ))}
          </ul>
        ) : <p className="note">Nothing stands out yet. Check back once there are a few weeks of chat.</p>}
      </section>

      <section>
        <h2>📈 How busy has the group been?</h2>
        <div className="legend">
          <span><i className="swatch series-1" /> Messages</span>
          <span><i className="swatch series-2" /> Reactions</span>
        </div>
        <WeeklyChart weeks={weeks} onTip={setTip} />
        <details>
          <summary>Show as a table</summary>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Week of</th><th className="num">Messages</th><th className="num">Replies</th><th className="num">Reactions</th><th className="num">Links</th><th className="num">People</th><th className="num">New</th></tr></thead>
              <tbody>
                {weeks.map(w => (
                  <tr key={w.weekStart}><td>{day(w.weekStart)}</td><td className="num">{w.messages}</td><td className="num">{w.replies}</td><td className="num">{w.reactions}</td><td className="num">{w.links}</td><td className="num">{w.activeParticipants}</td><td className="num">{w.newParticipants}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section>
        <h2>🙋 Who's taking part?</h2>
        <p className="note">
          The badges are just what shows up in the chat, not a judgement. Tap or hover over one to see what it means. "Responses" is how many replies and reactions someone's messages got from others.
          {concentration.posters >= 2 && ` ${concentration.peopleForHalf} of the ${concentration.posters} people who posted wrote half of the messages.`}
        </p>
        {participants.length
          ? <Participants participants={participants} weeks={weeks} hideNames={hideNames} onTip={setTip} />
          : <p className="empty">No one's posted yet. Say hi in the group! 👋</p>}
        <div className="legend heat-legend">
          <span>Quiet week</span>
          {[1, 2, 3, 4].map(step => <i key={step} className={`cell step-${step}`} />)}
          <span>Busy week</span>
        </div>
      </section>

      <section>
        <h2>🗣️ What gets people talking?</h2>
        <p className="note">
          How many replies and reactions each kind of message gets, on average. Who sends it and when matters too, so treat these as hints.
        </p>
        {responsesByType.length ? (
          <div className="bars">
            {responsesByType.map(r => (
              <div className="bar-row" key={r.type}
                onMouseMove={e => setTip({ x: e.clientX, y: e.clientY, text: `${r.type}: ${r.messages} messages, ${Math.round(r.shareWithResponse * 100)}% got at least one reply or reaction` })}
                onMouseLeave={() => setTip(null)}>
                <span className="bar-label">{typeEmoji[r.type] ?? "💬"} {r.type}</span>
                <span className="bar-track"><span className="bar series-1" style={{ width: `${(r.averageResponses / maxResponses) * 100}%` }} /></span>
                <span className="bar-value">{r.averageResponses.toFixed(1)} <small>({r.messages} sent)</small></span>
              </div>
            ))}
          </div>
        ) : <p className="empty">No messages yet.</p>}
      </section>

      <section>
        <h2>🧠 What did people talk about?</h2>
        <Themes roomId={roomId} />
      </section>

      <section>
        <h2>❓ Questions to ask your members</h2>
        <p className="note">Numbers only tell you so much. These are good conversation starters:</p>
        <ul className="questions">{memberQuestions.map(q => <li key={q}>{q}</li>)}</ul>
      </section>

      <section>
        <h2>🧰 Tips for a lively group</h2>
        <p className="note">From Campaign Lab's "Getting the most out of WhatsApp Groups" session.</p>
        <div className="tips">
          {groupTips.map(([icon, title, text]) => (
            <div className="tip-card" key={title}>
              <span className="icon" aria-hidden="true">{icon}</span>
              <strong>{title}</strong>
              <p>{text}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="settings">
        <h2>⚙️ Settings & privacy</h2>
        <p className="note">🔒 Only organisers can see this page. Please don't share your link. Members can check what's recorded about them by sending 🏆 (or <code>!engagement me</code>), or opt out with <code>!engagement optout</code>.</p>
        <details>
          <summary>What this dashboard can't see</summary>
          <ul className="plain">{notCaptured.map(item => <li key={item}>{item}</li>)}</ul>
        </details>
        {dashboard.canImportHistory && (
          <details>
            <summary>Add older messages</summary>
            <p className="note">
              Adds messages from before the dashboard was turned on. People didn't know about the dashboard then, so the group will be told.
            </p>
            <div className="import">
              <label>Last <input type="number" min={1} max={365} value={importDays} onChange={e => setImportDays(Number(e.target.value))} /> days</label>
              <button onClick={runImport}>Add them</button>
            </div>
            {importStatus && <p className="note">{importStatus}</p>}
          </details>
        )}
        <Organisers roomId={roomId} />
      </section>

      {tip && <div className="tooltip" style={{ left: tip.x + 12, top: tip.y + 12 }}>{tip.text}</div>}
    </main>
  );
}

function Banner({ children }: { children?: ReactNode }) {
  return (
    <header className="banner">
      <h1>📊 Engagement Dashboard</h1>
      <p className="lede">See who's joining in, who's gone quiet, and what gets people talking. Use it to start conversations, not to judge anyone.</p>
      {children}
    </header>
  );
}
