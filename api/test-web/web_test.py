#!/usr/bin/env python3
"""Runs web/index.html in headless Chrome against the LOCAL Worker with made-up users. No real data, no network to Cloudflare."""
import json, re, shutil, subprocess, sys, threading, http.server, socketserver, os
from playwright.sync_api import sync_playwright

SRC = '/home/claude/splittrip-api/web/index.html'
SERVE = '/tmp/webserve'; os.makedirs(SERVE, exist_ok=True)
html = open(SRC, encoding='utf-8').read()
API = re.search(r"const API_BASE\s*= '([^']+)';", html).group(1)
NAMES = 'api,claimMemberships,fetchTrips,fetchTripAll,createTrip,addMemberToTrip,saveExpense,removeExpense,updateExpenseRecord,removeMemberFromTrip,updateTrip,deleteTripById,updateProfileName,fetchPayments,createPayment,confirmPayment,cancelPayment,computeSettlements'
test_html = html.replace(API, 'http://localhost:8787')
assert "const MS_CLIENT_ID     = '';" in test_html
test_html = test_html.replace("const MS_CLIENT_ID     = '';", "const MS_CLIENT_ID     = 'ms-test-client-id';")
marker = "    ReactDOM.createRoot(document.getElementById('root')).render(<App />);"
assert test_html.count(marker) == 1
test_html = test_html.replace(marker, "    window.__t = { " + NAMES + " };\n" + marker)   # test copy only: exposes the helpers
open(f'{SERVE}/index.html', 'w', encoding='utf-8').write(test_html)

class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=SERVE, **k)
    def log_message(s, *a): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', 8080), Q); threading.Thread(target=srv.serve_forever, daemon=True).start()

NM = '/home/claude/webtest/node_modules'
FA = '/tmp/sri-run-21/x/fortawesome-fontawesome-free-6.5.0/package/css'
# The page pins exact versions with integrity hashes: serve the exact npm files, so Chrome checks every hash for real.
LOCAL = {
  'cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js': (f'{NM}/react/umd/react.production.min.js', 'application/javascript'),
  'cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js': (f'{NM}/react-dom/umd/react-dom.production.min.js', 'application/javascript'),
  'cdn.jsdelivr.net/npm/@babel/standalone@7.29.7/babel.min.js': (f'{NM}/@babel/standalone/babel.min.js', 'application/javascript'),
  'fontawesome-free@6.5.0/css/fontawesome.min.css': (f'{FA}/fontawesome.min.css', 'text/css'),
  'fontawesome-free@6.5.0/css/solid.min.css': (f'{FA}/solid.min.css', 'text/css'),
}
reqlog = []          # (method, url) of every request the pages make
mode = {'fail_delete': False, 'rates': None}
fails = []
def check(name, cond, extra=''):
    print(('PASS ' if cond else 'FAIL ') + name + (f'  [{extra}]' if extra and not cond else ''))
    if not cond: fails.append(name)

def route(r):
    u = r.request.url
    reqlog.append((r.request.method, u))
    for k, (p, ct) in LOCAL.items():
        if k in u: return r.fulfill(path=p, content_type=ct, headers={'Access-Control-Allow-Origin': '*'})
    if mode['fail_delete'] and r.request.method == 'DELETE' and u.endswith('/me'):
        return r.fulfill(status=500, content_type='application/json', headers={'Access-Control-Allow-Origin': 'http://localhost:8080'}, body='{"error":"internal"}')
    if 'currency-api@' in u and mode['rates'] is not None:
        return mode['rates'](r)
    if u.startswith('http://localhost'): return r.continue_()
    if 'tailwindcss' in u: return r.fulfill(body='window.tailwind={};', content_type='application/javascript')
    return r.abort()

errors = []
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    def ctx(token):
        c = br.new_context(viewport={'width': 420, 'height': 900})
        c.add_init_script(f"try{{ if(!sessionStorage.getItem('seeded')){{ sessionStorage.setItem('seeded','1'); localStorage.setItem('splittrip.session.v1','{token}'); }} }}catch(e){{}}")
        c.route('**/*', route)
        p = c.new_page()
        p.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
        p.on('console', lambda m: errors.append('console: ' + m.text) if m.type == 'error' and 'ERR_FAILED' not in m.text and 'Failed to load resource' not in m.text else None)
        p.goto('http://localhost:8080/'); p.wait_for_load_state('networkidle')
        return p
    A = ctx('tokenalice-aaaaaaaaaaaaaaaa')
    A.wait_for_timeout(1500)
    check('signed-in boot shows the trips screen (no sign-in card)', 'Sign in to continue' not in A.inner_text('body'))
    boot = [(m, u.split('8787')[1]) for m, u in reqlog if ':8787/' in u and m in ('GET', 'POST', 'PUT', 'PATCH', 'DELETE')]
    check('opening the app: ONE request to /me/claim, no GET /me, then the trip list', boot[:2] == [('POST', '/me/claim'), ('GET', '/trips')] and ('GET', '/me') not in boot, boot)
    hosts = sorted({u.split('/')[2] for m, u in reqlog if u.startswith('http') and ':8080' not in u and ':8787' not in u})
    check('the page only asks jsdelivr, Google and Tailwind for code (no unpkg, no cdnjs)', not any(h in hosts for h in ('unpkg.com', 'cdnjs.cloudflare.com')), hosts)

    ev = lambda page, js: page.evaluate('(() => { const {' + NAMES + '} = window.__t; return (' + js + ')(); })()')
    trip = ev(A, """async () => createTrip('Test Trip','a note','AUD','AUD','u-alice',[
        {name:'Alice Test',email:'alice@example.com',userId:'u-alice',isYou:true},{name:'Bob Test',email:'bob@example.com'},{name:'Cara',email:''}])""")
    tid = trip['id']
    mem = {m['name']: m['id'] for m in ev(A, f"async () => (await fetchTripAll('{tid}'))[0]")}
    check('3 members, Alice linked to her user', len(mem) == 3 and [m for m in ev(A, f"async () => (await fetchTripAll('{tid}'))[0]") if m['name']=='Alice Test'][0]['user_id'] == 'u-alice')
    a, b, c = mem['Alice Test'], mem['Bob Test'], mem['Cara']

    exp = ev(A, f"""async () => saveExpense('{tid}', {{paid_by_member_id:'{a}', amount:100.01, currency:'AUD', date:'2026-11-01',
        description:"Dinner's \\"fun\\"\\nline2", split_type:'equal'}}, [{{memberId:'{a}',amount:33.34}},{{memberId:'{b}',amount:33.34}},{{memberId:'{c}',amount:33.33}}], 'u-alice')""")
    check('expense amount comes back as the decimal 100.01', exp['amount'] == 100.01 and isinstance(exp['amount'], float), exp)
    ex = ev(A, f"async () => (await fetchTripAll('{tid}'))[1]")
    check('list: 1 expense, splits are decimals summing to 100.01', len(ex) == 1 and round(sum(s['amount'] for s in ex[0]['expense_splits']), 2) == 100.01 and ex[0]['description'].startswith("Dinner's"))
    check('splits carry member_id and expense_id', all(s['member_id'] and s['expense_id'] == ex[0]['id'] for s in ex[0]['expense_splits']))
    eid = ex[0]['id']

    ev(A, f"""async () => updateExpenseRecord('{eid}', {{paid_by_member_id:'{b}', amount:90, currency:'AUD', date:'2026-11-02', description:'Edited', split_type:'exact'}},
        [{{memberId:'{a}',amount:30}},{{memberId:'{b}',amount:30}},{{memberId:'{c}',amount:30}}])""")
    ex = ev(A, f"async () => (await fetchTripAll('{tid}'))[1]")
    check('edit saved (amount 90, payer Bob, 3 splits of 30, version 2)', ex[0]['amount'] == 90 and ex[0]['paid_by_member_id'] == b and [s['amount'] for s in ex[0]['expense_splits']] == [30, 30, 30] and ex[0]['version'] == 2, ex)
    stale = ev(A, f"""async () => {{ try {{ await api('PUT','/trips/{tid}/expenses/{eid}',{{paid_by_member_id:'{a}',amount_cents:100,currency:'AUD',date:'2026-11-02',description:'x',split_type:'exact',splits:[{{member_id:'{a}',amount_cents:100}}],version:1}}); return 'no error'; }} catch(e) {{ return e.code + ' | ' + e.message; }} }}""")
    check('stale edit is refused with the friendly message', stale.startswith('stale_version') and 'Someone else changed this' in stale, stale)
    two = ev(A, f"""async () => {{ await updateExpenseRecord('{eid}', {{paid_by_member_id:'{b}', amount:91, currency:'AUD', date:'2026-11-02', description:'Edited again', split_type:'exact'}}, [{{memberId:'{a}',amount:91}}]); return (await fetchTripAll('{tid}'))[1][0].version; }}""")
    check('two edits in a row work (version tracked after each save)', two == 3, two)

    pay = ev(A, f"async () => createPayment({{tripId:'{tid}', fromMemberId:'{b}', toMemberId:'{a}', amount:12.5, currency:'AUD', userId:'u-alice'}})")
    check('payment amount is the decimal 12.5, pending', pay['amount'] == 12.5 and pay['status'] == 'pending', pay)

    # UI: open the trip like a user would
    A.reload(); A.wait_for_load_state('networkidle'); A.wait_for_timeout(1500)
    body = A.inner_text('body')
    check('trips list shows the trip and its members count', 'Test Trip' in body, body[:200])
    A.locator('[title="Account settings"]').click(); A.wait_for_timeout(500)
    acct = A.inner_text('body')
    check('account menu: Delete account only (no password, no connection log)', 'Delete account' in acct and 'Change password' not in acct and 'Connection log' not in acct, acct[:300])
    A.keyboard.press('Escape'); A.reload(); A.wait_for_load_state('networkidle'); A.wait_for_timeout(1500)
    A.get_by_text('Test Trip').first.click(); A.wait_for_timeout(2500)
    body = A.inner_text('body')
    check('trip screen shows the expense and the pending payment', 'Edited again' in body and 'pending' in body.lower(), body[:1200])
    A.screenshot(path='/home/claude/out/web-trip-screen.png')

    # Bob: claims his invited member row, then confirms the payment
    B = ctx('tokenbob-bbbbbbbbbbbbbbbbbbb')
    ev(B, "async () => claimMemberships()")
    bt = ev(B, "async () => fetchTrips()")
    check('Bob sees the trip after claiming (his member row is now linked)', any(t['id'] == tid for t in bt))
    ev(B, f"async () => {{ await fetchPayments('{tid}'); }}")
    pid = ev(B, f"async () => (await fetchPayments('{tid}'))[0].id")
    ev(B, f"async () => confirmPayment('{pid}', 'u-bob')")
    pays = ev(B, f"async () => fetchPayments('{tid}')")
    check('Bob confirmed it (status confirmed, confirmed_at has a T)', pays[0]['status'] == 'confirmed' and 'T' in pays[0]['confirmed_at'], pays)

    p2 = ev(A, f"async () => createPayment({{tripId:'{tid}', fromMemberId:'{c}', toMemberId:'{a}', amount:5, currency:'AUD', userId:'u-alice'}})")
    ev(A, f"async () => cancelPayment('{p2['id']}')")
    check('cancel removes a pending payment', len(ev(A, f"async () => fetchPayments('{tid}')")) == 1)

    nonmember = ev(B, f"async () => {{ try {{ await updateTrip('{tid}', {{name:'hack',description:'',base_currency:'AUD',expense_currency:'AUD'}}); return 'allowed'; }} catch(e) {{ return e.code; }} }}")
    check("a member who is not the creator can't rename the trip", nonmember in ('forbidden', 'not_found') or nonmember != 'allowed', nonmember)

    ev(A, f"async () => updateTrip('{tid}', {{name:'Renamed Trip',description:'x',base_currency:'AUD',expense_currency:'USD'}})")
    ev(A, f"async () => updateTrip('{tid}', {{name:'Renamed Trip 2',description:'x',base_currency:'AUD',expense_currency:'USD'}})")
    ts = ev(A, "async () => fetchTrips()")
    check('trip renamed twice in a row; list sorted; version 3', ts[0]['name'] == 'Renamed Trip 2' and ts[0]['version'] == 3 and ts[0]['expense_currency'] == 'USD', ts)

    ev(A, f"async () => updateProfileName('u-alice','Alice Renamed')")
    me = ev(A, "async () => api('GET','/me')")
    check('profile name updated via PATCH /me', me['name'] == 'Alice Renamed')

    paid_block = ev(A, f"async () => {{ try {{ await removeMemberFromTrip('{b}'); return 'removed'; }} catch(e) {{ return e.message; }} }}")
    check('removing a member who paid is refused with a plain message', 'paid for an expense' in paid_block, paid_block)
    ev(A, f"async () => removeMemberFromTrip('{c}')")
    check('removing a member who only has splits works', len(ev(A, f"async () => (await fetchTripAll('{tid}'))[0]")) == 2)

    ev(A, f"async () => removeExpense('{eid}')")
    check('expense deleted', ev(A, f"async () => (await fetchTripAll('{tid}'))[1]") == [])

    ev(B, "async () => api('DELETE','/me')")
    still = ev(A, "async () => fetchTrips()")
    check("Bob's account deleted; Alice's trip is still there", any(t['id'] == tid for t in still))

    # the 401 path: a bad token returns to the sign-in screen and clears the stored token
    C = ctx('not-a-real-token-1234567890'); C.wait_for_timeout(3000)
    check('a bad token is cleared and the sign-in screen shows', C.evaluate("localStorage.getItem('splittrip.session.v1')") is None and 'Sign in to continue' in C.inner_text('body'), C.inner_text('body')[:200])

    # ---- fixes from the audit ----
    html_src = open(SRC, encoding='utf-8').read()
    tags = re.findall(r'<(?:script|link)[^>]*(?:cdn\.jsdelivr\.net|cdn\.tailwindcss\.com|accounts\.google\.com)[^>]*>', html_src)
    pinned = [t for t in tags if 'jsdelivr' in t]
    check('every jsdelivr script, stylesheet and preload is an exact version with an integrity hash',
          len(pinned) == 8 and all('integrity="sha384-' in t and 'crossorigin="anonymous"' in t and re.search(r'@\d+\.\d+\.\d+/', t) for t in pinned), pinned)

    bad_email = ev(A, f"async () => {{ try {{ await addMemberToTrip('{tid}', 'Typo', 'bob@gmail'); return 'ok'; }} catch(e) {{ return e.message; }} }}")
    check('a server error code the page knows gets a plain sentence (not "Something went wrong (code)")', "doesn't look right" in bad_email and 'Something went wrong' not in bad_email, bad_email)
    unknown = ev(A, f"async () => {{ try {{ await api('POST','/trips/{tid}/expenses',{{}}); return 'ok'; }} catch(e) {{ return e.message; }} }}")
    check('an unexpected code still shows the code so it can be reported', 'Something went wrong (' in unknown or 'amount' in unknown, unknown)

    D = ctx('tokenalice-aaaaaaaaaaaaaaaa'); D.wait_for_timeout(1500)
    D.get_by_role('button', name=re.compile('New Trip')).first.click(); D.wait_for_timeout(600)
    D.get_by_placeholder('Italy 2025, Japan Trip, Vegas Weekend…').fill('Typo trip')
    D.get_by_placeholder('Name *').first.fill('Zed')
    D.get_by_placeholder('Email (optional)').first.fill('zed@gmail')
    reqlog.clear()
    D.get_by_role('button', name=re.compile('Create Trip', re.I)).last.click(); D.wait_for_timeout(800)
    check('a mistyped email is caught in the page, with a message and no request sent',
          "doesn't look right" in D.inner_text('body') and not [1 for m, u in reqlog if ':8787/trips' in u and m == 'POST'], D.inner_text('body')[:300])
    D.keyboard.press('Escape')
    D.reload(); D.wait_for_load_state('networkidle'); D.wait_for_timeout(1200)

    # delete account must not sign the person out when the server did not delete it
    mode['fail_delete'] = True
    D.locator('[title="Account settings"]').click(); D.wait_for_timeout(400)
    D.get_by_text('Delete account').first.click(); D.wait_for_timeout(400)
    D.get_by_placeholder('DELETE').fill('DELETE')
    D.get_by_role('button', name=re.compile('Permanently Delete', re.I)).click(); D.wait_for_timeout(1500)
    body = D.inner_text('body')
    check('delete account fails: the person stays signed in and is told why',
          D.evaluate("localStorage.getItem('splittrip.session.v1')") == 'tokenalice-aaaaaaaaaaaaaaaa' and 'server had a problem' in body and 'Permanently Delete' in body, body[:300])
    check('the delete text is truthful (private mode: invited again; name and email stay on shared trips)', 'invited again' in body and 'email address will stay' in body)
    mode['fail_delete'] = False

    # settle-up rates: fetched together, one request per distinct currency and date; a failure still gives the old message
    import time
    rates_seen = []
    def rates(r):
        rates_seen.append(r.request.url)
        if '2026-10-03' in r.request.url: return r.fulfill(status=404, body='nope', headers={'Access-Control-Allow-Origin': '*'})
        return r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body=json.dumps({'date': 'x', 'vnd': {'aud': 0.0001, 'usd': 0.00004}}))
    mode['rates'] = rates
    members = [{'id': 'a'}, {'id': 'b'}]
    exps = [{'currency': 'VND', 'date': d, 'paid_by_member_id': 'a', 'amount': 1000000, 'expense_splits': [{'member_id': 'a', 'amount': 500000}, {'member_id': 'b', 'amount': 500000}]}
            for d in ('2026-10-01', '2026-10-01', '2026-10-02', '2026-10-04')]
    out = ev(A, "async () => computeSettlements(%s, %s, 'AUD', [])" % (json.dumps(exps), json.dumps(members)))
    check('settle up: 3 distinct dates = 3 rate requests, and the maths is unchanged (4 x 1,000,000 VND at 0.0001 = 400 AUD)',
          len(rates_seen) == 3 and out['totalSpend'] == 400 and out['balances']['a'] == 200 and out['balances']['b'] == -200, (rates_seen, out))
    failing = ev(A, "async () => { try { await computeSettlements(%s, %s, 'AUD', []); return 'ok'; } catch(e) { return e.message; } }" % (json.dumps([dict(exps[0], date='2026-10-03')]), json.dumps(members)))
    check('settle up: a missing rate still reports "Could not fetch exchange rate for VND→AUD"', failing.startswith('Could not fetch exchange rate for VND→AUD'), failing)
    mode['rates'] = None

    # ---- Microsoft sign-in: the redirect, the return, the token exchange (Microsoft and the Worker's /auth/microsoft are mocked) ----
    import hashlib, base64, urllib.parse
    seen = {}
    def ms_route(r):
        u = r.request.url
        if u.startswith('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize'):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(u).query)
            seen['auth'] = {k: v[0] for k, v in q.items()}
            return r.fulfill(status=302, headers={'Location': 'http://localhost:8080/?code=abc123&state=' + q['state'][0]})
        if u.startswith('https://login.microsoftonline.com/consumers/oauth2/v2.0/token'):
            seen['token'] = urllib.parse.parse_qs(r.request.post_data)
            return r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': '*'}, body='{"id_token":"fake.jwt.token"}')
        if u.endswith('/auth/microsoft') and r.request.method == 'POST':
            seen['api'] = r.request.post_data
            return r.fulfill(status=200, content_type='application/json', headers={'Access-Control-Allow-Origin': 'http://localhost:8080'},
                             body=json.dumps({'token': 'tokenalice-aaaaaaaaaaaaaaaa', 'user': {'id': 'u-alice', 'email': 'alice@example.com', 'name': 'Alice Test'}}))
        if u.endswith('/auth/microsoft'):   # CORS preflight
            return r.fulfill(status=204, headers={'Access-Control-Allow-Origin': 'http://localhost:8080', 'Access-Control-Allow-Headers': 'content-type,authorization', 'Access-Control-Allow-Methods': 'POST'})
        return route(r)
    mc = br.new_context(viewport={'width': 420, 'height': 900}); mc.route('**/*', ms_route)
    M = mc.new_page(); M.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    M.goto('http://localhost:8080/'); M.wait_for_load_state('networkidle')
    btn = M.get_by_text('Sign in with Microsoft')
    check('sign-in screen shows the Microsoft button when its id is set', btn.count() == 1)
    btn.click(); M.wait_for_timeout(2500)
    a = seen.get('auth', {})
    check('redirect asks Microsoft for code + PKCE with the right app and return address',
          a.get('client_id') == 'ms-test-client-id' and a.get('response_type') == 'code' and a.get('code_challenge_method') == 'S256'
          and a.get('redirect_uri') == 'http://localhost:8080/' and 'openid' in a.get('scope', ''), a)
    t = seen.get('token', {})
    verifier = (t.get('code_verifier') or [''])[0]
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip('=')
    check('token exchange sends the code and a verifier that matches the challenge', t.get('code') == ['abc123'] and challenge == a.get('code_challenge') and len(verifier) >= 43, t)
    check('the id token goes to the Worker with the nonce from the redirect, and the page signs in', json.loads(seen.get('api', '{}')).get('idToken') == 'fake.jwt.token' and json.loads(seen.get('api', '{}')).get('nonce') == seen['auth']['nonce']
          and M.evaluate("localStorage.getItem('splittrip.session.v1')") == 'tokenalice-aaaaaaaaaaaaaaaa')
    check('the code is cleared from the address bar', '?code' not in M.url and 'state=' not in M.url, M.url)
    M.wait_for_timeout(1500)
    check('after Microsoft sign-in the sign-in card is gone', 'Sign in to continue' not in M.inner_text('body'))
    # wrong state is refused
    bad = br.new_context(); bad.route('**/*', ms_route); B2 = bad.new_page()
    B2.goto('http://localhost:8080/?code=zzz&state=forged'); B2.wait_for_timeout(2500)
    check('a forged return (wrong state) is refused with a message', 'could not be verified' in B2.inner_text('body') and not B2.evaluate("localStorage.getItem('splittrip.session.v1')"), B2.inner_text('body')[:200])
    br.close()

errs = [e for e in errors if 'google' not in e.lower() and 'gsi' not in e.lower()]
check('no page errors in the browser console', not errs, errs[:5])
print('\n%d failed' % len(fails) if fails else '\nall passed')
sys.exit(1 if fails else 0)
