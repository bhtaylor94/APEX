import admin from "firebase-admin";

let _inited = false;

function normalizeServiceAccount(sa) {
  // Fix private_key line breaks when stored in env (common in GH secrets)
  if (sa && typeof sa.private_key === "string") {
    sa.private_key = sa.private_key.replace(/\\n/g, "\n");
  }
  return sa;
}

function loadServiceAccount() {
  const raw = String(process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "").trim();
  if (!raw) {
    throw new Error("Missing Firebase creds. Set FIREBASE_SERVICE_ACCOUNT_JSON (raw JSON or base64 JSON).");
  }

  const jsonText = raw.startsWith("{")
    ? raw
    : Buffer.from(raw, "base64").toString("utf8").trim();

  let sa;
  try {
    sa = JSON.parse(jsonText);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON (raw or base64). Parse error: " + (e?.message || e));
  }

  return normalizeServiceAccount(sa);
}

function init() {
  if (_inited) return;

  const sa = loadServiceAccount();

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(sa),
    });
  }

  _inited = true;
}

function col() {
  init();
  // Firestore collection used for KV
  return admin.firestore().collection("kv");
}

export async function kvGetJson(key) {
  const doc = await col().doc(String(key)).get();
  if (!doc.exists) return null;
  const data = doc.data() || {};
  return (data && Object.prototype.hasOwnProperty.call(data, "value")) ? data.value : null;
}

export async function kvSetJson(key, value) {
  await col().doc(String(key)).set({ value }, { merge: false });
  return true;
}
