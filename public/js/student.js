// Student SPA logic.

let quizId = null;
let participantId = null;
let quiz = null; // public quiz shape: {id, title, durationSeconds, status, startedAt, questions}
let answers = {}; // questionId -> selectedIndex
let submitted = false;
let socket = null;
let timerInterval = null;

const SESSION_KEY = 'quiz_session';

function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ quizId, participantId, answers }));
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

function screen(name) {
  ['join', 'waiting', 'quiz', 'locked', 'submitted', 'results'].forEach((s) => {
    document.getElementById(`screen-${s}`).classList.toggle('hidden', s !== name);
  });
}

// ---------- Resume after a refresh ----------
// A page refresh should NOT lose progress or count as leaving the quiz. We
// only ever auto-submit for a genuine tab/app switch (the Page Visibility
// API below), never for a reload — so on load we first check whether this
// browser already has a session for a quiz and silently reconnect to it.
async function init() {
  const saved = localStorage.getItem(SESSION_KEY);
  if (!saved) return screen('join');
  let sess;
  try {
    sess = JSON.parse(saved);
  } catch {
    return screen('join');
  }
  try {
    const data = await apiGet(`/api/quizzes/${sess.quizId}/rejoin/${sess.participantId}`);
    quizId = sess.quizId;
    participantId = sess.participantId;
    quiz = data.quiz;
    answers = sess.answers || {};
    submitted = !!data.participant.submitted;
    connectSocket();
    if (submitted) {
      if (data.participant.autoSubmitted && data.participant.reason === 'tab_switch') {
        screen('locked');
      } else if (quiz.status === 'ended') {
        showResults();
      } else {
        screen('submitted');
      }
    } else {
      routeByStatus();
    }
  } catch (e) {
    clearSession();
    screen('join');
  }
}

function leaveAndJoinAnother() {
  clearSession();
  quizId = participantId = quiz = null;
  answers = {};
  submitted = false;
  clearInterval(timerInterval);
  if (socket) socket.disconnect();
  socket = null;
  screen('join');
}

// ---------- Join ----------
async function handleJoin() {
  const code = document.getElementById('j-code').value.trim().toUpperCase();
  const name = document.getElementById('j-name').value.trim();
  const college = document.getElementById('j-college').value.trim();
  const rollNo = document.getElementById('j-roll').value.trim();
  const errEl = document.getElementById('j-error');
  errEl.style.display = 'none';

  if (!code || !name || !college) {
    errEl.textContent = 'Enter the quiz code, your name and college.';
    errEl.style.display = 'block';
    return;
  }
  try {
    const data = await apiPost(`/api/quizzes/${code}/join`, { name, college, rollNo });
    participantId = data.participantId;
    quiz = data.quiz;
    quizId = quiz.id;
    answers = {};
    saveSession();
    connectSocket();
    routeByStatus();
  } catch (e) {
    errEl.textContent = e.message;
    errEl.style.display = 'block';
  }
}

function connectSocket() {
  socket = io();
  socket.emit('join-room', { quizId, role: 'student' });
  socket.on('quiz-started', (payload) => {
    quiz.status = 'active';
    quiz.startedAt = payload.startedAt;
    if (!submitted) enterQuizScreen();
  });
  socket.on('quiz-ended', () => {
    if (!submitted) {
      submitted = true;
      clearInterval(timerInterval);
    }
    showResults();
  });
  socket.on('participant-joined', (p) => {
    if (!document.getElementById('screen-waiting').classList.contains('hidden')) {
      addRosterChip(p.name);
      document.getElementById('w-count').textContent = `${p.count} joined so far`;
    }
  });
}

function routeByStatus() {
  if (quiz.status === 'ended') {
    submitted = true;
    showResults();
  } else if (quiz.status === 'active') {
    enterQuizScreen();
  } else {
    screen('waiting');
    document.getElementById('w-title').textContent = `"${quiz.title}" — waiting for host to start…`;
    loadRoster();
  }
}

async function loadRoster() {
  try {
    const data = await apiGet(`/api/quizzes/${quizId}/roster`);
    const wrap = document.getElementById('w-roster');
    wrap.innerHTML = '';
    data.participants.forEach((p) => addRosterChip(p.name));
    document.getElementById('w-count').textContent = `${data.participants.length} joined so far`;
  } catch (e) {
    // Non-critical — the waiting screen still works without the roster.
  }
}

function addRosterChip(name) {
  const wrap = document.getElementById('w-roster');
  const chip = document.createElement('span');
  chip.className = 'pill';
  chip.style.margin = '4px';
  chip.textContent = name;
  wrap.appendChild(chip);
}

// ---------- Quiz taking ----------
function enterQuizScreen() {
  screen('quiz');
  document.getElementById('q-title').textContent = quiz.title;
  renderQuestions();
  startTimerLoop();
  attachTabSwitchGuard();
}

function renderQuestions() {
  const wrap = document.getElementById('q-questions');
  wrap.innerHTML = quiz.questions
    .map(
      (q, qi) => `
    <div class="card plain">
      <h3>${qi + 1}. ${escapeHtml(q.text)}</h3>
      <div id="opts-${q.id}">
        ${q.options
          .map(
            (opt, oi) => `
          <label class="option ${answers[q.id] === oi ? 'selected' : ''}" id="opt-${q.id}-${oi}">
            <input type="radio" name="ans-${q.id}" value="${oi}" ${answers[q.id] === oi ? 'checked' : ''} onchange="selectOption('${q.id}', ${oi})">
            <span>${escapeHtml(opt)}</span>
          </label>`
          )
          .join('')}
      </div>
    </div>`
    )
    .join('');
  updateProgress();
}

function selectOption(questionId, idx) {
  answers[questionId] = idx;
  saveSession();
  quiz.questions
    .find((q) => q.id === questionId)
    .options.forEach((_, oi) => {
      document.getElementById(`opt-${questionId}-${oi}`).classList.toggle('selected', oi === idx);
    });
  updateProgress();
}

function updateProgress() {
  const pct = Math.round((Object.keys(answers).length / quiz.questions.length) * 100);
  document.getElementById('q-progress').style.width = `${pct}%`;
}

function startTimerLoop() {
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Date.now() - quiz.startedAt;
    const remainingMs = quiz.durationSeconds * 1000 - elapsed;
    const timerEl = document.getElementById('q-timer');
    if (remainingMs <= 0) {
      timerEl.textContent = '0:00';
      clearInterval(timerInterval);
      if (!submitted) autoSubmit('time_up');
      return;
    }
    const s = Math.ceil(remainingMs / 1000);
    const m = Math.floor(s / 60);
    const r = s % 60;
    timerEl.textContent = `${m}:${String(r).padStart(2, '0')}`;
    timerEl.classList.toggle('low', s <= 30);
  }, 250);
}

// ---------- Tab-switch guard ----------
// Deliberately visibilitychange ONLY. A plain page refresh does not fire
// this event in a way that would falsely trigger it, which is what lets a
// refresh resume safely (see init() above) instead of being treated as
// cheating. Genuinely switching to another tab or app does fire it.
function attachTabSwitchGuard() {
  document.addEventListener('visibilitychange', onVisibilityChange);
}
function detachTabSwitchGuard() {
  document.removeEventListener('visibilitychange', onVisibilityChange);
}
function onVisibilityChange() {
  if (document.hidden && !submitted && quiz && quiz.status === 'active') {
    autoSubmit('tab_switch');
  }
}

function answersToArray() {
  return Object.entries(answers).map(([questionId, selectedIndex]) => ({ questionId, selectedIndex }));
}

// ---------- Submit ----------
async function manualSubmit() {
  await doSubmit(false, null);
}
async function autoSubmit(reason) {
  await doSubmit(true, reason);
}
async function doSubmit(autoSubmitted, reason) {
  if (submitted) return;
  submitted = true;
  clearInterval(timerInterval);
  detachTabSwitchGuard();
  try {
    await apiPost(`/api/quizzes/${quizId}/submit`, { participantId, answers: answersToArray(), autoSubmitted, reason });
  } catch (e) {
    // Keep the UI locked either way — the reason is shown so a student can
    // flag it to the organizers if the network call itself failed.
  }
  if (autoSubmitted && reason === 'tab_switch') {
    screen('locked');
  } else if (quiz.status === 'ended') {
    showResults();
  } else {
    screen('submitted');
  }
}

// ---------- Results ----------
async function showResults() {
  screen('results');
  document.getElementById('r-title').textContent = `${quiz ? quiz.title : 'Quiz'} — Results`;
  try {
    const data = await apiGet(`/api/quizzes/${quizId}/results`);
    const body = document.getElementById('r-body');
    body.innerHTML = data.participants
      .map(
        (p) => `
      <tr class="rank-${p.rank} ${p.id === participantId ? 'me' : ''}">
        <td>${p.rank}</td>
        <td>${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.college || '—')}</td>
        <td>${escapeHtml(p.rollNo || '—')}</td>
        <td>${p.score} / ${p.maxScore}</td>
        <td>${fmtTime(p.timeTakenMs)}</td>
      </tr>`
      )
      .join('');
  } catch (e) {
    document.getElementById('r-body').innerHTML = `<tr><td colspan="6" class="muted">Results aren't published yet.</td></tr>`;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init();
