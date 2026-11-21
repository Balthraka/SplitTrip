# web/index.html: what changed from the original page

Only the data layer, sign-in and account screens changed. Every other screen is the original code, unchanged.

| Part | Before | Now |
|---|---|---|
| Data helpers (`fetchTrips`, `saveExpense`, ...) | Supabase queries | Same function names and return shapes, calling the Worker. Money crosses the wire as integer cents; the screens still see decimals (cents / 100), as the old `numeric` columns returned. |
| Saving / editing an expense | expense, then splits, as separate calls | one call; the server writes them together. Edits send the `version` the page loaded; a stale edit shows "Someone else changed this...". |
| Trips list order | downloaded every expense row to sort | server keeps a last-activity time per trip |
| Sign in | email + password, register, forgot password | "Sign in with Google" button, plus "Sign in with Microsoft" (code + PKCE, no secret) once `MS_CLIENT_ID` is set; hidden while empty |
| Account menu | change password, connection log, delete account | delete account only (no passwords exist any more; the connection log was removed at the owner's request) |
| Session | Supabase session in localStorage; sign-out cleared ALL localStorage | one key, `splittrip.session.v1`; sign-out removes only that key |
| Connection handling | 3 s timeout + reset of the Supabase client + pings | plain 15 s request timeout (Workers have no sleeping connections) |
| New messages | | a plain sentence for every error the Worker can send (not invited, stale edit, removing a member who paid, bad email, too many people, unsupported currency, and so on) |
| Opening the app | `/me` then `/me/claim` | one call, `POST /me/claim`, which also returns the user (falls back to `GET /me` if it fails) |
| Email addresses | not checked | checked for the shape `x@y.z` before sending (the Worker checks the same) |
| Delete account | always signed out, even if the request failed | signs out only when the server confirmed the deletion; otherwise says so. The text now says name AND email stay on shared trips and that you would need to be invited again |
| Third-party files | React and ReactDOM floating (`@18`), Babel without a check, Font Awesome from cdnjs | exact versions (React 18.3.1, Babel 7.29.7, Font Awesome 6.5.0) from jsDelivr with `integrity` hashes; the browser refuses a file that differs. The Tailwind CDN script and Google's sign-in script cannot be pinned this way (see the audit) |
| Settle Up | exchange rates fetched one after another | every distinct rate fetched at the same time, then the same maths |

Browser test: `test-web/run.sh` starts the local Worker with two made-up users and drives the page in headless Chrome (needs Python Playwright and Chrome; React and Babel come from `npm i react@18 react-dom@18 @babel/standalone@7.29.7`).
Not covered: the Google button itself (needs a real Google sign-in), and styling (the test stubs the CSS and icon CDNs).

- Opening a trip: the page now calls `GET /trips/:id/all` (one request) instead of members, expenses and payments separately. Same data, same checks, two fewer requests per open. Payments alone are still re-fetched after a payment action.
