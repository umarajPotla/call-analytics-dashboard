import type { Source } from "@calls/shared";

/**
 * Demo tenants and their traffic profiles. The IDs are fixed so links, tests and the simulator are stable.
 * `conversion` is the probability that an ANSWERED call converts; `weight` is the share of the account's calls.
 */
export type CampaignProfile = {
  id: string;
  name: string;
  source: Source;
  weight: number;
  conversion: number;
};
export type AccountProfile = {
  id: string;
  name: string;
  timezone: string;
  callsPerDay: number;
  campaigns: CampaignProfile[];
};

export const CATALOG: AccountProfile[] = [
  {
    id: "dc85fdbe-de05-46c9-965d-e29d3553663d",
    name: "Acme Home Insurance",
    timezone: "America/Los_Angeles",
    callsPerDay: 4200,
    campaigns: [
      {
        id: "89916b78-6311-4b05-8fd1-5583ffbb661a",
        name: "Brand search",
        source: "google_ads",
        weight: 0.26,
        conversion: 0.34,
      },
      {
        id: "59b182a7-2d29-4222-8a8d-4b6b147815a7",
        name: "Non-brand search",
        source: "google_ads",
        weight: 0.2,
        conversion: 0.21,
      },
      {
        id: "4eea23e2-d374-4f71-9a97-f672549512a7",
        name: "Retargeting",
        source: "meta",
        weight: 0.14,
        conversion: 0.15,
      },
      {
        id: "856d8d8d-de04-4ab7-8aa9-cc3851bbdb7e",
        name: "Fall TV spot",
        source: "tv",
        weight: 0.12,
        conversion: 0.09,
      },
      {
        id: "3174b4ba-3cdd-4fd5-9d62-c87a04158733",
        name: "Organic search",
        source: "organic",
        weight: 0.16,
        conversion: 0.24,
      },
      {
        id: "219e5171-1cfe-4db9-86f9-7ced339f1b20",
        name: "Direct mail Q4",
        source: "direct_mail",
        weight: 0.07,
        conversion: 0.12,
      },
      {
        id: "083dee5a-a3a8-4912-808d-f78fae5c0fff",
        name: "Comparison sites",
        source: "affiliate",
        weight: 0.05,
        conversion: 0.18,
      },
    ],
  },
  {
    id: "5e9effc2-dbc6-4c91-aa3e-04a4018a1e11",
    name: "Northwind Auto Group",
    timezone: "America/New_York",
    callsPerDay: 2600,
    campaigns: [
      {
        id: "84668586-ef03-49fa-abce-0e9064ea4a2e",
        name: "Brand search",
        source: "google_ads",
        weight: 0.3,
        conversion: 0.3,
      },
      {
        id: "4a334596-6ede-46d4-a77a-474b84bd1f66",
        name: "Service specials",
        source: "meta",
        weight: 0.2,
        conversion: 0.16,
      },
      {
        id: "ef3d18ff-d28b-4086-a137-019fb1f9c1dc",
        name: "Regional TV",
        source: "tv",
        weight: 0.15,
        conversion: 0.1,
      },
      {
        id: "16f2f916-5164-4bb4-b916-2d46f848a5ff",
        name: "Organic search",
        source: "organic",
        weight: 0.25,
        conversion: 0.22,
      },
      {
        id: "bbc6b24a-cb93-46e7-8811-e715ba27fdf2",
        name: "Dealer listings",
        source: "affiliate",
        weight: 0.1,
        conversion: 0.2,
      },
    ],
  },
  {
    id: "5ec17146-7934-4de2-b196-9e0e516679e0",
    name: "Bright Smile Dental",
    timezone: "Europe/London",
    callsPerDay: 1500,
    campaigns: [
      {
        id: "fd3dc993-14f2-465d-8a1a-5245ecd4a87e",
        name: "Brand search",
        source: "google_ads",
        weight: 0.35,
        conversion: 0.38,
      },
      {
        id: "5fd6e869-4e77-43e7-8e14-0b216e406ae9",
        name: "Instagram offers",
        source: "meta",
        weight: 0.25,
        conversion: 0.2,
      },
      {
        id: "c4421546-2f38-4b4d-a94a-69e14a4999c7",
        name: "Organic search",
        source: "organic",
        weight: 0.3,
        conversion: 0.3,
      },
      {
        id: "aa3d76e8-c826-4058-8cbb-36a74c4709b5",
        name: "Leaflet drop",
        source: "direct_mail",
        weight: 0.1,
        conversion: 0.14,
      },
    ],
  },
];
