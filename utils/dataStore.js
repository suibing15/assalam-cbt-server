// utils/dataStore.js
const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, '../data/data.json');
console.log('USING DATA FILE:', filePath);


// Simple queue to serialize writes
let writeQueue = Promise.resolve();

/**
 * Safely stringify to JSON (prevents "Maximum call stack size exceeded"
 * if circular references appear).
 */
function safeStringify(obj, space = 2) {
  const cache = new WeakSet();
  return JSON.stringify(
    obj,
    (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) return undefined;
        cache.add(value);
      }
      return value;
    },
    space
  );
}

/**
 * Deep clone utility to avoid reference mutation issues.
 */
function deepClone(obj) {
  return obj ? JSON.parse(JSON.stringify(obj)) : obj;
}

function readData() {
  try {
    if (!fs.existsSync(filePath)) {
      // If the file does not exist, create a minimal structure and write it.
      const initial = {
        meta: {
          schoolName: "ASSALAM INTERNATIONAL ACADEMY GARKO",
          term: "First Term",
          logo: "uploads/logo.png",
          signaturePrincipal: "uploads/sign_principal.png",
          signatureFormMaster: "uploads/sign_formmaster.png",
          portalToggles: { teacherPortal: true, examPortal: true, reportPortal: true },
          portalPasswords: {
            teacherPortal: "portalteach2025",
            examPortal: "portalexam2025",
            reportPortal: "portalreport2025"
          }
        },
        admins: [{ username: "admin", password: "Admin@123" }],
        teachers: [{ username: "teacher1", password: "Teach@123", name: "Mrs Aisha", sections: ["Nursery", "Primary"] }],
        classes: [],
        students: [],
        parents: [],
        subjects: [],
        results: [],
        pdfs: []
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, safeStringify(initial, 2), 'utf8');
      return deepClone(initial);
    }

    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);

    // Return a detached deep clone to avoid circular self-linking during write
    return deepClone(parsed);
  } catch (err) {
    console.error('Error reading data.json:', err);
    throw new Error('Failed to read data.json. Please check the file content.');
  }
}

function writeData(obj) {
  // serialize writes in order
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve, reject) => {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch {
        /* ignore */
      }

      const safeJSON = safeStringify(obj, 2);
      fs.writeFile(filePath, safeJSON, 'utf8', (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  });
  return writeQueue;
}

module.exports = { readData, writeData };
