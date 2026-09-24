// Symposium Quiz v3 — multi-staff accounts, MongoDB persistence, reusable
// quizzes, a corridor/lobby display, and refresh-safe student sessions.

require('dotenv').config();
const express = require('express');
const compression = require('compression');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { Server } = require('socket.io');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
app.set('trust proxy', 1); // Render (and most hosts) sit behind a proxy.
const server = http.createServer(app);
const io = new Server(server);

app.use(compression()); // gzip responses — helps on the free tier's shared CPU.
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

const db = { users: {}, sessions: {}, quizzes: {}, participants: {} };

// ---------- Persistence helpers ----------
// Every mutation below updates `db` in memory (fast, used for every request)
// and also asks the store to persist just the piece that changed. In Mongo
// mode that's a targeted upsert; in local-file mode it's a debounced full
// dump of `db` to data/db.json.
function touchFile() {
  if (!store.isMongo()) store.saveLocalFileDebounced(db);
}
function persistUser(u) { store.upsert('users', u.id, u); touchFile(); }
function persistSession(token, s) { store.upsert('sessions', token, s); touchFile(); }
function removeSessionRecord(token) { store.remove('sessions', token); touchFile(); }
function persistQuiz(q) { store.upsert('quizzes', q.id, q); touchFile(); }
function removeQuizRecord(id) { store.remove('quizzes', id); touchFile(); }
function persistParticipant(p) { store.upsert('participants', p.id, p); touchFile(); }
function removeParticipantRecords(ids) { store.removeMany('participants', ids); touchFile(); }

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do code = Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join('');
  while (db.quizzes[code]);
  return code;
}
function cleanEmail(v) { return String(v || '').trim().toLowerCase(); }

function requireStaff(req, res, next) {
  const token = req.headers.authorization?.replace(/^Bearer\s+/i, '') || req.query.token;
  const session = token && db.sessions[token];
  if (!session || session.expiresAt < Date.now() || !db.users[session.userId]) {
    return res.status(401).json({ error: 'Please log in again' });
  }
  req.user = db.users[session.userId];
  req.userId = session.userId;
  req.token = token;
  next();
}

function publicUser(user) {
  return { id: user.id, email: user.email, name: user.name };
}

function publicQuiz(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    durationSeconds: quiz.durationSeconds,
    status: quiz.status,
    startedAt: quiz.startedAt,
    questions: quiz.questions.map((q) => ({ id: q.id, text: q.text, options: q.options, marks: q.marks, isCode: q.isCode })),
  };
}
function quizParticipants(id) {
  return Object.values(db.participants).filter((p) => p.quizId === id);
}
function adminQuizView(quiz) {
  const ps = quizParticipants(quiz.id);
  return { ...quiz, stats: { joined: ps.length, submitted: ps.filter((p) => p.submitted).length } };
}
function scoreSubmission(quiz, answers) {
  let score = 0;
  const maxScore = quiz.questions.reduce((s, q) => s + (q.marks || 1), 0);
  const byId = Object.fromEntries(quiz.questions.map((q) => [q.id, q]));
  const detail = answers.map((a) => {
    const q = byId[a.questionId];
    const correct = !!q && Number(a.selectedIndex) === Number(q.correctIndex);
    if (correct) score += q.marks || 1;
    return { questionId: a.questionId, selectedIndex: a.selectedIndex, correct };
  });
  return { score, maxScore, detail };
}
function endQuizIfNeeded(id, { force = false } = {}) {
  const quiz = db.quizzes[id];
  if (!quiz || quiz.status === 'ended') return;
  const ps = quizParticipants(id);
  const allSubmitted = ps.length > 0 && ps.every((p) => p.submitted);
  if (force || allSubmitted) {
    quiz.status = 'ended';
    quiz.endedAt = Date.now();
    persistQuiz(quiz);
    io.to(`quiz-${id}`).emit('quiz-ended', { quizId: id });
    io.to(`admin-${id}`).emit('quiz-ended', { quizId: id });
  }
}
const timers = {};

// ---------- Staff accounts ----------
app.post('/api/auth/register', (req, res) => {
  const { name, email, password } = req.body || {};
  const n = String(name || '').trim();
  const e = cleanEmail(email);
  const p = String(password || '');
  if (!n || !e || !p) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({ error: 'Enter a valid email address' });
  if (p.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters' });
  if (Object.values(db.users).some((u) => u.email === e)) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }
  const id = crypto.randomUUID();
  const pw = hashPassword(p);
  const user = { id, name: n.slice(0, 100), email: e, passwordHash: pw.hash, passwordSalt: pw.salt, createdAt: Date.now() };
  db.users[id] = user;
  persistUser(user);
  const token = newToken();
  const session = { userId: id, expiresAt: Date.now() + SESSION_TTL_MS };
  db.sessions[token] = session;
  persistSession(token, session);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const e = cleanEmail(req.body?.email);
  const p = String(req.body?.password || '');
  const user = Object.values(db.users).find((u) => u.email === e);
  if (!user || !verifyPassword(p, user.passwordSalt, user.passwordHash)) {
    return res.status(401).json({ error: 'Incorrect email or password' });
  }
  const token = newToken();
  const session = { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS };
  db.sessions[token] = session;
  persistSession(token, session);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/auth/logout', requireStaff, (req, res) => {
  delete db.sessions[req.token];
  removeSessionRecord(req.token);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireStaff, (req, res) => res.json({ user: publicUser(req.user) }));

// ---------- Admin/staff quiz CRUD (each staff account only sees its own) ----------
app.get('/api/admin/quizzes', requireStaff, (req, res) => {
  res.json(
    Object.values(db.quizzes)
      .filter((q) => q.ownerId === req.userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(adminQuizView)
  );
});

function buildQuiz({ title, durationMinutes, questions, ownerId }) {
  const id = genCode();
  return {
    id,
    ownerId,
    title: String(title).slice(0, 200),
    durationSeconds: Math.max(30, Math.round((Number(durationMinutes) || 10) * 60)),
    questions: questions.map((q, i) => ({
      id: `q${i + 1}`,
      text: String(q.text).slice(0, 4000),
      options: q.options.map((o) => String(o).slice(0, 300)),
      correctIndex: q.correctIndex,
      marks: Number(q.marks) > 0 ? Number(q.marks) : 1,
      isCode: !!q.isCode,
    })),
    status: 'draft',
    createdAt: Date.now(),
    startedAt: null,
    endedAt: null,
  };
}

app.post('/api/admin/quizzes', requireStaff, (req, res) => {
  const { title, durationMinutes, questions } = req.body || {};
  if (!title || !Array.isArray(questions) || !questions.length) {
    return res.status(400).json({ error: 'Title and at least one question are required' });
  }
  for (const q of questions) {
    if (!q.text || !Array.isArray(q.options) || q.options.length < 2) {
      return res.status(400).json({ error: 'Each question needs text and at least 2 options' });
    }
    if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex >= q.options.length) {
      return res.status(400).json({ error: 'Each question needs a valid correct answer' });
    }
  }
  const quiz = buildQuiz({ title, durationMinutes, questions, ownerId: req.userId });
  db.quizzes[quiz.id] = quiz;
  persistQuiz(quiz);
  res.json(adminQuizView(quiz));
});

function ownedQuizOr404(req, res) {
  const q = db.quizzes[req.params.id];
  if (!q || q.ownerId !== req.userId) {
    res.status(404).json({ error: 'Quiz not found' });
    return null;
  }
  return q;
}

app.get('/api/admin/quizzes/:id', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  res.json(adminQuizView(q));
});

app.delete('/api/admin/quizzes/:id', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  delete db.quizzes[q.id];
  const deadIds = [];
  Object.keys(db.participants).forEach((pid) => {
    if (db.participants[pid].quizId === q.id) {
      deadIds.push(pid);
      delete db.participants[pid];
    }
  });
  removeQuizRecord(q.id);
  removeParticipantRecords(deadIds);
  res.json({ ok: true });
});

// Reuse a quiz: clones the title, questions and duration into a brand new
// quiz with a fresh join code and no participants, so the same round can be
// run again for a different class/batch.
app.post('/api/admin/quizzes/:id/duplicate', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  const clone = buildQuiz({
    title: q.title,
    durationMinutes: q.durationSeconds / 60,
    questions: q.questions.map((qq) => ({ text: qq.text, options: qq.options, correctIndex: qq.correctIndex, marks: qq.marks, isCode: qq.isCode })),
    ownerId: req.userId,
  });
  db.quizzes[clone.id] = clone;
  persistQuiz(clone);
  res.json(adminQuizView(clone));
});

app.post('/api/admin/quizzes/:id/start', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  if (q.status !== 'draft') return res.status(400).json({ error: 'Quiz already started or ended' });
  q.status = 'active';
  q.startedAt = Date.now();
  persistQuiz(q);
  io.to(`quiz-${q.id}`).emit('quiz-started', { startedAt: q.startedAt, durationSeconds: q.durationSeconds });
  io.to(`admin-${q.id}`).emit('quiz-started', { startedAt: q.startedAt });
  clearTimeout(timers[q.id]);
  timers[q.id] = setTimeout(() => endQuizIfNeeded(q.id, { force: true }), q.durationSeconds * 1000 + 500);
  res.json(adminQuizView(q));
});

app.post('/api/admin/quizzes/:id/end', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  clearTimeout(timers[q.id]);
  endQuizIfNeeded(q.id, { force: true });
  res.json(adminQuizView(db.quizzes[q.id]));
});

app.get('/api/admin/quizzes/:id/export.csv', requireStaff, (req, res) => {
  const q = ownedQuizOr404(req, res);
  if (!q) return;
  const ps = quizParticipants(q.id).sort(
    (a, b) => (b.score || 0) - (a.score || 0) || (a.timeTakenMs || Infinity) - (b.timeTakenMs || Infinity)
  );
  const rows = [['Rank', 'Name', 'College', 'Team Name', 'Score', 'Max Score', 'Time Taken (s)', 'Auto-submitted']];
  ps.forEach((p, i) =>
    rows.push([
      i + 1,
      p.name,
      p.college || '',
      p.teamName || '',
      p.submitted ? p.score : '',
      q.questions.reduce((s, x) => s + (x.marks || 1), 0),
      p.timeTakenMs ? Math.round(p.timeTakenMs / 1000) : '',
      p.autoSubmitted ? 'YES' : '',
    ])
  );
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${q.title.replace(/[^a-z0-9]/gi, '_')}_results.csv"`);
  res.send(csv);
});

// ---------- Public / student ----------

// Lightweight roster for the corridor/lobby display and the student waiting
// room — names and colleges only, no team names or scores.
app.get('/api/quizzes/:id/roster', (req, res) => {
  const q = db.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'Quiz not found' });
  const ps = quizParticipants(q.id);
  res.json({
    title: q.title,
    status: q.status,
    participants: ps.map((p) => ({ name: p.name, college: p.college, teamName: p.teamName })),
  });
});

app.post('/api/quizzes/:id/join', (req, res) => {
  const q = db.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'Quiz code not found' });
  if (q.status === 'ended') return res.status(400).json({ error: 'This quiz has already ended' });
  const name = String(req.body?.name || '').trim();
  const college = String(req.body?.college || '').trim();
  const teamName = String(req.body?.teamName || '').trim();
  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!college) return res.status(400).json({ error: 'College name is required' });
  const id = crypto.randomUUID();
  const participant = {
    id,
    quizId: q.id,
    name: name.slice(0, 100),
    college: college.slice(0, 150),
    teamName: teamName.slice(0, 100),
    joinedAt: Date.now(),
    submitted: false,
    autoSubmitted: false,
    reason: null,
    score: null,
    maxScore: q.questions.reduce((s, x) => s + (x.marks || 1), 0),
    submittedAt: null,
    timeTakenMs: null,
    answers: [],
  };
  db.participants[id] = participant;
  persistParticipant(participant);
  const ps = quizParticipants(q.id);
  io.to(`admin-${q.id}`).emit('stats-update', { joined: ps.length, submitted: ps.filter((p) => p.submitted).length });
  io.to(`quiz-${q.id}`).emit('participant-joined', { name: participant.name, college: participant.college, teamName: participant.teamName, count: ps.length });
  res.json({ participantId: id, quiz: publicQuiz(q) });
});

// Lets a student's browser recover its place after a refresh, without
// counting as a new join or as leaving the quiz.
app.get('/api/quizzes/:id/rejoin/:participantId', (req, res) => {
  const q = db.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'Quiz not found' });
  const p = db.participants[req.params.participantId];
  if (!p || p.quizId !== q.id) return res.status(404).json({ error: 'Participant not found' });
  res.json({
    quiz: publicQuiz(q),
    participant: { name: p.name, submitted: p.submitted, autoSubmitted: p.autoSubmitted, reason: p.reason },
  });
});

app.post('/api/quizzes/:id/submit', (req, res) => {
  const q = db.quizzes[req.params.id];
  const p = db.participants[req.body?.participantId];
  if (!q) return res.status(404).json({ error: 'Quiz code not found' });
  if (!p || p.quizId !== q.id) return res.status(404).json({ error: 'Participant not found' });
  if (p.submitted) return res.json({ ok: true, alreadySubmitted: true });
  const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
  const { score, maxScore } = scoreSubmission(q, answers);
  p.submitted = true;
  p.autoSubmitted = !!req.body?.autoSubmitted;
  p.reason = req.body?.reason || null;
  p.score = score;
  p.maxScore = maxScore;
  p.submittedAt = Date.now();
  p.timeTakenMs = q.startedAt ? p.submittedAt - q.startedAt : null;
  p.answers = answers;
  persistParticipant(p);
  const ps = quizParticipants(q.id);
  io.to(`admin-${q.id}`).emit('stats-update', { joined: ps.length, submitted: ps.filter((x) => x.submitted).length });
  endQuizIfNeeded(q.id);
  res.json({ ok: true, score, maxScore });
});

app.get('/api/quizzes/:id/results', (req, res) => {
  const q = db.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'Not found' });
  if (q.status !== 'ended') return res.status(400).json({ error: 'Results are not published yet' });
  const participants = quizParticipants(q.id)
    .filter((p) => p.submitted)
    .sort((a, b) => b.score - a.score || (a.timeTakenMs || Infinity) - (b.timeTakenMs || Infinity))
    .map((p, i) => ({
      rank: i + 1,
      id: p.id,
      name: p.name,
      college: p.college,
      teamName: p.teamName,
      score: p.score,
      maxScore: p.maxScore,
      timeTakenMs: p.timeTakenMs,
      autoSubmitted: p.autoSubmitted,
    }));
  res.json({ title: q.title, participants });
});

app.get('/api/quizzes/:id/status', (req, res) => {
  const q = db.quizzes[req.params.id];
  if (!q) return res.status(404).json({ error: 'Not found' });
  res.json({ status: q.status, startedAt: q.startedAt, durationSeconds: q.durationSeconds });
});

// ---------- Sockets ----------
io.on('connection', (socket) => {
  socket.on('join-room', ({ quizId, role }) => {
    if (!quizId || !db.quizzes[quizId]) return;
    socket.join(role === 'admin' ? `admin-${quizId}` : `quiz-${quizId}`);
  });
});

// ---------- Boot ----------
store
  .init(db)
  .then(() => {
    server.listen(PORT, () => {
      console.log(`Symposium Quiz v3 running at http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to initialize storage:', e);
    process.exit(1);
  });
