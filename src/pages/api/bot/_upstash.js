import admin from "firebase-admin";

// ── Firebase Firestore KV (replaces Upstash which is read-only) ──

function loadServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (raw) {
    const sa = JSON.parse(raw);
    if (sa.private_key && typeof sa.private_key === "string") {
      sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    return sa;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");
  if (projectId && clientEmail && privateKey) {
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }
  throw new Error("Missing Firebase creds");
}

function getDb() {
  if (!admin.apps.length) {
    const sa = loadServiceAccount();
    admin.initializeApp({
      credential: admin.credential.cert(sa),
      projectId: sa.project_id,
    });
  }
  return admin.firestore();
}

function docId(key) {
  return String(key).replace(/[^a-zA-Z0-9_-]/g, "__");
}

export async function kvGetJson(key) {
  const db = getDb();
  const snap = await db.collection("kv").doc(docId(key)).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return data.value === undefined ? null : data.value;
}

export async function kvSetJson(key, value) {
  const db = getDb();
  await db.collection("kv").doc(docId(key)).set(
    { key, value, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  return true;
}

// ── Auth ──

export function requireUiToken(req) {
  const required = process.env.BOT_UI_TOKEN;
  if (!required) return;
  const got = req.headers["x-bot-token"];
  if (!got || got !== required) {
    const err = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
