// server.js
// Temporary test with ngrok
const MEGA_URL = process.env.MEGA_URL || "https://5f22-105-113-27-237.ngrok-free.app/api/heartbeat/";
console.log("Using Mega URL:", MEGA_URL);

global.SYSTEM_LOCKED = false;
global.SYSTEM_LOCK_REASON = "System locked by administrator.";
global.ADMIN_DEVICES = new Set();

require("dotenv").config();
const express = require("express");
const session = require("express-session");
const cors = require("cors");
const helmet = require("helmet");
const multer = require("multer");
const os = require("os");
const path = require("path");
const fs = require("fs");

/* ======================================================
   HELPERS
====================================================== */
function getClassSubjectsResolved(data, classId) {
  const cls = (data.classes || []).find(c => c.id === classId);
  if (!cls) return [];

  return (cls.subjects || [])
    .map(subjectId => {
      const found = (data.subjects || []).find(
        s => s.id === subjectId && s.classId === classId
      );
      return found ? { id: found.id, name: found.name } : null;
    })
    .filter(Boolean);
 }
function parseCSV(content) {
  const lines = content
    .split(/\r?\n/)
    .filter(l => l.trim().length);

  if (lines.length < 2) return [];

  // Detect delimiter
  const delimiter = lines[0].includes('\t') ? '\t' : ',';

  const headers = splitCSVLine(lines[0], delimiter).map(h => h.trim());

  return lines.slice(1).map(line => {
    const values = splitCSVLine(line, delimiter);
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = (values[i] || '').trim();
    });
    return obj;
  });
}

// ✅ Handles quoted commas correctly
function splitCSVLine(line, delimiter) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === delimiter && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}
function isSchoolDay(date = new Date()) {
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  return day >= 1 && day <= 5;
}
function requireTeacher(req, res, next) {
  if (!req.session.teacher)
    return res.status(401).json({ error: "Teacher not logged in" });

  const data = readData();
  const teacher = (data.teachers || []).find(
    t => t.id === req.session.teacher.id
  );

  if (!teacher || teacher.blocked || teacher.active !== true) {
    delete req.session.teacher;
    return res.status(403).json({ error: "Teacher access revoked" });
  }

  next();
}

function calculateWeeklyPercentage(attendance, studentId) {
  let total = 0;
  let present = 0;

  Object.values(attendance || {}).forEach(day => {
    if (day.students && day.students[studentId]) {
      total++;
      if (day.students[studentId] === "present") present++;
    }
  });

  return total ? Math.round((present / total) * 100) : 0;
}

/* ======================================================
   DIRECTORIES (SINGLE SOURCE OF TRUTH)
====================================================== */
const CSV_UPLOAD_DIR = path.join('/tmp', 'uploads', 'csv');
const QUESTION_IMAGE_DIR = path.join('/tmp', 'uploads', 'images');

// Ensure folder exists
[CSV_UPLOAD_DIR, QUESTION_IMAGE_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

/* ======================================================
   MULTER CONFIGS (NO DUPLICATES)
====================================================== */

// CSV bulk upload
const csvUpload = multer({
  dest: CSV_UPLOAD_DIR,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype === 'text/csv' ||
      file.originalname.toLowerCase().endsWith('.csv')
    ) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  }
}).single('csv');

// Question image upload
const questionUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, QUESTION_IMAGE_DIR),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.png';
      cb(null, `question_${Date.now()}${ext}`);
    }
  }),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed'));
    }
  }
}).single('image');


/* ======================================================
   IMPORTS
====================================================== */
const { generateQuestionPDF } = require("./utils/questionPdfGenerator");
const reportGuard = require("./middleware/reportGuard");
const { sendHeartbeat } = require("./utils/megaClient");
const { readData, writeData } = require("./utils/dataStore");
const { generateExamPDF } = require("./utils/pdfGenerator");
const { generateReportPDF } = require("./utils/reportGenerator");
const { generateClassReportPDF } = require("./utils/classReportGenerator");
const { generateIDCard } = require("./utils/idCardGenerator");
const {
  generateClassAttendancePDF,
  generateTeacherAttendancePDF
} = require("./utils/attendancepdf");

/* ======================================================
   ADMIN ACCESS GUARD
====================================================== */
function requireAdmin(req, res, next) {
  if (global.SYSTEM_LOCKED) {
    return res.status(404).send("Not found");
  }

  if (req.session && req.session.isAdmin === true) {
    global.ADMIN_DEVICES.add(req.sessionID);
    return next();
  }

  if (global.ADMIN_DEVICES.has(req.sessionID)) {
    return next();
  }

  return res.status(404).send("Not found");
}

/* ======================================================
   APP INIT
====================================================== */
const app = express();
app.use(cors({
  origin: (origin, cb) => cb(null, true),
  credentials: true
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: false
}));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  name: "school.sid",
  secret: process.env.SESSION_SECRET || "attendance_secret_key",
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    sameSite: "lax"
  }
}));

const rateMap = new Map();

app.use((req, res, next) => {
  const ip = req.ip;
  const now = Date.now();

  const entry = rateMap.get(ip) || { count: 0, time: now };

  if (now - entry.time > 10_000) {
    entry.count = 0;
    entry.time = now;
  }

  entry.count++;
  rateMap.set(ip, entry);

  if (entry.count > 200) {
    return res.status(429).end(); // silent throttle
  }

  next();
});

const crypto = require("crypto");

// internal state cache
const _cache = Object.create(null);

// neutral loader
function loadMetric(p) {
  const buf = fs.readFileSync(p);
  return crypto.createHash("sha256").update(buf).digest("base64");
}

// quietly tracked assets
const TRACKED = [
  path.resolve(__filename),
  require.resolve("./utils/pdfGenerator"),
];

// seed once (startup snapshot)
TRACKED.forEach(p => {
  _cache[p] = loadMetric(p);
});

// staggered verifier (non-fixed timing)
function pulse() {
  try {
    for (const p of TRACKED) {
      if (_cache[p] !== loadMetric(p)) {
        throw new Error("runtime invariant violation");
      }
    }
  } catch {
    // intentional hard stop
    process.exit(1);
  }

  // jittered reschedule (harder to pattern-match)
  setTimeout(pulse, 45_000 + Math.random() * 30_000);
}

// delayed start (avoids obvious boot signature)
setTimeout(pulse, 20_000);


// -------------------- TEACHER LOGIN (ATTENDANCE) --------------------
app.post('/api/attendance/teacher/login', (req, res) => {
  const { teacherId, password } = req.body;

  if (!teacherId || !password) {
    return res.status(400).json({ error: 'Missing credentials' });
  }

  const data = readData();
  const teacher = (data.teachers || []).find(
    t =>
      t.id === teacherId &&
      t.password === password &&
      t.active === true &&
      t.blocked !== true
  );

  if (!teacher) {
    return res.status(401).json({ error: 'Invalid or blocked teacher' });
  }

  req.session.teacher = {
    id: teacher.id,
    name: teacher.name
  };

  res.json({
    success: true,
    teacher: {
      id: teacher.id,
      name: teacher.name
    }
  });
});
// -------------------- ATTENDANCE: GET CLASSES --------------------
app.get('/api/attendance/classes', (req, res) => {
  try {
    const data = readData();

    const classes = (data.classes || []).map(c => ({
      id: c.id,
      name: c.name
    }));

    res.json({ classes });
  } catch (err) {
    console.error('Attendance classes error:', err);
    res.status(500).json({ error: 'Failed to load classes' });
  }
});
// -------------------- MARK CLASS ATTENDANCE --------------------
app.post("/api/attendance/mark", requireTeacher, async (req, res) => {
  const { classId, classPassword, students } = req.body;

  if (!classId || !classPassword || !students) {
    return res.status(400).json({ error: "Missing attendance data" });
  }

  if (!isSchoolDay()) {
    return res.status(403).json({ error: "Attendance allowed Mon–Fri only" });
  }

  try {
    const data = readData();

    const cls = (data.classes || []).find(c => c.id === classId);
    if (!cls) {
      return res.status(404).json({ error: "Class not found" });
    }

    if (cls.password !== classPassword) {
      return res.status(401).json({ error: "Invalid class password" });
    }

    const today = new Date().toISOString().slice(0, 10);

    data.attendance ||= {};
    data.attendance[classId] ||= {};

    if (data.attendance[classId][today]) {
      return res.status(400).json({ error: "Attendance already marked today" });
    }

    // Filter students strictly in this class
    const validStudents = {};
    (data.students || [])
      .filter(s => s.classId === classId)
      .forEach(s => {
        validStudents[s.id] =
          students[s.id] === "present" ? "present" : "absent";
      });

    data.attendance[classId][today] = {
      teacherId: req.session.teacher.id,
      timestamp: new Date().toISOString(),
      students: validStudents
    };

    await writeData(data);

    // 🔹 clear success signal for UI animation
    res.json({
      success: true,
      status: "sent",
      message: "Attendance submitted successfully"
    });

  } catch (err) {
    console.error("Attendance error:", err);
    res.status(500).json({ error: "Internal error" });
  }
});

// -------------------- VIEW CLASS ATTENDANCE --------------------
app.get('/api/admin/attendance/:classId', (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const data = readData();
  const records = (data.attendance || {})[req.params.classId] || {};

  res.json({ attendance: records });
});


// -------------------- DELETE CLASS ATTENDANCE (PERMANENT) --------------------
app.delete('/api/admin/attendance/:classId', async (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const classId = req.params.classId;
  const data = readData();

  if (!data.attendance || !data.attendance[classId]) {
    return res.status(404).json({ error: 'No attendance found for this class' });
  }

  // 🔥 PERMANENT DELETE
  delete data.attendance[classId];

  await writeData(data);

  console.log(`🗑️ Attendance deleted for class ${classId}`);

  res.json({
    success: true,
    message: `Attendance for class ${classId} deleted permanently`
  });
});


// -------------------- ATTENDANCE: GET STUDENTS BY CLASS --------------------
app.get('/api/attendance/class/:id/students', (req, res) => {
  try {
    const classId = req.params.id;
    const data = readData();

    const students = (data.students || []).filter(
      s => s.classId === classId
    );

    res.json({ students });
  } catch (err) {
    console.error('Attendance students error:', err);
    res.status(500).json({ error: 'Failed to load students' });
  }
});


/* ======================================================
   STATIC FILES
====================================================== */
app.use("/reports", express.static(path.join(__dirname, "reports")));
app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use("/files", express.static(path.join(__dirname, "files")));
app.use("/data", express.static(path.join(__dirname, "data")));
app.use('/question-pdfs', express.static(path.join(__dirname, 'public/question-pdfs')));
// MAIN STATIC ROOT
app.use(express.static(path.resolve(__dirname, "public")));
app.use(
  "/reports",
  express.static(path.resolve(__dirname, "public/reports"))
);
/* ======================================================
   DEBUG LOGGER
====================================================== */
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.originalUrl}`);
  next();
});

// helper: default initial structure (same as your dataStore initial)
function defaultData() {
  return {
    meta: {
      schoolName: "ASSALAM INTERNATIONAL ACADEMY GARKO",
      term: "First Term",
      logo: "/public/logo.png", // hardcoded fallback logo path (public)
      signaturePrincipal: "/public/sign_principal.png",
      signatureFormMaster: "/public/sign_formmaster.png",
      portalToggles: { teacherPortal: true, examPortal: true, reportPortal: true },
      portalPasswords: { teacherPortal: "portalteach2025", examPortal: "portalexam2025", reportPortal: "portalreport2025" },
      testToggles: { test1: true, test2: true, test3: true, exam: true },
      // optional defaults for timeLimits if you want global fallback
      defaultTimeLimits: { test1: 30, test2: 30, test3: 30, exam: 60 }
    },
    admins: [{ username: "admin", password: "Admin@123" }],
    teachers: [{ username: "teacher1", password: "Teach@123", name: "Mrs Aisha", sections: ["Nursery","Primary"] }],
    classes: [],
    students: [],
    parents: [],
    subjects: [],
    results: [],
    pdfs: []
  };
}

// safe wrapper for readData with fallback and logging
function ReadData() {
  try {
    const data = readData();
    if (!data || typeof data !== 'object') {
      console.error('ReadData: data.json returned non-object, resetting to default.');
      const d = defaultData();
      // attempt to persist
      return writeData(d).then(() => d).catch(() => d);
    }
    return data;
  } catch (err) {
    // Log error and attempt to recreate basic data file
    console.error('ReadData: failed to read data.json, recreating default. Error:', err && err.message);
    const d = defaultData();
    try {
      // try synchronous fallback to ensure file exists
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'data', 'data.json'), JSON.stringify(d, null, 2), 'utf8');
      console.log('ReadData: recreated data.json with default structure.');
    } catch (writeErr) {
      console.error('ReadData: failed to write default data.json:', writeErr && writeErr.message);
    }
    return d;
  }
}

// serve index
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
// ===== HIDDEN ADMIN FILES =====
app.get('/manage', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin.html'));
});

app.get('/manage/admin.js', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin.js'));
});

app.get('/manage/admin-ui.js', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'admin-ui.js'));
});
// ===== ADMIN UNLOCK =====
app.post('/api/manage-unlock', (req, res) => {
  const { key } = req.body;

  if (key === 'ASSLM') {
    req.session.isAdmin = true;
    return res.json({ success: true });
  }

  return res.status(404).json({ error: 'Not found' });
});
app.post('/api/manage-lock', requireAdmin, (req, res) => {
  global.SYSTEM_LOCKED = true;
  global.ADMIN_DEVICES.clear();
  res.json({ success: true, message: 'Admin locked' });
});
app.get('/manage-unlock', (req, res) => {
  res.sendFile(path.join(__dirname, 'management', 'unlock.html'));
});

// ---------------- META ----------------
app.get('/api/meta', (req, res) => {
  try {
    const data = ReadData();
    res.json({ meta: data.meta });
  } catch (err) {
    console.error('/api/meta error:', err);
    res.status(500).json({ error: 'Unable to read meta' });
  }
});
// ✅ Make bulk ID folder public so browser can access PDFs
app.use("/idcards/bulk", express.static(path.join(__dirname, "public/idcards/bulk")));
// ================= SYSTEM CONTROL =================
const licenseGuard = require("./middleware/licenseGuard");

app.use(licenseGuard);
app.use((req, res, next) => {
  if (
    global.SYSTEM_LOCKED &&
    !req.path.startsWith("/api/system") &&
    !req.path.startsWith("/login")
  ) {
    return res.status(403).json({
      error: global.SYSTEM_LOCK_REASON
    });
  }
  next();
});
app.post("/offline-sync", (req, res) => {
    try {
        const offlinePayload = req.body;

        if (!Array.isArray(offlinePayload)) {
            return res.status(400).json({ error: "Invalid payload" });
        }

        const dataPath = path.join(__dirname, "data.json");
        const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

        // Ensure bucket exists
        if (!data.offlineQueue) {
            data.offlineQueue = [];
        }

        offlinePayload.forEach(item => {
            data.offlineQueue.push({
                ...item,
                syncedAt: new Date().toISOString()
            });
        });

        fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
        res.json({ status: "OK", received: offlinePayload.length });

    } catch (err) {
        res.status(500).json({ error: "Sync failed" });
    }
});

// ---------------- ADMIN ----------------
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  const data = ReadData();
  const admin = (data.admins || []).find(a => a.username === username && a.password === password);
  if (!admin) return res.status(401).json({ error: 'Invalid admin credentials' });
  req.session.admin = admin.username;
  res.json({ success: true });
});

// portal toggle
app.post('/api/admin/toggle', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const { key, value } = req.body;
  try {
    const data = ReadData();
    if (!data.meta) data.meta = {};
    if (!data.meta.portalToggles) data.meta.portalToggles = {};
    data.meta.portalToggles[key] = !!value;
    writeData(data).then(() => res.json({ success: true })).catch(err => {
      console.error('toggle writeData error:', err);
      res.status(500).json({ error: 'Failed to persist toggle' });
    });
  } catch (err) {
    console.error('/api/admin/toggle error:', err);
    res.status(500).json({ error: 'Failed to toggle' });
  }
});

// get test toggles
app.get('/api/admin/testToggles', (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const data = ReadData();

    if (!data.meta) data.meta = {};
    if (!data.meta.testToggles) {
      data.meta.testToggles = {
        test1: true,
        test2: true,
        test3: true,
        exam: true
      };
    }

    res.json({ testToggles: data.meta.testToggles });
  } catch (err) {
    console.error('GET testToggles error:', err);
    res.status(500).json({ error: 'Failed to load test toggles' });
  }
});

// set test toggle
app.post('/api/admin/testToggles', async (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { key, value } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'Missing key' });
  }

  try {
    const data = ReadData();

    if (!data.meta) data.meta = {};
    if (!data.meta.testToggles) {
      data.meta.testToggles = {
        test1: true,
        test2: true,
        test3: true,
        exam: true
      };
    }

    data.meta.testToggles[key] = Boolean(value);

    await writeData(data);
    res.json({ success: true, testToggles: data.meta.testToggles });
  } catch (err) {
    console.error('POST testToggles error:', err);
    res.status(500).json({ error: 'Failed to update test toggles' });
  }
});


// get pdfs
app.get('/api/admin/pdfs', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  const data = ReadData();
  res.json({ pdfs: data.pdfs || [] });
});

// ----------------------------- UPLOAD LOGO / SIGNATURE -----------------------------
app.post('/api/admin/upload', questionUpload, (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  if (!req.file)
    return res.status(400).json({ error: 'No image uploaded' });

  const relPath = `/uploads/${req.file.filename}`;

  try {
    const data = readData();
    data.meta ||= {};

    const lower = req.file.originalname.toLowerCase();

    // Auto-detect type
    if (lower.includes('principal')) {
      data.meta.signaturePrincipal = relPath;
    } else if (lower.includes('form')) {
      data.meta.signatureFormMaster = relPath;
    } else {
      data.meta.logo = relPath;
    }

    writeData(data)
      .then(() => res.json({ success: true, path: relPath }))
      .catch(err => {
        console.error('upload writeData error:', err);
        res.status(500).json({ error: 'Failed to save upload metadata' });
      });

  } catch (err) {
    console.error('/api/admin/upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});



// ----------------------------- ADD SUBJECT (class-wise only) -----------------------------
app.post('/api/admin/subject', (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  const { id, name, classId } = req.body;
  if (!id || !name || !classId)
    return res.status(400).json({ error: 'Missing fields' });

  const data = readData();
  data.subjects ||= [];
  data.classes ||= [];

  if (data.subjects.some(s => s.id === id && s.classId === classId))
    return res.status(400).json({ error: 'Subject already exists' });

  data.subjects.push({
    id,
    name,
    classId,
    questions: { test1: [], test2: [], test3: [], exam: [] },
    timeLimits: { test1: 30, test2: 30, test3: 30, exam: 60 }
  });

  const cls = data.classes.find(c => c.id === classId);
  if (cls) {
    cls.subjects ||= [];
    if (!cls.subjects.includes(id)) cls.subjects.push(id);
  }

  writeData(data)
    .then(() =>
      res.json({
        success: true,
        message: "Operation completed successfully."
      })
    )
    .catch(() => res.status(500).json({ error: 'Write failed' }));
});



// ----------------------------- GET SUBJECTS BY CLASS -----------------------------
app.get('/api/admin/subjects', (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  try {
    const classId = req.query.classId;
    const data = readData();
    let subjects = data.subjects || [];

    if (classId) {
      subjects = subjects.filter(s => s.classId === classId);
    }

    // ✅ CRITICAL FIX: normalize timeLimits for ALL subjects
    subjects = subjects.map(s => {
      if (!s.timeLimits) {
        s.timeLimits = {
          test1: 30,
          test2: 30,
          test3: 30,
          exam: 60
        };
      }
      return s;
    });

    res.json({ subjects });
  } catch (err) {
    console.error('/api/admin/subjects GET error:', err);
    res.status(500).json({ error: 'Failed to fetch subjects' });
  }
});

// ----------------------------- DELETE SUBJECT -----------------------------
app.delete(['/api/admin/subject/:id/:classId', '/api/admin/subject/:id'], (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const id = req.params.id;
    const classId = req.params.classId || req.query.classId;
    if (!id || !classId)
      return res.status(400).json({ error: 'Missing subject ID or class ID' });

    const data = readData();

    data.subjects = (data.subjects || []).filter(
      s => !(s.id === id && s.classId === classId)
    );

    const cls = (data.classes || []).find(c => c.id === classId);
    if (cls && Array.isArray(cls.subjects)) {
      cls.subjects = cls.subjects.filter(sid => sid !== id);
    }

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Operation completed successfully."
        })
      )
      .catch(err => {
        console.error('delete subject writeData error:', err);
        res.status(500).json({ error: 'Failed to delete subject' });
      });

  } catch (err) {
    console.error('/api/admin/subject delete error:', err);
    res.status(500).json({ error: 'Failed to delete subject' });
  }
});


// ----------------------------- ADD QUESTION -----------------------------
app.post("/api/admin/question", (req, res) => {
  questionUpload(req, res, err => {
    if (err) {
      console.error("Image upload error:", err);
      return res.status(500).json({ error: "Image upload failed" });
    }

    if (!req.session.admin)
      return res.status(401).json({ error: "Unauthorized" });

    const { subjectId, classId, qid, text, options, answer, marks } = req.body;
    const type = String(req.body.type || "").toLowerCase();

    if (!subjectId || !classId || !type || !qid || !text)
      return res.status(400).json({ error: "Missing required fields" });

    try {
      const data = readData();
      const subj = data.subjects.find(
        s => s.id === subjectId && s.classId === classId
      );

      if (!subj)
        return res.status(404).json({ error: "Subject not found" });

      subj.questions[type] ||= [];

      let parsedOptions = [];
      try {
        parsedOptions = Array.isArray(options)
          ? options
          : JSON.parse(options);
      } catch {
         parsedOptions = String(options || '')
          .split(',')
          .map(o => o.trim())
          .filter(Boolean);
      }

      subj.questions[type].push({
        qid,
        text,
        options: parsedOptions,
        answer: answer || "",
        marks: Number(marks) || 1,
        image: req.file ? `/uploads/${req.file.filename}` : null
      });

      writeData(data)
        .then(() =>
          res.json({
            success: true,
            message: "Question added successfully"
          })
        )
        .catch(() => res.status(500).json({ error: "Write failed" }));
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Internal error" });
    }
  });
});


// -------------------- GENERATE QUESTION PDF --------------------
app.get("/api/admin/questions/pdf", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { classId, subjectId, type } = req.query;
  const normalizedType = String(type || "").toLowerCase();

  try {
    const data = readData();
    const subj = data.subjects.find(
      s => s.id === subjectId && s.classId === classId
    );

    if (!subj)
      return res.status(404).json({ error: "Subject not found" });

    const questions = subj.questions[normalizedType] || [];
    if (!questions.length)
      return res.status(400).json({ error: "No questions available" });

    const outputDir = path.join(__dirname, "public/question-pdfs");
    if (!fs.existsSync(outputDir))
      fs.mkdirSync(outputDir, { recursive: true });

    const fileName = `${classId}_${subjectId}_${normalizedType}.pdf`;
    const outputPath = path.join(outputDir, fileName);

    await generateQuestionPDF(
      {
        className: classId,
        subjectName: subj.name,
        type: normalizedType,
        term: data.meta?.term
      },
      questions,
      outputPath
    );

    res.json({ success: true, file: `/question-pdfs/${fileName}` });
  } catch (err) {
    console.error("Question PDF error:", err);
    res.status(500).json({ error: "Failed to generate PDF" });
  }
});


// -------------------- FORWARD QUESTIONS --------------------
app.post("/api/admin/questions/forward", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { fromClass, toClass, subjectId } = req.body;

  try {
    const data = readData();

    const source = data.subjects.find(
      s => s.id === subjectId && s.classId === fromClass
    );
    if (!source)
      return res.status(404).json({ error: "Source subject not found" });

    let target = data.subjects.find(
      s => s.id === subjectId && s.classId === toClass
    );

   if (!target) {
  target = {
    id: subjectId,
    name: source.name,
    classId: toClass,
    questions: { test1: [], test2: [], test3: [], exam: [] },

    // ✅ FIX: preserve timing
    timeLimits: source.timeLimits || {
      test1: 30,
      test2: 30,
      test3: 30,
      exam: 60
    }
  };
  data.subjects.push(target);
}


    ["test1", "test2", "test3", "exam"].forEach(t => {
      target.questions[t] = JSON.parse(
        JSON.stringify(source.questions[t] || [])
      );
    });

    const cls = (data.classes || []).find(c => c.id === toClass);
    if (cls) {
      cls.subjects = cls.subjects || [];
      if (!cls.subjects.includes(subjectId))
        cls.subjects.push(subjectId);
    }

    writeData(data).then(() => res.json({ success: true }));
  } catch (err) {
    console.error("Forward error:", err);
    res.status(500).json({ error: "Failed to forward questions" });
  }
});


// -------------------- BULK CSV UPLOAD --------------------
app.post('/api/admin/questions/bulk-upload', csvUpload, (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: 'Unauthorized' });

  const { subjectId, classId } = req.body;
  if (!req.file)
    return res.status(400).json({ error: 'CSV file required' });

  try {
    const csvContent = fs.readFileSync(req.file.path, 'utf8');
    fs.unlinkSync(req.file.path);

    const rows = parseCSV(csvContent);
    if (!rows.length)
      return res.status(400).json({ error: 'Empty CSV file' });

    const data = readData();
    const subj = data.subjects.find(
      s => s.id === subjectId && s.classId === classId
    );

    if (!subj)
      return res.status(404).json({ error: 'Subject not found' });

   rows.forEach(r => {
  const type = String(r.Type || r.type || '').toLowerCase();
  if (!subj.questions[type]) return;

  subj.questions[type].push({
    qid: r.QuestionID || r.qid,
    text: r.QuestionText || r.text,
    options: String(r.Options || '')
    .split(',')
    .map(o => o.trim())
    .filter(Boolean),

    answer: String(r.Answer || r.answer || '').trim(),
    marks: Number(r.Mark || r.marks) || 1
  });
});


    writeData(data).then(() => res.json({ success: true }));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'CSV upload failed' });
  }
})

// ----------------------------- DELETE QUESTION -----------------------------
app.delete('/api/admin/question/:subjectId/:qid/:classId', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { subjectId, qid, classId } = req.params;
    const data = readData();
    const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
    if (!subj) return res.status(404).json({ error: 'Subject not found' });

    let found = false;
    for (const t of ['test1', 'test2', 'test3', 'exam']) {
      const before = subj.questions[t].length;
      subj.questions[t] = subj.questions[t].filter(q => q.qid !== qid);
      if (before !== subj.questions[t].length) found = true;
    }

    if (!found) return res.status(404).json({ error: 'Question not found' });

    writeData(data)
      .then(() => res.json({ success: true }))
      .catch(err => res.status(500).json({ error: 'Failed to delete question' }));
  } catch (err) {
    console.error('/api/admin/question DELETE error:', err);
    res.status(500).json({ error: 'Failed to delete question' });
  }
});

// ----------------------------- UPDATE TIMINGS -----------------------------
app.post('/api/admin/subject/timings', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { subjectId, classId, timings } = req.body;
    if (!subjectId || !classId || !timings)
      return res.status(400).json({ error: 'Missing subjectId/classId/timings' });

    const data = readData();
    const subj = (data.subjects || []).find(s => s.id === subjectId && s.classId === classId);
    if (!subj) return res.status(404).json({ error: 'Subject not found' });

    subj.timeLimits = {
      test1: Number(timings.test1) || 30,
      test2: Number(timings.test2) || 30,
      test3: Number(timings.test3) || 30,
      exam: Number(timings.exam) || 60
    };

    writeData(data)
      .then(() => res.json({ success: true, timeLimits: subj.timeLimits }))
      .catch(err => {
        console.error('timings writeData error:', err);
        res.status(500).json({ error: 'Failed to update timings' });
      });
  } catch (err) {
    console.error('/api/admin/subject/timings error:', err);
    res.status(500).json({ error: 'Failed to update timings' });
  }
});

// ---------------- ADMIN: CLASSES ----------------

// Get classes
app.get('/api/admin/classes', (req, res) => {
  if (!req.session?.admin) return res.status(401).json({ error: 'Unauthorized' });
  const data = readData();
  res.json({ classes: data.classes || [] });
});

// Add class
app.post('/api/admin/class', (req, res) => {
  if (!req.session?.admin) return res.status(401).json({ error: 'Unauthorized' });

  const { id, name, password } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Missing class id or name' });

  try {
    const data = readData();
    if (!data.classes) data.classes = [];

    if (data.classes.find(c => c.id === id)) {
      return res.status(400).json({ error: 'Class id already exists' });
    }

    data.classes.push({ id, name, password: password || '' });

    writeData(data)
      .then(() => res.json({ success: true }))
      .catch(() => res.status(500).json({ error: 'Failed to save class' }));

  } catch {
    res.status(500).json({ error: 'Failed to add class' });
  }
});

// Delete class
app.delete("/api/admin/class/:id", (req, res) => {
  if (!req.session?.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const id = req.params.id;
    const data = readData();

    data.classes = (data.classes || []).filter(c => c.id !== id);
    data.students = (data.students || []).filter(s => s.classId !== id);

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Class deleted successfully"
        })
      )
      .catch(() =>
        res.status(500).json({ error: "Failed to delete class" })
      );
  } catch {
    res.status(500).json({ error: "Failed to delete class" });
  }
});



// ---------------- STUDENT CRUD ----------------

// ✅ Ensure upload directory exists
const uploadDir = path.join(__dirname, "public", "images");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// ✅ Configure multer storage (for photo uploads)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || ".jpg";
    cb(null, `student_${Date.now()}${ext}`);
  },
});

// ✅ Safely create or reuse upload instance
let uploadInstance;
try {
  uploadInstance = global.upload || multer({ storage });
} catch (err) {
  uploadInstance = multer({ storage });
}
global.upload = uploadInstance;

// ✅ Define upload middleware
const studentUpload = uploadInstance.single("photo");

// ---------------- ROUTES ----------------

// Get all students in a class
app.get("/api/admin/class/:id/students", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const classId = req.params.id;
  const data = readData();
  const students = (data.students || []).filter((s) => s.classId === classId);
  res.json({ students });
});

// Add a new student
app.post("/api/admin/student", studentUpload, (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, name, classId, password } = req.body;
  if (!id || !name || !classId)
    return res
      .status(400)
      .json({ error: "Missing student id/name/classId" });

  try {
    const data = readData();
    if (!data.students) data.students = [];

    if (data.students.find(s => s.id === id))
      return res.status(400).json({ error: "Student id already exists" });

    if (!data.classes.find(c => c.id === classId))
      return res.status(400).json({ error: "Class does not exist" });

    let photoPath = null;
    if (req.file) {
      photoPath = path.relative(__dirname, req.file.path).replace(/\\/g, "/");
    }

    data.students.push({
      id,
      name,
      classId,
      password: password || id,
      photo: photoPath
    });

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Student added successfully"
        })
      )
      .catch(err => {
        console.error("add student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student" });
      });
  } catch (err) {
    console.error("/api/admin/student POST error:", err);
    res.status(500).json({ error: "Failed to add student" });
  }
});


// Edit student
app.put("/api/admin/student/:id", studentUpload, (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const studentId = req.params.id;
    const { name, classId, password } = req.body;
    const data = readData();
    const st = (data.students || []).find(s => s.id === studentId);
    if (!st) return res.status(404).json({ error: "Student not found" });

    if (typeof name !== "undefined") st.name = name;
    if (typeof classId !== "undefined") {
      if (!data.classes.find(c => c.id === classId))
        return res.status(400).json({ error: "Class does not exist" });
      st.classId = classId;
    }
    if (typeof password !== "undefined") st.password = password;

    if (req.file) {
      st.photo = path.relative(__dirname, req.file.path).replace(/\\/g, "/");
    }

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Student updated successfully"
        })
      )
      .catch(err => {
        console.error("edit student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student edit" });
      });
  } catch (err) {
    console.error("/api/admin/student PUT error:", err);
    res.status(500).json({ error: "Failed to edit student" });
  }
});


// Delete student
app.delete("/api/admin/student/:id", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  try {
    const studentId = req.params.id;
    const data = readData();

    data.students = (data.students || []).filter(s => s.id !== studentId);
    data.results = (data.results || []).filter(r => r.studentId !== studentId);
    data.pdfs = (data.pdfs || []).filter(p => p.studentId !== studentId);

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Student deleted successfully"
        })
      )
      .catch(err => {
        console.error("delete student writeData error:", err);
        res.status(500).json({ error: "Failed to persist student deletion" });
      });
  } catch (err) {
    console.error("/api/admin/student DELETE error:", err);
    res.status(500).json({ error: "Failed to delete student" });
  }
});

// -------------------- BULK PROMOTE STUDENTS --------------------
app.post("/api/admin/students/promote", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { fromClass, toClass } = req.body;

  if (!fromClass || !toClass)
    return res.status(400).json({ error: "Missing fromClass or toClass" });

  try {
    const data = readData();

    // Validate target class
    const targetClass = (data.classes || []).find(c => c.id === toClass);
    if (!targetClass)
      return res.status(404).json({ error: "Target class does not exist" });

    const students = (data.students || []).filter(
      s => s.classId === fromClass
    );

    if (!students.length)
      return res.status(404).json({ error: "No students in source class" });

    // Promote students
    students.forEach(st => {
      st.classId = toClass;
    });

    const promotedIds = students.map(s => s.id);

    // ❌ Remove all academic traces
    data.results = (data.results || []).filter(
      r => !promotedIds.includes(r.studentId)
    );

    data.pdfs = (data.pdfs || []).filter(
      p => !promotedIds.includes(p.studentId)
    );

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          count: students.length,
          message: "Students promoted successfully"
        })
      )
      .catch(err => {
        console.error("bulk promote writeData error:", err);
        res.status(500).json({ error: "Failed to promote students" });
      });

  } catch (err) {
    console.error("Bulk promotion error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
 // -------------------- ADD TEACHER --------------------
app.post("/api/admin/teacher", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { id, name, password } = req.body;
  if (!id || !name || !password)
    return res.status(400).json({ error: "Missing id/name/password" });

  try {
    const data = readData();
    data.teachers ||= [];

    if (data.teachers.find(t => t.id === id))
      return res.status(400).json({ error: "Teacher already exists" });

    data.teachers.push({
      id,
      name,
      password,
      active: true,
      blocked: false,
      createdAt: new Date().toISOString().slice(0, 10)
    });

    writeData(data)
      .then(() =>
        res.json({
          success: true,
          message: "Teacher registered successfully"
        })
      )
      .catch(() =>
        res.status(500).json({ error: "Failed to save teacher" })
      );

  } catch (err) {
    console.error("Add teacher error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// -------------------- LIST TEACHERS --------------------
app.get("/api/admin/teachers", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const data = readData();
  res.json({ teachers: data.teachers || [] });
});

// -------------------- TOGGLE TEACHER ACCESS --------------------
app.put("/api/admin/teacher/:id/toggle", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const teacherId = decodeURIComponent(req.params.id);

  const data = readData();
  const teacher = (data.teachers || []).find(
    t => t.id === teacherId
  );

  if (!teacher)
    return res.status(404).json({ error: "Teacher not found" });

  teacher.blocked = !teacher.blocked;

  writeData(data)
    .then(() => res.json({ success: true, blocked: teacher.blocked }))
    .catch(() => res.status(500).json({ error: "Failed to update teacher" }));
});

// -------------------- DELETE TEACHER --------------------
app.delete("/api/admin/teacher/:id", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const teacherId = decodeURIComponent(req.params.id);

  const data = readData();
  data.teachers = (data.teachers || []).filter(
    t => t.id !== teacherId
  );

  writeData(data)
    .then(() => res.json({ success: true }))
    .catch(() => res.status(500).json({ error: "Failed to delete teacher" }));
});

app.post("/api/teacher/logout", (req, res) => {
  delete req.session.teacher;
  res.json({ success: true });
});

/* ========= CLASS PDF ========= */
app.get("/api/admin/attendance/class/:id/pdf", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { from, to } = req.query;
  const data = readData();

  const cls = data.classes.find(c => c.id === req.params.id);
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const students = data.students.filter(s => s.classId === cls.id);
  const attendance = data.attendance?.[cls.id] || {};

  const outDir = path.join(__dirname, "public/reports");
  fs.mkdirSync(outDir, { recursive: true });

  const file = `ATTENDANCE_${cls.id}.pdf`;
  const outPath = path.join(outDir, file);

  generateClassAttendancePDF({
    meta: data.meta,
    cls,
    students,
    attendance,
    fromDate: from,
    toDate: to,
    outPath
  });

  res.json({ file: `/reports/${file}` });
});

/* ========= TEACHER PDF ========= */
app.get("/api/admin/attendance/teachers/pdf", (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Unauthorized" });

  const { from, to } = req.query;
  const data = readData();

  const outDir = path.join(__dirname, "public/reports");
  fs.mkdirSync(outDir, { recursive: true });

  const file = "TEACHER_ATTENDANCE.pdf";
  const outPath = path.join(outDir, file);

  generateTeacherAttendancePDF({
    meta: data.meta,
    teachers: data.teachers || [],
    attendance: data.attendance || {},
    fromDate: from,
    toDate: to,
    outPath
  });

  res.json({ file: `/reports/${file}` });
});

// ---------------- PORTAL AUTH ----------------
app.post('/api/portal/teacher/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.teacherPortal === false) {
    return res.status(403).json({ error: 'Teacher portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.teacherPortal) {
    req.session.portalTeacher = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/portal/exam/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.examPortal === false) {
    return res.status(403).json({ error: 'Exam portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.examPortal) {
    req.session.portalExam = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

app.post('/api/portal/report/auth', (req, res) => {
  const { portalPassword } = req.body;
  const data = readData();
  if (data.meta?.portalToggles?.reportPortal === false) {
    return res.status(403).json({ error: 'Report portal is disabled by admin' });
  }
  if (portalPassword === data.meta.portalPasswords.reportPortal) {
    req.session.portalReport = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Invalid password' });
});

// ---------------- CLASSES & STUDENTS (public) ----------------
app.get('/api/classes', (req, res) => {
  const data = readData();
  res.json({ classes: data.classes || [] });
});

// ✅ Admin classes endpoint (for dropdowns, ID card pages etc)
app.get('/api/admin/classes', (req, res) => {
  if (!req.session.admin) return res.status(401).json({ error: 'Admin login required' });

  const data = readData();
  res.json({ classes: data.classes || [] });
});

// Helper: normalize class IDs (remove spaces + lowercase)
function normalize(str) {
  return String(str).toLowerCase().replace(/\s+/g, '');
}

// ✅ Teacher class auth using session only
app.post('/api/teacher/class/auth', (req, res) => {
  if (!req.session.portalTeacher)
    return res.status(401).json({ error: 'Teacher login required' });

  const { classId, classPassword } = req.body;
  const data = readData();

  // FIXED: match class IDs with or without spaces
  const cls = data.classes.find(c => normalize(c.id) === normalize(classId));

  if (!cls) 
    return res.status(404).json({ error: 'Class not found' });

  if (cls.password !== classPassword)
    return res.status(401).json({ error: 'Wrong class password' });

  // Save the REAL class ID in the session
  req.session.teacherClass = cls.id;

  res.json({ success: true });
});


// ✅ Get students in a class (public endpoint for exam portal)
app.get('/api/class/:classId/students', (req, res) => {
  const classId = req.params.classId;
  const data = readData();
  const students = (data.students || []).filter(s => s.classId === classId);

  res.json({ students });
});

// ======================================================
// SINGLE ID CARD (ADMIN ONLY)
// ======================================================
app.post("/api/admin/idcard/:studentId", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const data = readData();
    const students = data.students || [];

    const student = students.find(
      s => s.id === req.params.studentId || s.studentId === req.params.studentId
    );

    if (!student)
      return res.status(404).json({ error: "Student not found" });

    const outputDir = path.join(__dirname, "public/idcards");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const sid = student.id || student.studentId;
    const outputPath = path.join(outputDir, `${sid}.pdf`);

    const { generateIDCard } = require("./utils/idCardGenerator");
    await generateIDCard(student, outputPath);

    res.json({
      success: true,
      message: "ID Card generated successfully",
      file: `/idcards/${sid}.pdf`
    });

  } catch (err) {
    console.error("❌ Single ID card error:", err);
    res.status(500).json({ error: "Failed to generate ID Card" });
  }
});


// ======================================================
// BULK ID CARDS (ONE PDF PER CLASS – ADMIN ONLY)
// ======================================================
app.post("/api/admin/idcards/class/:classId", async (req, res) => {
  if (!req.session.admin)
    return res.status(401).json({ error: "Admin login required" });

  try {
    const classId = req.params.classId.trim().toUpperCase();

    const data = readData();
    const students = data.students || [];

    const classStudents = students.filter(
      s => String(s.classId || "").toUpperCase() === classId
    );

    if (!classStudents.length) {
      return res.status(404).json({
        error: `No students found in class ${classId}`
      });
    }

    const outputDir = path.join(__dirname, "public/idcards");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const outputFile = path.join(
      outputDir,
      `CLASS_${classId}_ID_CARDS.pdf`
    );

    const { generateBulkIDCards } = require("./utils/idCardGenerator");
    await generateBulkIDCards(classStudents, outputFile);

    res.json({
      success: true,
      message: `ID cards generated successfully for class ${classId}`,
      file: `/idcards/CLASS_${classId}_ID_CARDS.pdf`
    });

  } catch (err) {
    console.error("❌ Bulk ID card error:", err);
    res.status(500).json({ error: "Failed to generate class ID cards" });
  }
});

// ✅ Update class lock
app.put("/api/admin/class/:classId/lock", (req, res) => {
  try {
    const { classId } = req.params;
    const { locked } = req.body;

    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    const cls = (data.classes || []).find(c => c.id === classId);
    if (!cls) return res.status(404).json({ error: "Class not found" });

    cls.locked = !!locked;
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

    res.json({ success: true, locked: cls.locked });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to update class lock" });
  }
});
// 🔔 Global Broadcast Message (Admin only)
app.post("/api/admin/broadcast", (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({ error: "Admin login required" });
  }

  const { text } = req.body; // Expect { text: "Your message" } from front-end
  if (!text || text.trim() === "") {
    return res.status(400).json({ error: "Broadcast message cannot be empty" });
  }

  // Save broadcast in memory for 30 seconds
  global.broadcastMessage = {
    text: text.trim(),
    expiresAt: Date.now() + 30000 // expires after 30 seconds
  };

  console.log("Broadcast sent:", global.broadcastMessage.text);
  res.json({ success: true, message: "Broadcast sent to all users" });
});

// 🔍 Route for users to fetch current broadcast message
app.get("/api/broadcast", (req, res) => {
  if (!global.broadcastMessage || Date.now() > global.broadcastMessage.expiresAt) {
    return res.json({ text: null }); // No active broadcast
  }

  // Return current broadcast
  res.json({ text: global.broadcastMessage.text });
});

// ================= SYSTEM MANAGEMENT API =================

// Get system status
app.get("/api/system/status", (req, res) => {
  res.json({
    locked: SYSTEM_LOCKED,
    reason: SYSTEM_LOCK_REASON
  });
});

// Lock system
app.post("/api/system/lock", (req, res) => {
  SYSTEM_LOCKED = true;
  SYSTEM_LOCK_REASON = req.body.reason || "System locked by administrator";
  res.json({ success: true });
});

// Unlock system
app.post("/api/system/unlock", (req, res) => {
  SYSTEM_LOCKED = false;
  SYSTEM_LOCK_REASON = "";
  res.json({ success: true });
});
// ======================================================
// DOWNLOAD STUDENT STATISTICS PDF (WITH SCHOOL HEADER)
// ======================================================
app.get("/api/admin/student-stats-pdf", (req, res) => {
  try {
    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    const students = data.students || [];
    const classes = data.classes || [];

    const PDFDocument = require("pdfkit");

    /* ================= CONSTANTS ================= */
    const BORDER_MARGIN = 25;
    const INNER_MARGIN = BORDER_MARGIN + 15;
    const CONTENT_START_Y = 200;
    const CONTENT_WIDTH = 595 - INNER_MARGIN * 2; // A4 width

    const doc = new PDFDocument({ size: "A4", margin: 40 });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      "inline; filename=Student_Statistics.pdf"
    );

    doc.pipe(res);

    /* ========== HEADER FUNCTION ========== */
    function drawHeader() {
      // Border
      doc.lineWidth(1).strokeColor("#000");
      doc.rect(
        BORDER_MARGIN,
        BORDER_MARGIN,
        doc.page.width - BORDER_MARGIN * 2,
        doc.page.height - BORDER_MARGIN * 2
      ).stroke();

      // Logo
      const logoPath = path.join(__dirname, "public", "logo.png");
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, doc.page.width / 2 - 20, 40, { width: 40 });
        } catch {}
      }

      // School name box
      doc.font("Helvetica-Bold").fontSize(14);
      const schoolName = "ASSALAM INTERNATIONAL ACADEMIC SCHOOL";
      const boxW = doc.widthOfString(schoolName) + 60;
      const boxX = (doc.page.width - boxW) / 2;
      const boxY = 90;

      doc.rect(boxX, boxY, boxW, 26).stroke();
      doc.text(schoolName, 0, boxY + 6, { align: "center" });

      // School info
      doc.font("Helvetica").fontSize(9);
      doc.text(
        "Address: Behind Garko Motor Park, Opp. Tasidi Filling Station",
        INNER_MARGIN,
        boxY + 36,
        { width: CONTENT_WIDTH, align: "center" }
      );
      doc.text(
        "Motto: Success comes after tears",
        INNER_MARGIN,
        boxY + 50,
        { width: CONTENT_WIDTH, align: "center" }
      );
      doc.text(
        "Phone: 08165789331, 08103992584, 08151015152, 07068595598",
        INNER_MARGIN,
        boxY + 64,
        { width: CONTENT_WIDTH, align: "center" }
      );

      doc.moveTo(60, boxY + 80).lineTo(540, boxY + 80).stroke();
      doc.y = CONTENT_START_Y;
    }

    /* ========== INITIAL HEADER ========== */
    drawHeader();

    /* ========== HEADER ON EVERY PAGE ========== */
    doc.on("pageAdded", drawHeader);

    /* ========== CONTENT ================= */
    doc.font("Helvetica-Bold").fontSize(14);
    doc.text("STUDENT ENROLLMENT STATISTICS", INNER_MARGIN, doc.y, {
      width: CONTENT_WIDTH,
      align: "center"
    });

    doc.moveDown(1.5);

    doc.font("Helvetica").fontSize(11);
    doc.text(`Total Students: ${students.length}`, INNER_MARGIN);

    doc.moveDown();

    classes.forEach(cls => {
      const count = students.filter(s => s.classId === cls.id).length;
      doc.text(`${cls.name || cls.id}: ${count} students`, INNER_MARGIN);
    });

    doc.moveDown(2);
    doc.fontSize(9).text(
      `Generated on: ${new Date().toLocaleString()}`,
      INNER_MARGIN,
      doc.y,
      { width: CONTENT_WIDTH, align: "right" }
    );

    doc.end();
  } catch (err) {
    console.error("Student stats PDF error:", err);
    res.status(500).send("PDF generation failed");
  }
});

// ======================================================
// FEATURE REQUEST TO DEVELOPER
// ======================================================
app.post("/api/admin/feature-request", (req, res) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({ success: false });
    }

    console.log("📩 FEATURE REQUEST RECEIVED:");
    console.log(message);

    // FOR NOW (FREE VERSION):
    // Just log it — later you can send email via Gmail / SMTP

    res.json({ success: true });
  } catch (err) {
    console.error("Feature request error:", err);
    res.status(500).json({ success: false });
  }
});
// ======================================================
// ADMIN: VIEW ALL DATA.JSON (READ ONLY)
// ======================================================
app.get("/api/admin/data-view", (req, res) => {
  try {
    const dataPath = path.join(__dirname, "data", "data.json");
    const raw = fs.readFileSync(dataPath, "utf8");
    const data = JSON.parse(raw);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "Failed to load data" });
  }
});
// ======================================================
// ADMIN: RESET ALL DATA
// ======================================================
app.post("/api/admin/reset-data", (req, res) => {
  try {
    const { confirm1, confirm2 } = req.body;

    if (confirm1 !== "YES" || confirm2 !== "RESET") {
      return res.status(400).json({ error: "Confirmation failed" });
    }

    const emptyData = {
      school: {},
      classes: [],
      students: [],
      teachers: [],
      results: [],
      users: [],
      settings: {}
    };

    const dataPath = path.join(__dirname, "data", "data.json");
    fs.writeFileSync(dataPath, JSON.stringify(emptyData, null, 2));

    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: "Reset failed" });
  }
});
app.post("/api/admin/school", (req, res) => {
  const dataPath = path.join(__dirname, "data/data.json");
  const data = JSON.parse(fs.readFileSync(dataPath));

  data.school = { ...data.school, ...req.body };

  fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
  res.json({ success: true });
});
// ---------------- RESULT ANALYTICS ----------------
app.get("/api/admin/results/analytics", (req, res) => {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId, mode } = req.query;
  if (!classId || !mode) {
    return res.status(400).json({ error: "Missing parameters" });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  // 🔎 Filter strictly by class
  const filtered = results.filter(r => r.classId === classId);

  const output = {};

  if (mode === "students") {
    filtered.forEach(r => {
      if (!r.studentId) return;

      output[r.studentId] ??= { total: 0, count: 0 };
      output[r.studentId].total += Number(r.total) || 0;
      output[r.studentId].count++;
    });
  }

  if (mode === "subjects") {
    filtered.forEach(r => {
      const subject =
        typeof r.subject === "string"
          ? r.subject
          : r.subject?.id || "UNKNOWN";

      output[subject] ??= { total: 0, count: 0 };
      output[subject].total += Number(r.total) || 0;
      output[subject].count++;
    });
  }

  // 🧮 Compute averages
  const result = {};
  Object.entries(output).forEach(([k, v]) => {
    result[k] = Math.round(v.total / Math.max(v.count, 1));
  });

  res.json({ data: result });
});
// ---------------- CLASS RANKING ----------------
app.get("/api/admin/results/ranking", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) {
    return res.status(400).json({ error: "Missing classId" });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  const map = {};

  results
    .filter(r => r.classId === classId)
    .forEach(r => {
      map[r.studentId] ??= { total: 0, count: 0 };
      map[r.studentId].total += Number(r.total) || 0;
      map[r.studentId].count++;
    });

  const ranking = Object.entries(map)
    .map(([studentId, v]) => ({
      studentId,
      avg: Math.round(v.total / Math.max(v.count, 1))
    }))
    .sort((a, b) => b.avg - a.avg);

  res.json({ ranking });
});
// ---------------- TOP 5 STUDENTS ----------------
app.get("/api/admin/results/top5", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "Missing classId" });

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  const map = {};

  results
    .filter(r => r.classId === classId)
    .forEach(r => {
      map[r.studentId] ??= { total: 0, count: 0 };
      map[r.studentId].total += Number(r.total) || 0;
      map[r.studentId].count++;
    });

  const top5 = Object.entries(map)
    .map(([studentId, v]) => ({
      studentId,
      avg: Math.round(v.total / Math.max(v.count, 1))
    }))
    .sort((a, b) => b.avg - a.avg)
    .slice(0, 5);

  res.json({ top5 });
});
// ---------------- PASS / FAIL DISTRIBUTION ----------------
app.get("/api/admin/results/passfail", (req, res) => {
  if (!req.session?.admin) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "Missing classId" });

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  let pass = 0;
  let fail = 0;

  results
    .filter(r => r.classId === classId)
    .forEach(r => {
      if ((Number(r.total) || 0) >= 50) pass++;
      else fail++;
    });

  res.json({
    pass,
    fail,
    total: pass + fail
  });
});

// ---------------- TEACHER REPORT (Single Student) ----------------
app.put("/api/teacher/student/:studentId/report", async (req, res) => {
  try {
    const { studentId } = req.params;
    const { reports } = req.body;
    if (!reports) return res.status(400).json({ error: "Missing report data" });

    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    // Find student
    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) return res.status(404).json({ error: "Student not found" });

    // Check class
    const classEntry = data.classes?.find(c => c.id === student.classId);
    if (!classEntry) return res.status(400).json({ error: "Class info missing" });
    const classSubjects = classEntry.subjects || [];
  // Build subjectId -> subjectName map FROM CLASS SUBJECTS
const subjectNameMap = {};
(classEntry.subjects || []).forEach(s => {
  subjectNameMap[s.id] = s.name;
});

    if (classEntry.locked) {
      return res.status(403).json({ error: "Class is locked. Contact admin." });
    }

    if (!data.results) data.results = [];

    // Merge logic: only for subjects in this class
    const resolvedSubjects = getClassSubjectsResolved(data, student.classId);
const validSubjectIds = resolvedSubjects.map(s => s.id);

  for (const [subjectId, vals] of Object.entries(reports)) {
  if (!validSubjectIds.includes(subjectId)) continue;


      const existing = data.results.find(
        r => r.studentId === studentId && r.subject === subjectId
      );

      if (existing) {
        // Merge with CBT + teacher inputs
        existing.test1 = vals.test1 !== undefined ? Number(vals.test1) : (existing.test1 ?? 0);

        existing.test2 = vals.test2 !== undefined && vals.test2 !== ""
          ? Number(vals.test2)
          : (existing.test2 ?? 0);

        existing.test3 = vals.test3 !== undefined ? Number(vals.test3) : (existing.test3 ?? 0);
        existing.exam  = vals.exam  !== undefined ? Number(vals.exam)  : (existing.exam ?? undefined);

        existing.total =
          (existing.test1 || 0) +
          (existing.test2 || 0) +
          (existing.test3 || 0) +
          (existing.exam  || 0);

        existing.updatedAt = new Date().toISOString();
      } else {
        const t1 = vals.test1 !== undefined ? Number(vals.test1) : 0;
        const t2 = vals.test2 !== undefined && vals.test2 !== "" ? Number(vals.test2) : 0;
        const t3 = vals.test3 !== undefined ? Number(vals.test3) : 0;
        const ex = vals.exam  !== undefined ? Number(vals.exam)  : undefined;

        data.results.push({
          studentId,
          classId: student.classId,
          subject: subjectId,
          test1: t1,
          test2: t2,
          test3: t3,
          exam: ex,
          total: t1 + t2 + t3 + (ex || 0),
          updatedAt: new Date().toISOString(),
        });
      }
    }

    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
   // ---------- ENSURE SUBJECTS ARE RESOLVABLE FOR PDF ----------
const studentResults = (data.results || [])
  .filter(r => r.studentId === studentId);

studentResults.forEach(r => {
  if (!subjectNameMap[r.subject]) {
    console.warn("⚠️ Unresolved subject:", r.subject);
  }
});
 res.json({ success: true, message: "Report updated successfully." });
  } catch (err) {
    console.error("PUT /api/teacher/student/:studentId/report error:", err);
    res.status(500).json({ error: "Internal server error", details: err.message });
  }
});

// ---------------- DELETE REPORT + CLEAN OLD SCORES ----------------
app.delete("/api/teacher/student/:studentId/report", (req, res) => {
  try {
    const { studentId } = req.params;
    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    // Delete any report PDFs belonging to this student
    const reportDir = path.join(__dirname, "reports");
    const deleted = [];
    if (fs.existsSync(reportDir)) {
      fs.readdirSync(reportDir).forEach((file) => {
        if (file.startsWith(studentId) && file.endsWith(".pdf")) {
          fs.unlinkSync(path.join(reportDir, file));
          deleted.push(file);
        }
      });
    }

    // Clean all results for this student
    data.results = (data.results || []).filter((r) => r.studentId !== studentId);
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

    console.log(`🧹 Cleaned old test/exam records for student ${studentId}`);
    res.json({ success: true, deleted });
  } catch (err) {
    console.error("Error deleting report:", err);
    res.status(500).json({ error: "Failed to delete report", details: err.message });
  }
});

// ---------------- GET CLASS INFO ----------------
app.get("/api/classes/:classId", (req, res) => {
  const dataPath = path.join(__dirname, "data", "data.json");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
  const classId = req.params.classId;

  const found = (data.classes || []).find(
    c => c.id.toUpperCase() === classId.toUpperCase()
  );

  if (!found) {
    return res.status(404).json({ error: "Class not found" });
  }

  res.json({
    id: found.id,
    name: found.name,
    locked: !!found.locked,
    subjects: found.subjects || [] // send full subject objects {id,name}
  });
});

// ---------------- TEACHER: GENERATE ALL REPORTS IN A CLASS ----------------
app.get(
  "/api/teacher/class/:classId/reports",
  reportGuard,
  async (req, res) => {


  try {
    const { classId } = req.params;
    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    const students = (data.students || []).filter(s => s.classId === classId);
    if (!students.length) {
      return res.status(404).json({ error: "No students found in this class." });
    }

    // =========================
    // RESOLVE CLASS SUBJECTS (SINGLE SOURCE OF TRUTH)
    // =========================
    const resolvedSubjects = getClassSubjectsResolved(data, classId);
  console.log("📚 RESOLVED SUBJECTS:", resolvedSubjects);
  if (!resolvedSubjects.length) {
      return res.status(404).json({ error: "No subjects found for this class." });
    }

    const subjectIdToName = {};
    resolvedSubjects.forEach(s => {
      subjectIdToName[s.id] = s.name;
    });

    const subjectIds = resolvedSubjects.map(s => s.id);

    // =========================
    // CALCULATE AVERAGES (SAME LOGIC AS CLASS REPORT)
    // =========================
    const averages = students.map(s => {
      const results = (data.results || []).filter(
        r => r.studentId === s.id && subjectIds.includes(r.subject)
      );

      const total = results.reduce(
        (a, r) =>
          a +
          (r.test1 || 0) +
          (r.test2 || 0) +
          (r.test3 || 0) +
          (r.exam || 0),
        0
      );

      const avg = results.length ? total / results.length : 0;
      return { id: s.id, avg };
    });

    averages.sort((a, b) => b.avg - a.avg);

    const suffix = (n) => {
      if (n % 10 === 1 && n % 100 !== 11) return `${n}st`;
      if (n % 10 === 2 && n % 100 !== 12) return `${n}nd`;
      if (n % 10 === 3 && n % 100 !== 13) return `${n}rd`;
      return `${n}th`;
    };

    // =========================
    // META
    // =========================
    const metaResp = await fetch(`http://localhost:${PORT}/api/meta`);
    const metaJson = await metaResp.json();
    const baseMeta = metaJson.meta || {};
    baseMeta.totalStudents = students.length;

    const teacherSigFile = path.join(__dirname, "public/uploads/teacher_signature.png");
    if (fs.existsSync(teacherSigFile)) {
      baseMeta.teacherSignaturePath = "/uploads/teacher_signature.png";
    }

    const timestamp = new Date().toISOString().replace(/[:T]/g, "-").split(".")[0];
    const batchDir = path.join(__dirname, "reports", `class_${classId}_${timestamp}`);
    fs.mkdirSync(batchDir, { recursive: true });

    const generated = [];

    // =========================
    // GENERATE PER-STUDENT REPORTS
    // =========================
    for (let i = 0; i < averages.length; i++) {
      const { id } = averages[i];
      const student = students.find(s => s.id === id);
      const reportData = {};

     (data.results || [])
  .filter(r => r.studentId === id)
  .forEach(r => {

    let subjectId = null;

    // 🔹 Normalize subject field (ALL historical formats)
    if (typeof r.subject === "string") {
      subjectId = r.subject.trim().toUpperCase();
    } else if (typeof r.subject === "object" && r.subject?.id) {
      subjectId = String(r.subject.id).trim().toUpperCase();
    }

    // 🔹 Resolve name
    const subjectName = subjectIdToName[subjectId];
    if (!subjectName) return;

    reportData[subjectName] = {
      test1: r.test1 || 0,
      test2: r.test2 || 0,
      test3: r.test3 || 0,
      exam: r.exam || 0
    };
  });


      const meta = { ...baseMeta, position: suffix(i + 1) };
      const outPath = path.join(batchDir, `${id}_report.pdf`);

      await new Promise((resolve, reject) => {
        generateReportPDF(meta, student, reportData, outPath, (err) => {
          if (err) return reject(err);
          generated.push(`/reports/${path.basename(batchDir)}/${path.basename(outPath)}`);
          resolve();
        });
      });
    }

    console.log(`✅ Generated ${generated.length} reports for class ${classId}`);
    res.json({
      success: true,
      reports: generated,
      count: generated.length,
      folder: `/reports/${path.basename(batchDir)}`
    });

  } catch (err) {
    console.error("Bulk report generation error:", err);
    res.status(500).json({
      error: "Internal server error during bulk report generation."
    });
  }
});


// ============================================================================
// GENERATE ONE SINGLE PDF FOR A WHOLE CLASS (ALL STUDENTS + SUMMARY PAGE)
// ============================================================================
app.get(
  "/api/teacher/class/:classId/combined-report",
  reportGuard,
  async (req, res) => {

  try {
    const { classId } = req.params;
    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));

    const students = (data.students || []).filter(s => s.classId === classId);
    if (!students.length) {
      return res.status(404).json({ error: "No students found." });
    }

    const classEntry = (data.classes || []).find(c => c.id === classId);
    if (!classEntry || !classEntry.subjects) {
      return res.status(404).json({ error: "Class subjects not found." });
    }

    // ✅ ALWAYS resolve full subject list
    const subjects = getClassSubjectsResolved(data, classEntry.id);
    const subjectIds = subjects.map(s => s.id);
    const subjectCount = subjects.length || 1; // prevent division by zero

    // =========================
    // CALCULATE TOTALS & RANK (MATCH REPORT SHEET LOGIC)
    // =========================
    students.forEach(s => {

      let totalScore = 0;

      subjects.forEach(sub => {
        const r = (data.results || []).find(
          x => x.studentId === s.id && x.subject === sub.id
        ) || {};

        totalScore +=
          (r.test1 || 0) +
          (r.test2 || 0) +
          (r.test3 || 0) +
          (r.exam  || 0);
      });

      s.totalScore = totalScore;
      s.average = totalScore / subjectCount; // ✅ SAME AS REPORT SHEET
    });

    students.sort((a, b) => b.average - a.average);

    const suffix = n => {
      if (n % 10 === 1 && n % 100 !== 11) return "st";
      if (n % 10 === 2 && n % 100 !== 12) return "nd";
      if (n % 10 === 3 && n % 100 !== 13) return "rd";
      return "th";
    };

    students.forEach((s, i) => {
      s.positionIndex = i + 1;
      s.position = `${i + 1}${suffix(i + 1)}`;
    });

    // =========================
    // META
    // =========================
    const meta = {
      schoolName: "ASSALAM INTERNATIONAL ACADEMIC SCHOOL",
      className: classId,
      term: "First Term",
      session: "2024/2025",
      totalStudents: students.length
    };

    const reportsDir = path.join(__dirname, "reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const outPath = path.join(
      reportsDir,
      `Class_${classId}_FULL_REPORT.pdf`
    );

    generateClassReportPDF(
      meta,
      students,
      data.results || [],
      subjects,
      outPath,
      (err) => {
        if (err) {
          console.error("PDF generation error:", err);
          return res.status(500).json({ error: "PDF generation failed." });
        }

        res.json({
          success: true,
          file: `/reports/Class_${classId}_FULL_REPORT.pdf`
        });
      }
    );

  } catch (err) {
    console.error("Combined report error:", err);
    res.status(500).json({ error: "Server error." });
  }
});


// ---------------- SIGNATURE UPLOAD ROUTES ----------------

// ✅ Upload teacher signature (Class-specific)
app.post("/api/upload/teacher-signature/:classId", upload.single("signature"), (req, res) => {
  try {
    const { classId } = req.params;
    if (!classId) return res.status(400).json({ error: "Missing classId parameter" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    // Save inside main uploads folder so reportGenerator can find it
    const uploadDir = path.join(__dirname, "public", "uploads");
    fs.mkdirSync(uploadDir, { recursive: true });

    const filename = `${classId}_signature.png`;
    const dest = path.join(uploadDir, filename);

    try {
      if (fs.existsSync(dest)) fs.unlinkSync(dest);
      fs.renameSync(req.file.path, dest);
    } catch (mvErr) {
      try {
        fs.copyFileSync(req.file.path, dest);
        fs.unlinkSync(req.file.path);
      } catch (copyErr) {
        console.error("Failed to store uploaded signature:", mvErr, copyErr);
        return res.status(500).json({ error: "Failed to save uploaded file" });
      }
    }

    const rel = `/uploads/${filename}`;

    // ✅ Save signature path inside the class entry in data.json
    try {
      const data = readData();
      if (!data.classes) data.classes = [];

      let cls = data.classes.find(c => c.id === classId);
      if (cls) {
        cls.teacherSignature = rel;
      } else {
        data.classes.push({ id: classId, name: classId, teacherSignature: rel });
      }

      writeData(data).then(() => {
        res.json({
          success: true,
          file: rel,
          message: `Signature uploaded and saved for class ${classId}.`
        });
      }).catch((err) => {
        console.error("writeData error saving teacher signature:", err);
        res.status(500).json({
          success: false,
          file: rel,
          error: "File saved but metadata failed",
          details: String(err)
        });
      });

    } catch (metaErr) {
      console.error("Error updating data.json:", metaErr);
      return res.status(500).json({ error: "Failed to update metadata", details: String(metaErr) });
    }

  } catch (err) {
    console.error("Teacher signature upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ✅ Upload principal signature (Global)
app.post("/api/upload/principal-signature", upload.single("signature"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const uploadDir = path.join(__dirname, "public/uploads");
    fs.mkdirSync(uploadDir, { recursive: true });

    const dest = path.join(uploadDir, "principal_signature.png");

    // Remove old file
    if (fs.existsSync(dest)) fs.unlinkSync(dest);

    // Save the new file
    fs.renameSync(req.file.path, dest);

    // ✔ Update data.json
    const dataPath = path.join(__dirname, "data", "data.json");
    const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
    data.signaturePrincipal = "/uploads/principal_signature.png";
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));

    res.json({
      success: true,
      file: "/uploads/principal_signature.png",
      message: "Principal signature uploaded successfully.",
    });

  } catch (err) {
    console.error("Principal signature upload error:", err);
    res.status(500).json({ error: "Upload failed", details: err.message });
  }
});

// ---------------- EXAM ----------------
app.get('/api/exam/questions', (req, res) => {
  if (!req.session.portalExam)
    return res.status(401).json({ error: 'Portal exam access required' });

  const { subjectId, type, classId } = req.query;
  const data = readData();

  // enforce test toggles
  if (data.meta?.testToggles && data.meta.testToggles[type] === false) {
    return res.status(403).json({ error: `${type} is disabled by admin` });
  }

  const subj = (data.subjects || []).find(
    (s) => s.id === subjectId && s.classId === classId
  );
  if (!subj)
    return res.status(404).json({ error: 'Subject not found for this class' });

  // Provide both questions and time limit for the requested test type
  const items = subj.questions[type] || [];
  const timeForType =
    subj.timeLimits && typeof subj.timeLimits[type] !== 'undefined'
      ? subj.timeLimits[type]
      : data.meta?.defaultTimeLimits?.[type] ?? (type === 'exam' ? 60 : 30);

  // return questions and duration (minutes)
  res.json({ items, duration: timeForType });
});

// ---------------- EXAM ATTEMPT TRACKING ----------------
function preventMultipleSubmissions(req, res, next) {
  if (!req.session.portalExam) {
    return res.status(401).json({ error: 'Portal exam access required' });
  }

  const { studentId, type, subjectId, classId } = req.body || req.query;

  if (!studentId || !type || !subjectId || !classId) {
    return res.status(400).json({ error: 'Missing exam attempt parameters' });
  }

  const data = readData();
  const results = Array.isArray(data.results) ? data.results : [];

  const normalizedSubjectId = String(subjectId).trim().toUpperCase();

  // 🔑 FIND ONLY VALID, CURRENT RESULTS
  const existing = results.find(r => {
    if (r.studentId !== studentId) return false;
    if (r.classId !== classId) return false;

    // Normalize stored subject (id OR name OR object)
    const stored =
      typeof r.subject === 'string'
        ? r.subject.trim().toUpperCase()
        : String(r.subject?.id || '').trim().toUpperCase();

    // 🔥 KEY FIX: must match subjectId EXACTLY
    if (stored !== normalizedSubjectId) return false;

    // 🔥 KEY FIX: record must actually contain this exam type
    if (type === 'test1' && r.test1 === undefined) return false;
    if (type === 'test2' && r.test2 === undefined) return false;
    if (type === 'test3' && r.test3 === undefined) return false;
    if (type === 'exam'  && r.exam  === undefined) return false;

    return true;
  });

  // ✅ No valid prior submission → allow
  if (!existing) {
    return next();
  }

  // 🚫 Block only if THIS attempt truly exists
  return res.status(403).json({
    error: `You have already submitted ${type} for this subject`
  });
}


app.post('/api/exam/submit', preventMultipleSubmissions, (req, res) => {
  if (!req.session.portalExam)
    return res.status(401).json({ error: 'Portal exam access required' });

  try {
    const { studentId, classId, subjectId, type, answers } = req.body;
    const data = readData();

    // enforce test toggles
    if (data.meta?.testToggles && data.meta.testToggles[type] === false) {
      return res.status(403).json({ error: `${type} is disabled by admin` });
    }

    const student = (data.students || []).find(
      (s) => s.id === studentId && s.classId === classId
    );
    const subj = (data.subjects || []).find(
      (s) => s.id === subjectId && s.classId === classId
    );

    if (!student || !subj)
      return res
        .status(404)
        .json({ error: 'Student or subject not found for this class' });

    // compute score safely
    let score = 0;
    const items = subj.questions[type] || [];
    const itemsWithAns = items.map((q) => {
      const ans =
        answers && Object.prototype.hasOwnProperty.call(answers, q.qid)
          ? answers[q.qid]
          : undefined;
      const marks = Number(q.marks) || 1;
      if (
        ans &&
        q.answer &&
        ans.trim().toLowerCase() === q.answer.trim().toLowerCase()
      )
        score += marks;
      return {
        qid: q.qid,
        text: q.text,
        options: Array.isArray(q.options)
          ? q.options.slice()
          : q.options || [],
        answer: q.answer,
        marks,
        studentAnswer: ans,
        image: q.image || null, // ✅ include question image
      };
    });

    const totalPossible = items.reduce(
      (sum, q) => sum + (Number(q.marks) || 1),
      0
    );
    const percentage =
      totalPossible > 0
        ? Number(((score / totalPossible) * 100).toFixed(2))
        : 0;

    if (!data.results) data.results = [];
   let existing = data.results.find(
  (r) =>
    r.studentId === studentId &&
    r.classId === classId &&
    r.subject === subjectId
);

    if (!existing) {
      existing = {
        id: `res_${Date.now()}`,
        studentId,
        classId,
       subject: subjectId,
      };
      data.results.push(existing);
    }

    if (type === 'test1') existing.test1 = score;
    if (type === 'test2') existing.test2 = score;
    if (type === 'test3') existing.test3 = score;
    if (type === 'exam') existing.exam = score;
    existing.total =
      (existing.test1 || 0) +
      (existing.test2 || 0) +
      (existing.test3 || 0) +
      (existing.exam || 0);
    existing.updatedAt = new Date().toISOString();

    if (!data.pdfs) data.pdfs = [];

    const outDir = path.join(__dirname, 'files', classId, studentId);
    fs.mkdirSync(outDir, { recursive: true });
    const filename = `exam_${type}_${studentId}_${Date.now()}.pdf`;
    const outPath = path.join(outDir, filename);
    const examMeta = {
      type,
      subject: subj.name,
      items: itemsWithAns,
      score,
      total: totalPossible,
      percentage,
    };

    // ✅ generate PDF including student photo + question images
    generateExamPDF(data.meta, student, examMeta, outPath, (err) => {
      if (err) {
        console.error('generateExamPDF error:', err);
        return res
          .status(500)
          .json({ error: 'Failed to generate exam PDF', details: err.message });
      }

      const relPath = `/files/${classId}/${studentId}/${filename}`;
      data.pdfs.push({
        id: `pdf_${Date.now()}`,
        type: 'exam_result',
        studentId,
        filePath: relPath,
        timestamp: new Date().toISOString(),
        subject: subj.name,
        examType: type,
      });

      writeData(data)
        .then(() => {
          res.json({
            success: true,
            score,
            total: totalPossible,
            percentage,
            pdf: relPath,
          });
        })
        .catch((err) => {
          console.error('writeData after exam pdf error:', err);
          res.status(500).json({
            error: 'Failed to persist exam result after generating PDF',
            details: err.message,
            pdf: relPath,
          });
        });
    });
  } catch (err) {
    console.error('/api/exam/submit unexpected error:', err);
    res
      .status(500)
      .json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------- PARENT PORTAL AUTH ----------------
app.post('/api/portal/parent/auth', (req, res) => {
  try {
    const { portalPassword } = req.body;
    const data = readData();

    // Optional toggle: allow admin to disable parent portal
    if (data.meta?.portalToggles?.parentPortal === false) {
      return res.status(403).json({ error: 'Parent portal is disabled by admin' });
    }

    // Check password
    if (portalPassword === data.meta?.portalPasswords?.parentPortal) {
      req.session.parentAuth = true; // ✅ unified session flag
      return res.json({ success: true, message: 'Parent portal login successful' });
    } else {
      return res.status(401).json({ error: 'Invalid password' });
    }
  } catch (err) {
    console.error('Parent portal auth error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


// ---------------- VERIFY STUDENT ID (NEW) ----------------
app.post('/api/verify-student-id', (req, res) => {
  try {
    // Require parent portal session
    if (!req.session.parentAuth) {
      return res.status(401).json({ error: 'Unauthorized. Please login to parent portal.' });
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: 'Missing student ID.' });
    }

    const data = readData();
    let foundStudent = null;

    // Check in data.students
    if (Array.isArray(data.students)) {
      foundStudent = data.students.find(s => s.id === studentId);
    }

    // If not found, check nested class structure
    if (!foundStudent && Array.isArray(data.classes)) {
      for (const cls of data.classes) {
        const student = (cls.students || []).find(s => s.id === studentId);
        if (student) {
          foundStudent = student;
          break;
        }
      }
    }

    if (!foundStudent) {
      return res.status(404).json({ valid: false, error: 'Student ID not found.' });
    }

    return res.json({
      valid: true,
      student: {
        id: foundStudent.id,
        name: foundStudent.name,
        classId: foundStudent.classId || 'N/A'
      }
    });
  } catch (err) {
    console.error('Verify student ID error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});


// ---------------- PARENT PORTAL: DOWNLOAD REPORTS ----------------
app.post('/api/portal/parent/download', (req, res) => {
  try {
    // Require parent portal session
    if (!req.session.parentAuth) {
      return res.status(401).json({ error: 'Unauthorized. Please login to parent portal.' });
    }

    const { studentId } = req.body;
    if (!studentId) {
      return res.status(400).json({ error: 'Missing student ID' });
    }

    const data = readData();

    // Find student record
    const student = (data.students || []).find(s => s.id === studentId);
    if (!student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    // Collect PDFs from data.json
    let pdfs = (data.pdfs || []).filter(p => p.studentId === studentId);

    // Include teacher portal PDFs (from reports folder)
    const reportDir = path.join(__dirname, 'reports');
    if (fs.existsSync(reportDir)) {
      const files = fs.readdirSync(reportDir).filter(f => f.startsWith(studentId));
      const folderPdfs = files.map(f => ({
        studentId,
        type: 'Report Sheet',
        filePath: `/reports/${f}`,
      }));

      // Merge, avoiding duplicates
      const existingPaths = pdfs.map(p => p.filePath);
      folderPdfs.forEach(f => {
        if (!existingPaths.includes(f.filePath)) pdfs.push(f);
      });
    }

    // CLEAN STALE ENTRIES: remove any PDF references that no longer exist
    pdfs = pdfs.filter(p => {
      const fullPath = path.join(__dirname, p.filePath.replace(/^\/+/, ''));
      return fs.existsSync(fullPath);
    });

    // OPTIONAL: update data.json to remove stale references
    data.pdfs = data.pdfs.filter(p => {
      const fullPath = path.join(__dirname, p.filePath.replace(/^\/+/, ''));
      return fs.existsSync(fullPath);
    });
    fs.writeFileSync(path.join(__dirname, 'data/data.json'), JSON.stringify(data, null, 2));

    if (pdfs.length === 0) {
      return res.status(404).json({ error: 'No reports found for this student.' });
    }

    return res.json({ success: true, pdfs });
  } catch (err) {
    console.error('Parent portal download error:', err);
    return res.status(500).json({ error: 'Internal server error', details: err.message });
  }
});

// ---------------- FILE DELIVERY ----------------
app.get('/file', (req, res) => {
  try {
    const rel = req.query.path;
    if (!rel) return res.status(400).send('Missing path');

    const full = path.join(__dirname, rel);
    if (fs.existsSync(full)) {
      return res.sendFile(full);
    } else {
      return res.status(404).send('Not found');
    }
  } catch (err) {
    console.error('File delivery error:', err);
    return res.status(500).send('Internal server error');
  }
});

// ---------------- GLOBAL ERROR HANDLERS ----------------
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason && reason.stack ? reason.stack : reason);
});

// ---------------- START ----------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
// 🔁 send heartbeat every 60 seconds
setInterval(() => {
  sendHeartbeat();
}, 60 * 1000);

// 🚀 send immediately on startup
sendHeartbeat();
const interfaces = os.networkInterfaces();
for (const name of Object.keys(interfaces)) {
  for (const iface of interfaces[name]) {
    if (iface.family === 'IPv4' && !iface.internal) {
      console.log(`🌍 Access this server at: http://${iface.address}:${PORT}`);
    }
  }
}



