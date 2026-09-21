# Symposium Quiz v2

This version adds the features needed for a multi-class college symposium:

- **Separate staff accounts:** staff create an account with name, email and password.
- **One quiz history per staff account:** a staff member sees only quizzes created by that account.
- **Past quiz history:** old quizzes remain on the dashboard; opening a finished quiz shows participants and results, and CSV export includes college.
- **Student college field:** students now enter **Name + College + Roll/Register Number**.
- **Existing live features remain:** quiz codes, live Socket.io updates, timer, tab-switch auto-submit, leaderboard and CSV export.

## Important production note

The current v2 code keeps the original JSON datastore (`data/db.json`) so it is easy to test. For a real internet-hosted event, move the data to a persistent database such as **PostgreSQL (for example Supabase/Neon)**. A normal free cloud web-service filesystem can be reset when the service restarts/redeploys, which could erase quiz history.

For a college event, the recommended production architecture is:

Browser → Node/Express + Socket.io → PostgreSQL

Tables/collections should be:

- `staff_users`
- `sessions`
- `quizzes`
- `questions`
- `participants`
- `answers`

### Staff account flow

1. Open `/admin.html`.
2. Click **Create staff account**.
3. Enter staff name, email and an 8+ character password.
4. Log in.
5. Create quizzes.
6. Each quiz is stored with that staff user's ID.
7. On the dashboard, that account can see its own previous quizzes and results.

### Student flow

1. Student opens the public site.
2. Enters quiz code.
3. Enters name.
4. Enters college.
5. Enters roll/register number.
6. Joins the round.

### Security note

This demo stores password hashes using Node's built-in `scrypt`, not plaintext passwords. For a public production deployment, also add HTTPS, rate limiting, email verification/password reset, stronger session management, database backups, and an organizer-only account creation policy if you do not want anyone on the internet to create staff accounts.

## Local test

```bash
npm install
npm start
```

Then open:

- Student: `http://localhost:3000/student.html`
- Staff/admin: `http://localhost:3000/admin.html`

Create two staff accounts and verify that each sees only its own quizzes.

## Hosting

For a real symposium with many classes, use a Node-compatible host plus a persistent PostgreSQL database. Keep the Socket.io process alive during the event. Open the site before the event starts and run a full rehearsal with multiple phones/laptops.
