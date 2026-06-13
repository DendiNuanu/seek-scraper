import "dotenv/config";
import express from "express";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHECKPOINT_PATH =
  process.env.SCRAPE_CHECKPOINT || path.join(__dirname, "scrape-checkpoint.json");

const app = express();
const PORT = 3000;

// ── State ────────────────────────────────────────────────────────────────────
let isRunning = false;
let clients = []; // active SSE response objects

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Broadcast an SSE event to all connected clients */
function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

/** Send SSE event to a single client */
function sendEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Spawn an npm script, stream stdout/stderr as SSE log lines,
 * and resolve/reject when the process exits.
 */
function runScript(scriptName, label) {
  return new Promise((resolve, reject) => {
    broadcast("status", { phase: scriptName, label });

    const child = spawn("npm", ["run", scriptName], {
      cwd: __dirname,
      shell: true,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      broadcast("log", { text, stream: "stdout" });
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      broadcast("log", { text, stream: "stderr" });
    });

    child.on("error", (err) => {
      broadcast("log", {
        text: `[server] Failed to spawn "${scriptName}": ${err.message}\n`,
        stream: "stderr",
      });
      reject(err);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`"${scriptName}" exited with code ${code}`));
      }
    });
  });
}

// ── GET /api/summary ─────────────────────────────────────────────────────────
app.get("/api/summary", (_req, res) => {
  try {
    const raw = fs.readFileSync(CHECKPOINT_PATH, "utf-8");
    const data = JSON.parse(raw);
    const candidates = data.candidates || [];
    const total = candidates.length;
    const enriched = candidates.filter((c) => c.email && c.email.trim() !== "").length;
    res.json({ total, enriched });
  } catch (err) {
    res.status(500).json({ error: `Failed to read checkpoint: ${err.message}` });
  }
});

// ── GET /api/run (SSE) ───────────────────────────────────────────────────────
app.get("/api/run", (req, res) => {
  if (isRunning) {
    res.status(409).json({ error: "busy", message: "A run is already in progress." });
    return;
  }

  // SSE headers
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  clients.push(res);

  // Remove client on disconnect
  req.on("close", () => {
    clients = clients.filter((c) => c !== res);
  });

  // Start the pipeline
  isRunning = true;

  (async () => {
    try {
      // Phase 1: turbo-list
      sendEvent(res, "status", { phase: "turbo-list", label: "Running: Fetching list..." });
      await runScript("turbo-list", "Running: Fetching list...");

      // Phase 2: turbo-enrich
      sendEvent(res, "status", { phase: "turbo-enrich", label: "Running: Enriching profiles..." });
      await runScript("turbo-enrich", "Running: Enriching profiles...");

      // Done
      const completionTime = new Date();
      const witaTime = new Date(completionTime.getTime() + 8 * 60 * 60 * 1000)
        .toISOString()
        .replace("T", " ")
        .substring(0, 19)
        .replace(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/, "WITA $4:$5");

      sendEvent(res, "status", { phase: "done", label: "Done ✅", completionWita: witaTime });
      broadcast("done", { completionWita: witaTime });
    } catch (err) {
      sendEvent(res, "status", { phase: "error", label: `Error ❌`, error: err.message });
      broadcast("error", { error: err.message });
    } finally {
      isRunning = false;
    }
  })();
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🌐 UI server running at http://localhost:${PORT}`);
});