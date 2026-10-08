import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AccountDirectory } from "../http/accounts";
import { AccountParams } from "../http/params";
import type { CallsRepo } from "../read/callsRepo";
import { formatUpdate, type SseHub } from "../realtime/sseHub";

const REPLAY_LIMIT = 500;
/** seq is assigned at insert, not commit, so a slightly older seq can become visible after a newer one.
 * Replaying a small overlap and letting the client dedupe closes that gap. */
const REPLAY_OVERLAP = 50;

type Deps = { accounts: AccountDirectory; calls: CallsRepo; hub: SseHub };

export const streamRoutes: FastifyPluginAsyncZod<Deps> = async (app, { accounts, calls, hub }) => {
  app.get(
    "/accounts/:accountId/calls/stream",
    {
      schema: {
        tags: ["calls"],
        summary: "Live feed (Server-Sent Events)",
        description:
          "Emits `call.updated` events with a FeedItem payload and `id` = event sequence. Reconnect with Last-Event-ID to replay what you missed; `reset` means refetch.",
        params: AccountParams,
        querystring: z.object({ campaignIds: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const account = accounts.require(req.params.accountId);
      const lastId = Number(req.headers["last-event-id"] ?? Number.NaN);
      const campaignIds = req.query.campaignIds ? req.query.campaignIds.split(",").filter(Boolean) : null;

      reply.hijack();
      const clientId = hub.attach(account.id, reply.raw, campaignIds);

      if (Number.isFinite(lastId) && lastId > 0) {
        try {
          const { items, truncated } = await calls.changesSince(
            account.id,
            Math.max(0, lastId - REPLAY_OVERLAP),
            REPLAY_LIMIT,
          );
          if (truncated) hub.sendTo(clientId, "event: reset\ndata: {}\n\n");
          else {
            const wanted = campaignIds ? new Set(campaignIds) : null;
            for (const item of items) {
              if (!wanted || wanted.has(item.campaign.id))
                hub.sendTo(clientId, formatUpdate(item.seq ?? lastId, item));
            }
          }
        } catch (err) {
          // The response is already hijacked, so no error page: tell the client to refetch instead of missing updates.
          req.log.warn({ err }, "stream: replay failed");
          hub.sendTo(clientId, "event: reset\ndata: {}\n\n");
        }
      }
    },
  );
};
