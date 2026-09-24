// Multi-staff admin SPA logic.
let token = localStorage.getItem('staff_token') || '';
let currentUser = null;
let socket = null;
let currentQuizId = null;
let questionCount = 0;
let authMode = 'login';
let editingQuizId = null;

function authHeaders() { return { Authorization: `Bearer ${token}` }; }
function screen(name) {
  ['login','dashboard','builder','monitor'].forEach(s =>
    document.getElementById(`screen-${s}`).classList.toggle('hidden', s !== name));
}
function toggleAuthMode() {
  authMode = authMode === 'login' ? 'register' : 'login';
  document.getElementById('auth-title').textContent = authMode === 'login' ? 'Staff login' : 'Create staff account';
  document.getElementById('auth-subtitle').textContent = authMode === 'login'
    ? 'Use your staff email and password.' : 'Each staff member gets a separate quiz history.';
  document.getElementById('register-name-wrap').classList.toggle('hidden', authMode !== 'register');
  document.getElementById('auth-btn').textContent = authMode === 'login' ? 'Log in' : 'Create account';
  document.getElementById('auth-switch').textContent = authMode === 'login' ? 'Create staff account' : 'Back to login';
  document.getElementById('login-error').style.display = 'none';
}
function togglePasswordVisibility() {
  const input = document.getElementById('login-password');
  const btn = document.getElementById('pw-toggle-btn');
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.textContent = showing ? 'Show' : 'Hide';
}
async function submitAuth() {
  const email=document.getElementById('login-email').value.trim();
  const password=document.getElementById('login-password').value;
  const err=document.getElementById('login-error'); err.style.display='none';
  try {
    const data = authMode === 'register'
      ? await apiPost('/api/auth/register',{name:document.getElementById('register-name').value.trim(),email,password})
      : await apiPost('/api/auth/login',{email,password});
    token=data.token; currentUser=data.user; localStorage.setItem('staff_token',token); showDashboard();
  } catch(e){ err.textContent=e.message; err.style.display='block'; }
}
async function checkAuthAndStart() {
  if(!token) return screen('login');
  try {
    const d=await apiGet('/api/auth/me',{headers:authHeaders()}); currentUser=d.user;
    // Refreshing mid-event shouldn't bounce you back to the dashboard —
    // reopen whichever quiz's monitor you had open, if it's still yours.
    const savedQuiz = localStorage.getItem('admin_open_quiz');
    if (savedQuiz) {
      try { await openMonitor(savedQuiz); return; } catch { localStorage.removeItem('admin_open_quiz'); }
    }
    showDashboard();
  }
  catch { token=''; localStorage.removeItem('staff_token'); screen('login'); }
}
async function logout() {
  try { await apiPost('/api/auth/logout',{}, {headers:authHeaders()}); } catch {}
  token=''; currentUser=null; localStorage.removeItem('staff_token'); localStorage.removeItem('admin_open_quiz'); screen('login');
}
async function showDashboard() {
  localStorage.removeItem('admin_open_quiz');
  screen('dashboard');
  document.getElementById('staff-account').textContent = `${currentUser.name} · ${currentUser.email}`;
  const list=await apiGet('/api/admin/quizzes',{headers:authHeaders()});
  const el=document.getElementById('quiz-list');
  if(!list.length){el.innerHTML='<div class="card plain"><p>No past quizzes yet. Create your first round.</p></div>';return;}
  el.innerHTML=list.map(q=>`
    <div class="card plain">
      <div class="row between wrap">
        <div>
          <h3 style="margin-bottom:4px;">${escapeHtml(q.title)}</h3>
          <div class="muted">Code <code class="code-token" style="font-size:.9rem;padding:2px 8px;">${q.id}</code>
          &nbsp;·&nbsp; ${q.questions.length} questions &nbsp;·&nbsp; ${Math.round(q.durationSeconds/60)} min
          &nbsp;·&nbsp; Joined ${q.stats.joined} &nbsp;·&nbsp; Submitted ${q.stats.submitted}</div>
        </div>
        <div class="row">
          <span class="badge ${q.status}">${q.status}</span>
          <button class="btn small" onclick="openMonitor('${q.id}')">Open</button>
          <button class="btn secondary small" onclick="editQuiz('${q.id}')" title="Create an editable copy of this quiz">Edit</button>
          <button class="btn secondary small" onclick="duplicateQuiz('${q.id}')" title="Run this same quiz again with a new join code">Reuse</button>
          <button class="icon-btn" onclick="deleteQuiz('${q.id}')">Delete</button>
        </div>
      </div>
    </div>`).join('');
}
async function deleteQuiz(id){
  if(!confirm('Delete this quiz and all its submissions?')) return;
  await apiDelete(`/api/admin/quizzes/${id}`,{headers:authHeaders()}); showDashboard();
}
async function duplicateQuiz(id){
  const clone = await apiPost(`/api/admin/quizzes/${id}/duplicate`,{},{headers:authHeaders()});
  showToast(`New code ${clone.id} ready — same questions, fresh round.`);
  openMonitor(clone.id);
}
function showBuilder(){
  editingQuizId = null;
  screen('builder'); document.getElementById('builder-heading').textContent='Create a quiz';
  document.getElementById('qz-title').value=''; document.getElementById('qz-duration').value=10;
  document.getElementById('qz-questions').innerHTML=''; document.getElementById('builder-error').style.display='none';
  document.getElementById('builder-submit-btn').textContent='Publish quiz & get join code';
  questionCount=0; addQuestion();
}

async function editQuiz(id){
  try {
    const q = await apiGet(`/api/admin/quizzes/${id}`, {headers:authHeaders()});
    editingQuizId = id;
    screen('builder');
    document.getElementById('builder-heading').textContent='Edit & reuse quiz';
    document.getElementById('qz-title').value=q.title;
    document.getElementById('qz-duration').value=Math.max(1, Math.round(q.durationSeconds / 60));
    document.getElementById('qz-questions').innerHTML='';
    document.getElementById('builder-error').style.display='none';
    document.getElementById('builder-submit-btn').textContent='Save changes & create new quiz';
    questionCount=0;
    q.questions.forEach(question => addQuestion(question));
  } catch(e) {
    showToast(e.message || 'Unable to open quiz for editing.');
  }
}
function addQuestion(existing=null){
  questionCount++; const qid=questionCount; const wrap=document.createElement('div');
  wrap.className='qbuilder-q'; wrap.id=`qbuild-${qid}`;
  wrap.innerHTML=`<div class="row between"><strong>Question ${qid}</strong>
    <button class="icon-btn" onclick="document.getElementById('qbuild-${qid}').remove()">Remove</button></div>
    <label>Question text</label><textarea rows="2" class="q-text" placeholder="Question" oninput="autoResize(this)" style="overflow-y:hidden; resize:none;"></textarea>
    <label class="row" style="gap:8px; margin-top:10px;">
      <input type="checkbox" class="q-iscode" style="width:16px;height:16px;" onchange="onCodeToggle(this, ${qid})">
      <span class="muted" style="margin:0;">This question includes a code snippet</span>
    </label>
    <div id="code-hint-${qid}" class="muted hidden" style="margin:4px 0 0;">Paste the code as-is — line breaks and indentation will be shown exactly as typed, in a monospace font, for students.</div>
    <div class="grid-2"><div><label>Marks</label><input type="number" class="q-marks" value="1" min="1"></div></div>
    <label>Options — mark the correct one</label><div class="q-options"></div>
    <button class="btn secondary small" type="button" onclick="addOption(this)">+ Add option</button>`;
  document.getElementById('qz-questions').appendChild(wrap);
  const ow=wrap.querySelector('.q-options');
  if(existing){
    const options=Array.isArray(existing.options) ? existing.options : [];
    const optionCount=Math.max(2, options.length);
    for(let i=0;i<optionCount;i++) addOptionTo(ow,qid);
    options.forEach((value,i)=>{ const input=ow.children[i]?.querySelector('.q-option-text'); if(input) input.value=value; });
    const correct=ow.querySelector(`input[type=radio][value="${Number(existing.correctIndex)}"]`);
    if(correct) correct.checked=true;
    wrap.querySelector('.q-text').value=existing.text || '';
    wrap.querySelector('.q-marks').value=Number(existing.marks) || 1;
    const code=wrap.querySelector('.q-iscode'); code.checked=!!existing.isCode;
    onCodeToggle(code,qid);
    autoResize(wrap.querySelector('.q-text'));
  } else {
    for(let i=0;i<4;i++) addOptionTo(ow,qid);
  }
}
function addOption(btn){ addOptionTo(btn.previousElementSibling,btn.closest('.qbuilder-q').id.split('-')[1]); }
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight + 2}px`;
}
function onCodeToggle(checkbox, qid) {
  document.getElementById(`code-hint-${qid}`).classList.toggle('hidden', !checkbox.checked);
  const textarea = document.getElementById(`qbuild-${qid}`).querySelector('.q-text');
  textarea.style.fontFamily = checkbox.checked ? "'Space Grotesk', monospace" : '';
  textarea.style.whiteSpace = checkbox.checked ? 'pre' : 'normal';
  textarea.placeholder = checkbox.checked ? 'Paste the code snippet here, then ask your question in the text just before/after it' : 'Question';
  autoResize(textarea);
}
function addOptionTo(ow,qid){
  const idx=ow.children.length,row=document.createElement('div');row.className='row';row.style.marginBottom='8px';
  row.innerHTML=`<input type="radio" name="correct-${qid}" value="${idx}" ${idx===0?'checked':''} style="width:17px;height:17px;flex-shrink:0;">
  <input type="text" class="q-option-text" placeholder="Option ${idx+1}" style="flex:1;">
  <button class="icon-btn" type="button" onclick="removeOption(this)">✕</button>`;
  ow.appendChild(row);
}
function removeOption(button){
  const row=button.parentElement;
  const options=row.parentElement;
  const wasChecked=row.querySelector('input[type=radio]')?.checked;
  row.remove();
  Array.from(options.children).forEach((item,i)=>{
    const radio=item.querySelector('input[type=radio]');
    const input=item.querySelector('.q-option-text');
    if(radio) radio.value=i;
    if(input) input.placeholder=`Option ${i+1}`;
  });
  if(wasChecked || !options.querySelector('input[type=radio]:checked')){
    options.querySelector('input[type=radio]')?.click();
  }
}
async function submitQuiz(){
  const title=document.getElementById('qz-title').value.trim(), durationMinutes=Number(document.getElementById('qz-duration').value)||10;
  const err=document.getElementById('builder-error');err.style.display='none';const questions=[];
  for(const block of document.querySelectorAll('.qbuilder-q')){
    const text=block.querySelector('.q-text').value.trim(),marks=Number(block.querySelector('.q-marks').value)||1;
    const isCode=block.querySelector('.q-iscode').checked;
    const options=Array.from(block.querySelectorAll('.q-option-text')).map(i=>i.value.trim());
    const r=block.querySelector('input[type=radio]:checked');const correctIndex=r?Number(r.value):-1;
    if(!text||options.some(o=>!o)||options.length<2||correctIndex<0){err.textContent='Every question needs text, 2+ filled options and a correct answer.';err.style.display='block';return;}
    questions.push({text,options,correctIndex,marks,isCode});
  }
  if(!title||!questions.length){err.textContent='Add a title and at least one question.';err.style.display='block';return;}
  try{
    const endpoint = editingQuizId ? `/api/admin/quizzes/${editingQuizId}/edit-copy` : '/api/admin/quizzes';
    const q=await apiPost(endpoint,{title,durationMinutes,questions},{headers:authHeaders()});
    editingQuizId=null;
    openMonitor(q.id);
  }
  catch(e){err.textContent=e.message;err.style.display='block';}
}
async function openMonitor(id){
  currentQuizId=id;
  localStorage.setItem('admin_open_quiz', id);
  screen('monitor');
  await refreshMonitor();
  connectSocket(id);
  if (document.getElementById('mon-status').textContent === 'draft') loadJoinedNames(id);
}
function connectSocket(id){
  if(!socket)socket=io();socket.emit('join-room',{quizId:id,role:'admin'});
  socket.off('stats-update');socket.off('quiz-started');socket.off('quiz-ended');socket.off('participant-joined');
  socket.on('stats-update',s=>{document.getElementById('mon-joined').textContent=s.joined;document.getElementById('mon-submitted').textContent=s.submitted;});
  socket.on('quiz-started',refreshMonitor);socket.on('quiz-ended',refreshMonitor);
  socket.on('participant-joined',p=>{
    if(document.getElementById('mon-status').textContent==='draft') addJoinedChip(p.name);
  });
}
async function loadJoinedNames(id){
  try {
    const data = await apiGet(`/api/quizzes/${id}/roster`);
    const wrap = document.getElementById('mon-roster');
    wrap.innerHTML='';
    data.participants.forEach(p=>addJoinedChip(p.name));
  } catch {}
}
function addJoinedChip(name){
  const wrap=document.getElementById('mon-roster');
  const chip=document.createElement('span');
  chip.className='pill'; chip.style.margin='4px'; chip.textContent=name;
  wrap.appendChild(chip);
}
async function refreshMonitor(){
  const q=await apiGet(`/api/admin/quizzes/${currentQuizId}`,{headers:authHeaders()});
  document.getElementById('mon-title').textContent=q.title;document.getElementById('mon-code').textContent=q.id;
  document.getElementById('mon-status').textContent=q.status;document.getElementById('mon-status').className=`badge ${q.status}`;
  document.getElementById('mon-joined').textContent=q.stats.joined;document.getElementById('mon-submitted').textContent=q.stats.submitted;
  document.getElementById('mon-export-btn').href=`/api/admin/quizzes/${q.id}/export.csv?token=${encodeURIComponent(token)}`;
  document.getElementById('mon-lobby-btn').href=`lobby.html?code=${q.id}`;
  document.getElementById('mon-start-btn').style.display=q.status==='draft'?'inline-flex':'none';
  document.getElementById('mon-end-btn').style.display=q.status==='active'?'inline-flex':'none';
  document.getElementById('mon-duplicate-btn').style.display=q.status==='ended'?'inline-flex':'none';
  const rosterWrap=document.getElementById('mon-roster-wrap');
  rosterWrap.classList.toggle('hidden', q.status!=='draft');
  const rw=document.getElementById('mon-results-wrap');
  if(q.status==='ended'){rw.classList.remove('hidden');await loadMonitorResults(q.id);}else rw.classList.add('hidden');
}
async function loadMonitorResults(id){
  const d=await apiGet(`/api/quizzes/${id}/results`),body=document.getElementById('mon-results-body');
  body.innerHTML=d.participants.map(p=>`<tr class="rank-${p.rank}"><td>${p.rank}</td><td>${escapeHtml(p.name)}</td>
    <td>${escapeHtml(p.college||'—')}</td><td>${escapeHtml(p.teamName||'—')}</td><td>${p.score} / ${p.maxScore}</td>
    <td>${fmtTime(p.timeTakenMs)}</td><td>${p.autoSubmitted?'<span class="muted">tab-switch auto-submit</span>':''}</td></tr>`).join('');
}
async function startQuiz(){await apiPost(`/api/admin/quizzes/${currentQuizId}/start`,{}, {headers:authHeaders()});refreshMonitor();}
async function endQuiz(){if(!confirm('End the round now and publish results to everyone?'))return;await apiPost(`/api/admin/quizzes/${currentQuizId}/end`,{}, {headers:authHeaders()});refreshMonitor();}
function escapeHtml(s){return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
checkAuthAndStart();
