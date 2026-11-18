"""Additional real Windows acceptance gates; no synthetic native input or saved tokens."""
import base64
import ctypes
from ctypes import wintypes
import datetime
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
INSTALL = Path('F:/SpaceXpanse-x64-OSGSim')
REPORT = Path(sys.argv[1]).resolve()
OUT = REPORT / ('continuation-' + datetime.datetime.now(datetime.timezone.utc).strftime('%H%M%SZ'))
OUT.mkdir()
USER = ctypes.WinDLL('user32', use_last_error=True)
USER.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
USER.SendMessageW.restype = ctypes.c_ssize_t
USER.GetParent.restype = wintypes.HWND
USER.GetDlgItem.restype = wintypes.HWND
OWNED = []
BACKUPS = {}
GENERATED = []
ENV = dict(os.environ)
ENV.pop('OSG_SOURCE_DIR', None)
ENV['OSG_BRIDGE_TOKEN'] = secrets.token_urlsafe(32)


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2), encoding='utf-8')


def check(command, label, timeout=120):
    with (OUT / (label + '.log')).open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, cwd=ROOT, env=ENV, stdout=stream, stderr=subprocess.STDOUT)
        OWNED.append(process)
        save(label + '-process.json', {'pid': process.pid, 'command': command})
        try:
            code = process.wait(timeout)
        except subprocess.TimeoutExpired:
            save(label + '-timeout.json', {'pid': process.pid, 'timeoutSeconds': timeout})
            process.terminate()
            code = process.wait(10)
        save(label + '-exit.json', {'command': command, 'exitCode': code})
        return code


def spawn(command, label):
    process = subprocess.Popen(command, cwd=INSTALL if label.startswith('sim') else ROOT, env=ENV,
                               stdout=(OUT / (label + '.stdout.log')).open('w'),
                               stderr=(OUT / (label + '.stderr.log')).open('w'))
    OWNED.append(process)
    save(label + '-process.json', {'pid': process.pid, 'command': command})
    return process


def api(endpoint):
    with urllib.request.urlopen('http://127.0.0.1:4377/api/' + endpoint, timeout=20) as response:
        return json.load(response)


def wait_until(predicate, seconds, page=None):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        if page:
            page.wait_for_timeout(100)
        else:
            time.sleep(.1)
    return False


def signal(name):
    (OUT / (name + '.signal')).touch()


def windows(pid):
    found = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def add(hwnd, _):
        owner = wintypes.DWORD()
        USER.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            text = ctypes.create_unicode_buffer(512)
            cls = ctypes.create_unicode_buffer(128)
            USER.GetWindowTextW(hwnd, text, len(text))
            USER.GetClassNameW(hwnd, cls, len(cls))
            found.append({'hwnd': hwnd, 'text': text.value, 'class': cls.value,
                          'id': USER.GetDlgCtrlID(hwnd), 'parent': USER.GetParent(hwnd),
                          'visible': bool(USER.IsWindowVisible(hwnd))})
        return True
    callback = callback_type(add)
    USER.EnumWindows(callback, 0)
    for window in list(found):
        USER.EnumChildWindows(window['hwnd'], callback, 0)
    return found


def blocked_only():
    global sim, receiver, connection
    receiver = socket.socket()
    receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    receiver.bind(('127.0.0.1', 4378))
    receiver.listen(1)
    receiver.settimeout(150)
    name = 'OSG-Blocked-' + OUT.name
    scenario = INSTALL / 'Scenarios' / (name + '.scn')
    script = INSTALL / 'Script' / (name + '.lua')
    assert not scenario.exists() and not script.exists()
    GENERATED.extend([scenario, script])
    text = (ROOT / 'scenarios/OSG-Sim-Moon-Descent.scn').read_text().replace('  System Sol', '  System Sol\n  Script ' + name)
    vessel = text.split('BEGIN_SHIPS\n', 1)[1].split('END_SHIPS', 1)[0]
    text = text.replace('END_SHIPS', ''.join(vessel.replace('OSG-Lander', 'Blocked-' + str(i)) for i in range(7)) + 'END_SHIPS')
    scenario.write_text(text, encoding='ascii')
    script.write_text("proc.wait_simtime(19.9)\noapi.write_log('OSG_BLOCKED_STOP_PENDING sys='..oapi.get_systime())\n", encoding='ascii')
    shutil.copy2(scenario, OUT / 'blocked-receiver.scn')
    shutil.copy2(script, OUT / 'blocked-receiver.lua')
    sim = spawn([str(INSTALL / 'Modules/Server/SpaceXpanse.exe'), '-s', name, '--fixedstep=0.02', '--maxsimtime=20', '--maxsystime=90'], 'sim-blocked-only')
    connection, address = receiver.accept()
    connected = time.monotonic()
    marker = None
    available = wintypes.ULONG()
    ws = ctypes.WinDLL('Ws2_32')
    ws.ioctlsocket.argtypes = [ctypes.c_size_t, ctypes.c_long, ctypes.POINTER(wintypes.ULONG)]
    progress = []
    deadline = time.monotonic() + 120
    while sim.poll() is None and time.monotonic() < deadline:
        ws.ioctlsocket(connection.fileno(), ctypes.c_long(0x4004667f), ctypes.byref(available))
        progress.append({'secondsConnected': time.monotonic() - connected, 'unreadBytes': available.value})
        log = (INSTALL / 'SpaceXpanse.log').read_text(errors='replace')
        if marker is None and 'OSG_BLOCKED_STOP_PENDING' in log:
            marker = time.monotonic()
        save('blocked-receiver-progress.json', progress)
        time.sleep(.05)
    result = {'receiverReadCalls': 0, 'receiveBufferBytes': connection.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF),
              'unreadBytesMaximum': max(x['unreadBytes'] for x in progress), 'exitCode': sim.poll(),
              'forced': False, 'secondsConnected': time.monotonic() - connected,
              'secondsFromPreShutdownMarker': time.monotonic() - marker if marker is not None else None,
              'command': 'simulator --maxsimtime=20 natural shutdown with nonreading TCP receiver; pre-shutdown Lua marker at 19.9',
              'scope': 'Actual installed DLL, eight vessels, no receiver read calls including HELLO'}
    if sim.poll() is None:
        result['cleanup'] = close_sim(sim, 'blocked-timeout')
        result['forced'] = result['cleanup']['forced']
    save('blocked-receiver-result.json', result)
    shutil.copy2(INSTALL / 'SpaceXpanse.log', OUT / 'blocked-simulator.log')
    connection.close()
    connection = None
    receiver.close()
    receiver = None


def close_sim(process, label):
    started = time.monotonic()
    candidates = [w for w in windows(process.pid) if w['class'] != '#32770' and not w['parent']]
    for window in candidates:
        USER.PostMessageW(window['hwnd'], 0x0010, 0, 0)
    forced = False
    try:
        code = process.wait(15)
    except subprocess.TimeoutExpired:
        forced = True
        process.terminate()
        code = process.wait(10)
    result = {'command': 'WM_CLOSE to task-owned simulator main window', 'exitCode': code,
              'secondsFromCloseRequest': time.monotonic() - started, 'forced': forced, 'windows': candidates}
    save(label + '-shutdown.json', result)
    return result


def snapshot(page):
    return {name: page.locator('#' + name).inner_text() for name in
            ['step', 'source-label', 'contact', 'event-count', 'altitude', 'scene-message']}


def try_recreate(pid):
    # Only ordinary messages to the task-owned Scenario Editor; no injected code.
    result = {'route': 'Installed Scenario Editor via Ctrl+F4 custom command and Win32 controls'}
    signal('editor')
    time.sleep(2)
    result['windowsBefore'] = windows(pid)
    lists = [w for w in result['windowsBefore'] if w['class'] == 'ListBox' and w['visible']]
    for control in lists:
        count = USER.SendMessageW(control['hwnd'], 0x018B, 0, 0)
        for index in range(min(count, 50)):
            text = ctypes.create_unicode_buffer(512)
            USER.SendMessageW(control['hwnd'], 0x0189, index, ctypes.addressof(text))
            if 'Scenario Editor' in text.value:
                USER.SendMessageW(control['hwnd'], 0x0186, index, 0)
                USER.PostMessageW(control['parent'], 0x0111, (2 << 16) | control['id'], control['hwnd'])
    time.sleep(1)
    current = windows(pid)
    new_button = next((w for w in current if w['id'] == 1007 and w['visible']), None)
    if new_button:
        USER.SendMessageW(new_button['hwnd'], 0x00F5, 0, 0)
        time.sleep(.5)
        current = windows(pid)
        name = next((w for w in current if w['id'] == 1072 and w['visible']), None)
        tree = next((w for w in current if w['id'] == 1112 and w['visible']), None)
        create = next((w for w in current if w['id'] == 1059 and w['visible']), None)
        if name and tree and create:
            text = ctypes.create_unicode_buffer('OSG-Companion')
            USER.SendMessageW(name['hwnd'], 0x000C, 0, ctypes.addressof(text))
            USER.SetFocus(tree['hwnd'])
            for letter in 'ShuttlePB':
                USER.SendMessageW(tree['hwnd'], 0x0102, ord(letter), 0)
            USER.SendMessageW(create['hwnd'], 0x00F5, 0, 0)
            time.sleep(1)
    result['windowsAfter'] = windows(pid)
    save('same-name-recreation-route.json', result)


def gpu_probe(playwright, headless, args, label):
    result = {'headless': headless, 'args': args, 'pageErrors': [], 'console': [], 'network': []}
    browser = None
    try:
        browser = playwright.chromium.launch(headless=headless, args=args, timeout=20000)
        session = browser.new_browser_cdp_session()
        result['systemInfo'] = session.send('SystemInfo.getInfo')
        page = browser.new_page(viewport={'width': 1280, 'height': 900})
        page.on('pageerror', lambda error: result['pageErrors'].append(str(error)))
        page.on('console', lambda message: result['console'].append({'type': message.type, 'text': message.text}))
        page.on('requestfailed', lambda request: result['network'].append({'url': request.url, 'failure': request.failure}))
        page.on('response', lambda response: result['network'].append({'url': response.url, 'status': response.status})
                if 'playcanvas' in response.url else None)
        page.goto('http://127.0.0.1:4377/?observer=A', wait_until='domcontentloaded', timeout=15000)
        result['webgl'] = page.evaluate('''() => { const g=document.createElement('canvas').getContext('webgl2');
          if(!g)return null; const e=g.getExtension('WEBGL_debug_renderer_info');
          return {version:g.getParameter(g.VERSION), renderer:g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER)}; }''')
        page.locator('#enable-playcanvas').click(timeout=5000)
        page.wait_for_timeout(10000)
        result['button'] = page.locator('#enable-playcanvas').inner_text()
        result['message'] = page.locator('#scene-message').inner_text()
        result['rendererLabel'] = page.locator('#renderer-label').inner_text()
        result['fontStatus'] = page.evaluate('() => document.fonts.status')
        # CDP screenshot does not wait for document fonts, unlike the original failing capture.
        capture = page.context.new_cdp_session(page).send('Page.captureScreenshot', {'format': 'png'})
        (OUT / (label + '.png')).write_bytes(base64.b64decode(capture['data']))
    except Exception as error:
        result['error'] = str(error)
    finally:
        if browser:
            browser.close()
        save(label + '.json', result)
    return result


service = None
sim = None
receiver = None
connection = None
slow = None
summary = {'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'reportDirectory': str(OUT)}
try:
    for filename in ['SpaceXpanse_NG.cfg', 'SpaceXpanse_NG.~cfg', 'SpaceXpanse.log', 'SpaceXpanse.log_',
                     'D3D9Client.cfg', 'Scenarios/(Current state).scn']:
        path = INSTALL / filename
        BACKUPS[filename] = path.read_bytes() if path.exists() else None
        if path.exists():
            target = OUT / 'originals' / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(BACKUPS[filename])
    for port in [4377, 4378]:
        with socket.socket() as probe:
            try:
                probe.connect(('127.0.0.1', port))
            except ConnectionRefusedError:
                continue
            raise RuntimeError('Port already occupied: ' + str(port))
    cfg = BACKUPS['SpaceXpanse_NG.cfg'].decode('ascii').replace('\r\n', '\n')
    cfg = cfg.replace('Fullscreen = TRUE', 'Fullscreen = FALSE').replace('WindowWidth = 400', 'WindowWidth = 1280').replace('WindowHeight = 300', 'WindowHeight = 720')
    cfg = cfg.replace('  OSGSimBridge\n', '  OSGSimBridge\n  ScnEditor\n')
    if os.environ.get('OSG_ACCEPTANCE_NO_GRAPHICS'):
        cfg = cfg.replace('  D3D9Client\n', '')
    cfg += '\nStartPaused = FALSE\nSystimeSampling = FALSE\n'
    (INSTALL / 'SpaceXpanse_NG.cfg').write_text(cfg, encoding='ascii')
    (OUT / 'temporary-runtime.cfg').write_bytes((INSTALL / 'SpaceXpanse_NG.cfg').read_bytes())
    if os.environ.get('OSG_ACCEPTANCE_BLOCKED_ONLY'):
        blocked_only()
        raise SystemExit(0)
    scenario_name = 'OSG-Continuation-' + OUT.name
    scenario = INSTALL / 'Scenarios' / (scenario_name + '.scn')
    script = INSTALL / 'Script' / (scenario_name + '.lua')
    assert not scenario.exists() and not script.exists()
    GENERATED.extend([scenario, script])
    text = (ROOT / 'scenarios/OSG-Sim-Moon-Descent.scn').read_text().replace('  System Sol', '  System Sol\n  Script ' + scenario_name)
    companion = '''OSG-Companion:ShuttlePB
  STATUS Orbiting Moon
  RPOS 1749000.0 0.0 0.0
  RVEL 0.0 0.0 1600.0
  AROT 0.0 0.0 0.0
  PRPLEVEL 0:1.000 1:1.000
END
'''
    scenario.write_text(text.replace('END_SHIPS', companion + 'END_SHIPS'), encoding='ascii')
    lua_path = OUT.as_posix()
    lua = '''local function mark(s) oapi.write_log('OSG_CONTINUATION '..s..' sim='..oapi.get_simtime()) end
local function await(s)
  local path = 'REPORTPATH/'..s..'.signal'
  while true do local f=io.open(path,'r'); if f then f:close(); return end; proc.skip() end
end
mark('READY')
proc.wait_simtime(56)
mark('CONTACT_HOLD')
mark('TIME_JUMP_REQUEST')
oapi.set_simmjd(oapi.get_simmjd()+30/86400)
proc.wait_sysdt(3)
mark('TIME_JUMP_DONE')
local v=vessel.get_interface('OSG-Lander')
local s=v:get_status(2)
s.status=0; s.rpos={x=1749000,y=0,z=0}; s.rvel={x=0,y=0,z=1600}
v:defset_status(s)
v:shift_centreofmass({x=100,y=0,z=0})
mark('VESSEL_JUMP_CALLBACK_REQUESTED shift_local_m=100')
proc.wait_sysdt(3)
mark('REPOSITION_DONE')
oapi.del_vessel('OSG-Companion')
proc.wait_sysdt(3)
mark('DELETE_DONE count='..vessel.get_count())
oapi.simulatebufferedkey(OAPI_KEY.F4,OAPI_KEY.LCONTROL)
mark('EDITOR_REQUESTED')
proc.wait_sysdt(60)
mark('FINISH_REQUESTED')
oapi.set_simmjd(oapi.get_simmjd()+20000/86400)
'''.replace('REPORTPATH', lua_path)
    script.write_text(lua, encoding='ascii')
    shutil.copy2(scenario, OUT / 'lifecycle.scn')
    shutil.copy2(script, OUT / 'lifecycle.lua')
    stop_path = OUT / 'stop-service.signal'
    ENV['OSG_DATA_DIR'] = str(OUT / 'native-data')
    ENV['OSG_ACCEPTANCE_STOP'] = str(stop_path)
    # Observe write return/queue length without changing service behavior.
    service_code = """import {existsSync,appendFileSync} from 'node:fs';import net from 'node:net';
import {createWorldServer} from './apps/world-service/server.mjs';
const write=net.Socket.prototype.write;net.Socket.prototype.write=function(...args){const ok=write.apply(this,args);
if(this.localPort===4377&&(!ok||this.writableLength>65536))appendFileSync(process.env.OSG_DATA_DIR+'/../socket-backpressure.jsonl',JSON.stringify({utc:new Date().toISOString(),ok,writableLength:this.writableLength,needDrain:this.writableNeedDrain})+'\\n');return ok};
const app=await createWorldServer({dataDir:process.env.OSG_DATA_DIR});console.log('READY');
const timer=setInterval(async()=>{if(existsSync(process.env.OSG_ACCEPTANCE_STOP)){clearInterval(timer);await app.close();console.log('CLOSED');process.exit(0)}},200);"""
    service = spawn(['node', '--input-type=module', '-e', service_code.replace('\n', ' ')], 'service')
    def ready():
        try:
            return api('status')['mode'] == 'native'
        except Exception:
            return False
    assert wait_until(ready, 15), 'Service not ready'
    if os.environ.get('OSG_ACCEPTANCE_GPU_ONLY'):
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            for headless, args, label in [(True, [], 'gpu-default'), (False, ['--use-angle=d3d11', '--ignore-gpu-blocklist'], 'gpu-headed-d3d11'),
                                         (True, ['--use-angle=d3d11', '--disable-software-rasterizer', '--ignore-gpu-blocklist'], 'gpu-hardware-only')]:
                gpu_probe(p, headless, args, label)
        raise SystemExit(0)
    from playwright.sync_api import sync_playwright, expect
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pages = []
        browser_result = {'pageErrors': [], 'stages': []}
        for ident in ['A', 'B', 'C']:
            page = browser.new_page(viewport={'width': 1450, 'height': 1024})
            page.add_init_script('''(() => {
              window.acceptance={resets:[],contacts:[],epochs:{},entities:{},samples:0};
              const Original=window.WebSocket;
              window.WebSocket=class extends Original {constructor(...args){super(...args);this.addEventListener('message',event=>{
                const d=JSON.parse(event.data), a=window.acceptance;
                if(d.type==='SIMULATION_RESET') {const r={frame:d};a.resets.push(r);requestAnimationFrame(()=>requestAnimationFrame(()=>{
                  r.dom=Object.fromEntries(['event-count','altitude','source-label','step','contact'].map(id=>[id,document.getElementById(id)?.textContent]));}));}
                if(d.type==='CONTACT_BEGIN'||d.type==='CONTACT_END')a.contacts.push(d);
                if(d.type==='PHYSICS_SAMPLE'){a.samples++;a.epochs[d.epoch]??=d;a.entities[d.entityId]={first:a.entities[d.entityId]?.first??d,last:d};}
              });}};
            })();''')
            page.on('pageerror', lambda error: browser_result['pageErrors'].append(str(error)))
            page.goto('http://127.0.0.1:4377/?observer=' + ident)
            expect(page.locator('#authority')).to_contain_text('SDK')
            pages.append(page)
        sim = spawn([str(INSTALL / 'Modules/Server/SpaceXpanse.exe'), '-s', scenario_name,
                     '--fixedstep=0.02', '--maxsimtime=20000', '--maxsystime=180'], 'sim-lifecycle')
        assert wait_until(lambda: api('status')['samplesAccepted'] > 10, 120, pages[0]), 'No native telemetry within startup allowance'
        save('lifecycle-runtime-status.json', api('status'))
        slow = socket.socket()
        slow.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
        slow.connect(('127.0.0.1', 4377))
        slow.sendall(b'GET /ws HTTP/1.1\r\nHost: 127.0.0.1:4377\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n')
        # Do not read this observer until capture ends.
        before = [snapshot(page) for page in pages]
        pages[0].locator('#camera-yaw').fill('101')
        browser_result['independentYaw'] = pages[1].locator('#camera-yaw').input_value() == '-58'
        assert wait_until(lambda: any(event['type'] == 'CONTACT_BEGIN' for event in api('journal')['events']), 130, pages[0]), 'No pre-reset native contact'
        browser_result['stages'].append({'stage': 'beforeJump', 'status': api('status'), 'entities': api('entities'), 'dom': [snapshot(page) for page in pages]})
        save('lifecycle-browser.json', browser_result)
        initial_epoch = api('state')['state']['epoch']
        signal('jump')
        jumped = wait_until(lambda: api('state')['state']['epoch'] > initial_epoch, 15, pages[0])
        pages[0].wait_for_timeout(300)
        browser_result['stages'].append({'stage': 'afterJump', 'observedNewEpoch': jumped, 'status': api('status'), 'state': api('state'), 'dom': [snapshot(page) for page in pages]})
        save('lifecycle-browser.json', browser_result)
        jump_epoch = api('state')['state']['epoch']
        signal('reposition')
        repositioned = wait_until(lambda: 'REPOSITION_DONE' in (INSTALL / 'SpaceXpanse.log').read_text(errors='replace'), 12, pages[0])
        pages[0].wait_for_timeout(300)
        browser_result['stages'].append({'stage': 'afterReposition', 'observedNewEpoch': repositioned, 'status': api('status'), 'state': api('state'), 'dom': [snapshot(page) for page in pages]})
        signal('delete')
        wait_until(lambda: 'DELETE_DONE' in (INSTALL / 'SpaceXpanse.log').read_text(errors='replace'), 12, pages[0])
        pages[0].wait_for_timeout(300)
        browser_result['stages'].append({'stage': 'afterDelete', 'entities': api('entities'), 'status': api('status'), 'dom': [snapshot(page) for page in pages]})
        try_recreate(sim.pid)
        pages[0].wait_for_timeout(2000)
        browser_result['stages'].append({'stage': 'afterRecreateAttempt', 'entities': api('entities'), 'status': api('status'), 'dom': [snapshot(page) for page in pages]})
        browser_result['before'] = before
        browser_result['after'] = [snapshot(page) for page in pages]
        browser_result['transportCapture'] = [page.evaluate('() => window.acceptance') for page in pages]
        save('lifecycle-browser.json', browser_result)
        browser.close()
        if not os.environ.get('OSG_ACCEPTANCE_SKIP_GPU'):
            for headless, args, label in [(True, [], 'gpu-default'), (False, ['--use-angle=d3d11', '--ignore-gpu-blocklist'], 'gpu-headed-d3d11'),
                                          (True, ['--use-angle=d3d11', '--disable-software-rasterizer', '--ignore-gpu-blocklist'], 'gpu-hardware-only')]:
                gpu_probe(p, headless, args, label)
    save('lifecycle-status-final.json', api('status'))
    save('lifecycle-journal.json', api('journal'))
    save('lifecycle-state-final.json', api('state'))
    signal('finish')
    try:
        sim.wait(90)
        save('lifecycle-shutdown.json', {'command': 'scenario final time jump crosses --maxsimtime=20000', 'exitCode': sim.returncode, 'forced': False})
    except subprocess.TimeoutExpired:
        close_sim(sim, 'lifecycle')
    shutil.copy2(INSTALL / 'SpaceXpanse.log', OUT / 'lifecycle-simulator.log')
    slow.settimeout(3)
    total = 0
    closed = False
    try:
        while True:
            data = slow.recv(65536)
            if not data:
                closed = True
                break
            total += len(data)
    except (ConnectionResetError, ConnectionAbortedError):
        closed = True
    except socket.timeout:
        pass
    save('nonreading-observer.json', {'receiveBuffer': slow.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF), 'bytesDrainedAfterTest': total, 'closedByService': closed})
    slow.close()
    slow = None
    stop_path.touch()
    service.wait(45)
    save('service-exit.json', {'exitCode': service.returncode})
    check(['node', 'scripts/verify-native-journal.mjs', str(OUT / 'native-data')], 'native-journal')
    if os.environ.get('OSG_ACCEPTANCE_LIFECYCLE_ONLY'):
        raise SystemExit(0)
    check(['npm.cmd', 'run', 'test:e2e'], 'browser-regression-rerun', 100)
    # Real native worker connected to a receiver that NEVER reads, including HELLO.
    receiver = socket.socket()
    receiver.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    receiver.bind(('127.0.0.1', 4378))
    receiver.listen(1)
    receiver.settimeout(120)
    blocked_name = scenario_name + '-Blocked'
    blocked = INSTALL / 'Scenarios' / (blocked_name + '.scn')
    assert not blocked.exists()
    GENERATED.append(blocked)
    blocked_text = (ROOT / 'scenarios/OSG-Sim-Moon-Descent.scn').read_text()
    for index in range(7):
        blocked_text = blocked_text.replace('END_SHIPS', companion.replace('OSG-Companion', 'OSG-Blocked-' + str(index)) + 'END_SHIPS')
    blocked.write_text(blocked_text, encoding='ascii')
    shutil.copy2(blocked, OUT / 'blocked-receiver.scn')
    sim = spawn([str(INSTALL / 'Modules/Server/SpaceXpanse.exe'), '-s', blocked_name,
                 '--fixedstep=0.02', '--maxsystime=40'], 'sim-blocked')
    connection, address = receiver.accept()
    connection.setsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF, 1024)
    connected_at = time.monotonic()
    time.sleep(8)
    available = wintypes.ULONG()
    ws = ctypes.WinDLL('Ws2_32')
    ws.ioctlsocket.argtypes = [ctypes.c_size_t, ctypes.c_long, ctypes.POINTER(wintypes.ULONG)]
    ws.ioctlsocket(connection.fileno(), ctypes.c_long(0x4004667f), ctypes.byref(available))
    check(['powershell', '-NoProfile', '-Command', f'(Get-Process -Id {sim.pid}).Modules | Select-Object ModuleName,FileName | ConvertTo-Json'], 'blocked-modules')
    result = close_sim(sim, 'blocked-receiver')
    result.update({'receiverReadCalls': 0, 'receiveBufferBytes': connection.getsockopt(socket.SOL_SOCKET, socket.SO_RCVBUF),
                   'unreadBytesBeforeClose': available.value, 'secondsConnectedBeforeStop': time.monotonic() - connected_at - result['secondsFromCloseRequest'],
                   'scope': 'Actual installed DLL with 8 vessels; receiver never reads any telemetry or HELLO'})
    save('blocked-receiver-result.json', result)
    shutil.copy2(INSTALL / 'SpaceXpanse.log', OUT / 'blocked-simulator.log')
    connection.close()
    connection = None
    receiver.close()
    receiver = None
except Exception as error:
    summary['error'] = {'type': type(error).__name__, 'message': str(error)}
finally:
    if slow:
        slow.close()
    if connection:
        connection.close()
    if receiver:
        receiver.close()
    for process in reversed(OWNED):
        if process.poll() is None:
            if process == service:
                signal('stop-service')
                try:
                    process.wait(15)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(10)
            elif process == sim:
                close_sim(process, 'cleanup-sim')
            else:
                process.terminate()
                process.wait(10)
    if (INSTALL / 'SpaceXpanse.log').exists():
        shutil.copy2(INSTALL / 'SpaceXpanse.log', OUT / 'simulator-before-restoration.log')
    restored = []
    for filename, content in BACKUPS.items():
        path = INSTALL / filename
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(content)
        restored.append({'path': filename, 'restored': path.read_bytes() == content if content is not None else not path.exists(),
                         'sha256Before': hashlib.sha256(content).hexdigest() if content is not None else None,
                         'sha256After': hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None})
    for path in GENERATED:
        path.unlink(missing_ok=True)
    summary.update({'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'restoration': restored,
                    'ownedProcesses': [{'pid': process.pid, 'exitCode': process.poll()} for process in OWNED],
                    'temporaryFilesRemoved': all(not path.exists() for path in GENERATED)})
    save('execution-result.json', summary)
    print(json.dumps(summary, indent=2))
    (REPORT / 'continuation-latest.json').write_text(json.dumps({'directory': str(OUT), 'exitCode': 1 if 'error' in summary else 0}, indent=2))
sys.exit(1 if 'error' in summary else 0)
