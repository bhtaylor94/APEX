import admin from "firebase-admin";

function loadServiceAccount() {
  // Preferred: FIREBASE_SERVICE_ACCOUNT_JSON as a JSON string (GitHub Secret friendly)
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || "";
  if (raw) {
    const sa = JSON.parse(raw);
    // normalize private_key newlines if needed
    if (sa.private_key && typeof sa.private_key === "string") {
      sa.private_key = sa.private_key.replace(/\\n/g, "\n");
    }
    return sa;
  }

  // Alternate: individual env vars
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (privateKey) privateKey = privateKey.replace(/\\n/g, "\n");

  if (projectId && clientEmail && privateKey) {
    return { project_id: projectId, client_email: clientEmail, private_key: privateKey };
  }

  throw new Error("Missing Firebase creds. Set FIREBASE_SERVICE_ACCOUNT_JSON (recommended) or FIREBASE_PROJECT_ID/CLIENT_EMAIL/PRIVATE_KEY.");
}

function init() {
  if (admin.apps.length) return admin.firestore();

  const sa = loadServiceAccount();
  admin.initializeApp({
    credential: admin.credential.cert(sa),
    projectId: sa.project_id,
  });

  return admin.firestore();
}

function docForKey(key) {
  // store keys as documents under collection "kv"
  // bot:position => doc id "bot__position" (Firestore doc ids can't contain '/')
  const safeId = String(key).replace(/[^a-zA-Z0-9_-]/g, "__");
  return { col: "kv", id: safeId, key };
}

export async function kvGetJson(key) {
  const db = init();
  const ref = docForKey(key);
  const snap = await db.collection(ref.col).doc(ref.id).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return (data.value === undefined) ? null : data.value;
}

export async function kvSetJson(key, value) {
  const db = init();
  const ref = docForKey(key);
  await db.collection(ref.col).doc(ref.id).set({
    key: ref.key,
    value,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { ok: true };
}
