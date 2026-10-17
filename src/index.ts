import "dotenv/config";
import express from "express";
import * as fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { MatrixEvent } from "../types";
import { forgetCachedPowerLevels, organiserFor } from "./access";
import { classify, isCommand } from "./classify";
import { firstContactNotice, handleCommand, handleConfirmation, Reply } from "./commands";
import { deleteActivityEvent, getActivity, getOptOutCount, getRoom, getThemes, insertActivity, insertRoom, isOptedOut, savePowerLevels, startDuckDB, forgetRoom, getAiSettings, getAiOptOutCount, aiOptInByReaction } from "./duckdb";
import { canImportHistory, sendToGroup, TOOL_ID } from "./hub";
import { importHistory } from "./history";
import { computeDashboard } from "./metrics";
import { canFindThemes, findThemes, noticeEndsAt, switchAi } from "./themes";
import { canEmail } from "./email";
import { grantAccess, listOrganisers, removeAccess } from "./organisers";

const { engagement_secret, tool_url } = process.env;

const port = Number(process.env.PORT ?? 5065);

// the hub tells us its Matrix user with every event; remembered so history
// imports can leave out the bot's own messages
let botUserId: string | undefined = process.env.bot_user_id;

const moduleRegistration = {
  id: TOOL_ID,
  uuid: uuidv4(),
  url: tool_url || `http://localhost:${port}`,
  emoji: "📊",
  introduction: "This records when people post, react, reply and join, but never what they write, so the group's organisers can see how participation changes over time. Organisers: send !engagement email your@address to get the dashboard link. AI theme summaries stay off unless an organiser switches them on, and you'll be able to opt out here first. Send !engagement to see what's tracked, get your own data, or opt out.",
  title: "Engagement",
  description: "Shows organisers how participation changes over time, with questions to discuss with the group",
  secret: engagement_secret,
  event_types: [
    "m.room.message", "m.reaction", "m.room.member", "m.room.redaction", "m.room.power_levels"
  ]
}

function generateRegistrationFile() {
  fs.writeFileSync(`./${moduleRegistration.id}.json`, JSON.stringify(moduleRegistration, null, 2));
}

async function handleEvent(event: MatrixEvent): Promise<Reply | Reply[] | undefined> {
  // admins can change at any time; remembered for hubs that can't be asked directly
  if (event.type === "m.room.power_levels") {
    await savePowerLevels(event.room_id, event.content);
    forgetCachedPowerLevels(event.room_id);
    return;
  }

  if (event.type === "m.room.redaction") {
    const redacts = event.redacts ?? event.content?.redacts;
    if (!redacts) return;
    await deleteActivityEvent(event.room_id, redacts);

    // a removed ❌ on the AI notice opts that person back in
    const optedBackIn = await aiOptInByReaction(event.room_id, redacts);
    if (optedBackIn)
      return { recipient: optedBackIn, message: "You removed your ❌, so your messages may be included in AI theme summaries in that group again." };
    return;
  }

  if (isCommand(event))
    return await handleCommand(event);

  if (event.type === "m.reaction" && event.prevEvent?.sender === botUserId)
    return await handleConfirmation(event);

  const activity = classify(event, botUserId, "live");
  if (activity && !await isOptedOut(event.room_id, activity.sender))
    await insertActivity(activity);
}

async function start() {
  const app = express();
  app.use(express.json());
  await startDuckDB();

  app.get("/", async (req, res) => {
    const htmlPath = path.resolve(__dirname, "../../web/dist/index.html")

    res.sendFile(htmlPath);
  })

  app.post("/", async (req, res) => {
    const { event } = req.body;
    botUserId = req.body.botUserId ?? botUserId;

    const isNewRoom = !await getRoom(event.room_id);
    if (isNewRoom)
      await insertRoom(event.room_id, Date.now());

    const reply = await handleEvent(event);

    // the first time the tool hears from a group, it says what it records
    const replies = (Array.isArray(reply) ? reply : reply ? [reply] : []).map(r => typeof r === "string" ? { message: r } : r);
    const response = isNewRoom && !isCommand(event)
      ? [{ message: firstContactNotice() }, ...replies]
      : Array.isArray(reply) ? replies : reply;

    res.send({ success: true, response });
  });

  // everything under /api is for the group's admins only: the key in their
  // personal link must match the group, and its owner must still be an admin
  app.use("/api", async (req, res, next) => {
    const roomId = String(req.query.roomId ?? "");
    const key = req.get("x-engagement-key") ?? undefined;

    const organiser = await organiserFor(roomId, key);
    if (!organiser)
      return res.status(401).send({ success: false, message: "This link isn't valid any more. Organisers can get a new one by sending !engagement email your@address in the group." });

    res.locals.organiser = organiser;
    next();
  });

  app.get("/api/dashboard", async (req, res) => {
    const { roomId } = req.query;

    const activity = await getActivity(roomId as string);
    const room = await getRoom(roomId as string);
    const optedOut = await getOptOutCount(roomId as string);

    res.send({ ...computeDashboard(activity, room, optedOut), canImportHistory: canImportHistory() });
  })

  app.post("/api/import", async (req, res) => {
    const { roomId } = req.query;
    const days = Math.min(365, Math.max(1, Number(req.body.days) || 30));

    if (!canImportHistory())
      return res.send({ success: false, message: "Set hub_url and engagement_secret to import history" });

    try {
      const result = await importHistory(roomId as string, days, botUserId);
      res.send({ success: true, ...result });
    } catch (err) {
      console.error("history import failed", err);
      res.send({ success: false, message: String(err) });
    }
  })

  app.get("/api/themes", async (req, res) => {
    const { roomId } = req.query;

    const settings = await getAiSettings(roomId as string);

    res.send({
      months: await getThemes(roomId as string),
      canFindThemes: canFindThemes(),
      enabled: settings.enabled,
      availableFrom: settings.enabled ? noticeEndsAt(settings.enabledAt) : null,
      aiOptOuts: await getAiOptOutCount(roomId as string),
    });
  })

  // the admin's switch; turning it on posts the opt-out notice in the group
  app.post("/api/themes/switch", async (req, res) => {
    const { roomId } = req.query;

    if (!canFindThemes())
      return res.send({ success: false, message: "AI theme summaries aren't set up on this server" });

    res.send(await switchAi(roomId as string, Boolean(req.body.enabled)));
  })

  app.post("/api/themes", async (req, res) => {
    const { roomId } = req.query;

    if (!canFindThemes())
      return res.send({ success: false, message: "Set ANTHROPIC_API_KEY, hub_url and engagement_secret to find themes" });

    try {
      const result = await findThemes(roomId as string, String(req.body.month), botUserId);
      res.send({ success: true, ...result });
    } catch (err) {
      console.error("finding themes failed", err);
      res.send({ success: false, message: err instanceof Error ? err.message : String(err) });
    }
  })

  app.get("/api/organisers", async (req, res) => {
    const { roomId } = req.query;
    res.send({ organisers: await listOrganisers(roomId as string), you: res.locals.organiser, canEmail: canEmail() });
  })

  // add someone directly, or approve a request made in the chat
  app.post("/api/organisers", async (req, res) => {
    const { roomId } = req.query;
    res.send(await grantAccess(roomId as string, String(req.body.email ?? ""), res.locals.organiser));
  })

  // decline a request, or remove someone's access
  app.post("/api/organisers/remove", async (req, res) => {
    const { roomId } = req.query;
    res.send(await removeAccess(roomId as string, String(req.body.email ?? "")));
  })

  app.post("/api/forget", async (req, res) => {
    const { roomId } = req.query;
    await forgetRoom(roomId as string);
    await sendToGroup(roomId as string, "📊 An organiser has deleted everything the Engagement tool held for this group. Tracking starts afresh from now unless the tool is removed (⚙️, then 🙏).");
    res.send({ success: true });
  })

  app.listen(port);
};

generateRegistrationFile();
start();
