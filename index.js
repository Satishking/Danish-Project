const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");
const schedule = require("node-schedule");

const MANUAL_CONTROL_FILE = "./restart.txt";
const DATA_FOLDER = "./data";

let processes = [];
let restartTimer = null;
let restartReason = null;
let lastRestartTime = 0;
const MIN_RESTART_INTERVAL = 3 * 60 * 1000; // 3 minutes
let isErrorRestart = false;

// 🔁 Start/Restart front.js and back.js
function startProcesses() {
    processes.forEach(proc => proc.kill());

    processes = [
        spawn("node", ["back.js"], { stdio: "inherit" }),
        spawn("node", ["front.js"], { stdio: "inherit" }),
    ];

    console.log(`✅ Restarted front.js, back.js due to: ${restartReason || "unknown"}`);

    processes.forEach((proc, index) => {
        proc.on("exit", code => {
            console.log(`❌ Process ${index + 1} exited with code ${code}`);
            if (code !== 0 && code !== null) {
                debounceRestart(`Process ${index + 1} crashed (exit code: ${code})`, true);
            }
        });
    });

    isErrorRestart = false; // reset after restart
}

// ⏳ Debounced Restart with 3-minute Cooldown (bypass if forced)
function debounceRestart(reason = "", force = false) {
    const now = Date.now();

    if (!force && now - lastRestartTime < MIN_RESTART_INTERVAL) {
        console.log(`⏳ Restart blocked (cooldown). Last restart was less than 3 minutes ago.`);
        return;
    }

    restartReason = reason;
    if (restartTimer) clearTimeout(restartTimer);

    console.log(`🕒 Restart scheduled in 5s due to: ${reason} ${force ? "(forced bypass)" : ""}`);

    restartTimer = setTimeout(() => {
        lastRestartTime = Date.now();
        startProcesses();
        restartTimer = null;
        restartReason = null;
    }, 5000);
}

// 🔘 Manual Restart Trigger
function triggerManualRestart() {
    console.log("🔁 Manual restart triggered...");
    fs.writeFileSync(MANUAL_CONTROL_FILE, "off");
    debounceRestart("Manual restart via restart.txt", true);
}

// ✅ Check restart.txt ON/OFF
function isManualRestartEnabled() {
    if (!fs.existsSync(MANUAL_CONTROL_FILE)) {
        fs.writeFileSync(MANUAL_CONTROL_FILE, "off");
        return false;
    }
    const content = fs.readFileSync(MANUAL_CONTROL_FILE, "utf-8").trim().toLowerCase();
    return content === "on";
}

// ⏰ Restart every hour at 30th minute (but skip if error restart pending)
schedule.scheduleJob("30 * * * *", () => {
    if (isErrorRestart) {
        console.log("⚠️ Skipping scheduled restart due to recent error-triggered restart.");
        return;
    }
    console.log("⏰ Hourly scheduled restart at 30th minute.");
    debounceRestart("Scheduled hourly restart at 30th minute");
});

// 👀 Init
startProcesses();

// 👀 Watch restart.txt
fs.watchFile(MANUAL_CONTROL_FILE, () => {
    if (isManualRestartEnabled()) {
        triggerManualRestart();
    } else {
        console.log("📕 Manual restart is OFF");
    }
});

// 👀 Watch folder deletions
function watchProcessFolders() {
    const watcher = chokidar.watch(DATA_FOLDER, {
        ignoreInitial: true,
        depth: 2,
        awaitWriteFinish: true
    });

    watcher.on("unlinkDir", folderPath => {
        const parts = folderPath.split(path.sep);
        const len = parts.length;

        if (len >= 3 && parts[len - 3] === "data") {
            const username = parts[len - 2];
            const processId = parts[len - 1];
            console.log(`🗑️ Process folder deleted: ${username}/${processId}`);
            debounceRestart(`process_id folder deleted (${username}/${processId})`, true);
        }
    });
}

watchProcessFolders();

// 🛡️ Global crash handlers
process.on('uncaughtException', err => {
    console.error("❌ Uncaught Exception:", err.message);
    isErrorRestart = true;
    debounceRestart("Uncaught Exception", true);
});

process.on('unhandledRejection', reason => {
    console.error("❌ Unhandled Rejection:", reason);
    isErrorRestart = true;
    debounceRestart("Unhandled Promise Rejection", true);
});
