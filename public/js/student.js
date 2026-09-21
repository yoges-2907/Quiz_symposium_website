// Student SPA logic.

let quizId = null;
let participantId = null;
let quiz = null; // public quiz shape: {id, title, durationSeconds, status, startedAt, questions}
let answers = {}; // questionId -> selectedIndex
let submitted = false;
let socket = null;
let timerInterval = null;

function screen(name) {
  ['join', 'waiting', 'quiz', 'locked', 'submitted', 'results'].forEach((s) => {
    document.getElementById(`screen-${s}`).classList.toggle('hidden', s !== name);
  });
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
      // Round ended before this student submitted — show locked/expired state.
      submitted = true;
      clearInterval(timerInterval);
    }
    showResults();
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
  }
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
          <label class="option" id="opt-${q.id}-${oi}">
            <input type="radio" name="ans-${q.id}" value="${oi}" onchange="selectOption('${q.id}', ${oi})">
            <span>${escapeHtml(opt)}</span>
          </label>`
          )
          .join('')}
      </div>
    </div>`
    )
    .join('');
}

function selectOption(questionId, idx) {
  answers[questionId] = idx;
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
function attachTabSwitchGuard() {
  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('pagehide', onPageHide);
}

function detachTabSwitchGuard() {
  document.removeEventListener('visibilitychange', onVisibilityChange);
  window.removeEventListener('pagehide', onPageHide);
}

function onVisibilityChange() {
  if (document.hidden && !submitted && quiz && quiz.status === 'active') {
    autoSubmit('tab_switch');
  }
}

function onPageHide() {
  // Best-effort: if the tab is being closed/navigated away mid-quiz, fire a
  // beacon so the submission still lands even though the page can't wait
  // for a normal fetch response.
  if (!submitted && quiz && quiz.status === 'active' && participantId) {
    const payload = JSON.stringify({
      participantId,
      answers: answersToArray(),
      autoSubmitted: true,
      reason: 'tab_closed',
    });
    navigator.sendBeacon &&
      navigator.sendBeacon(`/api/quizzes/${quizId}/submit`, new Blob([payload], { type: 'application/json' }));
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
    await apiPost(`/api/quizzes/${quizId}/submit`, {
      participantId,
      answers: answersToArray(),
      autoSubmitted,
      reason,
    });
  } catch (e) {
    // Even if the network call fails we keep the UI locked — the reason is
    // shown so a student can flag it to the organizers if needed.
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
