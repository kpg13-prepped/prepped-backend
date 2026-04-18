import { runRecommendation } from "./recommendationEngine.js";
import express from "express";
import cors from "cors";
import "dotenv/config";
import crypto from "node:crypto";
import cookieParser from "cookie-parser";
import { Resend } from "resend";
import { db } from "./db.js";

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log("DB tables:", tables);

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN?.split(",") ?? true,
    credentials: true,
  }),
);

const port = Number(process.env.PORT || 3001);
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
const cookieName = process.env.AUTH_COOKIE_NAME || "prepped_auth";
const magicMinutes = Number(process.env.MAGIC_LINK_MINUTES || 15);
const authDays = Number(process.env.AUTH_SESSION_DAYS || 30);
const resendApiKey = process.env.RESEND_API_KEY || "";
const emailFrom = process.env.EMAIL_FROM || "PREPPED <onboarding@example.com>";
const resend = resendApiKey ? new Resend(resendApiKey) : null;

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

const createTablesSql = `
CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profiles (
  profile_id TEXT PRIMARY KEY,
  customer_id TEXT,
  session_id TEXT NOT NULL UNIQUE,
  answers_json TEXT NOT NULL DEFAULT '{}',
  recommendation_json TEXT NOT NULL DEFAULT '{}',
  location_json TEXT NOT NULL DEFAULT '{}',
  household_json TEXT NOT NULL DEFAULT '{}',
  logistics_json TEXT NOT NULL DEFAULT '{}',
  readiness_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS profile_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  snapshot_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (profile_id) REFERENCES profiles(profile_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS magic_link_tokens (
  token_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  session_id TEXT,
  redirect_path TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  auth_session_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  session_token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_profiles_customer_id ON profiles(customer_id);
CREATE INDEX IF NOT EXISTS idx_snapshots_profile_id ON profile_snapshots(profile_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_magic_customer_id ON magic_link_tokens(customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_auth_customer_id ON auth_sessions(customer_id, created_at DESC);
`;
db.exec(createTablesSql);

// --- types ---
type AnyRecord = Record<string, unknown>;

type AddressResult = {
  id: string;
  fullAddress: string;
  suburb: string;
  city: string;
  region: string;
  lat: number | null;
  lng: number | null;
};

type SavedProfile = {
  profileId: string;
  customerId?: string | null;
  sessionId: string;
  answers?: AnyRecord;
  recommendation?: AnyRecord;
  location?: AnyRecord;
  household?: AnyRecord;
  logistics?: AnyRecord;
  readiness?: AnyRecord;
  generatedAt?: string;
  createdAt?: string;
  updatedAt: string;
};

type SuggestedModule = {
  key: string;
  title: string;
  quantity: number;
  reason: string;
  priority: "high" | "medium";
};

type RecommendationResponse = {
  ok: true;
  sessionId: string;
  scorecard: {
    peopleCount: number;
    supportLoad: number;
    householdWeight: number;
    preparationPackQty: number;
    homePackQty: number;
    carPackQty: number;
    mode: "Mobile-first" | "Hybrid" | "Home-first";
    path: "Starter" | "Risk-led" | "Family-led";
    confidence: "High fit" | "Good fit" | "Needs refinement";
  };
  recommendation: {
    mode: "Mobile-first" | "Hybrid" | "Home-first";
    path: "Starter" | "Risk-led" | "Family-led";
    confidence: "High fit" | "Good fit" | "Needs refinement";
    preparationPackQty: number;
    homePackQty: number;
    carPackQty: number;
    mainMessage: string;
    whyRecommended: string[];
    modules: SuggestedModule[];
    immediateActions: string[];
    nextStage: string;
  };
};

// --- helpers ---
function nowIso(): string {
  return new Date().toISOString();
}

function addMinutesIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function addDaysIso(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60_000).toISOString();
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
}

function asNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return 0;
}

function clampMin(value: number, min: number): number {
  return Math.max(min, value);
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

function parseJsonObject(value: string | null | undefined): AnyRecord {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as AnyRecord) : {};
  } catch {
    return {};
  }
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function buildMagicVerifyUrl(rawToken: string): string {
  return `${frontendUrl.replace(/\/$/, "")}/auth/callback?token=${encodeURIComponent(rawToken)}`;
}

function isIsoExpired(value: string): boolean {
  return new Date(value).getTime() <= Date.now();
}

function setAuthCookie(res: express.Response, rawSessionToken: string): void {
  res.cookie(cookieName, rawSessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(addDaysIso(authDays)),
  });
}

function clearAuthCookie(res: express.Response): void {
  res.clearCookie(cookieName, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
}

// --- db statements ---
const upsertCustomerStmt = db.prepare(`
INSERT INTO customers (customer_id, email, name, created_at, updated_at, last_seen_at)
VALUES (@customerId, @email, @name, @createdAt, @updatedAt, @lastSeenAt)
ON CONFLICT(email) DO UPDATE SET
  name = COALESCE(excluded.name, customers.name),
  updated_at = excluded.updated_at,
  last_seen_at = excluded.last_seen_at
`);

const getCustomerByEmailStmt = db.prepare(`SELECT * FROM customers WHERE email = ?`);
const getCustomerByIdStmt = db.prepare(`SELECT * FROM customers WHERE customer_id = ?`);

const getProfileBySessionIdStmt = db.prepare(`SELECT * FROM profiles WHERE session_id = ?`);
const getProfileByProfileIdStmt = db.prepare(`SELECT * FROM profiles WHERE profile_id = ?`);
const getProfilesForCustomerStmt = db.prepare(`SELECT * FROM profiles WHERE customer_id = ? ORDER BY updated_at DESC`);

const upsertProfileStmt = db.prepare(`
INSERT INTO profiles (
  profile_id, customer_id, session_id,
  answers_json, recommendation_json, location_json, household_json, logistics_json, readiness_json,
  generated_at, created_at, updated_at
)
VALUES (
  @profileId, @customerId, @sessionId,
  @answersJson, @recommendationJson, @locationJson, @householdJson, @logisticsJson, @readinessJson,
  @generatedAt, @createdAt, @updatedAt
)
ON CONFLICT(session_id) DO UPDATE SET
  customer_id = COALESCE(excluded.customer_id, profiles.customer_id),
  answers_json = excluded.answers_json,
  recommendation_json = excluded.recommendation_json,
  location_json = excluded.location_json,
  household_json = excluded.household_json,
  logistics_json = excluded.logistics_json,
  readiness_json = excluded.readiness_json,
  generated_at = excluded.generated_at,
  updated_at = excluded.updated_at
`);

const linkProfileToCustomerBySessionStmt = db.prepare(`
UPDATE profiles SET customer_id = ?, updated_at = ? WHERE session_id = ?
`);

const insertSnapshotStmt = db.prepare(`
INSERT INTO profile_snapshots (snapshot_id, profile_id, snapshot_type, payload_json, created_at)
VALUES (?, ?, ?, ?, ?)
`);

const insertMagicTokenStmt = db.prepare(`
INSERT INTO magic_link_tokens (token_id, customer_id, email, token_hash, session_id, redirect_path, expires_at, used_at, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)
`);

const getMagicTokenByHashStmt = db.prepare(`
SELECT * FROM magic_link_tokens WHERE token_hash = ?
`);

const markMagicTokenUsedStmt = db.prepare(`
UPDATE magic_link_tokens SET used_at = ? WHERE token_id = ?
`);

const insertAuthSessionStmt = db.prepare(`
INSERT INTO auth_sessions (auth_session_id, customer_id, session_token_hash, expires_at, created_at)
VALUES (?, ?, ?, ?, ?)
`);

const getAuthSessionByHashStmt = db.prepare(`
SELECT * FROM auth_sessions WHERE session_token_hash = ?
`);

const deleteAuthSessionByHashStmt = db.prepare(`DELETE FROM auth_sessions WHERE session_token_hash = ?`);
const deleteExpiredAuthSessionsStmt = db.prepare(`DELETE FROM auth_sessions WHERE expires_at <= ?`);
const deleteExpiredMagicTokensStmt = db.prepare(`DELETE FROM magic_link_tokens WHERE expires_at <= ? AND used_at IS NOT NULL`);

deleteExpiredAuthSessionsStmt.run(nowIso());
deleteExpiredMagicTokensStmt.run(nowIso());

// --- persistence helpers ---
function rowToProfile(row: any): SavedProfile | null {
  if (!row) return null;
  return {
    profileId: String(row.profile_id),
    customerId: row.customer_id ? String(row.customer_id) : null,
    sessionId: String(row.session_id),
    answers: parseJsonObject(row.answers_json),
    recommendation: parseJsonObject(row.recommendation_json),
    location: parseJsonObject(row.location_json),
    household: parseJsonObject(row.household_json),
    logistics: parseJsonObject(row.logistics_json),
    readiness: parseJsonObject(row.readiness_json),
    generatedAt: String(row.generated_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function loadProfileBySessionId(sessionId: string): SavedProfile | null {
  const row = getProfileBySessionIdStmt.get(sessionId);
  return rowToProfile(row);
}

function saveProfile(profile: SavedProfile): SavedProfile {
  const existing = loadProfileBySessionId(profile.sessionId);
  const createdAt = existing?.createdAt || nowIso();
  upsertProfileStmt.run({
    profileId: existing?.profileId || profile.profileId,
    customerId: profile.customerId ?? existing?.customerId ?? null,
    sessionId: profile.sessionId,
    answersJson: JSON.stringify(profile.answers || {}),
    recommendationJson: JSON.stringify(profile.recommendation || {}),
    locationJson: JSON.stringify(profile.location || {}),
    householdJson: JSON.stringify(profile.household || {}),
    logisticsJson: JSON.stringify(profile.logistics || {}),
    readinessJson: JSON.stringify(profile.readiness || {}),
    generatedAt: profile.generatedAt || existing?.generatedAt || nowIso(),
    createdAt,
    updatedAt: profile.updatedAt,
  });

  const saved = loadProfileBySessionId(profile.sessionId);
  if (!saved) {
    throw new Error("Failed to load saved profile");
  }
  return saved;
}

function normaliseProfilePayload(body: AnyRecord): SavedProfile {
  const sessionId = asString(body.sessionId) || makeId("session");
  const existing = loadProfileBySessionId(sessionId);

  return {
    profileId: existing?.profileId || asString(body.profileId) || makeId("profile"),
    customerId: asString(body.customerId) || existing?.customerId || null,
    sessionId,
    answers: (body.answers as AnyRecord) || existing?.answers || {},
    recommendation: (body.recommendation as AnyRecord) || existing?.recommendation || {},
    location: (body.location as AnyRecord) || existing?.location || {},
    household: (body.household as AnyRecord) || existing?.household || {},
    logistics: (body.logistics as AnyRecord) || existing?.logistics || {},
    readiness: (body.readiness as AnyRecord) || existing?.readiness || {},
    generatedAt: asString(body.generatedAt) || existing?.generatedAt || nowIso(),
    createdAt: existing?.createdAt,
    updatedAt: nowIso(),
  };
}

function insertSnapshot(profileId: string, snapshotType: string, payload: unknown): void {
  insertSnapshotStmt.run(makeId("snap"), profileId, snapshotType, JSON.stringify(payload ?? {}), nowIso());
}

function upsertCustomer(email: string, name?: string): { customerId: string; email: string; name?: string } {
  const normalEmail = normaliseEmail(email);
  const existing = getCustomerByEmailStmt.get(normalEmail) as any;
  const customerId = existing?.customer_id ? String(existing.customer_id) : makeId("cust");
  const now = nowIso();
  upsertCustomerStmt.run({
    customerId,
    email: normalEmail,
    name: name || existing?.name || null,
    createdAt: existing?.created_at || now,
    updatedAt: now,
    lastSeenAt: now,
  });
  const customer = getCustomerByEmailStmt.get(normalEmail) as any;
  return {
    customerId: String(customer.customer_id),
    email: String(customer.email),
    name: customer.name ? String(customer.name) : undefined,
  };
}

async function sendMagicLinkEmail(email: string, url: string): Promise<void> {
  if (!resend) {
    console.log("[PREPPED magic link preview]", email, url);
    return;
  }

  await resend.emails.send({
    from: emailFrom,
    to: [email],
    subject: "Your PREPPED secure sign-in link",
    html: `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;line-height:1.5;color:#201B17;">
        <h2 style="margin:0 0 12px;">Your PREPPED secure link</h2>
        <p style="margin:0 0 12px;">Use the button below to reopen your saved plan and continue your preparedness journey.</p>
        <p style="margin:20px 0;">
          <a href="${url}" style="display:inline-block;background:#213A57;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700;">Open my saved PREPPED plan</a>
        </p>
        <p style="margin:0 0 8px;">This link expires in ${magicMinutes} minutes and can only be used once.</p>
        <p style="margin:0;color:#5E564C;font-size:12px;">If you didn’t request this, you can ignore this email.</p>
      </div>
    `,
  });
}

function createMagicLink(email: string, sessionId?: string, redirectPath?: string): { customerId: string; previewUrl: string; expiresAt: string } {
  const customer = upsertCustomer(email);
  const rawToken = randomToken(32);
  const tokenHash = sha256(rawToken);
  const expiresAt = addMinutesIso(magicMinutes);
  insertMagicTokenStmt.run(
    makeId("mlt"),
    customer.customerId,
    customer.email,
    tokenHash,
    sessionId || null,
    redirectPath || "/dashboard",
    expiresAt,
    nowIso(),
  );
  return {
    customerId: customer.customerId,
    previewUrl: buildMagicVerifyUrl(rawToken),
    expiresAt,
  };
}

function getCurrentCustomer(req: express.Request): { customerId: string; email: string; name?: string } | null {
  const rawSessionToken = asString(req.cookies?.[cookieName]);
  if (!rawSessionToken) return null;

  const session = getAuthSessionByHashStmt.get(sha256(rawSessionToken)) as any;
  if (!session) return null;
  if (isIsoExpired(String(session.expires_at))) {
    deleteAuthSessionByHashStmt.run(String(session.session_token_hash));
    return null;
  }

  const customer = getCustomerByIdStmt.get(String(session.customer_id)) as any;
  if (!customer) return null;
  return {
    customerId: String(customer.customer_id),
    email: String(customer.email),
    name: customer.name ? String(customer.name) : undefined,
  };
}

// --- recommendation logic (existing) ---
function buildRecommendation(input: AnyRecord): RecommendationResponse {
  const sessionId = asString(input.sessionId) || makeId("session");
  const answers = (input.answers as AnyRecord) || {};
  const household = (input.household as AnyRecord) || {};
  const logistics = (input.logistics as AnyRecord) || {};
  const readiness = (input.readiness as AnyRecord) || {};

  const priorities = asArray(readiness.priorities || answers.priority);
  const current = asArray(readiness.current || answers.current);
  const accessChips = asArray(logistics.accessChips || answers.access_chips);
  const complexity = asString(readiness.complexity || answers.complexity);
  const budget = asString(readiness.budget || answers.budget);
  const homeType = asString(logistics.housingType || answers.home);

  const adults = asNumber(household.adults || answers.adult_count);
  const babies = asNumber(household.babies || answers.infants_count);
  const toddlers = asNumber(household.toddlers || answers.toddlers_count);
  const children = asNumber(household.children || answers.kids_count);
  const teens = asNumber(household.teens || answers.teens_count);
  const pets = asNumber(household.pets || answers.pets_count);

  const supportLoad =
    asNumber(household.supportAdults || answers.adult_support_count) +
    asNumber(household.supportBabies || answers.infants_support_count) +
    asNumber(household.supportToddlers || answers.toddlers_support_count) +
    asNumber(household.supportChildren || answers.kids_support_count) +
    asNumber(household.supportTeens || answers.teens_support_count) +
    asNumber(household.supportPets || answers.pets_support_count);

  const peopleCount = adults + babies + toddlers + children + teens;
  const weightedPeople = adults + babies * 1.35 + toddlers * 1.2 + children * 1.1 + teens * 1.0;
  const householdWeight = weightedPeople + supportLoad * 0.75 + pets * 0.35;

  let preparationPackQty = clampMin(Math.ceil(householdWeight / 2), 1);
  let homePackQty = 0;
  let carPackQty = 0;

  let mode: RecommendationResponse["scorecard"]["mode"] = "Mobile-first";
  if (["House (older style)", "House (modern)", "Townhouse / new build", "Rural / lifestyle block"].includes(homeType)) {
    mode = peopleCount >= 3 ? "Home-first" : "Hybrid";
  }
  if (homeType === "Apartment") mode = peopleCount >= 3 ? "Hybrid" : "Mobile-first";

  if (mode === "Home-first") {
    homePackQty = preparationPackQty;
    carPackQty = asNumber(logistics.vehicleCount || answers.vehicle_count) > 0 ? 1 : 0;
  } else if (mode === "Hybrid") {
    homePackQty = clampMin(Math.ceil(preparationPackQty * 0.67), 1);
    carPackQty = asNumber(logistics.vehicleCount || answers.vehicle_count) > 0 ? 1 : 0;
  }

  let path: RecommendationResponse["scorecard"]["path"] = "Starter";
  if (babies + toddlers + children + teens + pets >= 2 || supportLoad > 0) path = "Family-led";
  if (priorities.includes("Flooding") || priorities.includes("Power outages") || priorities.includes("Evacuation")) {
    path = path === "Family-led" ? "Family-led" : "Risk-led";
  }

  let confidence: RecommendationResponse["scorecard"]["confidence"] = "Good fit";
  if (priorities.length >= 2 && current.length >= 2 && peopleCount > 0) confidence = "High fit";
  if (peopleCount === 0) confidence = "Needs refinement";

  if (budget === "Just want to start small" || budget === "Start small") {
    preparationPackQty = clampMin(Math.ceil(preparationPackQty * 0.75), 1);
  }

  const modules: SuggestedModule[] = [];
  const addModule = (module: SuggestedModule) => {
    if (!modules.find((m) => m.key === module.key)) modules.push(module);
  };

  if (!current.includes("Some water stored") || priorities.includes("Flooding")) {
    addModule({
      key: "water-security",
      title: "Water Security",
      quantity: peopleCount >= 4 ? 2 : 1,
      reason: "Improves water depth and supports outages or flood disruption.",
      priority: "high",
    });
  }

  if (!current.includes("Torch / lighting") || priorities.includes("Power outages")) {
    addModule({
      key: "power-lighting",
      title: "Power & Lighting",
      quantity: peopleCount >= 5 ? 2 : 1,
      reason: "Supports blackout resilience, charging, and household visibility.",
      priority: "high",
    });
  }

  if (children + babies + toddlers >= 1) {
    addModule({
      key: babies > 0 ? "baby-support" : "family-expansion",
      title: babies > 0 ? "Baby Support" : "Family Expansion",
      quantity: babies > 0 || children >= 3 ? 2 : 1,
      reason: "Extends consumables and comfort items for dependent household members.",
      priority: "high",
    });
  }

  if (pets > 0) {
    addModule({
      key: "pet-care",
      title: "Pet Care",
      quantity: 1,
      reason: "Adds food, handling, and care continuity for pets.",
      priority: "medium",
    });
  }

  if (priorities.includes("Flooding")) {
    addModule({
      key: "flood-protection",
      title: "Flood Protection",
      quantity: 1,
      reason: "Adds waterproofing, document protection, and faster grab-and-go readiness.",
      priority: "high",
    });
  }

  if (priorities.includes("Evacuation") || accessChips.includes("One road in/out")) {
    addModule({
      key: "vehicle-survival",
      title: "Vehicle Survival",
      quantity: 1,
      reason: "Builds continuity if you need to leave home quickly or rely on road transport.",
      priority: "medium",
    });
  }

  if (homeType === "Apartment") {
    addModule({
      key: "urban-apartment",
      title: "Urban / Apartment",
      quantity: 1,
      reason: "Improves compact storage, evacuation practicality, and small-space readiness.",
      priority: "medium",
    });
  }

  if (!current.includes("Some food stored")) {
    addModule({
      key: "cooking-heating",
      title: "Cooking & Heating",
      quantity: peopleCount >= 4 ? 2 : 1,
      reason: "Improves ability to use food, stay warm, and function beyond the initial outage window.",
      priority: "medium",
    });
  }

  const immediateActions: string[] = [
    `Start with ${preparationPackQty} Preparation Pack${preparationPackQty > 1 ? "s" : ""} sized for your household.`,
    modules.length
      ? `Add ${modules.slice(0, 2).map((m) => m.title).join(" + ")} first, as the highest-value next layer.`
      : "Confirm what you already own so the next recommendation can remove duplicates.",
    complexity === "Keep it really simple" || complexity === "Keep it simple"
      ? "Keep the first step tight: baseline pack, one add-on, then review again."
      : "Save your plan so you can come back, refine, and expand in stages.",
  ];

  const whyRecommended: string[] = [];
  if (peopleCount > 0) whyRecommended.push(`You are planning for ${peopleCount} person${peopleCount > 1 ? "s" : ""}.`);
  if (supportLoad > 0) whyRecommended.push("Your support needs increase the value of a more dependable setup.");
  if (priorities.length) whyRecommended.push(`Your current priorities are ${priorities.slice(0, 3).join(", ")}.`);
  if (budget) whyRecommended.push(`Your starting budget mode is “${budget}”.`);
  if (homeType) whyRecommended.push(`Your housing context is “${homeType}”, which affects storage and continuity planning.`);

  const mainMessage =
    path === "Family-led"
      ? "A family-weighted setup is the best fit: start with baseline coverage, then add dependent-specific modules."
      : path === "Risk-led"
        ? "A risk-led setup is the best fit: cover the baseline, then prioritise the hazards most likely to disrupt you."
        : "A starter pathway is the best fit: establish the essentials first, then build depth gradually.";

  return {
    ok: true,
    sessionId,
    scorecard: {
      peopleCount,
      supportLoad,
      householdWeight: Math.round(householdWeight * 100) / 100,
      preparationPackQty,
      homePackQty,
      carPackQty,
      mode,
      path,
      confidence,
    },
    recommendation: {
      mode,
      path,
      confidence,
      preparationPackQty,
      homePackQty,
      carPackQty,
      mainMessage,
      whyRecommended,
      modules: modules.slice(0, 4),
      immediateActions,
      nextStage: preparationPackQty > 1 || modules.length >= 2 ? "Resourcing" : "Preparing",
    },
  };
}

// --- demo address lookup ---
function demoResults(q: string, note?: string) {
  const fallback: AddressResult[] = [
    {
      id: "demo-1",
      fullAddress: `${q} (demo result)`,
      suburb: "Demo suburb",
      city: "Demo city",
      region: "Demo region",
      lat: null,
      lng: null,
    },
  ];

  return {
    results: fallback,
    source: "demo",
    note,
  };
}

async function getLiveAddressResults(q: string, apiKey: string): Promise<AddressResult[] | null> {
  const liveUrl = `https://data.linz.govt.nz/services;key=${encodeURIComponent(apiKey)}/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=layer-123113&outputFormat=application/json&srsName=EPSG:4326&count=8&CQL_FILTER=${encodeURIComponent(`full_address ilike '${q.replace(/'/g, "''") }%'`)}`;
  const response = await fetch(liveUrl, { headers: { Accept: "application/json" } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;

  const rawResults = Array.isArray((data as any)?.features)
    ? (data as any).features
    : Array.isArray((data as any)?.addresses)
      ? (data as any).addresses
      : Array.isArray((data as any)?.results)
        ? (data as any).results
        : [];

  const results: AddressResult[] = rawResults.map((item: any, index: number) => {
    const props = item?.properties ?? item ?? {};
    const coords = Array.isArray(item?.geometry?.coordinates) ? item.geometry.coordinates : null;
    return {
      id: String(props?.address_id || props?.id || `linz-${index}`),
      fullAddress: String(
        props?.full_address ||
          props?.FULL_ADDRESS ||
          [props?.address_number, props?.road_name, props?.suburb_locality, props?.town_city]
            .filter(Boolean)
            .join(", ") ||
          q,
      ),
      suburb: String(props?.suburb_locality || props?.suburb || ""),
      city: String(props?.town_city || props?.city || ""),
      region: String(props?.region || ""),
      lat: coords && typeof coords[1] === "number" ? coords[1] : null,
      lng: coords && typeof coords[0] === "number" ? coords[0] : null,
    };
  });

  return results.length ? results : null;
}

// --- routes ---
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "prepped-backend-phase1", storage: "sqlite" });
});

app.get("/api/address-search", async (req, res) => {
  const q = String(req.query.q || "").trim();
  if (q.length < 3) {
    res.json({ results: [] });
    return;
  }

  const apiKey = process.env.LINZ_API_KEY;
  if (!apiKey || apiKey === "replace_me") {
    res.json(demoResults(q, "Set LINZ_API_KEY in .env to return live address data."));
    return;
  }

  try {
    const results = await getLiveAddressResults(q, apiKey);
    if (!results) {
      res.json(demoResults(q, "Live LINZ lookup failed or returned no results. Using demo results for now."));
      return;
    }
    res.json({ results, source: "linz" });
  } catch (error) {
    console.error("Address lookup failed:", error);
    res.json(demoResults(q, "Live LINZ lookup failed. Falling back to demo results so the prototype remains usable."));
  }
});

app.post("/api/customer-upsert", (req, res) => {
  const email = normaliseEmail(asString(req.body?.email));
  const name = asString(req.body?.name) || undefined;
  if (!email || !email.includes("@")) {
    res.status(400).json({ ok: false, error: "A valid email is required" });
    return;
  }

  const customer = upsertCustomer(email, name);
  res.json({ ok: true, customer });
});

app.post("/api/profile-save", (req, res) => {
  try {
    const body = (req.body || {}) as AnyRecord;
    const sessionId = asString(body.sessionId || body.session_id) || makeId("session");
    const existing = loadProfileBySessionId(sessionId);
    const generatedAt = nowIso();

    const location: AnyRecord = {
      text: asString(body.location_text || body.locationText) || null,
      region: asString(body.location_region || body.locationRegion) || null,
    };

    const household: AnyRecord = {
      adults: asNumber(body.adults),
      children: asNumber(body.children),
      babies: asNumber(body.babies),
      pets: asNumber(body.pets),
    };

    const logistics: AnyRecord = {
      housingType: asString(body.housing_type || body.housingType) || null,
      storageSpace: asString(body.storage_space || body.storageSpace) || null,
      vehicleCount: asNumber(body.vehicle_count || body.vehicleCount),
      vehicleCapacity: asNumber(body.vehicle_capacity || body.vehicleCapacity),
    };

    const readiness: AnyRecord = {
      foodDepth: asString(body.food_depth || body.foodDepth) || null,
      waterDepth: asString(body.water_depth || body.waterDepth) || null,
      blackoutReady: Boolean(body.blackout_ready ?? body.blackoutReady),
      firstAidReady: Boolean(body.first_aid_ready ?? body.firstAidReady),
      documentsReady: Boolean(body.documents_ready ?? body.documentsReady),
    };

    const recommendation = runRecommendation({
      adults: household.adults as number,
      babies: household.babies as number,
      children: household.children as number,
      pets: household.pets as number,
      location_region: location.region as string | undefined,
      housing_type: logistics.housingType as string | undefined,
      vehicle_count: logistics.vehicleCount as number,
      storage_space: logistics.storageSpace as string | undefined,
      food_depth: readiness.foodDepth as string | undefined,
      water_depth: readiness.waterDepth as string | undefined,
      blackout_ready: readiness.blackoutReady as boolean,
      first_aid_ready: readiness.firstAidReady as boolean,
      documents_ready: readiness.documentsReady as boolean,
    }) as unknown as AnyRecord;

    const saved = saveProfile({
      profileId: existing?.profileId || asString(body.profileId || body.profile_id) || makeId("profile"),
      customerId: asString(body.customerId || body.customer_id) || existing?.customerId || null,
      sessionId,
      answers: Object.keys((body.answers as AnyRecord) || {}).length ? (body.answers as AnyRecord) : body,
      recommendation,
      location,
      household,
      logistics,
      readiness,
      generatedAt,
      createdAt: existing?.createdAt,
      updatedAt: generatedAt,
    });

    insertSnapshot(saved.profileId, "profile-save", {
      sessionId,
      location,
      household,
      logistics,
      readiness,
      recommendation,
    });

    res.json({
      ok: true,
      profileId: saved.profileId,
      customerId: saved.customerId ?? null,
      sessionId: saved.sessionId,
      savedAt: saved.updatedAt,
      profile: saved,
    });
  } catch (error) {
    console.error("profile-save failed", error);
    res.status(500).json({ ok: false, error: "Failed to save profile" });
  }
});

app.get("/api/profile-load/:profileId", (req, res) => {
  try {
    const { profileId } = req.params;

    const row = db
      .prepare(
        `
        SELECT *
        FROM profiles
        WHERE profile_id = ?
        LIMIT 1
      `
      )
      .get(profileId) as any;

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "Profile not found",
      });
    }

    const profile = {
      profileId: row.profile_id,
      customerId: row.customer_id,
      sessionId: row.session_id,
      answers: row.answers_json ? JSON.parse(row.answers_json) : {},
      recommendation: row.recommendation_json
        ? JSON.parse(row.recommendation_json)
        : {},
      location: row.location_json ? JSON.parse(row.location_json) : {},
      household: row.household_json ? JSON.parse(row.household_json) : {},
      logistics: row.logistics_json ? JSON.parse(row.logistics_json) : {},
      readiness: row.readiness_json ? JSON.parse(row.readiness_json) : {},
      generatedAt: row.generated_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };

    res.json({
      ok: true,
      profile,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      ok: false,
      error: "Failed to load profile",
    });
  }
});

app.get("/api/profile-load", (req, res) => {
  const sessionId = String(req.query.sessionId || "").trim();
  if (!sessionId) {
    res.status(400).json({ ok: false, error: "sessionId is required" });
    return;
  }

  const profile = loadProfileBySessionId(sessionId);
  if (!profile) {
    res.status(404).json({ ok: false, error: "Profile not found", sessionId });
    return;
  }

  res.json({ ok: true, sessionId, profile, loadedAt: nowIso() });
});

app.post("/api/recommendation-run", (req, res) => {
  try {
    const body = (req.body || {}) as AnyRecord;
    const response = buildRecommendation(body);
    const existing = loadProfileBySessionId(response.sessionId);
    if (existing) {
      const updated = saveProfile({
        ...existing,
        recommendation: response.recommendation as unknown as AnyRecord,
        updatedAt: nowIso(),
      });
      insertSnapshot(updated.profileId, "recommendation", response);
    }
    res.json(response);
  } catch (error) {
    console.error("recommendation-run failed", error);
    res.status(500).json({ ok: false, error: "Failed to build recommendation" });
  }
});

app.post("/api/auth/magic/request", async (req, res) => {
  try {
    const email = normaliseEmail(asString(req.body?.email));
    const sessionId = asString(req.body?.sessionId) || undefined;
    const redirectPath = asString(req.body?.redirectPath) || "/dashboard";

    if (!email || !email.includes("@")) {
      res.status(400).json({ ok: false, error: "A valid email is required" });
      return;
    }

    const magic = createMagicLink(email, sessionId, redirectPath);
    await sendMagicLinkEmail(email, magic.previewUrl);

    if (sessionId) {
      const profile = loadProfileBySessionId(sessionId);
      if (profile) {
        saveProfile({ ...profile, customerId: magic.customerId, updatedAt: nowIso() });
      }
    }

    res.json({
      ok: true,
      email,
      customerId: magic.customerId,
      expiresAt: magic.expiresAt,
      previewUrl: process.env.NODE_ENV === "production" ? undefined : magic.previewUrl,
      message: resend ? "Magic link sent" : "Magic link generated in dev mode. Check previewUrl or backend logs.",
    });
  } catch (error) {
    console.error("magic/request failed", error);
    res.status(500).json({ ok: false, error: "Failed to create magic link" });
  }
});

app.get("/api/auth/magic/verify", (req, res) => {
  try {
    const token = asString(req.query.token);
    if (!token) {
      res.status(400).send("Missing token");
      return;
    }

    const tokenRecord = getMagicTokenByHashStmt.get(sha256(token)) as any;
    if (!tokenRecord) {
      res.status(400).send("This sign-in link is invalid.");
      return;
    }
    if (tokenRecord.used_at) {
      res.status(400).send("This sign-in link has already been used.");
      return;
    }
    if (isIsoExpired(String(tokenRecord.expires_at))) {
      res.status(400).send("This sign-in link has expired.");
      return;
    }

    const rawSessionToken = randomToken(32);
    insertAuthSessionStmt.run(
      makeId("auth"),
      String(tokenRecord.customer_id),
      sha256(rawSessionToken),
      addDaysIso(authDays),
      nowIso(),
    );
    markMagicTokenUsedStmt.run(nowIso(), String(tokenRecord.token_id));

    if (tokenRecord.session_id) {
      linkProfileToCustomerBySessionStmt.run(String(tokenRecord.customer_id), nowIso(), String(tokenRecord.session_id));
    }

    setAuthCookie(res, rawSessionToken);
    const redirectPath = asString(tokenRecord.redirect_path) || "/dashboard";
    res.redirect(`${frontendUrl.replace(/\/$/, "")}${redirectPath}`);
  } catch (error) {
    console.error("magic/verify failed", error);
    res.status(500).send("Could not verify sign-in link.");
  }
});

app.get("/api/auth/me", (req, res) => {
  const customer = getCurrentCustomer(req);
  if (!customer) {
    res.status(401).json({ ok: false, error: "Not signed in" });
    return;
  }

  const profiles = (getProfilesForCustomerStmt.all(customer.customerId) as any[]).map(rowToProfile).filter(Boolean);
  res.json({ ok: true, customer, profiles, loadedAt: nowIso() });
});

app.post("/api/auth/logout", (req, res) => {
  const rawSessionToken = asString(req.cookies?.[cookieName]);
  if (rawSessionToken) {
    deleteAuthSessionByHashStmt.run(sha256(rawSessionToken));
  }
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.listen(port, () => {
  console.log(`PREPPED backend listening on http://localhost:${port}`);
});
