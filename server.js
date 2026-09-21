// Symposium Quiz v2 — multi-staff accounts + college field.
// NOTE: For production hosting, use a persistent database/storage. This version
// keeps the existing JSON datastore so you can test the new account workflow first.

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data', 'db.json');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHash) {
  const actual = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expectedHash, 'hex'));
}
function newToken() { return crypto.randomBytes(32).toString('hex'); }

function loadDB() {
  try {
    const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db.users ||= {};
    db.sessions ||= {};
    db.quizzes ||= {};
    db.participants ||= {};
    return db;
  } catch {
    return { users: {}, sessions: {}, quizzes: {}, participants: {} };
  }
}
let db = loadDB();
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }, 100);
}

function genCode(len = 6) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do code = Array.from({length: len}, () => chars[crypto.randomInt(chars.length)]).join('');
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
    id: quiz.id, title: quiz.title, durationSeconds: quiz.durationSeconds,
    status: quiz.status, startedAt: quiz.startedAt,
    questions: quiz.questions.map(q => ({ id:q.id, text:q.text, options:q.options, marks:q.marks }))
  };
}
function quizParticipants(id) {
  return Object.values(db.participants).filter(p => p.quizId === id);
}
function adminQuizView(quiz) {
  const ps = quizParticipants(quiz.id);
  return {...quiz, stats:{joined:ps.length, submitted:ps.filter(p=>p.submitted).length}};
}
function scoreSubmission(quiz, answers) {
  let score = 0;
  const maxScore = quiz.questions.reduce((s,q)=>s+(q.marks||1),0);
  const byId = Object.fromEntries(quiz.questions.map(q=>[q.id,q]));
  const detail = answers.map(a => {
    const q = byId[a.questionId];
    const correct = !!q && Number(a.selectedIndex) === Number(q.correctIndex);
    if (correct) score += q.marks || 1;
    return {questionId:a.questionId, selectedIndex:a.selectedIndex, correct};
  });
  return {score,maxScore,detail};
}
function endQuizIfNeeded(id,{force=false}={}) {
  const quiz=db.quizzes[id];
  if(!quiz || quiz.status==='ended') return;
  const ps=quizParticipants(id);
  const allSubmitted=ps.length>0 && ps.every(p=>p.submitted);
  if(force || allSubmitted) {
    quiz.status='ended'; quiz.endedAt=Date.now(); saveDB();
    io.to(`quiz-${id}`).emit('quiz-ended',{quizId:id});
    io.to(`admin-${id}`).emit('quiz-ended',{quizId:id});
  }
}
const timers={};

// ---------- Account auth ----------
app.post('/api/auth/register', (req,res) => {
  const {name,email,password} = req.body || {};
  const n=String(name||'').trim(), e=cleanEmail(email), p=String(password||'');
  if(!n || !e || !p) return res.status(400).json({error:'Name, email and password are required'});
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return res.status(400).json({error:'Enter a valid email address'});
  if(p.length<8) return res.status(400).json({error:'Password must be at least 8 characters'});
  if(Object.values(db.users).some(u=>u.email===e)) return res.status(409).json({error:'An account with this email already exists'});
  const id=crypto.randomUUID(), pw=hashPassword(p);
  db.users[id]={id,name:n.slice(0,100),email:e,passwordHash:pw.hash,passwordSalt:pw.salt,createdAt:Date.now()};
  const token=newToken();
  db.sessions[token]={userId:id,expiresAt:Date.now()+SESSION_TTL_MS};
  saveDB();
  res.json({token,user:publicUser(db.users[id])});
});

app.post('/api/auth/login',(req,res)=>{
  const e=cleanEmail(req.body?.email), p=String(req.body?.password||'');
  const user=Object.values(db.users).find(u=>u.email===e);
  if(!user || !verifyPassword(p,user.passwordSalt,user.passwordHash))
    return res.status(401).json({error:'Incorrect email or password'});
  const token=newToken();
  db.sessions[token]={userId:user.id,expiresAt:Date.now()+SESSION_TTL_MS};
  saveDB();
  res.json({token,user:publicUser(user)});
});
app.post('/api/auth/logout',requireStaff,(req,res)=>{
  delete db.sessions[req.token]; saveDB(); res.json({ok:true});
});
app.get('/api/auth/me',requireStaff,(req,res)=>res.json({user:publicUser(req.user)}));

// ---------- Admin/staff quiz CRUD ----------
app.get('/api/admin/quizzes',requireStaff,(req,res)=>{
  res.json(Object.values(db.quizzes)
    .filter(q=>q.ownerId===req.userId)
    .sort((a,b)=>b.createdAt-a.createdAt)
    .map(adminQuizView));
});
app.post('/api/admin/quizzes',requireStaff,(req,res)=>{
  const {title,durationMinutes,questions}=req.body||{};
  if(!title || !Array.isArray(questions) || !questions.length)
    return res.status(400).json({error:'Title and at least one question are required'});
  for(const q of questions){
    if(!q.text || !Array.isArray(q.options) || q.options.length<2)
      return res.status(400).json({error:'Each question needs text and at least 2 options'});
    if(typeof q.correctIndex!=='number' || q.correctIndex<0 || q.correctIndex>=q.options.length)
      return res.status(400).json({error:'Each question needs a valid correct answer'});
  }
  const id=genCode();
  const quiz={id,ownerId:req.userId,title:String(title).slice(0,200),
    durationSeconds:Math.max(30,Math.round((Number(durationMinutes)||10)*60)),
    questions:questions.map((q,i)=>({id:`q${i+1}`,text:String(q.text).slice(0,1000),
      options:q.options.map(o=>String(o).slice(0,300)),correctIndex:q.correctIndex,
      marks:Number(q.marks)>0?Number(q.marks):1})),
    status:'draft',createdAt:Date.now(),startedAt:null,endedAt:null};
  db.quizzes[id]=quiz; saveDB(); res.json(adminQuizView(quiz));
});
app.get('/api/admin/quizzes/:id',requireStaff,(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q || q.ownerId!==req.userId) return res.status(404).json({error:'Quiz not found'});
  res.json(adminQuizView(q));
});
app.delete('/api/admin/quizzes/:id',requireStaff,(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q || q.ownerId!==req.userId) return res.status(404).json({error:'Quiz not found'});
  delete db.quizzes[q.id];
  Object.keys(db.participants).forEach(pid=>{if(db.participants[pid].quizId===q.id) delete db.participants[pid]});
  saveDB(); res.json({ok:true});
});
app.post('/api/admin/quizzes/:id/start',requireStaff,(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q || q.ownerId!==req.userId) return res.status(404).json({error:'Quiz not found'});
  if(q.status!=='draft') return res.status(400).json({error:'Quiz already started or ended'});
  q.status='active'; q.startedAt=Date.now(); saveDB();
  io.to(`quiz-${q.id}`).emit('quiz-started',{startedAt:q.startedAt,durationSeconds:q.durationSeconds});
  io.to(`admin-${q.id}`).emit('quiz-started',{startedAt:q.startedAt});
  clearTimeout(timers[q.id]);
  timers[q.id]=setTimeout(()=>endQuizIfNeeded(q.id,{force:true}),q.durationSeconds*1000+500);
  res.json(adminQuizView(q));
});
app.post('/api/admin/quizzes/:id/end',requireStaff,(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q || q.ownerId!==req.userId) return res.status(404).json({error:'Quiz not found'});
  clearTimeout(timers[q.id]); endQuizIfNeeded(q.id,{force:true});
  res.json(adminQuizView(db.quizzes[q.id]));
});
app.get('/api/admin/quizzes/:id/export.csv',requireStaff,(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q || q.ownerId!==req.userId) return res.status(404).send('Not found');
  const ps=quizParticipants(q.id).sort((a,b)=>(b.score||0)-(a.score||0)||(a.timeTakenMs||Infinity)-(b.timeTakenMs||Infinity));
  const rows=[['Rank','Name','College','Roll No','Score','Max Score','Time Taken (s)','Auto-submitted']];
  ps.forEach((p,i)=>rows.push([i+1,p.name,p.college||'',p.rollNo||'',p.submitted?p.score:'',
    q.questions.reduce((s,x)=>s+(x.marks||1),0),p.timeTakenMs?Math.round(p.timeTakenMs/1000):'',p.autoSubmitted?'YES':'']));
  const csv=rows.map(r=>r.map(v=>`"${String(v).replace(/"/g,'""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition',`attachment; filename="${q.title.replace(/[^a-z0-9]/gi,'_')}_results.csv"`);
  res.send(csv);
});

// ---------- Public/student ----------
app.post('/api/quizzes/:id/join',(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q) return res.status(404).json({error:'Quiz code not found'});
  if(q.status==='ended') return res.status(400).json({error:'This quiz has already ended'});
  const name=String(req.body?.name||'').trim(), college=String(req.body?.college||'').trim(), rollNo=String(req.body?.rollNo||'').trim();
  if(!name) return res.status(400).json({error:'Name is required'});
  if(!college) return res.status(400).json({error:'College name is required'});
  const id=crypto.randomUUID();
  db.participants[id]={id,quizId:q.id,name:name.slice(0,100),college:college.slice(0,150),rollNo:rollNo.slice(0,50),
    joinedAt:Date.now(),submitted:false,autoSubmitted:false,reason:null,score:null,
    maxScore:q.questions.reduce((s,x)=>s+(x.marks||1),0),submittedAt:null,timeTakenMs:null,answers:[]};
  saveDB();
  io.to(`admin-${q.id}`).emit('stats-update',{joined:quizParticipants(q.id).length,submitted:quizParticipants(q.id).filter(p=>p.submitted).length});
  res.json({participantId:id,quiz:publicQuiz(q)});
});
app.post('/api/quizzes/:id/submit',(req,res)=>{
  const q=db.quizzes[req.params.id], p=db.participants[req.body?.participantId];
  if(!q) return res.status(404).json({error:'Quiz code not found'});
  if(!p || p.quizId!==q.id) return res.status(404).json({error:'Participant not found'});
  if(p.submitted) return res.json({ok:true,alreadySubmitted:true});
  const answers=Array.isArray(req.body?.answers)?req.body.answers:[];
  const {score,maxScore}=scoreSubmission(q,answers);
  p.submitted=true;p.autoSubmitted=!!req.body?.autoSubmitted;p.reason=req.body?.reason||null;
  p.score=score;p.maxScore=maxScore;p.submittedAt=Date.now();p.timeTakenMs=q.startedAt?p.submittedAt-q.startedAt:null;p.answers=answers;
  saveDB();
  const ps=quizParticipants(q.id);
  io.to(`admin-${q.id}`).emit('stats-update',{joined:ps.length,submitted:ps.filter(x=>x.submitted).length});
  endQuizIfNeeded(q.id); res.json({ok:true,score,maxScore});
});
app.get('/api/quizzes/:id/results',(req,res)=>{
  const q=db.quizzes[req.params.id];
  if(!q) return res.status(404).json({error:'Not found'});
  if(q.status!=='ended') return res.status(400).json({error:'Results are not published yet'});
  const participants=quizParticipants(q.id).filter(p=>p.submitted).sort((a,b)=>(b.score-a.score)||(a.timeTakenMs||Infinity)-(b.timeTakenMs||Infinity))
    .map((p,i)=>({rank:i+1,id:p.id,name:p.name,college:p.college,rollNo:p.rollNo,score:p.score,maxScore:p.maxScore,timeTakenMs:p.timeTakenMs,autoSubmitted:p.autoSubmitted}));
  res.json({title:q.title,participants});
});
app.get('/api/quizzes/:id/status',(req,res)=>{
  const q=db.quizzes[req.params.id]; if(!q)return res.status(404).json({error:'Not found'});
  res.json({status:q.status,startedAt:q.startedAt,durationSeconds:q.durationSeconds});
});

io.on('connection',socket=>{
  socket.on('join-room',({quizId,role})=>{
    if(!quizId || !db.quizzes[quizId]) return;
    socket.join(role==='admin'?`admin-${quizId}`:`quiz-${quizId}`);
  });
});

server.listen(PORT,()=>console.log(`Symposium Quiz v2 running at http://localhost:${PORT}`));
