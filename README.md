# Symposium Quiz (v3)

A live quiz platform for a college symposium, built to run on a free Render web service:

- **Staff accounts**: any staff member creates their own login (email + password). Each account only sees and manages its own quizzes — different classes/departments running quizzes at the same time never see each other's data.
- **Students** join with just their name, college, and roll number — no account or login.
- **Tab-switch protection**: if a student switches tabs/apps during the quiz, their answers are automatically submitted and the quiz locks — they can't come back in.
- **Refresh-safe**: refreshing the page — as a student mid-quiz, or as an admin on the monitor screen — does **not** log you out or lose progress. Only genuinely switching away from the tab triggers auto-submit; a reload silently resumes exactly where you were.
- **Corridor/lobby display**: an open, no-login page you can project near the venue entrance, showing the quiz title, join code, and every student's name live as they join — so you can visually confirm everyone's in before hitting Start.
- **Reusable quizzes**: "Reuse" a finished quiz to get a brand-new join code with the same questions, ready to run again for the next class/batch.
- **Persistent database**: point it at a free MongoDB Atlas cluster and every quiz, staff account, and result survives server restarts and redeploys — which matters on Render's free tier, whose disk is wiped on every restart.
- **Live sync & results**: join/submit counts update in real time for the admin across every device (Socket.io). A leaderboard appears for everyone automatically once the timer runs out *or* every joined student has submitted.

## 1. Run it locally

You need [Node.js](https://nodejs.org) 18+.

```bash
cd quiz-app
npm install
npm start
```

Open `http://localhost:3000`. Click **Admin panel** and use **Create staff account** to make your first login, or **Join a quiz** to try the student flow.

Without any extra setup this uses a local `data/db.json` file — fine for trying things out, but see the next section before the real event.

## 2. Set up a persistent database (do this before the real event)

Render's free tier wipes the local filesystem on every restart and redeploy, which would delete every quiz and result stored in `data/db.json`. MongoDB Atlas has a free-forever tier (512MB) that fixes this in about five minutes:

1. Go to [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) and create a free account.
2. Create a new **free (M0) cluster** — any cloud provider/region is fine.
3. Under **Database Access**, add a database user with a username and password (write them down).
4. Under **Network Access**, add IP address `0.0.0.0/0` ("allow access from anywhere") — Render's servers use dynamic IPs, so this is the simplest option for a small event tool.
5. Click **Connect** on your cluster → **Drivers** → copy the connection string. It looks like:
   ```
   mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. Replace `<username>` and `<password>` with the ones from step 3.

Set this as the `MONGODB_URI` environment variable — locally, copy `.env.example` to `.env` and paste it in; on Render, add it in the service's **Environment** settings (see below). Once it's set, the startup log will say `Connected to MongoDB — data persists across restarts.` instead of the local-file warning.

## 3. Host it for free on Render

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), create a **New Web Service** and connect the repo.
3. Build command: `npm install` — Start command: `npm start`.
4. Under **Environment**, add:
   - `MONGODB_URI` — your Atlas connection string from step 2 above.
5. Deploy. Render gives you a public URL like `https://your-quiz.onrender.com` — this is the link you share with every class.

### Will the free tier (0.5 CPU / 512MB) handle ~100 students at once?

Yes, comfortably. This app is plain Express + Socket.io with no heavy processing per request — a bare Node process like this typically uses 60–120MB of RAM, and each connected student's socket costs only a few KB. 100 concurrent students answering multiple-choice questions is a light load for 0.5 CPU. The two things that actually matter on the free tier:

- **Cold starts**: Render's free web services spin down after ~15 minutes with no traffic, and take 30–60 seconds to wake back up. Open your app's URL a few minutes before each round starts so it's already warm — don't rely on the very first request of the day being instant.
- **A real database** (step 2): without it, a Render restart (which can happen at any time on the free tier, not just when you redeploy) wipes all quizzes and results. This is the actual risk at 100-student scale, not CPU/RAM.

If you outgrow the free tier later (multiple symposiums running in parallel, very large audiences), Render's cheapest paid tier removes the spin-down and gives dedicated CPU — but for a single symposium's rounds, free is enough.

## 4. Running the quiz on the day

1. Open the hosted URL → **Admin panel** → log in (or create a staff account per teacher/department beforehand).
2. **Create quiz**: title, round duration, add questions with 2–6 options each, mark the correct one, set marks per question.
3. Click **Publish quiz & get join code** — you land on the live monitor showing a 6-character join code.
4. Optionally click **Open corridor display** to open `lobby.html` on a projector or a screen near the entrance — it shows the join code in big text and every student's name as they join, live.
5. Share the site URL and the join code with students. They go to **Join a quiz** → enter the code, name, college, and roll number.
6. Watch the joined-names list fill in (on the monitor and/or the corridor display), then click **Start round** when ready. Every waiting student's screen switches to the quiz automatically.
7. If a student switches tabs mid-quiz, their attempt auto-submits and locks — flagged in results as "tab-switch auto-submit". If they simply refresh the page (flaky wifi, accidental F5), nothing bad happens — they resume exactly where they were.
8. When the timer runs out (or everyone has submitted, whichever is first), results publish automatically to every student's screen and to your monitor. **End round now** publishes early if needed.
9. **Export results (CSV)** to keep a record.
10. Need to run the same quiz for another class? Click **Reuse** on the dashboard (or **Run again with a new code** on a finished quiz's monitor) — it clones the questions into a fresh quiz with a new join code, no leftover participants.

## Notes and honest limitations

- The admin "account" system is a simple email/password login meant for a handful of staff members, not a full identity system — no email verification or password reset flow. Good enough for an internal event tool.
- The tab-switch detection uses the browser's standard visibility API, which reliably catches switching tabs, minimizing, or switching apps. It deliberately does **not** treat closing/refreshing the tab as cheating (those look identical to a browser, and treating them the same would auto-submit students on every accidental refresh) — a determined student closing the tab entirely to look something up on another device isn't caught by this or any browser-based quiz tool.
- The corridor display and the "roster" it's built on only ever show names and colleges — never roll numbers or scores — since it's meant to be visible to a crowd.
- If your college network blocks outbound access to Render, host on a laptop connected to the venue Wi-Fi instead: run `npm start`, then share `http://<your-laptop-ip>:3000` (find the IP with `ipconfig`/`ifconfig`). MongoDB Atlas still works from there since it's an outbound connection to the internet, not inbound.
