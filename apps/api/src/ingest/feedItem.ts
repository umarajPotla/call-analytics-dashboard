import type { CallStatus, FeedItem } from "@calls/shared";
import type { CampaignInfo } from "./campaignDirectory";

export type CallRow = {
  id: string;
  account_id: string;
  campaign_id: string;
  status: CallStatus;
  started_at: Date;
  answered_at: Date | null;
  ended_at: Date | null;
  converted_at: Date | null;
  duration_sec: number | null;
  caller_masked: string | null;
  caller_region: string | null;
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function toFeedItem(row: CallRow, campaign: CampaignInfo, seq: number | null): FeedItem {
  return {
    seq,
    callId: row.id,
    status: row.status,
    campaign: { id: campaign.id, name: campaign.name, source: campaign.source },
    startedAt: row.started_at.toISOString(),
    answeredAt: iso(row.answered_at),
    endedAt: iso(row.ended_at),
    convertedAt: iso(row.converted_at),
    durationSec: row.duration_sec,
    callerMasked: row.caller_masked,
    callerRegion: row.caller_region,
  };
}
