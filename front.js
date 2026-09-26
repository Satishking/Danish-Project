// Express + Node.js replica of provided Flask backend
const express = require("express");
const { spawn } = require("child_process");
const session = require("express-session");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const uuid = require("uuid").v4;
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const DATA_FILE = "input.json";
const DATA_FOLDER = "data";
const MIN_PASSWORD_LENGTH = 8;
const SESSION_SECRET = process.env.SESSION_SECRET || "local-development-session-secret";

// Middleware
app.use(express.static("static"));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax" }
}));
const upload = multer();

if (!fs.existsSync(DATA_FILE)) {
  fs.writeFileSync(DATA_FILE, JSON.stringify({ users: [] }, null, 4));
}
if (!fs.existsSync(DATA_FOLDER)) {
  fs.mkdirSync(DATA_FOLDER);
}

const loadData = () => JSON.parse(fs.readFileSync(DATA_FILE));
const saveData = (data) => fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 4));

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(":")) return false;
  const [salt, hash] = storedHash.split(":");
  const expected = Buffer.from(hash, "hex");
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length > 0 &&
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual);
};

// Existing imported accounts did not have passwords. Give them a temporary
// username-as-password credential and force a password change after login.
const migrateUsersToPasswordAuth = () => {
  const data = loadData();
  let changed = false;
  for (const user of data.users || []) {
    if (!user.passwordHash) {
      user.passwordHash = hashPassword(user.username);
      user.mustChangePassword = true;
      changed = true;
    }
  }
  if (changed) saveData(data);
};

migrateUsersToPasswordAuth();

// A migrated account may only use the password-change page until its
// temporary password has been replaced.
app.use((req, res, next) => {
  const username = req.session.username;
  const allowedPaths = ["/", "/register", "/change-password", "/logout"];
  if (username && !allowedPaths.includes(req.path)) {
    const user = loadData().users.find((candidate) => candidate.username === username);
    if (user?.mustChangePassword) {
      if (req.path.startsWith("/api/")) {
        return res.status(403).json({ error: "Password change required" });
      }
      return res.redirect("/change-password");
    }
  }
  next();
});

// Routes
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "approved.html"));
});

app.post("/", upload.none(), (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const data = loadData();
  const user = data.users.find((u) => u.username === username);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    return res.status(401).send("Invalid username or password. <a href=\"/\">Back to login</a>");
  }

  if (!user.approved) {
    res.sendFile(path.join(__dirname, "templates", "not_approved.html"));
    return;
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).send("Could not start a secure session.");
    req.session.username = username;
    res.redirect(user.mustChangePassword ? "/change-password" : "/dashboard");
  });
});

app.get("/register", (req, res) => {
  res.sendFile(path.join(__dirname, "templates", "register.html"));
});

app.post("/register", upload.none(), (req, res) => {
  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (!/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
    return res.status(400).send("Username must be 3-32 characters and use only letters, numbers, or underscore.");
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).send(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== confirmPassword) {
    return res.status(400).send("Passwords do not match.");
  }

  const data = loadData();
  if (data.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
    return res.status(409).send("Username already exists. <a href=\"/\">Back to login</a>");
  }

  data.users.push({
    username,
    passwordHash: hashPassword(password),
    mustChangePassword: false,
    approved: false,
    admin: false,
    owner: false,
    conversations: []
  });
  saveData(data);
  res.sendFile(path.join(__dirname, "templates", "not_approved.html"));
});

app.get("/change-password", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  res.sendFile(path.join(__dirname, "templates", "change_password.html"));
});

app.post("/change-password", upload.none(), (req, res) => {
  if (!req.session.username) return res.redirect("/");
  const password = String(req.body.password || "");
  const confirmPassword = String(req.body.confirmPassword || "");

  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).send(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password !== confirmPassword) {
    return res.status(400).send("Passwords do not match.");
  }

  const data = loadData();
  const user = data.users.find((candidate) => candidate.username === req.session.username);
  if (!user) return req.session.destroy(() => res.redirect("/"));

  user.passwordHash = hashPassword(password);
  user.mustChangePassword = false;
  saveData(data);
  res.redirect("/dashboard");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

app.get("/dashboard", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  res.sendFile(path.join(__dirname, "templates", "dashboard.html"));
});

app.get("/admin", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  const data = loadData();
  const user = data.users.find(u => u.username === req.session.username);
  if (!user || !user.admin) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "templates", "admin.html"));
});

app.get("/start", (req, res) => {
  if (!req.session.username) return res.redirect("/");
  res.sendFile(path.join(__dirname, "templates", "start.html"));
});

app.post("/start", upload.fields([{ name: "tokens" }, { name: "messages" }]), (req, res) => {
  const username = req.session.username;
  if (!username) return res.redirect("/");

  try {
    const data = loadData();
    const rawPhone = req.body.convo_id;
    const rawHaterID = req.body.haterID;
    const haterName = req.body.hater_name;
    const delayInput = req.body.delay;
    const isGroup = (req.body.isGroup || "false").toLowerCase() === "true";

    // Validate required fields
    if (!rawPhone || !rawHaterID || !haterName || !delayInput) {
      return res.status(400).send("Missing required fields");
    }

    const phoneNumber = rawPhone.replace(/\D/g, "");
    const haterID = rawHaterID.replace(/\D/g, "");
    const delayTime = parseInt(delayInput);

    // Validate phone number length
    if (phoneNumber.length < 10) {
      return res.status(400).send("Invalid phone number. Must be at least 10 digits.");
    }

    // Validate hater ID
    if (haterID.length < 10) {
      return res.status(400).send("Invalid target ID. Must be at least 10 digits.");
    }

    // Validate delay
    if (isNaN(delayTime) || delayTime < 1) {
      return res.status(400).send("Delay must be at least 1 second.");
    }

    // Check if user exists
    const user = data.users.find((u) => u.username === username);
    if (!user) return res.status(400).send("User not found");

    const tokens = req.files["tokens"]?.[0];
    const messages = req.files["messages"]?.[0];

    // Validate files
    if (!tokens || !messages) {
      return res.status(400).send("Please upload both credentials and messages files.");
    }

    // Validate message file size
    if (messages.size > 100 * 1024) {
      return res.status(400).send("Message file size should be 100KB or less.");
    }

    // Validate credentials file is valid JSON
    try {
      JSON.parse(tokens.buffer.toString());
    } catch (e) {
      return res.status(400).send("Invalid credentials file. Must be valid JSON.");
    }

    const process_id = `${phoneNumber}_${uuid().slice(0, 6)}`;
    const folderPath = path.join(DATA_FOLDER, username, process_id);

    try {
      fs.mkdirSync(folderPath, { recursive: true });

      const credsPath = path.join(folderPath, "sessions", "creds.json");
      const msgPath = path.join(folderPath, "msg.txt");
      const namePath = path.join(folderPath, "name.txt");

      fs.mkdirSync(path.dirname(credsPath), { recursive: true });
      fs.writeFileSync(credsPath, tokens.buffer);
      fs.writeFileSync(msgPath, messages.buffer);
      fs.writeFileSync(namePath, haterName);

      const newEntry = {
        process_id,
        phoneNumber,
        haterID,
        isGroup,
        hatersName: namePath,
        filePath: msgPath,
        delayTime: delayTime,
        startTime: new Date().toISOString()
      };

      user.conversations = user.conversations || [];
      user.conversations.push(newEntry);
      saveData(data);

      console.log(`✅ Process started: ${process_id} by ${username}`);
      res.send(`Process started successfully! Process ID: ${process_id}`);
    } catch (fileErr) {
      // Clean up folder if file operations fail
      try {
        if (fs.existsSync(folderPath)) {
          fs.rmSync(folderPath, { recursive: true, force: true });
        }
      } catch (cleanupErr) {
        console.error("Cleanup error:", cleanupErr.message);
      }
      console.error("File operation error:", fileErr.message);
      return res.status(500).send("Server error while creating process files.");
    }
  } catch (err) {
    console.error("Start error:", err.message);
    return res.status(500).send("Server error. Please try again.");
  }
});

app.get("/stop", (req, res) => {
    if (!req.session.username) return res.redirect("/");
    res.redirect("/process-status");
});

app.post("/stop_process", upload.none(), (req, res) => {
    if (!req.session.username) return res.redirect("/");
    
    const data = loadData();
    const username = req.session.username;
    const processId = req.body.process_id;

    if (!processId) {
        return res.redirect("/stop");
    }

    const user = data.users.find(u => u.username === username);
    if (!user) return res.redirect("/");

    const conversations = user.conversations || [];
    const updatedConvos = conversations.filter(c => c.process_id !== processId);

    if (updatedConvos.length === conversations.length) {
        return res.redirect("/stop");
    }

    const folderPath = path.join(DATA_FOLDER, username, processId);

    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`🗑️ Deleted folder: ${folderPath}`);
        }
    } catch (err) {
        console.error(`❌ Error deleting folder ${folderPath}:`, err.message);
    }

    user.conversations = updatedConvos;
    saveData(data);

    res.redirect("/process-status");
});

// Calculate uptime helper
const calculateUptime = (startTime) => {
    if (!startTime) return "Unknown";
    const start = new Date(startTime);
    const now = new Date();
    const diff = Math.floor((now - start) / 1000);
    
    const days = Math.floor(diff / 86400);
    const hours = Math.floor((diff % 86400) / 3600);
    const minutes = Math.floor((diff % 3600) / 60);
    const seconds = diff % 60;
    
    if (days > 0) return `${days}d ${hours}h ${minutes}m ${seconds}s`;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
};

// Extract only letters from username (remove numbers and symbols)
const getDisplayName = (username) => {
    return username.replace(/[^a-zA-Z]/g, '');
};

app.get("/api/status", (req, res) => {
    if (!req.session.username) return res.status(401).json({ error: "Unauthorized" });
    const data = loadData();
    const user = data.users.find(u => u.username === req.session.username);
    if (!user) return res.status(404).json({ error: "User not found" });
    
    // Include username in each conversation object for the UI
    const conversations = (user.conversations || []).map(conv => ({
        ...conv,
        username: user.username.replace(/[^a-zA-Z]/g, '')
    }));
    
    res.json(conversations);
});

app.post("/api/stop/:process_id", (req, res) => {
    if (!req.session.username) return res.status(401).json({ error: "Unauthorized" });
    const data = loadData();
    const username = req.session.username;
    const processId = req.params.process_id;
    const user = data.users.find(u => u.username === username);
    if (!user) return res.status(404).json({ error: "User not found" });

    const conversations = user.conversations || [];
    const updatedConvos = conversations.filter(c => c.process_id !== processId);
    
    if (updatedConvos.length === conversations.length) {
        return res.status(404).json({ error: "Process not found" });
    }

    const folderPath = path.join(DATA_FOLDER, username, processId);
    try {
        if (fs.existsSync(folderPath)) {
            fs.rmSync(folderPath, { recursive: true, force: true });
        }
    } catch (err) {
        console.error(`❌ Error deleting folder ${folderPath}:`, err.message);
    }

    user.conversations = updatedConvos;
    saveData(data);
    res.json({ success: true });
});

app.get("/process-status", (req, res) => {
    if (!req.session.username) return res.redirect("/");
    res.sendFile(path.join(__dirname, "templates", "process_status.html"));
});

app.post("/monitor", upload.none(), (req, res) => {
    if (!req.session.username) return res.redirect("/");
    res.send("Monitor feature coming soon!");
});

app.get("/monitor/:process_id", (req, res) => {
    if (!req.session.username) return res.redirect("/");
    res.sendFile(path.join(__dirname, "templates", "coming_soon.html"));
});

// Admin API Routes
const isAdmin = (req) => {
    if (!req.session.username) return false;
    const data = loadData();
    const user = data.users.find(u => u.username === req.session.username);
    return user && (user.admin || user.owner);
};

const getCurrentUser = (req, data = loadData()) => {
    if (!req.session.username) return null;
    return data.users.find(u => u.username === req.session.username) || null;
};

const canManageTarget = (req, target, data) => {
    const actor = getCurrentUser(req, data);
    if (!actor || (!actor.admin && !actor.owner)) return false;
    // Keep the single owner account immutable so the project cannot be orphaned.
    return target.owner !== true;
};

const adminUserView = (user) => ({
    username: user.username,
    approved: Boolean(user.approved),
    admin: Boolean(user.admin),
    owner: Boolean(user.owner),
    mustChangePassword: Boolean(user.mustChangePassword)
});

app.get("/api/admin/users", (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const data = loadData();
    res.json({ success: true, users: data.users.map(adminUserView) });
});

app.post("/api/admin/add-user", upload.none(), (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const username = String(req.body.username || "").trim();
    const password = String(req.body.password || "");
    
    if (!username || username.trim().length === 0) {
        return res.status(400).json({ success: false, message: "Username is required" });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return res.status(400).json({ success: false, message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }
    
    const data = loadData();
    
    if (data.users.find(u => u.username === username)) {
        return res.status(400).json({ success: false, message: "User already exists" });
    }
    
    data.users.push({
        username: username,
        passwordHash: hashPassword(password),
        mustChangePassword: true,
        approved: false,
        admin: false,
        owner: false,
        conversations: []
    });
    
    saveData(data);
    res.json({ success: true, message: "User added successfully" });
});

app.post("/api/admin/delete-user", upload.none(), (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, message: "Username is required" });
    }
    
    const data = loadData();
    const target = data.users.find(u => u.username === username);

    if (!target) {
        return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!canManageTarget(req, target, data)) {
        return res.status(403).json({ success: false, message: "Only the owner can manage the owner account" });
    }

    data.users = data.users.filter(u => u.username !== username);
    
    saveData(data);
    res.json({ success: true, message: "User deleted successfully" });
});

app.post("/api/admin/toggle-approval", upload.none(), (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, message: "Username is required" });
    }
    
    const data = loadData();
    const user = data.users.find(u => u.username === username);
    
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!canManageTarget(req, user, data)) {
        return res.status(403).json({ success: false, message: "Only the owner can manage the owner account" });
    }
    
    user.approved = !user.approved;
    saveData(data);
    res.json({ success: true, message: "Approval status updated", approved: user.approved });
});

app.post("/api/admin/toggle-admin", upload.none(), (req, res) => {
    if (!isAdmin(req)) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    
    const { username } = req.body;
    
    if (!username) {
        return res.status(400).json({ success: false, message: "Username is required" });
    }
    
    const data = loadData();
    const user = data.users.find(u => u.username === username);
    
    if (!user) {
        return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!canManageTarget(req, user, data)) {
        return res.status(403).json({ success: false, message: "Only the owner can manage the owner account" });
    }
    
    user.admin = !user.admin;
    saveData(data);
    res.json({ success: true, message: "Admin status updated", admin: user.admin });
});


app.post("/update", upload.single("tokens"), (req, res) => {
  const username = req.session.username;
  if (!username) return res.redirect("/");

  try {
    const process_id = req.body.process_id;
    const newToken = req.file;

    // Validate required fields
    if (!process_id) {
      return res.status(400).send("Please provide a process ID.");
    }

    if (!newToken) {
      return res.status(400).send("Please upload a credentials file.");
    }

    // Validate credentials file is valid JSON
    try {
      JSON.parse(newToken.buffer.toString());
    } catch (e) {
      return res.status(400).send("Invalid credentials file. Must be valid JSON.");
    }

    const data = loadData();
    const user = data.users.find((u) => u.username === username);
    if (!user) return res.status(400).send("User not found.");

    const convo = (user.conversations || []).find(c => c.process_id === process_id);
    if (!convo) return res.status(400).send("Invalid process ID. Please check and try again.");

    const credsPath = path.join(DATA_FOLDER, username, process_id, "sessions", "creds.json");

    // Delete old creds if exists
    if (fs.existsSync(credsPath)) {
      fs.unlinkSync(credsPath);
    }

    // Ensure folder exists
    fs.mkdirSync(path.dirname(credsPath), { recursive: true });

    // Save new creds immediately
    fs.writeFileSync(credsPath, newToken.buffer);
    console.log(`✅ New creds.json saved for ${username}/${process_id}`);

    // Create restart marker to trigger session restart in back.js
    const markerPath = path.join(DATA_FOLDER, username, process_id, "sessions", "restart.marker");
    fs.writeFileSync(markerPath, Date.now().toString());
    console.log(`✅ Restart marker created for ${username}/${process_id}`);

    res.send("Token updated successfully! The process will use the new credentials.");
  } catch (err) {
    console.error("Update error:", err.message);
    res.status(500).send("Server error while updating token. Please try again.");
  }
});


app.listen(PORT, "0.0.0.0", () => console.log(`Server running on http://0.0.0.0:${PORT}`));
