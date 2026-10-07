import { CallStatus } from "@calls/shared";
import { z } from "zod";

/** Comma-separated list in a query string, e.g. ?campaignIds=a,b -> ["a","b"]; empty/absent -> null (no filter). */
const csv = <T extends z.ZodType>(item: T) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const parts = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const out: z.output<T>[] = [];
      for (const p of parts) {
        const r = item.safeParse(p);
        if (!r.success) {
          ctx.addIssue({ code: "custom", message: `invalid value "${p}"` });
          return z.NEVER;
        }
        out.push(r.data);
      }
      return out.length ? out : null;
    });

export const AccountParams = z.object({ accountId: z.uuid() });

export const RangeQuery = z.object({
  from: z.iso
    .date()
    .optional()
    .describe("First local date (YYYY-MM-DD, account time zone). Default: 6 days ago."),
  to: z.iso.date().optional().describe("Last local date, inclusive. Default: today."),
  campaignIds: csv(z.uuid()).describe("Comma-separated campaign ids"),
});

export const OutcomeFilter = z.object({
  outcomes: csv(CallStatus).describe("Comma-separated statuses: ringing, connected, missed, converted"),
});
