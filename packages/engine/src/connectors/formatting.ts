// Built-in "Formatting" connector — pure-JS data tidying helpers that run
// locally (no API, no credential, no credits). Each method transforms a single
// row's inputs and returns the cleaned value.

import type { Connector, ConnectorMethod } from "../types.js";

function str(v: unknown): string {
  return v == null ? "" : typeof v === "string" ? v : String(v);
}

const cleanCompanyName: ConnectorMethod = {
  id: "cleanCompanyName",
  label: "Clean Company Name",
  description: "Remove common suffixes like Inc, LLC, Ltd, Corp, and Co from company names.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["companyName"],
    properties: { companyName: { type: "string", description: "Company name to clean" } },
  },
  source: `const suffixes = /[,.]?\\s*(Inc\\.?|LLC|Ltd\\.?|Corp\\.?|Corporation|Company|Co\\.?|Incorporated|GmbH|S\\.?A\\.?|Pty|Limited|PLC|LLP)\\.?$/i;
const cleaned = companyName.replace(suffixes, "").trim();`,
  run: async (input) => {
    const name = str(input.companyName);
    if (!name) return null;
    const suffixes = /[,.]?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?|Incorporated|GmbH|S\.?A\.?|Pty|Limited|PLC|LLP)\.?$/i;
    return name.replace(suffixes, "").trim();
  },
};

const concatenate: ConnectorMethod = {
  id: "concatenate",
  label: "Concatenate",
  description: "Concatenate two text values with a configurable separator.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["text1", "text2"],
    properties: {
      text1: { type: "string", description: "First value to concatenate" },
      text2: { type: "string", description: "Second value to concatenate" },
      separator: { type: "string", description: "Separator between values (default: space)" },
    },
  },
  source: `const a = text1 ?? "", b = text2 ?? "";
const sep = separator ?? " ";
return a && b ? a + sep + b : a || b;`,
  run: async (input) => {
    const a = str(input.text1);
    const b = str(input.text2);
    if (!a && !b) return null;
    const sep = input.separator != null ? str(input.separator) : " ";
    return a && b ? a + sep + b : a || b;
  },
};

const domainFromEmail: ConnectorMethod = {
  id: "domainFromEmail",
  label: "Domain from Email",
  description: "Extract the domain portion from an email address.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["email"],
    properties: { email: { type: "string", description: "Email address to extract domain from" } },
  },
  source: `const parts = email.split("@");
return parts.length === 2 ? parts[1].toLowerCase().trim() : null;`,
  run: async (input) => {
    const email = str(input.email);
    if (!email) return null;
    const parts = email.split("@");
    return parts.length === 2 ? parts[1].toLowerCase().trim() : null;
  },
};

const domainFromUrl: ConnectorMethod = {
  id: "domainFromUrl",
  label: "Domain from URL",
  description: "Extract the root domain from a website URL.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", description: "Website URL to extract domain from" } },
  },
  source: `let url = input.url.trim();
if (!url.startsWith("http")) url = "https://" + url;
return new URL(url).hostname.replace(/^www\\./, "");`,
  run: async (input) => {
    const raw = str(input.url).trim();
    if (!raw) return null;
    try {
      const url = raw.startsWith("http://") || raw.startsWith("https://") ? raw : "https://" + raw;
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return null;
    }
  },
};

const extractLinkedinHandle: ConnectorMethod = {
  id: "extractLinkedinHandle",
  label: "Extract LinkedIn Handle",
  description: "Extract the LinkedIn username from a LinkedIn profile URL.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["linkedinUrl"],
    properties: { linkedinUrl: { type: "string", description: "LinkedIn profile URL" } },
  },
  source: `const match = linkedinUrl.match(/linkedin\\.com\\/in\\/([^\\/\\?#]+)/);
return match ? match[1].toLowerCase() : null;`,
  run: async (input) => {
    const url = str(input.linkedinUrl);
    if (!url) return null;
    const match = url.match(/linkedin\.com\/in\/([^/?#]+)/);
    return match ? match[1].toLowerCase() : null;
  },
};

export const formattingConnector: Connector = {
  id: "formatting",
  name: "Formatting",
  category: "formatting",
  auth: null,
  methods: [cleanCompanyName, concatenate, domainFromEmail, domainFromUrl, extractLinkedinHandle],
};
