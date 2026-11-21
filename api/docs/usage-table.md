| Route (10x dataset: 20 trips x 200 expenses, ~18,000 rows) | Queries | Rows read | Rows written | Note |
|---|---|---|---|---|
| POST /auth/google (sign-in) | 3 | 3 | 3 |  |
| GET /me | 1 | 2 | 0 |  |
| GET /trips (user in all 20 trips) | 3 | 423 | 0 | worst case: 20 trips, 100 members |
| GET /trips/:id | 4 | 5 | 0 |  |
| GET /trips/:id/members | 4 | 15 | 0 |  |
| GET /trips/:id/expenses (200 expenses + splits) | 5 | 789 | 0 | whole trip, as the app needs for balances |
| GET /trips/:id/payments (10) | 4 | 14 | 0 |  |
| GET /trips/:id/all (members + 200 expenses + payments) | 7 | 810 | 0 | the page uses this: one request instead of three |
| POST /trips/:id/expenses (3 splits) | 11 | 16 | 22 |  |
| PUT /trips/:id/expenses/:eid (3 splits) | 12 | 27 | 21 |  |
| DELETE /trips/:id/expenses/:eid | 6 | 17 | 5 |  |
| POST /trips/:id/payments | 6 | 9 | 7 |  |
| POST /trips/:id/payments/:pid/confirm | 5 | 6 | 2 |  |
| DELETE /trips/:id/payments/:pid (pending) | 4 | 5 | 1 |  |
| POST /trips/:id/members | 5 | 10 | 5 |  |
| DELETE /trips/:id/members/:mid (unused member) | 6 | 6 | 1 |  |
| PATCH /trips/:id | 5 | 6 | 1 |  |
| PATCH /me (rename) | 3 | 24 | 21 | also renames the user's member rows |
| POST /me/claim | 2 | 3 | 0 |  |
| DELETE /trips/:id (200 expenses, cascade) | 4 | 2413 | 801 | rare; one-off cost of removing a whole trip |
| DELETE /me (user in 20 trips) | 3 | 16791 | 8402 | rare; promotes a new creator on each owned trip |
