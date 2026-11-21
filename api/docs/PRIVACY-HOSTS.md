# Which outside hosts the page talks to

The page itself has no privacy screen today. Adding a sentence to the page is a visible change, so it is proposed here, not made. This list is what such a sentence must cover.

| Host | What it is for | What it can see |
|---|---|---|
| `cdn.jsdelivr.net` | React, ReactDOM, Babel and Font Awesome (all pinned to an exact version with an integrity hash, so a changed file is refused), and the exchange-rate files (`@fawazahmed0/currency-api`) | The visitor's IP address and browser details. For rates: which currency and date were asked for. |
| `fonts.googleapis.com` and `fonts.gstatic.com` | The Sora font | The visitor's IP address and browser details |
| `accounts.google.com` | The "Sign in with Google" button and script. Google serves this script itself, so it cannot be pinned with a hash. | Google sees that the visitor opened the page |
| `login.microsoftonline.com` | Microsoft sign-in, only if it is switched on | Microsoft sees the sign-in |
| The SplitTrip Worker (Cloudflare) | All trip data | Everything the visitor saves |
| GitHub Pages | Serves the page | The visitor's IP address |

Tailwind is no longer downloaded: its CSS is built ahead of time into the page (`npm run build:css`).

Proposed sentence for the sign-in screen: "SplitTrip loads its code, icons and exchange rates from jsDelivr, its font from Google Fonts, and sign-in from Google (and Microsoft if enabled). Those services see your IP address. Your trips are stored with Cloudflare."
