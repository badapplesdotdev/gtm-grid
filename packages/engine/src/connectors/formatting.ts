// Built-in "Formatting" connector — pure-JS data tidying helpers that run
// locally (no API, no credential, no credits). Each method transforms a single
// row's inputs and returns the cleaned value.

import type { Connector, ConnectorMethod } from "../types.js";

function str(v: unknown): string {
  return v == null ? "" : typeof v === "string" ? v : String(v);
}

// Title-case a string: capitalise the first letter of each word (word breaks at
// whitespace, hyphen, slash, apostrophe).
function toTitleCase(value: string): string {
  return value.toLowerCase().replace(/(?:^|[\s\-/'])\S/g, (c) => c.toUpperCase());
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

// ── Date ──────────────────────────────────────────────────
function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
function parseDate(value: unknown): Date | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value > 1e11 ? value : value * 1000); // seconds vs ms epoch
  }
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return new Date(n > 1e11 ? n : n * 1000);
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

const formatDate: ConnectorMethod = {
  id: "formatDate",
  label: "Format Date",
  description: "Format a date-like value into a preset or custom textual representation.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["value"],
    properties: {
      value: { type: "string", description: "Date-like value to format (ISO string, epoch seconds/ms, or a parseable date)" },
      format: { type: "string", description: "iso | date (YYYY-MM-DD, default) | datetime | us (MM/DD/YYYY) | eu (DD/MM/YYYY) | long (Month D, YYYY)" },
    },
  },
  source: `const d = parseDate(value);
switch (format) {
  case "iso":      return d.toISOString();
  case "datetime": return \`\${y}-\${mo}-\${da} \${h}:\${mi}\`;
  case "us":       return \`\${mo}/\${da}/\${y}\`;
  case "eu":       return \`\${da}/\${mo}/\${y}\`;
  case "long":     return \`\${MONTHS[d.getUTCMonth()]} \${d.getUTCDate()}, \${y}\`;
  default:         return \`\${y}-\${mo}-\${da}\`;  // date
}`,
  run: async (input) => {
    const d = parseDate(input.value);
    if (!d) return null;
    const y = d.getUTCFullYear();
    const mo = pad(d.getUTCMonth() + 1);
    const da = pad(d.getUTCDate());
    const h = pad(d.getUTCHours());
    const mi = pad(d.getUTCMinutes());
    switch (str(input.format).toLowerCase()) {
      case "iso":
        return d.toISOString();
      case "datetime":
        return `${y}-${mo}-${da} ${h}:${mi}`;
      case "us":
        return `${mo}/${da}/${y}`;
      case "eu":
        return `${da}/${mo}/${y}`;
      case "long":
        return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${y}`;
      default:
        return `${y}-${mo}-${da}`;
    }
  },
};

// ── Company name ──────────────────────────────────────────
const normalizeCompanyName: ConnectorMethod = {
  id: "normalizeCompanyName",
  label: "Normalize Company Name",
  description: "Remove common legal suffixes and optionally title-case names that are entirely upper- or lowercase.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["companyName"],
    properties: {
      companyName: { type: "string", description: "Company name to normalize" },
      titleCaseIfUniform: { type: "boolean", description: "Title-case the result if it is ALL CAPS or all lowercase (default: true)" },
    },
  },
  source: `const suffixes = /[,.]?\\s*(Inc\\.?|LLC|Ltd\\.?|Corp\\.?|Corporation|Company|Co\\.?|Incorporated|GmbH|S\\.?A\\.?|Pty|Limited|PLC|LLP|Holdings|Group)\\.?$/i;
let cleaned = companyName.replace(suffixes, "").trim().replace(/\\s+/g, " ");
const uniform = cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase();
return titleCaseIfUniform && uniform ? toTitleCase(cleaned) : cleaned;`,
  run: async (input) => {
    const name = str(input.companyName);
    if (!name) return null;
    const suffixes = /[,.]?\s*(Inc\.?|LLC|Ltd\.?|Corp\.?|Corporation|Company|Co\.?|Incorporated|GmbH|S\.?A\.?|Pty|Limited|PLC|LLP|Holdings|Group)\.?$/i;
    const cleaned = name.replace(suffixes, "").trim().replace(/\s+/g, " ");
    if (!cleaned) return null;
    const wantTitle = input.titleCaseIfUniform !== false && str(input.titleCaseIfUniform).toLowerCase() !== "false";
    const uniform = cleaned === cleaned.toUpperCase() || cleaned === cleaned.toLowerCase();
    return wantTitle && uniform ? toTitleCase(cleaned) : cleaned;
  },
};

// ── Domain ────────────────────────────────────────────────
// Two-label public suffixes where the registrable domain is the last 3 labels.
const SECOND_LEVEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "co.in", "co.jp", "co.kr", "co.za",
  "com.br", "com.mx", "com.tr", "com.cn", "com.sg", "com.hk",
]);

const normalizeDomain: ConnectorMethod = {
  id: "normalizeDomain",
  label: "Normalize Domain",
  description: "Normalize a URL, email, or domain into a clean canonical registrable domain (drops protocol, www, and paths).",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", description: "URL, domain, or email-like value to normalize" } },
  },
  source: `let candidate = raw.includes("@") && !raw.includes("://") ? raw.split("@")[1] : raw;
const host = new URL(/^https?:\\/\\//i.test(candidate) ? candidate : "https://" + candidate)
  .hostname.toLowerCase().replace(/^www\\./, "");
const parts = host.split(".");
if (parts.length <= 2) return host;
const lastTwo = parts.slice(-2).join(".");
return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;`,
  run: async (input) => {
    const raw = str(input.url).trim();
    if (!raw) return null;
    const candidate = raw.includes("@") && !raw.includes("://") ? raw.split("@")[1] : raw;
    if (!candidate) return null;
    let host: string;
    try {
      host = new URL(/^https?:\/\//i.test(candidate) ? candidate : "https://" + candidate).hostname;
    } catch {
      return null;
    }
    host = host.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".");
    if (parts.length <= 2) return host;
    const lastTwo = parts.slice(-2).join(".");
    return SECOND_LEVEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join(".") : lastTwo;
  },
};

// ── Phone ─────────────────────────────────────────────────
interface CountryMeta {
  countryCode: string;
  lengths: number[];
  groups: number[];
  trunkPrefix: boolean;
}
const PHONE_COUNTRIES: Record<string, CountryMeta> = {
  US: { countryCode: "1", lengths: [10], groups: [3, 3, 4], trunkPrefix: false },
  CA: { countryCode: "1", lengths: [10], groups: [3, 3, 4], trunkPrefix: false },
  GB: { countryCode: "44", lengths: [10], groups: [4, 3, 3], trunkPrefix: true },
  DE: { countryCode: "49", lengths: [10, 11], groups: [3, 3, 4], trunkPrefix: true },
  FR: { countryCode: "33", lengths: [9], groups: [1, 2, 2, 2, 2], trunkPrefix: true },
  ES: { countryCode: "34", lengths: [9], groups: [3, 3, 3], trunkPrefix: false },
  IT: { countryCode: "39", lengths: [9, 10], groups: [3, 3, 4], trunkPrefix: true },
  NL: { countryCode: "31", lengths: [9], groups: [3, 3, 3], trunkPrefix: true },
  AU: { countryCode: "61", lengths: [9], groups: [1, 4, 4], trunkPrefix: true },
  NZ: { countryCode: "64", lengths: [8, 9], groups: [2, 3, 4], trunkPrefix: true },
  IN: { countryCode: "91", lengths: [10], groups: [5, 5], trunkPrefix: true },
  IE: { countryCode: "353", lengths: [9], groups: [2, 3, 4], trunkPrefix: true },
};
function groupDigits(digits: string, groups: number[]): string {
  const out: string[] = [];
  let i = 0;
  for (const g of groups) {
    if (i >= digits.length) break;
    out.push(digits.slice(i, i + g));
    i += g;
  }
  if (i < digits.length) out.push(digits.slice(i));
  return out.join(" ");
}

const normalizePhoneNumber: ConnectorMethod = {
  id: "normalizePhoneNumber",
  label: "Normalize Phone Number",
  description: "Parse a phone number into structured international (E.164) and national representations using a built-in country metadata table.",
  batchSize: 500,
  credits: 0,
  output: "json",
  inputSchema: {
    type: "object",
    required: ["phone"],
    properties: {
      phone: { type: "string", description: "Phone number to parse and normalize" },
      defaultCountry: { type: "string", description: "ISO country code to assume when there is no + prefix (default: US)" },
    },
  },
  source: `// strip to digits, detect +CC or fall back to defaultCountry, then format
return { e164, international, national, countryCode, country, valid };`,
  run: async (input) => {
    const raw = str(input.phone).trim();
    if (!raw) return null;
    const defaultCountry = (str(input.defaultCountry) || "US").toUpperCase();
    const hasPlus = raw.trimStart().startsWith("+");
    let digits = raw.replace(/[^\d]/g, "");
    if (!digits) return null;

    let country: string | null = null;
    let meta: CountryMeta | undefined;
    let national = digits;

    if (hasPlus) {
      // Match the longest country code prefix.
      const entries = Object.entries(PHONE_COUNTRIES).sort((a, b) => b[1].countryCode.length - a[1].countryCode.length);
      for (const [iso, m] of entries) {
        if (digits.startsWith(m.countryCode)) {
          country = iso;
          meta = m;
          national = digits.slice(m.countryCode.length);
          break;
        }
      }
    } else {
      meta = PHONE_COUNTRIES[defaultCountry];
      country = meta ? defaultCountry : null;
      if (meta?.trunkPrefix && national.startsWith("0")) national = national.slice(1);
      // A US/CA number written with a leading 1 and 11 digits → strip the 1.
      if (meta && meta.countryCode === "1" && national.length === 11 && national.startsWith("1")) national = national.slice(1);
    }

    if (!meta || !country) {
      return { e164: hasPlus ? `+${digits}` : null, international: null, national: digits, countryCode: null, country: null, valid: false };
    }

    const e164 = `+${meta.countryCode}${national}`;
    const grouped = groupDigits(national, meta.groups);
    const valid = meta.lengths.includes(national.length);
    return {
      e164,
      international: `+${meta.countryCode} ${grouped}`,
      national: meta.trunkPrefix ? `0${grouped}` : grouped,
      countryCode: meta.countryCode,
      country,
      valid,
    };
  },
};

// ── URL ───────────────────────────────────────────────────
const normalizeUrl: ConnectorMethod = {
  id: "normalizeUrl",
  label: "Normalize URL",
  description: "Add an https:// prefix if missing, lowercase the hostname, and strip a trailing slash.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string", description: "URL to normalize" } },
  },
  source: `let url = input.url.trim();
if (!/^https?:\\/\\//i.test(url)) url = "https://" + url;
const u = new URL(url);
let out = u.protocol + "//" + u.hostname.toLowerCase() + (u.pathname === "/" ? "" : u.pathname) + u.search;
return out.replace(/\\/$/, "");`,
  run: async (input) => {
    const raw = str(input.url).trim();
    if (!raw) return null;
    try {
      const url = /^https?:\/\//i.test(raw) ? raw : "https://" + raw;
      const u = new URL(url);
      const path = u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "");
      return u.protocol + "//" + u.hostname.toLowerCase() + path + u.search;
    } catch {
      return null;
    }
  },
};

// ── Names ─────────────────────────────────────────────────
const splitFullName: ConnectorMethod = {
  id: "splitFullName",
  label: "Split Full Name",
  description: "Split a full name into first, middle, and last name parts. Returns { firstName, middleName, lastName }.",
  batchSize: 500,
  credits: 0,
  output: "json",
  inputSchema: {
    type: "object",
    required: ["fullName"],
    properties: { fullName: { type: "string", description: "Full name to split" } },
  },
  source: `const parts = fullName.trim().replace(/\\s+/g, " ").split(" ");
if (parts.length === 1) return { firstName: parts[0], middleName: "", lastName: "" };
return { firstName: parts[0], middleName: parts.slice(1, -1).join(" "), lastName: parts[parts.length - 1] };`,
  run: async (input) => {
    const name = str(input.fullName).trim().replace(/\s+/g, " ");
    if (!name) return null;
    const parts = name.split(" ");
    if (parts.length === 1) return { firstName: parts[0], middleName: "", lastName: "" };
    return {
      firstName: parts[0],
      middleName: parts.slice(1, -1).join(" "),
      lastName: parts[parts.length - 1],
    };
  },
};

const titleCase: ConnectorMethod = {
  id: "titleCase",
  label: "Title Case",
  description: "Capitalize the first letter of each word in a text value.",
  batchSize: 500,
  credits: 0,
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", description: "Text to convert to title case" } },
  },
  source: `return text.toLowerCase().replace(/(?:^|[\\s\\-/'])\\S/g, (c) => c.toUpperCase());`,
  run: async (input) => {
    const t = str(input.text);
    if (!t) return null;
    return toTitleCase(t);
  },
};

export const formattingConnector: Connector = {
  id: "formatting",
  name: "Formatting",
  category: "formatting",
  auth: null,
  methods: [
    cleanCompanyName,
    concatenate,
    domainFromEmail,
    domainFromUrl,
    extractLinkedinHandle,
    formatDate,
    normalizeCompanyName,
    normalizeDomain,
    normalizePhoneNumber,
    normalizeUrl,
    splitFullName,
    titleCase,
  ],
};
