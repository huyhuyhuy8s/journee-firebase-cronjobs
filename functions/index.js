const admin = require("firebase-admin");
const jwt = require("jsonwebtoken");
const {defineString, defineSecret} = require("firebase-functions/params");
const {onSchedule} = require("firebase-functions/v2/scheduler");
const {onCall, HttpsError} = require("firebase-functions/v2/https");
const {onDocumentCreated} = require("firebase-functions/firestore");

if (process.env.FUNCTIONS_EMULATOR === "true") {
  require("dotenv").config();
}

admin.initializeApp();
const db = admin.firestore();
const BACKEND_URL_PARAM = defineString("BACKEND_URL");
const JWT_SECRET_SECRET = defineSecret("BACKEND_JWT_SECRET"); // must match backend

const getBackendUrl = () => BACKEND_URL_PARAM.value() || process.env.BACKEND_URL || "https://journee-1gt3.onrender.com";
const getJwtSecret = () => JWT_SECRET_SECRET.value() || process.env.JWT_SECRET || "";

const getDateInTimezone = (timezone = "Asia/Ho_Chi_Minh") => {
  const date = new Date();
  return new Intl.DateTimeFormat("en-CA", {timeZone: timezone}).format(date);
};

// Scheduled function - runs every day at midnight (local TZ)
exports.createDailyJournals = onSchedule(
  {schedule: "0 0 * * *", timeZone: "Asia/Ho_Chi_Minh", secrets: [JWT_SECRET_SECRET]},
  async (_) => {
    try {
      const today = getDateInTimezone("Asia/Ho_Chi_Minh");
      console.log(`Creating daily journals for ${today}`);

      // Get all active users
      const usersSnapshot = (await db.collection("users").where("isActive", "==", true).get());
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
        const token = jwt.sign({userId}, getJwtSecret(), {expiresIn: "1d"});

        // Call backend to create a journal to respect auth and controller logic
        try {
          const res = await fetch(`${getBackendUrl()}/api/journals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({name}),
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

exports.onUserCreated = onDocumentCreated(
  {
    document: "users/{userId}",
    secrets: [JWT_SECRET_SECRET],
  },
  async (event) => {
    const userId = event.params.userId;
    const userData = event.data.data();

    if (!userData) {
      console.log("No new user data found:", userId);
      return;
    }

    try {
      const date = getDateInTimezone();
      const journalName = `Daily ${date}`;

      const existingQuery = await db
        .collection("journals")
        .where("userId", "==", userId)
        .where("name", "==", journalName)
        .limit(1)
        .get();

      if (!existingQuery.empty) {
        console.log(`User ${userId} already has a journal named ${journalName}. Skipping creation.`);
        return;
      }

      if (!getJwtSecret()) {
        console.error("Missing JWT_SECRET in functions environment. Skipping API calls.");
        return;
      }

      const token = jwt.sign({userId}, getJwtSecret(), {expiresIn: "1h"});

      const response = await fetch(`${getBackendUrl()}/api/journals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({name: journalName}),
      });

      if (!response.ok) {
        console.error(`Failed to create journal for ${userId}: ${response.status} ${await response.text()}`);
        return;
      }

      const result = await response.json();
      console.log(`Created journal ${result.id} for user ${userId}`);
    } catch (error) {
      console.error(`Error creating journals for user ${userId}:`, error);
    }
  },
);

exports.createJournalForUser = onCall(
  async (request) => {
    // Check authentication
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const userId = request.auth.uid;
    const date = request.data.date || getDateInTimezone();
    const customName = request.data.name;

    try {
      // Use custom name if provided, otherwise use a default format
      const journalName = customName || `Daily ${date}`;

      // Idempotency check - check Firestore first
      const existingQuery = await db
        .collection("journals")
        .where("userId", "==", userId)
        .where("name", "==", journalName)
        .limit(1)
        .get();

      if (!existingQuery.empty) {
        const existingDoc = existingQuery.docs[0];
        return {
          success: true,
          message: "Journal already exists",
          journalId: existingDoc.id,
          journal: {
            id: existingDoc.id,
            ...existingDoc.data(),
          },
        };
      }

      // Call backend API to create a journal
      if (!getJwtSecret()) {
        console.log("Error 412: Server missing JWT secret");
        return;
      }

      const token = jwt.sign({userId}, getJwtSecret(), {expiresIn: "1h"});

      const response = await fetch(`${getBackendUrl()}/api/journals`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({name: journalName}),
      });

      if (!response.ok) {
        const text = await response.text();
        console.log("Error 500:", `Backend error: ${response.status} ${text}`);
        return;
      }

      const result = await response.json();
      const journal = result.results.journal;

      if (!journal) {
        console.log("Error 500: Backend returned invalid response");
        return;
      }

      return {
        success: true,
        message: "Journal created successfully",
        journalId: journal.id,
        journal: journal,
      };
    } catch (error) {
      console.error("Error creating journal:", error);

      if (error instanceof HttpsError) {
        throw error;
      }

      throw new HttpsError(
        "internal",
        `Failed to create journal: ${error.message}`,
      );
    }
  },
);

exports.createMissingJournals = onCall(
  {timeoutSeconds: 540}, // 9 minutes for a long-running task
  async (request) => {
    // Only allow admin users to run this
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    // Check if a user has admin privileges
    const userDoc = await db.collection("users").doc(request.auth.uid).get();
    const isAdmin = userDoc.data().role === "admin" || userDoc.data().role === "Nintendo7131";

    if (!isAdmin) {
      throw new HttpsError(
        "permission-denied",
        "Only admins can run this function",
      );
    }

    try {
      const date = getDateInTimezone();
      const journalName = `Daily ${date}`;

      if (!getJwtSecret()) {
        console.log("Error 412: Server missing JWT secret");
        return;
      }

      // Get all users
      const usersSnapshot = await db.collection("users").get();
      const users = usersSnapshot.docs;

      const results = {
        total: users.length,
        created: 0,
        skipped: 0,
        errors: 0,
        details: [],
      };

      // Process each user
      for (const userDoc of users) {
        const userId = userDoc.id;

        try {
          // Check if the user already has a journal
          const existingQuery = await db
            .collection("journals")
            .where("userId", "==", userId)
            .limit(1)
            .get();

          if (!existingQuery.empty) {
            results.skipped++;
            results.details.push({
              userId,
              status: "skipped",
              reason: "Journal already exists",
            });
            continue;
          }

          // Create a journal via backend API
          const token = jwt.sign({userId}, getJwtSecret(), {expiresIn: "1h"});

          const response = await fetch(`${getBackendUrl()}/api/journals`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${token}`,
            },
            body: JSON.stringify({name: journalName}),
          });

          if (!response.ok) {
            const text = await response.text();
            console.log("Error 500:", `Backend error: ${response.status} ${text}`);
            return;
          }

          const result = await response.json();
          const journalId = result.results.journal.id;

          results.created++;
          results.details.push({
            userId,
            status: "created",
            journalId,
          });

          console.log(`Created journal ${journalId} for user ${userId}`);
        } catch (error) {
          results.errors++;
          results.details.push({
            userId,
            status: "error",
            error: error.message,
          });
          console.error(`Error processing user ${userId}:`, error);
        }
      }

      return {
        success: true,
        message: `Processed ${results.total} users`,
        results,
      };
    } catch (error) {
      console.error("Error in bulk journal creation:", error);
      throw new HttpsError(
        "internal",
        `Failed to create journals: ${error.message}`,
      );
    }
  },
);

exports.checkUserJournal = onCall(
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "User must be authenticated");
    }

    const userId = request.auth.uid;

    try {
      const journalsSnapshot = await db
        .collection("journals")
        .where("userId", "==", userId)
        .limit(1)
        .get();

      const hasJournal = !journalsSnapshot.empty;
      const journalDoc = hasJournal ? journalsSnapshot.docs[0] : null;

      return {
        success: true,
        hasJournal,
        journalId: journalDoc ? journalDoc.id : null,
        journal: journalDoc ? {
          id: journalDoc.id,
          ...journalDoc.data(),
        } : null,
      };
    } catch (error) {
      console.error("Error checking user journal:", error);
      throw new HttpsError(
        "internal",
        `Failed to check journal: ${error.message}`,
      );
    }
  },
);
