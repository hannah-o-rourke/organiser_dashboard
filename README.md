# 📊 Engagement

A Chat Hackers tool that shows organisers how participation in a group changes
over time, and turns what it sees into questions to take back to the group.

It is built to help organisers **ask better questions**, not to score people.
Someone who reads everything and never posts may be as committed as the most
active member, and this tool can't tell the difference. The dashboard says so
plainly. Only the group's organisers can open it. Everyone can
see what's held about themselves, and anyone can opt out.

## What "engagement" means here

For this prototype, engagement is **visible activity in the chat**, and nothing
else:

| Measure | What it counts |
|---|---|
| Posts | messages of any kind (text, photo, voice note, file) |
| Replies | posts that quote-reply someone else's message |
| Reactions | emoji reactions to other people's messages |
| Started | posts sent after 3+ quiet hours, i.e. that (re)open a conversation |
| Responses got | replies and reactions *other people* gave to someone's posts |
| Weekly activity | posts + reactions per week, Monday to Sunday (UTC) |
| Joined / left | membership changes while the tool is on |

### What it observes vs. what it assumes

**Observed** (in the data): when someone posted, reacted or replied, and to whom;
whether a message had a link or a question mark; roughly how long it was; when
people joined or left.

**Not observed** (and so never claimed): reading, motivation, mood, how people
feel about the group, anything said in person or in other chats, and anything
before the tool was turned on, unless history is imported.

Patterns on the dashboard are literal descriptions of the rule that produced
them ("Posted or reacted in at least two earlier weeks, but not in the last
two"), never interpretations ("disengaged"). The *why* is left as a question in
the **Questions to discuss** section, for organisers to explore with people.

| Pattern | Rule |
|---|---|
| Joined recently | joined in the last 14 days |
| Quieter lately | active in ≥ 2 earlier weeks, nothing in the last 14 days |
| No visible activity | seen joining, never posted or reacted |
| Mostly reacts | ≥ 3 reactions and at least twice as many reactions as posts |
| Starts conversations | ≥ 3 conversation starts, and ≥ 30% of their posts |
| Draws responses | ≥ 3 posts, averaging ≥ 1.5× the group's responses per post |

## Privacy and trust

- **Message text is never stored.** Each event is reduced to a row of timings
  and flags (`src/classify.ts`) and the body is discarded.
- **It announces itself.** The first time the tool sees activity in a group, it
  posts what it records and how to opt out. `!engagement` repeats that at any time.
- **Only organisers see the dashboard.** When the tool first hears from a group,
  its welcome message asks organisers to send `!engagement email your@address`.
  The tool emails that address a personal dashboard link (via Resend), and the
  group sees only a masked address (`h•••@campaignlab.uk`). The first address in
  a group is set up straight away. After that, a new address waits on the
  dashboard until an existing organiser approves it. Organisers can also add,
  remove and approve people from the dashboard, and the group is told whenever
  someone is given access. Asking again sends a fresh link and stops the old
  one, removing someone stops their link, and only a hash of each key is
  stored. The key is moved out of the address bar once the page loads, and
  there's a *Hide names* toggle for screen sharing.
- **Group admins, once the hub supports it.** With the tool-hub power-levels
  patch applied, WhatsApp/Signal admins are approved automatically, can get a
  link by DM with `!engagement dashboard`, and non-admins can't be the first
  organiser.
- **People control their own data:**
  - `!engagement me` replies in the group with what's held about you (counts
    only, never anything written)
  - `!engagement optout` deletes it and stops recording you, including your
    name on others' replies to you
  - `!engagement optin` reverses that
  - ❌ on the AI notice, or `!engagement ai optout` / `ai optin`, keeps your
    messages out of AI theme summaries or includes them again
  - organisers can delete everything held for the group from the dashboard
    (*Organisers and data*). Organisers keep their access, and opt-outs are kept
- **Deleted messages are deleted here too** (the tool listens for redactions).
- **Importing earlier history is opt-in and announced.** People weren't told
  about tracking when they sent those messages, so the dashboard asks for
  confirmation and the tool posts a notice in the group when it's done.

## Main themes

Admins can get a month's main themes summarised by AI. This is the only
feature that reads what people wrote, so it's opt-out and switched off by
default:

1. **An organiser switches it on** with the *AI theme summaries* switch on the
   dashboard. Nothing is ever sent to Claude while it's off.
2. **Switching on posts a notice in the group** explaining what will happen.
   Anyone who reacts ❌ to it has their messages left out of every summary, and
   the tool confirms by DM. Anyone who doesn't react is treated as happy to be
   included. Removing the ❌ opts that person back in, and
   `!engagement ai optout` / `ai optin` do the same for anyone who missed the
   notice, such as people who join later. If the notice can't be posted, the
   switch stays off.
3. **There's a notice period.** No summary can run until `AI_NOTICE_HOURS`
   (default 48) after switching on, so people have time to react. Switching off
   and on again starts it afresh. Earlier opt-outs carry over.
4. **An organiser presses *Find themes*** for a month. The tool fetches that month's
   text messages from the hub. It leaves out anyone who opted out of AI
   summaries or of the tool, plus the bot and commands. It strips quoted
   replies, Matrix ids, phone numbers, emails and members' names, and labels
   speakers "Person 1", "Person 2" and so on.
5. That transcript goes to Claude (Haiku 5.5), which is told to describe topics,
   never people. Only the 3–6 themes that come back are stored, and the group
   gets a message saying it happened.

Names inside messages are only stripped when they match a member's display
name, so nicknames can get through. Claude is told not to name anyone either
way.

**Cost.** One hosted API key serves every group. Haiku 5.5 costs roughly half a
penny for a busy group's month. There's no limit on how often summaries can be
run, so keep an eye on usage: each request's token usage is logged in the
`ThemeRuns` table, and a monthly spend limit can be set on the API key in the
Anthropic Console. A month too long for one request (about
100K tokens) is refused rather than cut short. Without `ANTHROPIC_API_KEY` the
button doesn't appear.

## Admin checks need a tool-hub update (optional)

The tool asks the hub who the group's admins are, through a new
`GET /api/room/power-levels?roomId&toolId&secret` endpoint in
[`tool-hub-power-levels.patch`](tool-hub-power-levels.patch). Apply it in the
tool-hub repo with `git apply`. The mautrix bridges give WhatsApp and Signal
admins a raised Matrix power level, and anyone at `ADMIN_POWER_LEVEL` (default
50) or above counts as an admin.

Without the patch, everything works through organiser emails. The only
difference is that the first person to send `!engagement email` becomes the
group's first organiser, whoever they are. Because that's announced in the
group, a wrong first claim is easy to spot: another organiser can be added and
the wrong one removed from the dashboard.

## Running it

```bash
cp .env.example .env   # fill in tool_url, hub_url, engagement_secret
npm install
npm run build-web      # builds the dashboard into web/dist/index.html
npm run dev            # builds the server, writes engagement.json, listens on 5065
npm test               # unit tests for the classifier and metrics
```

Expose port 5065 with ngrok or a Cloudflare quick tunnel and put that URL in
`tool_url` **before** `npm run dev`, so it lands in the generated
`engagement.json`. Send that JSON to whoever runs the tool hub to add to its
`registrations/` folder. In a group, send ⚙️ and react ❤️ to *Engagement* to turn
it on.

Port 5061 would be the obvious next port after the other tools, but it's on
`fetch`'s blocked-port list (SIP), so the hub couldn't reach a tool there.

| Variable | What it does |
|---|---|
| `tool_url` | public URL of this tool, written into the registration |
| `hub_url` | tool hub base URL, used for dashboard links and history import |
| `engagement_secret` | the `secret` in the registration, needed for the hub's `/api/send`, `/api/room/power-levels` and history |
| `RESEND_API_KEY` | Resend API key for emailing organisers their dashboard link. Emails come from `engagement@dashboard.chathackers.uk`, so `dashboard.chathackers.uk` must be verified in that Resend account |
| `ANTHROPIC_API_KEY` | optional; turns on theme summaries |
| `ANTHROPIC_WORKSPACE_ID` | only needed if the Anthropic key isn't scoped to a workspace: that workspace's ID |
| `AI_NOTICE_HOURS` | hours between switching AI summaries on and the first summary (default `48`) |
| `ADMIN_POWER_LEVEL` | Matrix power level that counts as a group admin (default `50`) |
| `bot_user_id` | optional; the hub's Matrix user, so imported history skips its messages. It's learnt from live events otherwise. |
| `PORT` | defaults to `5065` |
| `DUCKDB_DATA_DIR` | where `engagement_duckdb.db` is kept |

## How it fits the tool hub

- Subscribes to `m.room.message`, `m.reaction`, `m.room.member`,
  `m.room.redaction` and `m.room.power_levels`.
- `POST /` records the event and replies `{ success, response }`. `response` is
  a string, `{ message, context?, recipient? }`, or an array of those. The
  `!engagement forget` prompt carries `context.engagementConfirm`, and the 🗑️
  reaction comes back with it on `event.prevEvent.content.context`.
- `GET /` serves the single-file dashboard. The hub proxies it at
  `<hub>/engagement/?roomId=…&key=…`, and the page calls `api/dashboard`,
  `api/import` and `api/themes` relative to that, sending the key as an
  `x-engagement-key` header. Every `/api` route checks it.
- History import calls the hub's `GET /api/room/history?roomId&since` and
  announces through `POST /api/send?roomId&toolId&secret`.

## Questions for organisers and participants

The dashboard generates discussion points from the data, but some questions
belong in any conversation about this tool:

- Did the group agree to having this turned on? Who decided, and how was it explained?
- What would people *like* participation to look like, and is the chat even the right measure of it?
- For people who have gone quiet: is a check-in welcome, and who should make it?
- What would make it easier for people who don't usually speak up?
- Should the tool be switched off after a set period, with the data deleted?
