import crypto from "crypto";

// Firebase Firestore REST API — zero npm dependencies beyond Node built-ins.
// Replaces firebase-admin SDK which failed to install on GitHub Actions.

function loadServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON");
  const jsonText = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8").trim();
  const sa = JSON.parse(jsonText);
  if (sa && typeof sa.private_key === "string") {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  return sa;
}

let _cachedToken = null;
let _tokenExpiry = 0;
let _projectId = null;

async function getAccessToken() {
  if (_cachedToken && Date.now() < _tokenExpiry) return _cachedToken;

  const sa = loadServiceAccount();
  _projectId = sa.project_id;
  const now = Math.floor(Date.now() / 1000);

  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/datastore",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  })).toString("base64url");

  const signInput = header + "." + payload;
  const signature = crypto.sign("sha256", Buffer.from(signInput), { key: sa.private_key });
  const jwt = signInput + "." + signature.toString("base64url");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=" + jwt,
  });

  const data = await res.json();
  if (!res.ok) throw new Error("OAuth2 token error: " + JSON.stringify(data));

  _cachedToken = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _cachedToken;
}

function docUrl(key) {
  return `https://firestore.googleapis.com/v1/projects/${_projectId}/databases/(default)/documents/kv/${encodeURIComponent(String(key))}`;
}

// ── Firestore value format converters ──

function parseFirestoreValue(fv) {
  if (!fv) return null;
  if ("nullValue" in fv) return null;
  if ("booleanValue" in fv) return fv.booleanValue;
  if ("integerValue" in fv) return Number(fv.integerValue);
  if ("doubleValue" in fv) return fv.doubleValue;
  if ("stringValue" in fv) return fv.stringValue;
  if ("timestampValue" in fv) return fv.timestampValue;
  if ("mapValue" in fv) {
    const obj = {};
    for (const [k, v] of Object.entries(fv.mapValue.fields || {})) {
      obj[k] = parseFirestoreValue(v);
    }
    return obj;
  }
  if ("arrayValue" in fv) {
    return (fv.arrayValue.values || []).map(parseFirestoreValue);
  }
  return null;
}

function toFirestoreValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === "boolean") return { booleanValue: val };
  if (typeof val === "number") {
    if (Number.isInteger(val)) return { integerValue: String(val) };
    return { doubleValue: val };
  }
  if (typeof val === "string") return { stringValue: val };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toFirestoreValue) } };
  }
  if (typeof val === "object") {
    const fields = {};
    for (const [k, v] of Object.entries(val)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

// ── Public API ──

export async function kvGetJson(key) {
  const token = await getAccessToken();
  const res = await fetch(docUrl(key), {
    headers: { Authorization: "Bearer " + token },
  });

  if (res.status === 404) return null;
  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Firestore GET " + key + " failed (" + res.status + "): " + txt);
  }

  const doc = await res.json();
  return parseFirestoreValue(doc.fields?.value);
}

export async function kvSetJson(key, value) {
  const token = await getAccessToken();
  const res = await fetch(docUrl(key), {
    method: "PATCH",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: { value: toFirestoreValue(value) },
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error("Firestore SET " + key + " failed (" + res.status + "): " + txt);
  }
  return true;
}
