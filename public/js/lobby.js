// Corridor / lobby display — read-only, no login. Meant to be opened on a
// projector or a screen near the venue entrance so students can see
// themselves appear as they join, before the host starts the round.

const params = new URLSearchParams(location.search);
const quizId = (params.get('code') || '').toUpperCase();

async function init() {
  if (!quizId) {
    document.getElementById('l-title').textContent = 'No quiz code given';
    return;
  }
  await refresh();
  const socket = io();
  socket.emit('join-room', { quizId, role: 'student' });
  socket.on('participant-joined', (p) => {
    addChip(p.name);
    document.getElementById('l-count').textContent = p.count;
  });
  socket.on('quiz-started', () => {
    document.getElementById('l-status').textContent = 'active';
    document.getElementById('l-status').className = 'badge active';
    document.getElementById('l-title').textContent = 'Round in progress — good luck!';
  });
  socket.on('quiz-ended', () => {
    document.getElementById('l-status').textContent = 'ended';
    document.getElementById('l-status').className = 'badge ended';
    document.getElementById('l-title').textContent = 'Round finished — check the results page';
  });
}

async function refresh() {
  try {
    const data = await apiGet(`/api/quizzes/${quizId}/roster`);
    document.getElementById('l-title').textContent = data.title;
    document.getElementById('l-code').textContent = quizId;
    document.getElementById('l-count').textContent = data.participants.length;
    document.getElementById('l-status').textContent = data.status;
    document.getElementById('l-status').className = `badge ${data.status}`;
    const wrap = document.getElementById('l-roster');
    wrap.innerHTML = '';
    data.participants.forEach((p) => addChip(p.name));
  } catch (e) {
    document.getElementById('l-title').textContent = 'Quiz code not found';
  }
}

function addChip(name) {
  const wrap = document.getElementById('l-roster');
  const chip = document.createElement('div');
  chip.className = 'roster-chip';
  chip.textContent = name;
  wrap.appendChild(chip);
}

init();
