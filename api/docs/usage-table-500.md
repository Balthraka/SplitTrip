| Route (one trip with 500+ expenses, ~1,500 splits, 5 members) | Queries | Rows read | Rows written |
|---|---|---|---|
| POST expense (trip already holds 499) | 12 | 18 | 27 |
| GET expenses (500 expenses) | 5 | 2055 | 0 |
| PUT expense (trip holds 500) | 10 | 27 | 12 |
| DELETE expense (trip holds 500) | 6 | 13 | 3 |
| POST payment | 6 | 9 | 7 |
| POST payment confirm | 5 | 6 | 2 |
| DELETE payment (pending) | 4 | 5 | 1 |
| GET expenses (475 expenses, after edits) | 5 | 1957 | 0 |
| GET payments | 4 | 8 | 0 |
| GET /trips | 3 | 27 | 0 |
| DELETE trip (475 expenses) | 4 | 5893 | 1963 |
