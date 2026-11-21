#!/usr/bin/env python3
"""Screenshot tour of every screen/state. usage: shots.py <variant> <outdir> [<extra css file>]
variant 'after'  = web/index.html as shipped (prebuilt Tailwind block)
variant 'before' = the same page, but the Tailwind block is replaced by CSS built from the DOM the browser really rendered (what a run-time
                   compiler such as the Play CDN produces: every class actually present on screen)."""
import json, re, sys, os, threading, http.server, socketserver
from playwright.sync_api import sync_playwright
variant, outdir = sys.argv[1], sys.argv[2]; extra = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(outdir, exist_ok=True)
SRC = '/home/claude/splittrip-api/web/index.html'
html = open(SRC, encoding='utf-8').read()
if variant == 'before':
    a = html.index('<!-- tailwind:start'); b = html.index('<!-- tailwind:end -->') + len('<!-- tailwind:end -->')
    html = html[:a] + '<style>' + open(extra, encoding='utf-8').read() + '</style>' + html[b:]
NAMES = re.search(r"NAMES = '([^']+)'", open('/home/claude/splittrip-api/test-web/web_test.py').read().replace('\\\n', '')).group(1)
t = html.replace('https://splittrip-api.YOUR-SUBDOMAIN.workers.dev', 'http://localhost:8787')
t = t.replace("const MS_CLIENT_ID     = '';", "const MS_CLIENT_ID     = 'ms-test-client-id';")   # shows the Microsoft button too
m = "    ReactDOM.createRoot(document.getElementById('root')).render(<App />);"
t = t.replace(m, "    window.__t = { " + NAMES + " };\n" + m)
SERVE = f'/tmp/webserve-{variant}'; os.makedirs(SERVE, exist_ok=True); open(f'{SERVE}/index.html', 'w', encoding='utf-8').write(t)
class Q(http.server.SimpleHTTPRequestHandler):
    def __init__(s, *a, **k): super().__init__(*a, directory=SERVE, **k)
    def log_message(s, *a): pass
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(('127.0.0.1', 8080), Q); threading.Thread(target=srv.serve_forever, daemon=True).start()
NM = '/home/claude/webtest/node_modules'; FA = '/tmp/sri-run-21/x/fortawesome-fontawesome-free-6.5.0/package/css'
LOCAL = {'react@18.3.1/umd/react.production.min.js': (f'{NM}/react/umd/react.production.min.js', 'application/javascript'),
 'react-dom@18.3.1/umd/react-dom.production.min.js': (f'{NM}/react-dom/umd/react-dom.production.min.js', 'application/javascript'),
 '@babel/standalone@7.29.7/babel.min.js': (f'{NM}/@babel/standalone/babel.min.js', 'application/javascript'),
 'fontawesome-free@6.5.0/css/fontawesome.min.css': (f'{FA}/fontawesome.min.css', 'text/css'),
 'fontawesome-free@6.5.0/css/solid.min.css': (f'{FA}/solid.min.css', 'text/css'),
 'fontawesome-free@6.5.0/webfonts/fa-solid-900.woff2': (f'{FA}/../webfonts/fa-solid-900.woff2', 'font/woff2')}
CORS = {'Access-Control-Allow-Origin': '*'}
mode = {'trips500': False, 'delete500': False}
def route(r):
    u = r.request.url
    for k, (p, ct) in LOCAL.items():
        if k in u: return r.fulfill(path=p, content_type=ct, headers=CORS)
    if 'currency-api@' in u:
        if '2026-10-03' in u: return r.fulfill(status=404, body='no', headers=CORS)
        return r.fulfill(status=200, content_type='application/json', headers=CORS, body=json.dumps({'date': 'x', 'vnd': {'aud': 0.0001, 'usd': 0.00004}, 'aud': {'usd': 0.65, 'vnd': 16000}}))
    O = {'Access-Control-Allow-Origin': 'http://localhost:8080'}
    if mode['trips500'] and r.request.method == 'GET' and re.search(r':8787/trips(/|$)', u):
        return r.fulfill(status=500, content_type='application/json', headers=O, body='{"error":"internal"}')
    if mode['delete500'] and r.request.method == 'DELETE' and u.endswith('/me'):
        return r.fulfill(status=500, content_type='application/json', headers=O, body='{"error":"internal"}')
    if u.startswith('http://localhost'): return r.continue_()
    return r.abort()
FREEZE = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
doms = []; log = []; errors = []
SIZES = {'desktop': (1280, 800), 'phone': (390, 844)}
ALICE, BOB, DAVE = 'tokenalice-aaaaaaaaaaaaaaaa', 'tokenbob-bbbbbbbbbbbbbbbbbbb', 'tokendave-dddddddddddddddddd'
with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path='/usr/bin/google-chrome', headless=True, args=['--no-sandbox'])
    def newpage(token, size):
        c = br.new_context(viewport={'width': size[0], 'height': size[1]}, device_scale_factor=1, locale='en-AU', timezone_id='UTC')
        if token: c.add_init_script(f"try{{ if(!sessionStorage.getItem('seeded')){{ sessionStorage.setItem('seeded','1'); localStorage.setItem('splittrip.session.v1','{token}'); }} }}catch(e){{}}")
        c.route('**/*', route); p = c.new_page()
        p.on('pageerror', lambda e: errors.append(str(e)))
        p.goto('http://localhost:8080/'); p.wait_for_load_state('networkidle'); p.add_style_tag(content=FREEZE); p.wait_for_timeout(1200)
        return c, p
    ev = lambda page, js: page.evaluate('(() => { const {' + NAMES + '} = window.__t; return (' + js + ')(); })()')
    # ---- made-up data ----
    c0, A = newpage(ALICE, (1280, 800))
    existing = [t for t in ev(A, 'async () => fetchTrips()') if t['name'] == 'Test Trip']
    trip = existing[0] if existing else ev(A, """async () => createTrip('Test Trip','Made-up trip for screenshots','AUD','AUD','u-alice',[{name:'Alice Test',email:'alice@example.com',userId:'u-alice',isYou:true},{name:'Bob Test',email:'bob@example.com'},{name:'Cara',email:''}])""")
    if not existing: ev(A, """async () => createTrip('Empty Trip','','USD','USD','u-alice',[{name:'Alice Test',email:'alice@example.com',userId:'u-alice',isYou:true}])""")
    tid = trip['id']; mem = {m['name']: m['id'] for m in ev(A, f"async () => (await fetchTripAll('{tid}'))[0]")}
    a, b, c = mem['Alice Test'], mem['Bob Test'], mem['Cara']
    def exp(who, amt, cur, d, desc, st, sp):
        ev(A, f"async () => saveExpense('{tid}', {{paid_by_member_id:'{who}', amount:{amt}, currency:'{cur}', date:'{d}', description:{json.dumps(desc)}, split_type:'{st}'}}, {json.dumps(sp)}, 'u-alice')")
    q = lambda m, x: {'memberId': m, 'amount': x}
    if not existing: exp(a, 100.01, 'AUD', '2026-11-01', 'Dinner at the harbour', 'equal', [q(a, 33.34), q(b, 33.34), q(c, 33.33)])
    if not existing: exp(b, 900000, 'VND', '2026-10-02', 'Street food tour', 'percent', [q(a, 300000), q(b, 300000), q(c, 300000)])
    if not existing: exp(c, 45, 'AUD', '2026-10-04', 'Taxi to the airport with a very long description that must wrap across more than one line on a narrow phone screen', 'single', [q(a, 45)])
    if not existing: ev(A, f"async () => createPayment({{tripId:'{tid}', fromMemberId:'{b}', toMemberId:'{a}', amount:12.5, currency:'AUD', userId:'u-alice'}})")
    c0.close()
    def shot(name, page, size_name):
        page.wait_for_timeout(500)
        doms.append(page.evaluate('document.documentElement.outerHTML'))
        page.screenshot(path=f'{outdir}/{name}-{size_name}.png', full_page=True); log.append(f'{name}-{size_name}')
    def step(name, size_name, fn):
        try: fn()
        except Exception as e: log.append(f'!! {name}-{size_name}: {str(e)[:120]}'); 
    for sn, size in SIZES.items():
        # sign-in
        c, P = newpage(None, size); step('signin', sn, lambda: shot('01-signin', P, sn)); c.close()
        # empty trip list (Bob: no trips, no membership yet) 
        c, P = newpage(DAVE, size); step('empty-list', sn, lambda: shot('02-trips-empty', P, sn)); c.close()
        # trip load error
        mode['trips500'] = True; c, P = newpage(ALICE, size); step('trips-error', sn, lambda: shot('03-trips-load-error', P, sn)); c.close(); mode['trips500'] = False
        # trip list, create-trip modal
        c, P = newpage(ALICE, size); step('list', sn, lambda: shot('04-trips-list', P, sn))
        def create():
            P.get_by_role('button', name=re.compile('new trip', re.I)).first.click(); P.wait_for_timeout(500); P.add_style_tag(content=FREEZE); shot('05-create-trip-modal', P, sn)
            P.locator('input').nth(0).fill('x'); P.get_by_text(re.compile('^(Create|Create Trip)$')).last.click(); P.wait_for_timeout(400); shot('06-create-trip-error', P, sn)
        step('create', sn, create); c.close()
        # trip screens
        c, P = newpage(ALICE, size)
        def opentrip(): P.get_by_text('Test Trip').first.click(); P.wait_for_timeout(1800); P.add_style_tag(content=FREEZE)
        step('open', sn, opentrip); step('trip', sn, lambda: shot('07-trip-expenses', P, sn))
        def expand():
            P.get_by_text('Dinner at the harbour').first.click(); P.wait_for_timeout(400); shot('08-expense-expanded', P, sn)
        step('expand', sn, expand)
        def addexp():
            P.get_by_role('button', name=re.compile('Add Expense')).click(); P.wait_for_timeout(600); P.add_style_tag(content=FREEZE); shot('09-add-expense', P, sn)
            for lab in ('%', 'Exact', '1 Person'):
                P.get_by_role('button', name=lab, exact=True).click(); P.wait_for_timeout(250); shot(f'10-add-expense-split-{re.sub("[^a-z]", "", lab.lower()) or "pct"}', P, sn)
            P.get_by_role('button', name=re.compile(r'^(Add Expense|Save)')).last.click(); P.wait_for_timeout(400); shot('11-add-expense-error', P, sn)
            P.keyboard.press('Escape')
        step('addexp', sn, addexp)
        P.close(); c.close()
        c, P = newpage(ALICE, size); opentrip()
        def settle():
            P.get_by_role('button', name=re.compile('Settle Up')).click(); P.wait_for_timeout(2500); shot('12-settle-up', P, sn)
            P.get_by_text(re.compile("I've paid this|Mark as received")).first.click(); P.wait_for_timeout(400); shot('13-settle-pay-form', P, sn)
        step('settle', sn, settle)
        def people():
            P.get_by_role('button', name=re.compile('People')).click(); P.wait_for_timeout(800); shot('14-people', P, sn)
            P.get_by_text('Add person').click(); P.wait_for_timeout(300); P.get_by_placeholder(re.compile('Email')).fill('not-an-email'); P.get_by_placeholder('Name *').fill('Dan'); 
            P.get_by_role('button', name='Add', exact=True).click(); P.wait_for_timeout(300); shot('15-people-add-error', P, sn)
        step('people', sn, people)
        def edittrip():
            P.locator('[title="Edit trip"]').click(); P.wait_for_timeout(500); P.add_style_tag(content=FREEZE); shot('16-edit-trip', P, sn); P.keyboard.press('Escape')
        step('edittrip', sn, edittrip)
        def deltrip():
            P.reload(); P.wait_for_load_state('networkidle'); P.add_style_tag(content=FREEZE); opentrip(); P.locator('[title="Delete trip"]').click(); P.wait_for_timeout(300); shot('17-delete-trip-confirm', P, sn)
        step('deltrip', sn, deltrip); P.close(); c.close()
        # empty expenses state
        c, P = newpage(ALICE, size)
        step('emptyexp', sn, lambda: (P.get_by_text('Empty Trip').first.click(), P.wait_for_timeout(1800), P.add_style_tag(content=FREEZE), shot('18-trip-empty', P, sn))); c.close()
        # account + delete
        c, P = newpage(ALICE, size)
        def acct():
            P.locator('[title="Account settings"]').click(); P.wait_for_timeout(500); P.add_style_tag(content=FREEZE); shot('19-account', P, sn)
            P.get_by_text('Delete account').first.click(); P.wait_for_timeout(400); shot('20-delete-account-confirm', P, sn)
            P.get_by_placeholder('DELETE').fill('DELETE'); mode['delete500'] = True
            btns = P.get_by_role('button', name=re.compile('delete', re.I)); btns.last.click(); P.wait_for_timeout(800); shot('21-delete-account-error', P, sn); mode['delete500'] = False
        step('acct', sn, acct); c.close()
    br.close()
open(f'{outdir}/_doms.json', 'w').write(json.dumps(doms)); open(f'{outdir}/_log.txt', 'w').write('\n'.join(log + ['ERRORS:'] + errors))
print('\n'.join(log)); print('page errors:', errors[:5])
