let currentClass = null;
let students = [];

/* ========================= */
/* TEACHER LOGIN             */
/* ========================= */

async function loginTeacher() {
  const teacherId = document.getElementById('teacherId').value.trim();
  const password = document.getElementById('teacherPassword').value.trim();

  if (!teacherId || !password) {
    return alert('Enter teacher credentials');
  }

  const res = await fetch('/api/attendance/teacher/login', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teacherId, password })
  });

  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    return alert(e.error || 'Login failed');
  }

  document.getElementById('teacherLogin').style.display = 'none';
  document.getElementById('attendancePanel').style.display = 'block';

  loadClasses();
}

/* ========================= */
/* LOAD CLASSES              */
/* ========================= */

async function loadClasses() {
  const res = await fetch('/api/attendance/classes', {
    credentials: 'include'
  });

  if (!res.ok) return;

  const { classes } = await res.json();
  const sel = document.getElementById('classSelect');

  sel.innerHTML = '<option value="">Select Class</option>';

  classes.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c.id;
    opt.textContent = `${c.name} (${c.id})`;
    sel.appendChild(opt);
  });

  sel.onchange = () => {
    currentClass = sel.value;
    students = [];
    document.getElementById('studentList').innerHTML = '';
    document.getElementById('classPassword').value = '';
  };
}

/* ========================= */
/* LOAD STUDENTS AFTER PASSWORD */
/* ========================= */

async function loadStudents() {
  if (!currentClass) return alert('Select class first');

  const pwd = document.getElementById('classPassword').value.trim();
  if (!pwd) return alert('Enter class password');

  // Verify password first via mark endpoint (light check)
  const verify = await fetch('/api/attendance/mark', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: currentClass,
      classPassword: pwd,
      students: {}
    })
  });

  if (verify.status === 401) {
    return alert('Invalid class password');
  }

  if (verify.status === 400) {
    // ignore duplicate message, we only used it for verification
  }

  // Now fetch students
  const res = await fetch(`/api/attendance/class/${currentClass}/students`, {
    credentials: 'include'
  });

  if (!res.ok) {
    return alert('Failed to load students');
  }

  const data = await res.json();
  students = data.students || [];

  const list = document.getElementById('studentList');
  list.innerHTML = '';

  students.forEach(st => {
    const row = document.createElement('div');
    row.className = 'student';
    row.innerHTML = `
      <span>${st.name}</span>
      <input type="checkbox" data-id="${st.id}" checked />
    `;
    list.appendChild(row);
  });
}
/* ========================= */
/* SUBMIT ATTENDANCE         */
/* ========================= */

async function submitAttendance() {
  if (!currentClass) return alert('Select class');

  const pwd = document.getElementById('classPassword').value.trim();
  if (!pwd) return alert('Enter class password');

  const marks = {};

  document.querySelectorAll('#studentList input[type="checkbox"]').forEach(cb => {
    marks[cb.dataset.id] = cb.checked ? 'present' : 'absent';
  });

  const res = await fetch('/api/attendance/mark', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      classId: currentClass,
      classPassword: pwd,
      students: marks
    })
  });

  const msg = document.getElementById('successMsg');

  if (res.ok) {
    msg.style.display = 'block';
    setTimeout(() => (msg.style.display = 'none'), 3000);
  } else {
    const e = await res.json().catch(() => ({}));
    alert(e.error || 'Failed to submit');
  }
}

/* ========================= */
/* LOGOUT                    */
/* ========================= */

async function logoutTeacher() {
  try {
    await fetch('/api/teacher/logout', {
      method: 'POST',
      credentials: 'include'
    });
  } catch {}

  currentClass = null;
  students = [];

  document.getElementById('attendancePanel').style.display = 'none';
  document.getElementById('teacherLogin').style.display = 'block';

  document.getElementById('classSelect').innerHTML = '';
  document.getElementById('studentList').innerHTML = '';
  document.getElementById('classPassword').value = '';
  document.getElementById('teacherId').value = '';
  document.getElementById('teacherPassword').value = '';

  const msg = document.getElementById('successMsg');
  if (msg) msg.style.display = 'none';
}