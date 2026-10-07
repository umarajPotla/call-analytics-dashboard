import type {
  Account,
  AppMeta,
  CallsPage,
  CampaignRef,
  ConversionResponse,
  InsightsResponse,
  SummaryResponse,
  VolumeResponse,
} from "@calls/shared";

/** RFC 9457 problem details, as every API error is returned. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly title: string,
    readonly detail?: string,
  ) {
    super(detail ?? title);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init?.body ? { "content-type": "application/json" } : {}) },
  });
  if (!res.ok) {
    const problem = (await res.json().catch(() => ({}))) as { title?: string; detail?: string };
    throw new ApiError(res.status, problem.title ?? res.statusText, problem.detail);
  }
  return (res.status === 204 ? null : await res.json()) as T;
}

export type Filters = {
  accountId: string;
  from: string;
  to: string;
  campaignIds: string[];
  outcomes: string[];
};

const qs = (params: Record<string, string | number | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params))
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
};
const rangeParams = (f: Filters) => ({
  from: f.from,
  to: f.to,
  campaignIds: f.campaignIds.join(","),
  outcomes: f.outcomes.join(","),
});
const acct = (f: Pick<Filters, "accountId">) => `/accounts/${f.accountId}`;

export const api = {
  meta: () => request<AppMeta>("/meta"),
  accounts: () => request<Account[]>("/accounts"),
  campaigns: (accountId: string) => request<CampaignRef[]>(`/accounts/${accountId}/campaigns`),
  summary: (f: Filters) => request<SummaryResponse>(`${acct(f)}/metrics/summary${qs(rangeParams(f))}`),
  volume: (f: Filters, granularity: "hour" | "day") =>
    request<VolumeResponse>(`${acct(f)}/metrics/volume${qs({ ...rangeParams(f), granularity })}`),
  conversion: (f: Filters, groupBy: "source" | "campaign") =>
    request<ConversionResponse>(
      `${acct(f)}/metrics/conversion${qs({ ...rangeParams(f), outcomes: "", groupBy })}`,
    ),
  recentCalls: (f: Pick<Filters, "accountId" | "campaignIds" | "outcomes">, limit = 50) =>
    request<CallsPage>(
      `${acct(f)}/calls${qs({ campaignIds: f.campaignIds.join(","), outcomes: f.outcomes.join(","), limit })}`,
    ),
  changes: (accountId: string, afterSeq: number) =>
    request<{ items: CallsPage["items"]; latestSeq: number; truncated: boolean }>(
      `/accounts/${accountId}/calls/changes${qs({ afterSeq })}`,
    ),
  insights: (f: Pick<Filters, "accountId" | "from" | "to">) =>
    request<InsightsResponse>(`${acct(f)}/insights${qs({ from: f.from, to: f.to })}`),
  feedback: (accountId: string, body: { cacheKey: string; insightId: string; rating: 1 | -1 }) =>
    request<null>(`/accounts/${accountId}/insights/feedback`, { method: "POST", body: JSON.stringify(body) }),
  spike: (accountId: string) =>
    request<{ ok: boolean }>("/dev/spike", { method: "POST", body: JSON.stringify({ accountId }) }),
};

export const streamUrl = (f: Pick<Filters, "accountId" | "campaignIds">) =>
  `/api/v1/accounts/${f.accountId}/calls/stream${qs({ campaignIds: f.campaignIds.join(",") })}`;
