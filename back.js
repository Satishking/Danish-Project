const fs = require("fs");
const pino = require("pino");
const path = require("path");
const NodeCache = require("node-cache");
const {
  default: makeWASocket,
  Browsers,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  DisconnectReason
} = require("@whiskeysockets/baileys");
const { generateMessageID } = require("@whiskeysockets/baileys");

// -------------------- Console Filter --------------------
const originalConsoleLog = console.log;
const originalStdoutWrite = process.stdout.write;
const originalStderrWrite = process.stderr.write;

function shouldIgnore(message) {
  return (
    message.includes("Closing session: SessionEntry") ||
    message.includes("Decrypted message with closed session.") ||
    message.includes("Removing old closed session: SessionEntry") ||
    message.includes("Session error: Error: Bad MAC") ||
    message.includes("Session error:Error: Bad MAC Error: Bad MAC") ||
    message.includes("Failed to decrypt message with any known session...") ||
    message.includes("Closing stale open session for new outgoing prekey bundle") ||
    message.includes("MessageCounterError: Key used already or never filled") ||
    message.includes("Session error: SessionError: Chain closed") ||
    message.includes("SessionError: Over 2000 messages into the future!") ||
    message.includes("Closing open session in favor of incoming prekey bundle")
  );
}

console.log = (...args) => {
  const message = args.join(" ");
  if (!shouldIgnore(message)) {
    originalConsoleLog(...args);
  }
};

process.stdout.write = (chunk, encoding, callback) => {
  const message = chunk.toString();
  if (!shouldIgnore(message)) {
    return originalStdoutWrite.call(process.stdout, chunk, encoding, callback);
  }
};

process.stderr.write = (chunk, encoding, callback) => {
  const message = chunk.toString();
  if (!shouldIgnore(message)) {
    return originalStderrWrite.call(process.stderr, chunk, encoding, callback);
  }
};

// -------------------- Utils --------------------
const options = {
  timeZone: "Asia/Kolkata",
  hour12: true,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
};
const formatter = new Intl.DateTimeFormat("en-GB", options);

function getCurrentTime() {
  const parts = formatter.formatToParts(new Date());
  const date = `${parts[0].value}-${parts[2].value}-${parts[4].value}`;
  const time = `${parts[6].value}:${parts[8].value}:${parts[10].value} ${parts[12].value}`;
  return { date, time };
}

const delay = (ms) => new Promise((res) => setTimeout(res, ms));
let activeProcesses = {};

console.log("\x1b[1;36m [+] Starting script...\x1b[0m");

// -------------------- Manage Processes --------------------

function manageProcesses() {
    try {
        const inputData = JSON.parse(fs.readFileSync('input.json', 'utf-8'));
        const allProcessIDs = [];
        for (const user of inputData.users || []) {
            for (const convo of user.conversations || []) allProcessIDs.push(convo.process_id);
        }

        for (const processID in activeProcesses) {
            if (!allProcessIDs.includes(processID)) {
                console.log("\x1b[1;31m [X] Stopping process: " + processID + "\x1b[0m");
                activeProcesses[processID].stop = true;
                activeProcesses[processID].connectionClosed = true;
                
                try {
                    if (activeProcesses[processID].instance) {
                        if (activeProcesses[processID].instance.ws) {
                            activeProcesses[processID].instance.ws.close();
                        }
                        if (activeProcesses[processID].instance.ev) {
                            activeProcesses[processID].instance.ev.removeAllListeners();
                        }
                        activeProcesses[processID].instance = null;
                    }
                } catch (err) {
                    console.log("\x1b[1;33m [~] Error closing socket for " + processID + ": " + err.message + "\x1b[0m");
                }
                
                delete activeProcesses[processID];
                console.log("\x1b[1;32m [✓] Process stopped successfully: " + processID + "\x1b[0m");
            }
        }

        for (const user of inputData.users || []) {
            const username = user.username;
            if (!user.approved) continue;

            for (const convo of user.conversations || []) {
                const { process_id, phoneNumber } = convo;
                if (!process_id || !phoneNumber) continue;

                convo.username = username;
                convo.hatersName = convo.hatersName.replace('<process_id>', process_id);
                convo.filePath = convo.filePath.replace('<process_id>', process_id);
                const sessionPath = path.join(__dirname, "data", user.username, process_id, "sessions");
                const credsFilePath = `${sessionPath}/creds.json`;

                // Debugging logs
                if (!fs.existsSync(convo.filePath)) {
                    console.log(`\x1b[1;33m [DEBUG] Missing msg.txt file: ${convo.filePath}\x1b[0m`);
                    continue;
                }
                if (!fs.existsSync(convo.hatersName)) {
                    console.log(`\x1b[1;33m [DEBUG] Missing name.txt file: ${convo.hatersName}\x1b[0m`);
                    continue;
                }
                if (!fs.existsSync(sessionPath)) {
                    console.log(`\x1b[1;33m [DEBUG] Missing sessionPath folder: ${sessionPath}\x1b[0m`);
                    continue;
                }
                if (!fs.existsSync(credsFilePath)) {
                    console.log(`\x1b[1;33m [DEBUG] Missing creds.json file: ${credsFilePath}\x1b[0m`);
                    continue;
                }

                convo.sessionPath = sessionPath;
                if (!activeProcesses[process_id]) {
                    console.log("\x1b[1;32m [✓] Starting new process: " + process_id + "\x1b[0m");
                    activeProcesses[process_id] = { stop: false, lastIndex: 0, connectionClosed: false, abortController: null };
                    startWhatsAppSession(convo);
                    watchRestartMarker(process_id, sessionPath, convo);
                }
            }
        }

    } catch (e) {
        console.error("\x1b[1;31m [X] Failed to load input.json:\x1b[0m", e.message);
    }
}


// -------------------- WhatsApp Session --------------------
async function startWhatsAppSession(user) {
  const { phoneNumber, process_id, username } = user;
  try {
    const sessionPath = user.sessionPath;
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(sessionPath);
    const msgRetryCounterCache = new NodeCache();

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      browser: Browsers.windows("Firefox"),
      markOnlineOnConnect: false,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "fatal" }))
      },
      msgRetryCounterCache
    });

    activeProcesses[process_id].instance = sock;

    sock.ev.on("connection.update", async (s) => {
      const { connection, lastDisconnect } = s;
      if (connection === "open") {
        console.log("\x1b[1;32m ✅ Login successful for:", process_id, "\x1b[0m");
        startMessageLoop(sock, user);
      } else if (connection === "close") {
        if (activeProcesses[process_id]?.stop || activeProcesses[process_id]?.connectionClosed) {
          console.log("\x1b[1;33m [~] Process " + process_id + " was stopped, skipping reconnect\x1b[0m");
          return;
        }
        
        const reason = lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode;
        if (reason === DisconnectReason.loggedOut) {
          console.log("\x1b[1;31m [X] Logged out from WhatsApp. QR scan needed for:", process_id, "\x1b[0m");
        } else {
          console.log("\x1b[1;31m ❌ Connection closed for:", process_id, "\x1b[0m");
          console.log("\x1b[1;33m [~] Reason:", lastDisconnect?.error?.message || lastDisconnect?.error, "\x1b[0m");
          
          if (!activeProcesses[process_id]?.stop) {
            console.log("\x1b[1;34m [~] Reconnecting in 5 seconds for:", process_id, "\x1b[0m");
            setTimeout(() => {
              if (!activeProcesses[process_id]?.stop && activeProcesses[process_id]) {
                startWhatsAppSession(user);
              }
            }, 5000);
          }
        }
      }
    });

    sock.ev.on("creds.update", saveCreds);
  } catch (err) {
    console.error("\x1b[1;31m [X] Error in startWhatsAppSession for:", process_id, "->", err.message, "\x1b[0m");
  }
}

// -------------------- Message Loop --------------------
async function startMessageLoop(sock, user) {
  const { process_id, phoneNumber, haterID, isGroup, filePath, delayTime, hatersName } = user;
  console.log("\x1b[1;36m 📤 Starting message loop from index:", activeProcesses[process_id].lastIndex, "\x1b[0m");

  const recipientID = isGroup ? `${haterID}@g.us` : `${haterID.replace(/[^0-9]/g, "")}@s.whatsapp.net`;

  try {
    if (!activeProcesses[process_id] || activeProcesses[process_id]?.stop) {
      console.log("\x1b[1;33m 🛑 Process stopped before message loop started.\x1b[0m");
      return;
    }
    
    const messages = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
    for (let i = activeProcesses[process_id]?.lastIndex || 0; i < messages.length; i++) {
      if (!activeProcesses[process_id] || activeProcesses[process_id]?.stop) {
        console.log("\x1b[1;33m 🛑 Message loop aborted for: " + process_id + "\x1b[0m");
        return;
      }

      const hatersNameRaw = fs.readFileSync(hatersName, "utf-8");
      const finalMessage = `${hatersNameRaw} ${messages[i]}`;

      try {
        await sock.sendMessage(recipientID, { text: finalMessage }, { messageId: generateMessageID() });
        const { date, time } = getCurrentTime();
        console.log(`\x1b[1;32m [✓] [ ${phoneNumber} ] → [ ${haterID} ] Message sent || Date: ${date} Time: ${time}\x1b[0m`);
      } catch {
        const { date, time } = getCurrentTime();
        console.log(`\x1b[1;31m [X] [ ${phoneNumber} ] → [ ${haterID} ] Message failed || Date: ${date} Time: ${time}\x1b[0m`);
      }

      activeProcesses[process_id].lastIndex = i + 1;
      await delay(delayTime * 1000);
    }

    // restart loop
    if (!activeProcesses[process_id] || activeProcesses[process_id]?.stop) {
      console.log("\x1b[1;33m 🛑 Process stopped, not restarting loop for: " + process_id + "\x1b[0m");
      return;
    }
    
    console.log("\x1b[1;32m ✅ All messages sent. Restarting loop in 1 minute...\x1b[0m");
    setTimeout(() => {
      if (activeProcesses[process_id] && !activeProcesses[process_id]?.stop) {
        activeProcesses[process_id].lastIndex = 0;
        startMessageLoop(sock, user);
      }
    }, 60000);
  } catch (e) {
    console.error("\x1b[1;31m [X] Error in startMessageLoop (" + process_id + "):\x1b[0m", e.message);
  }
}

// -------------------- Watch input.json --------------------
fs.watchFile("input.json", () => {
  console.log("\x1b[1;36m [+] Detected input.json change, updating processes...\x1b[0m");
  manageProcesses();
});

// -------------------- Watch restart marker for each process (manual creds update) --------------------
function watchRestartMarker(processId, sessionPath, user) {
  const markerPath = path.join(sessionPath, "restart.marker");
  
  fs.watchFile(markerPath, { interval: 2000 }, () => {
    if (!activeProcesses[processId] || activeProcesses[processId]?.stop) {
      fs.unwatchFile(markerPath);
      return;
    }
    
    // Check if marker file exists
    if (!fs.existsSync(markerPath)) return;
    
    console.log(`\x1b[1;36m [+] Manual creds update detected for ${processId}, restarting session...\x1b[0m`);
    
    // Delete marker file
    try {
      fs.unlinkSync(markerPath);
    } catch (err) {}
    
    // Stop current session
    activeProcesses[processId].stop = true;
    activeProcesses[processId].connectionClosed = true;
    
    try {
      if (activeProcesses[processId].instance) {
        if (activeProcesses[processId].instance.ws) {
          activeProcesses[processId].instance.ws.close();
        }
        if (activeProcesses[processId].instance.ev) {
          activeProcesses[processId].instance.ev.removeAllListeners();
        }
        activeProcesses[processId].instance = null;
      }
    } catch (err) {
      console.log("\x1b[1;33m [~] Error closing socket: " + err.message + "\x1b[0m");
    }
    
    // Restart with new creds after short delay
    setTimeout(() => {
      const credsPath = path.join(sessionPath, "creds.json");
      if (fs.existsSync(credsPath)) {
        console.log(`\x1b[1;32m [✓] Restarting process with new creds: ${processId}\x1b[0m`);
        activeProcesses[processId] = { stop: false, lastIndex: 0, connectionClosed: false };
        startWhatsAppSession(user);
      }
    }, 2000);
  });
}

// -------------------- Start --------------------
manageProcesses();
