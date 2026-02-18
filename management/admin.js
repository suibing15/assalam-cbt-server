// Admin Portal Logic (Toggles + Subjects/Questions + PDFs + Classes/Students + Timings)
// (Replace your existing admin.js with this file - keeps all original features but fixes class/subject population + uploads)


//////////////////////
// Helpers & startup
//////////////////////

// safe DOM elements
const classSelectorEl = document.getElementById('classSelector');
const subjectSelectorEl = document.getElementById('subjectSelector');

async function safeJson(resp) {
  try { return await resp.json(); } catch (e) { return null; }
}

//////////////////////
// TOGGLES (clean & stable)
//////////////////////

window.loadToggles = async function () {
  const metaResp = await fetch('/api/meta', { credentials: 'include' });
  if (!metaResp.ok) {
    alert('Failed to load meta');
    return;
  }

  const meta = await metaResp.json();
  const tDiv = document.getElementById('toggles');

  // Clear everything once (portal toggles own the container)
  tDiv.innerHTML = '';

  const toggles = meta.meta.portalToggles || {};

  Object.keys(toggles).forEach(k => {
    const row = document.createElement('div');
    row.className = 'list-item';

    const label = document.createElement('div');
    label.textContent = k;

    const btn = document.createElement('button');
    btn.textContent = toggles[k] ? 'ON' : 'OFF';

    btn.addEventListener('click', async () => {
      const res = await fetch('/api/admin/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: k, value: !toggles[k] })
      });

      const j = await res.json();
      if (j.success) {
        window.loadToggles();
      } else {
        alert(j.error || 'Error toggling');
      }
    });

    row.appendChild(label);
    row.appendChild(btn);
    tDiv.appendChild(row);
  });

  // Load test toggles AFTER portal toggles
  window.loadTestToggles();
};


window.loadTestToggles = async function () {
  const resp = await fetch('/api/admin/testToggles', { credentials: 'include' });
  if (!resp.ok) return;

  const body = await resp.json();
  const toggles = body.testToggles || {};
  const tDiv = document.getElementById('toggles');

  // 🔥 REMOVE previous test toggle section only
  const oldSection = tDiv.querySelector('.test-toggle-section');
  if (oldSection) oldSection.remove();

  // Create a dedicated wrapper (this is the key fix)
  const section = document.createElement('div');
  section.className = 'test-toggle-section';

  const divider = document.createElement('h4');
  divider.textContent = 'Test/Exam Toggles';
  section.appendChild(divider);

  Object.keys(toggles).forEach(k => {
    const row = document.createElement('div');
    row.className = 'list-item';

    const label = document.createElement('div');
    label.textContent = k.toUpperCase();

    const btn = document.createElement('button');
    btn.textContent = toggles[k] ? 'ON' : 'OFF';

    btn.addEventListener('click', async () => {
      await fetch('/api/admin/testToggles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ key: k, value: !toggles[k] })
      });

      // Re-render test toggles cleanly
      window.loadTestToggles();
    });

    row.appendChild(label);
    row.appendChild(btn);
    section.appendChild(row);
  });

  tDiv.appendChild(section);
};


//////////////////////
// UPLOAD LOGO (unchanged)
//////////////////////
document.getElementById('uploadForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(uploadForm);
  const r = await fetch('/api/admin/upload', { method: 'POST', body: fd, credentials: 'include' });
  const j = await r.json();
  if (j.success) alert('Uploaded: ' + j.path);
  else alert('Upload failed: ' + (j.error || 'Unknown error'));
};

//////////////////////
// PDF LIST (unchanged)
//////////////////////
window.loadPdfs = async function () {
  const r = await fetch('/api/admin/pdfs', { credentials: 'include' });
  if (!r.ok) return;
  const j = await r.json();
  const pDiv = document.getElementById('pdfList');
  pDiv.innerHTML = '';
  (j.pdfs || []).forEach(p => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `<div>${p.type} - ${p.studentId} - ${new Date(p.timestamp).toLocaleString()}</div>
      <div><a href="${p.filePath}" target="_blank">Open</a></div>`;
    pDiv.appendChild(row);
  });
};
//////////////////////
// CLASSES (populate list + selectors)
//////////////////////

window.loadClasses = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });

  // If session expired, force login screen
  if (r.status === 401) {
    alert('Session expired — please login again');
    if (document.getElementById('loginPage')) {
      document.getElementById('loginPage').style.display = 'block';
    }
    if (document.getElementById('adminPanel')) {
      document.getElementById('adminPanel').style.display = 'none';
    }
    return;
  }

  if (!r.ok) {
    console.error('Failed loading classes:', r.status);
    return;
  }

  const j = await r.json();
  const cDiv = document.getElementById('classList');
  cDiv.innerHTML = '';

  if (typeof classSelectorEl !== 'undefined' && classSelectorEl) {
    classSelectorEl.innerHTML = `<option value="">-- Choose Class --</option>`;
  }
  if (typeof subjectSelectorEl !== 'undefined' && subjectSelectorEl) {
    subjectSelectorEl.innerHTML = `<option value="">-- Select Subject --</option>`;
  }

  (j.classes || []).forEach(c => {
    const row = document.createElement('div');
    row.className = 'list-item';
    row.innerHTML = `<div>${c.name} (${c.id})</div>`;
    const delBtn = document.createElement('button');
    delBtn.textContent = "Delete";
    delBtn.addEventListener("click", () => deleteClass(c.id));
    row.appendChild(delBtn);
    cDiv.appendChild(row);

    if (typeof classSelectorEl !== 'undefined' && classSelectorEl) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.id})`;
      classSelectorEl.appendChild(opt);
    }
  });
};

// ===== ADD CLASS (OFFLINE-SAFE) =====
document.getElementById("addClassForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const fd = new FormData(e.target);

  const id = fd.get("id").trim();
  const name = fd.get("name").trim();
  const password = fd.get("password")?.trim() || "";

  const payload = { id, name, password };

const response = await fetch("/api/admin/class", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const result = await response.json();


  // If saved offline
  if (result?.offline) {
    alert("No internet. Class saved offline and will sync automatically.");
    return;
  }

  // Normal online response
  if (result?.success) {
    alert("Class added successfully");
    window.loadClasses();
  } else {
    alert(result?.error || "Failed to add class");
  }
});

//////////////////////
// SUBJECTS & QUESTIONS (class-wise only)
//////////////////////
window.loadSubjects = async function (classId = null) {
  if (!classId) {
    console.warn("No class selected for subject loading.");
    return;
  }

  let r;
  try {
    r = await fetch(
      `/api/admin/subjects?classId=${encodeURIComponent(classId)}`,
      { credentials: "include" }
    );
  } catch (err) {
    console.error("Network error loading subjects", err);
    return;
  }

  if (!r.ok) {
    console.error("Failed to fetch subjects");
    return;
  }

  const j = await r.json();
  const subjects = j.subjects || [];

  const sDiv = document.getElementById("subjectsList");
  if (!sDiv) {
    console.error("subjectsList container not found");
    return;
  }
  sDiv.innerHTML = "";

  if (typeof subjectSelectorEl !== "undefined" && subjectSelectorEl) {
    subjectSelectorEl.innerHTML =
      `<option value="">-- Select Subject --</option>`;
  }

  subjects.forEach(subj => {
    // ================= WRAPPER =================
    const wrapper = document.createElement("div");
    wrapper.className = "subject-block";
    wrapper.style.cssText =
      "border:1px solid #ddd;padding:10px;margin-bottom:12px;border-radius:6px;background:#f9f9f9";

    // ================= HEADER =================
    if (typeof subjectSelectorEl !== "undefined" && subjectSelectorEl) {
      const opt = document.createElement("option");
      opt.value = subj.id;
      opt.textContent = `${subj.name} (${subj.id}) — Class: ${subj.classId}`;
      subjectSelectorEl.appendChild(opt);
    }

    const header = document.createElement("div");
    header.innerHTML = `<b>${subj.name} (${subj.id}) — Class: ${subj.classId}</b>`;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.textContent = "Delete Subject";
    delBtn.onclick = async () => {
      if (!confirm(`Delete subject ${subj.name}?`)) return;
      await fetch(
        `/api/admin/subject/${subj.id}?classId=${encodeURIComponent(subj.classId)}`,
        { method: "DELETE", credentials: "include" }
      );
      window.loadSubjects(classId);
    };

    header.appendChild(delBtn);
    wrapper.appendChild(header);

    // ================= TIMING FORM (FIX) =================
    const timingForm = document.createElement("form");
    timingForm.innerHTML = `
      <hr>
      <b>Set Timings (minutes)</b><br>
      <input type="number" name="test1" placeholder="Test 1" value="${subj.timeLimits?.test1 ?? 30}">
      <input type="number" name="test2" placeholder="Test 2" value="${subj.timeLimits?.test2 ?? 30}">
      <input type="number" name="test3" placeholder="Test 3" value="${subj.timeLimits?.test3 ?? 30}">
      <input type="number" name="exam"  placeholder="Exam"  value="${subj.timeLimits?.exam  ?? 60}">
      <button type="submit">Save Timings</button>
    `;

    timingForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(timingForm);

      await fetch("/api/admin/subject/timings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          subjectId: subj.id,
          classId: subj.classId,
          timings: {
            test1: Number(fd.get("test1")) || 30,
            test2: Number(fd.get("test2")) || 30,
            test3: Number(fd.get("test3")) || 30,
            exam:  Number(fd.get("exam"))  || 60
          }
        })
      });

      alert("Timings updated successfully");
      window.loadSubjects(classId);
    };

    wrapper.appendChild(timingForm);

    // ================= QUESTIONS =================
    const qContainer = document.createElement("div");
    qContainer.style.marginTop = "10px";

    ["test1", "test2", "test3", "exam"].forEach(type => {
      const qList = (subj.questions && subj.questions[type]) || [];
      const qBlock = document.createElement("div");
      qBlock.style.marginTop = "8px";

      const title = document.createElement("h4");
      title.textContent = type.toUpperCase() + " QUESTIONS";
      title.style.color = "#004080";
      qBlock.appendChild(title);

      if (!qList.length) {
        const none = document.createElement("div");
        none.textContent = "(No questions yet)";
        none.style.color = "#666";
        qBlock.appendChild(none);
      } else {
        qList.forEach(q => {
          const qRow = document.createElement("div");
          qRow.style.cssText =
            "border-bottom:1px solid #ddd;padding:5px 0";

          qRow.innerHTML = `
            <div><b>${q.qid}:</b> ${q.text}</div>
            ${q.image ? `<img src="${q.image}" style="max-width:200px;margin:5px 0">` : ""}
            <div><i>Options:</i> ${Array.isArray(q.options) ? q.options.join(", ") : q.options}</div>
            <div><i>Answer:</i> ${q.answer}</div>
            <div><i>Marks:</i> ${q.marks}</div>
          `;

          const delQBtn = document.createElement("button");
          delQBtn.textContent = "Delete Question";
          delQBtn.onclick = async () => {
            if (!confirm(`Delete question ${q.qid}?`)) return;
            await fetch(
              `/api/admin/question/${subj.id}/${q.qid}/${subj.classId}`,
              { method: "DELETE", credentials: "include" }
            );
            window.loadSubjects(classId);
          };

          qRow.appendChild(delQBtn);
          qBlock.appendChild(qRow);
        });
      }

      qContainer.appendChild(qBlock);
    });

    wrapper.appendChild(qContainer);
    sDiv.appendChild(wrapper);
 

    // ================= ADD QUESTION =================
    const qForm = document.createElement("form");
    qForm.enctype = "multipart/form-data";
    qForm.innerHTML = `
      <hr><b>Add New Question</b><br>
      <select name="type" required>
        <option value="">Select Type</option>
        <option value="test1">Test 1</option>
        <option value="test2">Test 2</option>
        <option value="test3">Test 3</option>
        <option value="exam">Exam</option>
      </select>
      <input name="qid" placeholder="Question ID" required>
      <input name="text" placeholder="Question Text" required>
      <input name="options" placeholder="Options (comma separated)" required>
      <input name="answer" placeholder="Answer" required>
      <input name="marks" type="number" value="1">
      <input type="file" name="image" accept="image/*">
      <button type="submit">Add Question</button>
    `;

    qForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(qForm);
      fd.append("subjectId", subj.id);
      fd.append("classId", subj.classId);
      fd.set("type", String(fd.get("type")).toLowerCase());

      await fetch("/api/admin/question", {
        method: "POST",
        body: fd,
        credentials: "include"
      });

      window.loadSubjects(classId);
    };

    wrapper.appendChild(qForm);

    // ================= BULK CSV UPLOAD =================
    const csvForm = document.createElement("form");
    csvForm.enctype = "multipart/form-data";
    csvForm.innerHTML = `
      <hr><b>Bulk Upload Questions (CSV)</b><br>
      <input type="file" name="csv" accept=".csv" required>
      <button type="submit">Upload CSV</button>
      <div style="font-size:12px;color:#555">
        CSV columns: Type,QuestionID,QuestionText,Options,Answer,Mark
      </div>
    `;

    csvForm.onsubmit = async e => {
      e.preventDefault();
      const fd = new FormData(csvForm);
      fd.append("subjectId", subj.id);
      fd.append("classId", subj.classId);

      const res = await fetch("/api/admin/questions/bulk-upload", {
        method: "POST",
        body: fd,
        credentials: "include"
      });

      const out = await res.json();
      alert(out.success ? "CSV uploaded successfully" : (out.error || "CSV upload failed"));
      window.loadSubjects(classId);
    };

    wrapper.appendChild(csvForm);

    // ================= ACTION BUTTONS =================
    const pdfBtn = document.createElement("button");
    pdfBtn.type = "button";
    pdfBtn.textContent = "Generate Question PDF";
    pdfBtn.onclick = async () => {
      let type = prompt("Enter type (test1/test2/test3/exam)");
      if (!type) return;
      type = type.toLowerCase();

      const r = await fetch(
        `/api/admin/questions/pdf?classId=${subj.classId}&subjectId=${subj.id}&type=${type}`,
        { credentials: "include" }
      );

      const j = await r.json();
      if (j.file) window.open(j.file, "_blank");
      else alert(j.error || "Failed to generate PDF");
    };

    const forwardBtn = document.createElement("button");
    forwardBtn.type = "button";
    forwardBtn.textContent = "Forward Questions";
    forwardBtn.onclick = async () => {
      const toClass = prompt("Enter target class ID");
      if (!toClass) return;

      await fetch("/api/admin/questions/forward", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          fromClass: subj.classId,
          toClass,
          subjectId: subj.id
        })
      });

      alert("Questions forwarded");
      window.loadSubjects(classId);
    };

    wrapper.appendChild(pdfBtn);
    wrapper.appendChild(forwardBtn);

    // ================= FINAL APPEND =================
    sDiv.appendChild(wrapper);
  });
};


//////////////////////
// ADD SUBJECT (class-wise)
//////////////////////
document.addEventListener("DOMContentLoaded", () => {
  const addSubjectForm = document.getElementById("addSubjectForm");
  const classSelectorEl = document.getElementById("classSelector");

  if (!addSubjectForm) {
    console.warn("addSubjectForm not found");
    return;
  }

  addSubjectForm.addEventListener("submit", async e => {
    e.preventDefault(); // 🚫 stop page refresh

    const fd = new FormData(addSubjectForm);
    const classIdVal = classSelectorEl?.value;

    if (!classIdVal) {
      alert("Please select a class first");
      return;
    }

    try {
      const res = await fetch("/api/admin/subject", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          id: fd.get("id"),
          name: fd.get("name"),
          classId: classIdVal
        })
      });

      const j = await res.json();

      if (j && j.success) {
        addSubjectForm.reset();
        window.loadSubjects(classIdVal); // 🔁 refresh subject list
      } else {
        alert(j.error || "Failed to add subject");
      }
    } catch (err) {
      console.error("Add subject error:", err);
      alert("Network error while adding subject");
    }
  });
});


//////////////////////
// STUDENTS (unchanged)
//////////////////////
window.loadStudents = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });
  if (!r.ok) return;
  const j = await r.json();
  const sDiv = document.getElementById('studentList');
  sDiv.innerHTML = '';

  for (const cls of (j.classes || [])) {
    const r2 = await fetch(`/api/admin/class/${cls.id}/students`, { credentials: 'include' });
    if (!r2.ok) continue;
    const j2 = await r2.json();
    const block = document.createElement('div');
    block.innerHTML = `<h4>${cls.name} (${cls.id})</h4>`;

    (j2.students || []).forEach(st => {
      const row = document.createElement('div');
      row.className = 'list-item';
      row.innerHTML = `<div>${st.name} (${st.id})</div>`;

      // ✅ Single ID card button (unchanged)
      const idBtn = document.createElement('button');
      idBtn.textContent = "Generate ID Card";
      idBtn.addEventListener("click", async () => {
        try {
          const res = await fetch(`/api/admin/idcard/${st.id}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: 'include'
          });
          if (!res.ok) {
            const errText = await res.text();
            console.error("❌ Server error:", errText);
            alert("Failed to generate ID card: " + errText);
            return;
          }
          const blob = await res.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = url;
          a.download = `${st.id}_idcard.pdf`;
          a.click();
          URL.revokeObjectURL(url);
        } catch (err) {
          console.error("❌ Frontend Error:", err);
          alert("Error generating ID card");
        }
      });

      const delBtn = document.createElement('button');
      delBtn.textContent = "Delete";
      delBtn.addEventListener("click", () => deleteStudent(st.id));

      row.appendChild(idBtn);
      row.appendChild(delBtn);
      block.appendChild(row);
    });
    sDiv.appendChild(block);
  }
};

document.getElementById('addStudentForm').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(addStudentForm);
  await fetch('/api/admin/student', { method: 'POST', body: fd, credentials: 'include' });
  window.loadStudents();
};

//////////////////////
// Delete helpers
//////////////////////
async function deleteSubject(id, classId = '') {
  if (!confirm('Delete subject ' + id + '?')) return;
  const url = classId 
    ? `/api/admin/subject/${encodeURIComponent(id)}?classId=${encodeURIComponent(classId)}` 
    : `/api/admin/subject/${encodeURIComponent(id)}`;
  await fetch(url, { method: 'DELETE', credentials: 'include' });
  const sel = classSelectorEl ? classSelectorEl.value : null;
  window.loadSubjects(sel || null);
}

async function deleteClass(id) {
  if (!confirm('Delete class ' + id + '? This will also remove its students.')) return;
  await fetch('/api/admin/class/' + id, { method: 'DELETE', credentials: 'include' });
  window.loadClasses();
  window.loadStudents();
}

async function deleteStudent(id) {
  if (!confirm('Delete student ' + id + '?')) return;
  await fetch('/api/admin/student/' + id, { method: 'DELETE', credentials: 'include' });
  window.loadStudents();
}

////////////////////////////////////////////////
// ✅ BULK ID CARD SECTION — FIXED
////////////////////////////////////////////////

// ❌ REMOVE the auto-load on page load
// window.addEventListener("DOMContentLoaded", loadClassesForBulkID);

// ✅ Call this AFTER login when admin dashboard shows
async function loadClassesForBulkID() {
  try {
    const res = await fetch('/api/admin/classes', { credentials: 'include' });

    if (!res.ok) {
      console.warn("⚠️ Admin not logged in — bulk ID classes not loaded yet");
      return;
    }

    const data = await res.json();
    const classes = data.classes || [];

    const classSelect = document.getElementById("bulkClassSelect");
    if (!classSelect) return;

    classSelect.innerHTML = `<option value="">-- Select Class --</option>`;

    classes.forEach(c => {
      const opt = document.createElement("option");
      opt.value = c.id.trim();
      opt.textContent = `${c.id} — ${c.name}`;
      classSelect.appendChild(opt);
    });

    console.log("✅ Bulk ID classes loaded:", classes);

  } catch (err) {
    console.error("❌ Load bulk ID classes failed", err);
  }
}


// ✅ Bulk ID Generate Click Handler
const bulkBtn = document.getElementById("bulkIdGenerateBtn");
if (bulkBtn) {
  bulkBtn.addEventListener("click", async (e) => {
    e.preventDefault();

    const classId = document.getElementById("bulkClassSelect").value;
    const statusBar = document.getElementById("bulkIdStatus");

    if (!classId) {
      statusBar.style.background = "#ffdddd";
      statusBar.textContent = "⚠️ Select a class first.";
      return;
    }

    statusBar.style.background = "#fff3cd";
    statusBar.textContent = "⏳ Generating ID cards...";

    try {
      const res = await fetch(`/api/admin/idcards/class/${encodeURIComponent(classId)}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" }
      });

      const result = await res.json();

      if (!res.ok || !result.success) {
        statusBar.style.background = "#ffdddd";
        statusBar.textContent = `❌ Failed: ${result.error || "Unknown error"}`;
        return;
      }

      statusBar.style.background = "#d4edda";
      statusBar.textContent =
        `✅ ID cards generated for class ${classId}  
📁 Check folder: public/idcards/bulk/${classId}/`;

    } catch (err) {
      console.error("Bulk ID card error:", err);
      statusBar.style.background = "#ffdddd";
      statusBar.textContent = "❌ Network or server error";
    }
  });
}

//////////////////////
// LOGIN (unchanged)
//////////////////////
document.getElementById('adminLogin').onsubmit = async (e) => {
  e.preventDefault();
  const fd = new FormData(adminLogin);
  const r = await fetch('/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username: fd.get('username'), password: fd.get('password') })
  });
  const j = await safeJson(r);
  if (j && j.success) {
    document.getElementById('loginArea').style.display = 'none';
    document.getElementById('adminArea').style.display = 'block';
    window.loadToggles();
    window.loadPdfs();
    await window.loadClasses();      // populate classes & selector
    // If a class is selected in the selector, load subjects for it
    if (classSelectorEl) {
      classSelectorEl.addEventListener('change', () => {
        const val = classSelectorEl.value || null;
        window.loadSubjects(val);
      });
    }
    // load subjects for currently selected class if any
    const selected = classSelectorEl ? classSelectorEl.value : null;
    window.loadSubjects(selected || null);
    window.loadStudents();
  } else alert((j && j.error) || 'Login failed');
};

//////////////////////
// small preview for the global add question form (if present)
//////////////////////
const globalImgInput = document.querySelector('#addQuestionForm input[name="image"]');
const globalPreview = document.getElementById('questionPreview');
if (globalImgInput && globalPreview) {
  globalImgInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (ev) => {
        globalPreview.src = ev.target.result;
        globalPreview.style.display = 'block';
      };
      reader.readAsDataURL(file);
    } else {
      globalPreview.style.display = 'none';
    }
  });
}
//////////////////////
// CLASSES (SINGLE SOURCE OF TRUTH)
//////////////////////

window.loadClasses = async function () {
  const r = await fetch('/api/admin/classes', { credentials: 'include' });

  if (r.status === 401) {
    alert('Session expired — please login again');
    document.getElementById('loginArea').style.display = 'block';
    document.getElementById('adminArea').style.display = 'none';
    return;
  }

  if (!r.ok) {
    console.error('Failed loading classes:', r.status);
    return;
  }

  const { classes } = await r.json();

  // ===== Admin class list =====
  const cDiv = document.getElementById('classList');
  if (cDiv) cDiv.innerHTML = '';

  // ===== Shared selectors =====
  const selectors = [
    document.getElementById('classSelector'),
    document.getElementById('analyticsClass'),
    document.getElementById('attendanceClassSelect'),
    document.getElementById('bulkClassSelect')
  ].filter(Boolean);

  selectors.forEach(sel => {
    sel.innerHTML = `<option value="">-- Select Class --</option>`;
  });

  classes.forEach(c => {
    // --------- CLASS LIST ----------
    if (cDiv) {
      const row = document.createElement('div');
      row.className = 'list-item';

      const name = document.createElement('div');
      name.textContent = `${c.name} (${c.id})`;

      const delBtn = document.createElement('button');
      delBtn.textContent = "Delete";
      delBtn.onclick = () => deleteClass(c.id);

      const lockBtn = document.createElement('button');
      lockBtn.textContent = c.locked ? "🔒 Unlock" : "🔓 Lock";
      lockBtn.style.marginLeft = "6px";
      lockBtn.onclick = async () => {
        await fetch(`/api/admin/class/${encodeURIComponent(c.id)}/lock`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ locked: !c.locked })
        });
        window.loadClasses();
      };

      row.append(name, delBtn, lockBtn);
      cDiv.appendChild(row);
    }

    // --------- ALL SELECTORS ----------
    selectors.forEach(sel => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = `${c.name} (${c.id})`;
      sel.appendChild(opt);
    });
  });

  console.log("✅ Classes loaded & synchronized:", classes.length);
};

window.bulkPromoteStudents = async function () {
  const fromClass = prompt("Enter SOURCE class ID");
  if (!fromClass) return;

  const toClass = prompt("Enter TARGET class ID");
  if (!toClass) return;

  if (!confirm(`Promote ALL students from ${fromClass} to ${toClass}?`)) return;

  const res = await fetch("/api/admin/students/promote", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ fromClass, toClass })
  });

  const j = await res.json();

  if (!res.ok) {
    alert(j.error || "Promotion failed");
    return;
  }

  alert(`${j.count} students promoted successfully`);
  window.loadStudents();
};

// ================= SOFTWARE MANAGEMENT =================

// SYSTEM STATUS (future Mega Server hook)
async function loadSystemStatus() {
  try {
    const res = await fetch("/api/system/status");
    if (!res.ok) return;

    const j = await res.json();
    const el = document.getElementById("systemStatus");
    if (el) {
      el.textContent = j.locked ? "LOCKED" : "ACTIVE";
      el.style.color = j.locked ? "red" : "green";
    }
  } catch {
    // silent fail
  }
}

// DOWNLOAD STUDENT STATS
const statsBtn = document.getElementById("downloadStudentStatsBtn");
if (statsBtn) {
  statsBtn.addEventListener("click", () => {
    window.open("/api/admin/student-stats-pdf", "_blank");
  });
}

// RESET DATA (DOUBLE CONFIRM – SIMPLE)
const resetBtn = document.getElementById("resetDataBtn");
if (resetBtn) {
  resetBtn.addEventListener("click", async () => {
    if (!confirm("⚠ Are you ABSOLUTELY sure you want to reset ALL data?")) return;
    if (!confirm("❌ FINAL CONFIRMATION: This cannot be undone. Proceed?")) return;

    try {
      const res = await fetch("/api/admin/reset-data", { method: "POST" });
      const j = await res.json();

      if (j.success) {
        alert("✅ System data reset successfully.");
        location.reload();
      } else {
        alert("❌ Reset failed.");
      }
    } catch {
      alert("❌ Server error during reset.");
    }
  });
}

// SEND FEATURE REQUEST
const featureBtn = document.getElementById("sendFeatureRequestBtn");
if (featureBtn) {
  featureBtn.addEventListener("click", async () => {
    const textarea = document.getElementById("featureRequestText");
    if (!textarea) return;

    const msg = textarea.value.trim();
    if (!msg) return alert("Please enter your request.");

    try {
      const res = await fetch("/api/admin/feature-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg })
      });

      const j = await res.json();
      if (j.success) {
        alert("📨 Request sent to developer.");
        textarea.value = "";
      } else {
        alert("❌ Failed to send request.");
      }
    } catch {
      alert("❌ Network error.");
    }
  });
}

// LOAD STATUS ON PAGE LOAD
loadSystemStatus();

// ===============================
// VIEW DATA.JSON (SAFE)
// ===============================
const viewDataBtn = document.getElementById("viewDataBtn");
if (viewDataBtn) {
  viewDataBtn.onclick = async () => {
    const res = await fetch("/api/admin/data-view");
    if (!res.ok) return;

    const data = await res.json();
    const viewer = document.getElementById("dataViewer");
    if (viewer) {
      viewer.textContent = JSON.stringify(data, null, 2);
      viewer.style.display = "block";
    }
  };
}

// ===============================
// RESET ALL DATA (PROMPT VERSION)
// ===============================
const resetAllBtn = document.getElementById("resetDataBtn");
if (resetAllBtn) {
  resetAllBtn.onclick = async () => {
    const c1 = prompt("Type YES to continue");
    if (c1 !== "YES") return alert("Cancelled");

    const c2 = prompt("Type RESET to confirm FULL DELETE");
    if (c2 !== "RESET") return alert("Cancelled");

    const res = await fetch("/api/admin/reset-data", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm1: c1, confirm2: c2 })
    });

    const result = await res.json();
    if (result.success) {
      alert("All data cleared successfully");
      location.reload();
    } else {
      alert("Reset failed");
    }
  };
}

// ===============================
// SAVE SCHOOL INFO (SAFE)
// ===============================
const saveSchoolBtn = document.getElementById("saveSchoolInfo");
if (saveSchoolBtn) {
  saveSchoolBtn.onclick = async () => {
    const payload = {
      name: school_name?.value || "",
      address: school_address?.value || "",
      phone: school_phone?.value || "",
      motto: school_motto?.value || ""
    };

    await fetch("/api/admin/school", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    alert("School information updated");
  };
}

// ===============================
// OFFLINE ADMIN SYNC
// ===============================
async function syncAdminQueue() {
  if (!navigator.onLine || typeof adminDB === "undefined" || !adminDB) return;

  const tx = adminDB.transaction("queue", "readwrite");
  const store = tx.objectStore("queue");

  store.getAll().onsuccess = async e => {
    const pending = e.target.result.filter(x => !x.synced);
    if (pending.length === 0) return;

    try {
      const res = await fetch("/offline-sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pending)
      });

      if (!res.ok) return;

      pending.forEach(item => {
        item.synced = true;
        store.put(item);
      });

      console.log("Admin offline actions synced:", pending.length);
    } catch {
      // silent
    }
  };
}

// ================= TEACHER MANAGEMENT =================
function initTeacherManagement() {
  const form = document.getElementById("addTeacherForm");
  const list = document.getElementById("teacherList");
  const jet = document.getElementById("attendanceJet"); // reuse jet indicator

  if (!form || !list) return;

  // ----------------- Jet helpers -----------------
  function showJet(text = "🚀 Sending…") {
    if (!jet) return;
    jet.textContent = text;
    jet.classList.remove("hidden");
  }

  function hideJet(text = "🚀 Sending…", delay = 1000) {
    if (!jet) return;
    setTimeout(() => {
      jet.classList.add("hidden");
      jet.textContent = text;
    }, delay);
  }
  // -----------------------------------------------

  async function loadTeachers() {
    const res = await fetch("/api/admin/teachers", {
      credentials: "include"
    });
    if (!res.ok) return;

    const { teachers } = await res.json();
    list.innerHTML = "";

    teachers.forEach(t => {
      const div = document.createElement("div");
      div.style.border = "1px solid #ddd";
      div.style.padding = "8px";
      div.style.marginBottom = "6px";
      div.style.borderRadius = "6px";

      div.innerHTML = `
        <strong>${t.name}</strong> (${t.id})<br>
        Status:
        <b style="color:${t.blocked ? "red" : "green"}">
          ${t.blocked ? "Blocked" : "Active"}
        </b><br>
        <button data-toggle="${t.id}">
          ${t.blocked ? "Unblock" : "Block"}
        </button>
        <button data-delete="${t.id}" style="background:#b00020;color:#fff;">
          Delete
        </button>
      `;

      list.appendChild(div);
    });

    // -------- Toggle teacher --------
    list.querySelectorAll("[data-toggle]").forEach(btn => {
      btn.onclick = async () => {
        const id = encodeURIComponent(btn.dataset.toggle);

        showJet("🚀 Updating status…");

        try {
          await fetch(`/api/admin/teacher/${id}/toggle`, {
            method: "PUT",
            credentials: "include"
          });

          showJet("✅ Status updated");
          loadTeachers();
          hideJet();
        } catch {
          showJet("❌ Failed");
          hideJet("🚀 Sending…", 1500);
        }
      };
    });

    // -------- Delete teacher --------
    list.querySelectorAll("[data-delete]").forEach(btn => {
      btn.onclick = async () => {
        if (!confirm("Delete this teacher?")) return;

        const id = encodeURIComponent(btn.dataset.delete);
        showJet("🚀 Deleting teacher…");

        try {
          await fetch(`/api/admin/teacher/${id}`, {
            method: "DELETE",
            credentials: "include"
          });

          showJet("✅ Teacher deleted");
          loadTeachers();
          hideJet();
        } catch {
          showJet("❌ Failed");
          hideJet("🚀 Sending…", 1500);
        }
      };
    });
  }

  // -------- Add teacher --------
  form.onsubmit = async e => {
    e.preventDefault();

    const payload = {
      id: form.id.value.trim(),
      name: form.name.value.trim(),
      password: form.password.value.trim()
    };

    showJet("🚀 Adding teacher…");

    try {
      const res = await fetch("/api/admin/teacher", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        const err = await res.json();
        showJet("❌ Failed");
        hideJet("🚀 Sending…", 1500);
        return alert(err.error || "Failed");
      }

      showJet("✅ Teacher added");
      form.reset();
      loadTeachers();
      hideJet();
    } catch {
      showJet("❌ Failed");
      hideJet("🚀 Sending…", 1500);
    }
  };

  loadTeachers();
}



 // ================= ATTENDANCE REPORTS =================
(async function initAttendanceReports() {
  const sel = document.getElementById('attendanceClassSelect');
  const btn = document.getElementById('loadAttendanceBtn');
  const delBtn = document.getElementById('deleteAttendanceBtn');
  const viewer = document.getElementById('attendanceViewer');
 if (!sel || !viewer || !btn) return;
  // Load classes
  const res = await fetch('/api/admin/classes', { credentials: 'include' });
  if (!res.ok) return;

  const { classes } = await res.json();
  sel.innerHTML = '<option value="">Select Class</option>';

  classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.id})`;
    sel.appendChild(opt);
  });

  // Load attendance
  btn.onclick = async () => {
    if (!sel.value) return alert('Select class');

    const r = await fetch(`/api/admin/attendance/${sel.value}`, {
      credentials: 'include'
    });

    const j = await r.json();
    viewer.textContent = JSON.stringify(j.attendance, null, 2);
  };

  // 🔥 DELETE ATTENDANCE
  delBtn.onclick = async () => {
    if (!sel.value) return alert('Select class');

    const ok = confirm(
      `⚠️ This will permanently delete ALL attendance for class ${sel.value}.\n\nContinue?`
    );

    if (!ok) return;

    const r = await fetch(`/api/admin/attendance/${sel.value}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    const j = await r.json();

    if (!r.ok) {
      alert(j.error || 'Delete failed');
      return;
    }

    viewer.textContent = '';
    alert('✅ Attendance deleted permanently');
  };
})();

function getDateRange(mode) {
  const today = new Date();
  let from, to;

  if (mode === "weekly") {
    const day = today.getDay() || 7;
    today.setDate(today.getDate() - day + 1);
    from = today.toISOString().slice(0, 10);
    today.setDate(today.getDate() + 4);
    to = today.toISOString().slice(0, 10);
  }

  if (mode === "monthly") {
    from = new Date(today.getFullYear(), today.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    to = new Date(today.getFullYear(), today.getMonth() + 1, 0)
      .toISOString()
      .slice(0, 10);
  }

  return { from, to };
}

function downloadClassAttendance(mode = "monthly") {
  const cls = prompt("Enter Class ID");
  if (!cls) return;

  const { from, to } = getDateRange(mode);

  fetch(`/api/admin/attendance/class/${cls}/pdf?from=${from}&to=${to}`)
    .then(r => r.json())
    .then(j => window.open(j.file, "_blank"));
}

function downloadTeacherAttendance(mode = "monthly") {
  const { from, to } = getDateRange(mode);

  fetch(`/api/admin/attendance/teachers/pdf?from=${from}&to=${to}`)
    .then(r => r.json())
    .then(j => window.open(j.file, "_blank"));
}
async function loadResultAnalytics() {
  const classId = document.getElementById("analyticsClass")?.value;
  const canvas = document.getElementById("analyticsCanvas");
  const summary = document.getElementById("analyticsSummary");

  if (!classId || !canvas || !summary) {
    summary.textContent = "Select a class to view analytics.";
    return;
  }

  const ctx = canvas.getContext("2d");
  canvas.width = canvas.offsetWidth || 600;
  canvas.height = canvas.offsetHeight || 300;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  summary.textContent = "Loading analytics…";

  // --------- FETCH DATA ----------
  const [rankRes, topRes, pfRes] = await Promise.all([
    fetch(`/api/admin/results/ranking?classId=${classId}`, { credentials: "include" }),
    fetch(`/api/admin/results/top5?classId=${classId}`, { credentials: "include" }),
    fetch(`/api/admin/results/passfail?classId=${classId}`, { credentials: "include" })
  ]);

  const ranking = (await rankRes.json()).ranking || [];
  const passFail = await pfRes.json();

  if (!ranking.length) {
    summary.textContent = "No result data available.";
    return;
  }

  // --------- DRAW PASS / FAIL ----------
  const values = [passFail.pass, passFail.fail];
  const labels = ["Pass", "Fail"];
  const max = Math.max(...values, 1);

  const barWidth = 80;
  const gap = 40;
  const baseY = canvas.height - 40;

  values.forEach((v, i) => {
    const h = (v / max) * (canvas.height - 80);
    const x = 80 + i * (barWidth + gap);

    ctx.fillStyle = i === 0 ? "#198754" : "#dc3545";
    ctx.fillRect(x, baseY - h, barWidth, h);

    ctx.fillStyle = "#000";
    ctx.fillText(labels[i], x + 15, baseY + 15);
    ctx.fillText(v, x + 30, baseY - h - 6);
  });

  summary.textContent =
    `🏆 Top Student: ${ranking[0].studentId} | ` +
    `📊 Pass: ${passFail.pass}, Fail: ${passFail.fail}`;
}

document
  .getElementById("loadAnalyticsBtn")
  ?.addEventListener("click", loadResultAnalytics);

// ================= INIT =================
document.addEventListener("DOMContentLoaded", initTeacherManagement);
