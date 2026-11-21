# SplitTrip API contract (v0)

All routes except `/auth/*` need `Authorization: Bearer <token>`. Money is always integer `amount_cents` (amount x 100).
Errors are `{"error": "<code>"}`. Stale edits return `409 {"error":"stale_version"}`.
Every reply carries `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.
Currencies must be one of the 73 in `src/currencies.ts` (the same list as the page's picker); anything else is `400 invalid_currency` (or `invalid_base_currency` / `invalid_expense_currency`).
A trip holds at most 40 members and an expense at most 40 splits.

| Method | Path | Guard | Notes |
|---|---|---|---|
| POST | /auth/google | public | `{idToken}` -> `{token, user}`; 403 `not_invited` / `email_not_verified` / `account_already_linked` |
| POST | /auth/microsoft | public | same; personal accounts only |
| GET / PATCH / DELETE | /me | user | PATCH `{name}`; DELETE = old `delete_my_account` |
| POST | /me/claim | user | old `claim_memberships` -> `{claimed: n, id, email, name}`. The user fields are the same as `GET /me`, so the page opens with this one call |
| POST | /me/logout | user | revokes this token |
| GET / POST | /trips | user | POST `{name, description?, base_currency, expense_currency?, members:[{name, email?, is_self?}]}` |
| GET / PATCH / DELETE | /trips/:tripId | member / creator / creator | PATCH needs `version` |
| GET / POST | /trips/:tripId/members | member | POST `{name, email?}` |
| DELETE | /trips/:tripId/members/:memberId | creator | 409 `member_paid_expenses` |
| GET | /trips/:tripId/all | member | members, expenses (with `expense_splits`) and payments in one response: `{members, expenses, payments}`. The page uses this to open a trip in one request; the three separate GETs still work |
| GET / POST | /trips/:tripId/expenses | member | list returns each expense with `expense_splits` |
| PUT / DELETE | /trips/:tripId/expenses/:expenseId | member + expense creator | PUT needs `version`; body as POST |
| GET / POST | /trips/:tripId/payments | member | POST `{from_member_id, to_member_id, amount_cents, currency}` |
| POST | /trips/:tripId/payments/:paymentId/confirm | member | pending only |
| DELETE | /trips/:tripId/payments/:paymentId | member | pending only; initiator or either party |

Expense body: `{paid_by_member_id, amount_cents, currency, date:"YYYY-MM-DD", description, split_type:"equal|percent|exact|single", splits:[{member_id, amount_cents}], version?}`.
Timestamps are ISO-8601 UTC with a `T` (the app splits payment `confirmed_at` on `T` to pick the exchange-rate date).
