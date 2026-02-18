const http = require("http");
const crypto = require("crypto");
require("dotenv").config();
const { setReportLock } = require("./reportLockState");

/**
 * Send heartbeat to Mega Server
 */
function sendHeartbeat() {
  try {
    if (!process.env.MEGA_URL) {
      console.error("❌ MEGA_URL not set");
      return;
    }

    const url = new URL(process.env.MEGA_URL);
    const timestamp = Date.now().toString();

    const signature = crypto
      .createHmac("sha256", process.env.MEGA_API_KEY)
      .update(process.env.SCHOOL_CODE + timestamp)
      .digest("hex");

    const options = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-SCHOOL-ID": process.env.SCHOOL_CODE,
        "X-TIMESTAMP": timestamp,
        "X-SIGNATURE": signature,
      },
    };

    const req = http.request(options, res => {
      let body = "";

      res.on("data", chunk => (body += chunk));
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          console.log("🛰 Mega response:", data);
        
             setReportLock(
            data.lock_reports === true,
              data.lock_reason
);

          // 🔒 ENFORCE LOCK FROM MEGA SERVER
          if (data.locked === true) {
            global.SYSTEM_LOCKED = true;
            global.SYSTEM_LOCK_REASON =
              data.lock_reason || "System locked by Mega Server";

            console.log("🔒 SYSTEM LOCKED BY MEGA SERVER");
          } else {
            global.SYSTEM_LOCKED = false;
            console.log("🔓 SYSTEM UNLOCKED");
          }

        } catch (err) {
          console.error("❌ Invalid Mega response:", body);
        }
      });
    });

    req.on("error", err => {
      console.error("⚠️ Mega server unreachable:", err.message);
    });

    req.end();

  } catch (err) {
    console.error("Heartbeat error:", err.message);
  }
}

module.exports = { sendHeartbeat };

// Debug (safe)
console.log("MEGA_URL =", process.env.MEGA_URL);
