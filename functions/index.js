const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
// Load local env in emulator/dev; production uses Functions Params/Secrets
require("dotenv").config();
const { defineString, defineSecret } = require("firebase-functions/params");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onCall, HttpsError } = require("firebase-functions/v2/https");

admin.initializeApp();
const db = admin.firestore();
const BACKEND_URL_PARAM = defineString("BACKEND_URL");
const JWT_SECRET_SECRET = defineSecret("BACKEND_JWT_SECRET"); // must match backend

// Helper getters to support both dotenv (emulator/dev) and params/secrets (prod)
const getBackendUrl = () => BACKEND_URL_PARAM.value() || process.env.BACKEND_URL || "https://journee-1gt3.onrender.com";
const getJwtSecret = () => JWT_SECRET_SECRET.value() || process.env.JWT_SECRET || "";

// Scheduled function - runs every day at midnight (local TZ)
exports.createDailyJournals = onSchedule(
    { schedule: "0 0 * * *", timeZone: "Asia/Ho_Chi_Minh", secrets: [JWT_SECRET_SECRET] },
    async (event) => {
      try {
        const today = new Date().toISOString().split("T")[0];
        console.log(`Creating daily journals for ${today}`);

        // Get all active users
        const usersSnapshot = await db.collection("users").get();
        let created = 0;
        let skipped = 0;
        let failed = 0;

        if (!getJwtSecret()) {
          console.error("Missing JWT_SECRET in functions environment. Skipping API calls.");
          return null;
        }

        // Process users sequentially to avoid API rate limits
        for (const userDoc of usersSnapshot.docs) {
          const userId = userDoc.id;

          // Idempotency check: does a journal with today's name already exist?
          const name = `Daily ${today}`;
          const existingQuery = await db.collection("journals")
              .where("userId", "==", userId)
              .where("name", "==", name)
              .limit(1)
              .get();

          if (!existingQuery.empty) {
            skipped++;
            continue;
          }

          // Generate backend JWT for this user
          const token = jwt.sign({ userId }, getJwtSecret(), { expiresIn: "1d" });

          // Call backend to create journal to respect auth and controller logic
          try {
            const res = await fetch(`${getBackendUrl()}/api/journals`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`,
              },
              body: JSON.stringify({ name }),
            });

            if (res.ok) {
              created++;
            } else if (res.status === 409) {
            // conflict (if backend enforces uniqueness later)
              skipped++;
            } else {
              const text = await res.text();
              console.error(`Failed to create journal for ${userId}: ${res.status} ${text}`);
              failed++;
            }
          } catch (err) {
            console.error(`Error calling backend for ${userId}:`, err);
            failed++;
          }
        }

        console.log(
            `D-Journals: created=${created}, skipped=${skipped}, failed=${failed} for ${today}`,
        );

        return null;
      } catch (error) {
        console.error("Error creating daily journals:", error);
        return null;
      }
    },
);

// Manual trigger function (for testing or manual creation)
exports.createJournalForUser = onCall({ secrets: [JWT_SECRET_SECRET] }, async (request) => {
  // Check if user is authenticated
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "User must be authenticated");
  }

  const userId = request.auth.uid;
  const date = (request.data && request.data.date) ||
    new Date().toISOString().split("T")[0];

  try {
    if (!getJwtSecret()) {
      throw new HttpsError("failed-precondition", "Server missing JWT secret");
    }

    const name = `Daily ${date}`;
    // Idempotency check using Firestore
    const existingQuery = await db.collection("journals")
        .where("userId", "==", userId)
        .where("name", "==", name)
        .limit(1)
        .get();

    if (!existingQuery.empty) {
      return {
        success: true,
        message: "Journal already exists",
        journalId: existingQuery.docs[0].id,
      };
    }

    // Generate backend JWT and call API
    const token = jwt.sign({ userId }, getJwtSecret(), { expiresIn: "1h" });
    const res = await fetch(`${getBackendUrl()}/api/journals`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
      body: JSON.stringify({ name }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new HttpsError("internal", `Backend error: ${res.status} ${text}`);
    }

    const json = await res.json();
    return {
      success: true,
      message: "Journal created",
      journalId: json.journal && json.journal.id,
    };
  } catch (error) {
    console.error("Error creating journal:", error);
    throw new HttpsError("internal", "Failed to create journal");
  }
});
