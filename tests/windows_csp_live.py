"""Bounded original-scene hardware capture; never injects native telemetry or saves tokens."""
import base64
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
OUT = Path(sys.argv[1]).resolve()
OUT.mkdir(parents=True, exist_ok=True)
BACKUPS = {}
GENERATED = []
OWNED = []
result = {'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'errors': []}
service = sim = browser = None
stop = OUT / 'stop-service.signal'
env = dict(os.environ)
env.pop('OSG_SOURCE_DIR', None)
env['OSG_BRIDGE_TOKEN'] = secrets.token_urlsafe(32)
env['OSG_DATA_DIR'] = str(OUT / 'native-data')
env['OSG_ACCEPTANCE_STOP'] = str(stop)


def save(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2), encoding='utf-8')


def check(command, label, timeout=120):
    with (OUT / (label + '.log')).open('w', encoding='utf-8') as stream:
        process = subprocess.Popen(command, cwd=ROOT, stdout=stream, stderr=subprocess.STDOUT)
        OWNED.append(process)
        try:
            code = process.wait(timeout)
        except subprocess.TimeoutExpired:
            process.terminate()
            code = process.wait(10)
            result['errors'].append(label + ' exceeded deadline')
    save(label + '.exit.json', {'command': command, 'exitCode': code})
    return code


def api(endpoint):
    with urllib.request.urlopen('http://127.0.0.1:4377/api/' + endpoint, timeout=5) as response:
        return json.load(response)


def spawn(command, label, cwd):
    process = subprocess.Popen(command, cwd=cwd, env=env,
                               stdout=(OUT / (label + '.stdout.log')).open('w'),
                               stderr=(OUT / (label + '.stderr.log')).open('w'))
    OWNED.append(process)
    save(label + '.process.json', {'pid': process.pid, 'command': command})
    return process


INSTRUMENT = r'''() => {
 window.capture={workers:[],workerMessages:[],samples:0,contacts:[],lastSample:null,updates:[],textureUnlocks:[],draws:0};
 const a=window.capture, W=window.Worker;
 window.Worker=class extends W {constructor(...args){super(...args);a.workers.push({url:String(args[0])});this.addEventListener('message',e=>{const d=e.data;a.workerMessages.push({keys:Object.keys(d),count:d.count,orderLength:d.order?.length,orderFirst:d.order?Array.from(d.order.slice(0,12)):null});if(a.workerMessages.length>200)a.workerMessages.shift();});}};
 const WS=window.WebSocket;
 window.WebSocket=class extends WS {constructor(...args){super(...args);this.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.type==='PHYSICS_SAMPLE'){a.samples++;a.lastSample=d;}if(d.type==='CONTACT_BEGIN'||d.type==='CONTACT_END')a.contacts.push(d);});}};
}'''

HOOK = r'''async () => {
 const pc=await import('https://cdn.jsdelivr.net/npm/playcanvas@2.24.0/build/playcanvas.mjs');
 const a=window.capture;
 const update=pc.GSplatContainer.prototype.update;
 pc.GSplatContainer.prototype.update=function(...args){const r=update.apply(this,args);window.captureContainer=this;const rec={n:args[0],changed:args[1],time:a.lastSample?.simTime,centers:Array.from(this.centers.slice(0,12)),aabb:{center:this.aabb.center,halfExtents:this.aabb.halfExtents}};if(a.updates.length<400||a.updates.at(-1)?.n!==rec.n||rec.n>0){a.updates.push(rec);if(a.updates.length>1500)a.updates.splice(1,1);}return r;};
 const unlock=pc.Texture.prototype.unlock;
 pc.Texture.prototype.unlock=function(...args){if(this.name?.includes('dataCenter')||this.name?.includes('dataColor')){a.textureUnlocks.push({name:this.name,time:a.lastSample?.simTime,first:this._levels?.[0]?Array.from(this._levels[0].slice(0,16)):null});if(a.textureUnlocks.length>400)a.textureUnlocks.shift();}return unlock.apply(this,args);};
 window.capturePC=pc;
 return {version:pc.version,containerMethods:Object.getOwnPropertyNames(pc.GSplatContainer.prototype)};
}'''

SNAPSHOT = r'''() => {
 const pc=window.capturePC, app=pc.Application.getApplication(), a=window.capture;
 const g=app.graphicsDevice.gl,e=g.getExtension('WEBGL_debug_renderer_info');
 const visual=app.root.findByName('4D Contact Event Field'), c=visual?.gsplat;
 const instance=c?.instance;
 const mi=instance?.meshInstance;
 return {utc:new Date().toISOString(),dom:Object.fromEntries(['step','contact','scene-message','renderer-label','source-label'].map(id=>[id,document.getElementById(id)?.textContent])),
 canvas:{id:app.graphicsDevice.canvas.id,width:app.graphicsDevice.width,height:app.graphicsDevice.height,renderer:g.getParameter(e?e.UNMASKED_RENDERER_WEBGL:g.RENDERER),version:g.getParameter(g.VERSION)},
 samples:a.samples,lastSample:a.lastSample,contacts:a.contacts,workers:a.workers,workerMessages:a.workerMessages,
 updateCount:a.updates.length,latestUpdate:a.updates.at(-1),activeUpdates:a.updates.filter(x=>x.n>0).slice(-6),
 textureUnlockCount:a.textureUnlocks.length,textureUnlocks:a.textureUnlocks.slice(-4),
 componentKeys:c?Object.keys(c):[],instanceKeys:instance?Object.keys(instance):[],mesh:mi?{visible:mi.visible,visibleThisFrame:mi.visibleThisFrame,cull:mi.cull,instancingCount:mi.instancingCount,aabb:{center:mi.aabb.center,halfExtents:mi.aabb.halfExtents}}:null,
 drawCalls:app.stats.drawCalls,frame:app.stats.frame};
}'''

try:
    for port in [4377, 4378]:
        with socket.socket() as probe:
            probe.settimeout(1)
            assert probe.connect_ex(('127.0.0.1', port)) != 0, 'Occupied port: ' + str(port)
    assert check(['powershell', '-NoProfile', '-Command', "@(Get-Process -Name SpaceXpanse -ErrorAction SilentlyContinue).Count"], 'simulator-preflight') == 0
    assert (OUT / 'simulator-preflight.log').read_text().strip() == '0', 'Existing simulator must be preserved'
    # The negative regression mutates only the policy bytes, then restores in finally.
    source = ROOT / 'apps/world-service/server.mjs'
    original = source.read_bytes()
    assert original.count(b'worker-src blob:;') == 1
    try:
        source.write_bytes(original.replace(b'worker-src blob:;', b''))
        code = check(['node', '--test', 'tests/observer-csp.test.mjs'], 'csp-before-fix')
        assert code != 0, 'Regression must fail without worker-src'
    finally:
        source.write_bytes(original)
        save('source-restoration.json', {'byteIdentical': source.read_bytes() == original, 'sha256': hashlib.sha256(original).hexdigest()})
    assert check(['node', '--test', 'tests/observer-csp.test.mjs'], 'csp-restored') == 0
    for filename in ['SpaceXpanse_NG.cfg', 'SpaceXpanse_NG.~cfg', 'SpaceXpanse.log', 'SpaceXpanse.log_', 'D3D9Client.cfg', 'Scenarios/(Current state).scn']:
        path = INSTALL / filename
        BACKUPS[filename] = path.read_bytes() if path.exists() else None
        if path.exists():
            dest = OUT / 'originals' / filename
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(BACKUPS[filename])
    check(['powershell', '-NoProfile', '-Command', "Get-Process -Id 23016 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json"], 'wallet-before')
    name = 'OSG-CSP-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d-%H%M%S')
    scenario = INSTALL / 'Scenarios' / (name + '.scn')
    assert not scenario.exists()
    scenario.write_bytes((ROOT / 'scenarios/OSG-Sim-Moon-Descent.scn').read_bytes())
    GENERATED.append(scenario)
    shutil.copy2(scenario, OUT / 'original-scene.scn')
    cfg = BACKUPS['SpaceXpanse_NG.cfg'].decode('ascii').replace('\r\n', '\n')
    # Simulator graphics are unnecessary; the observer still uses actual D3D11 hardware.
    cfg = cfg.replace('  D3D9Client\n', '').replace('Fullscreen = TRUE', 'Fullscreen = FALSE')
    cfg += '\nStartPaused = FALSE\nSystimeSampling = FALSE\n'
    (INSTALL / 'SpaceXpanse_NG.cfg').write_text(cfg, encoding='ascii')
    (OUT / 'temporary-runtime.cfg').write_bytes((INSTALL / 'SpaceXpanse_NG.cfg').read_bytes())
    code = "import {existsSync} from 'node:fs';import {createWorldServer} from './apps/world-service/server.mjs';const a=await createWorldServer({dataDir:process.env.OSG_DATA_DIR});console.log('READY');const t=setInterval(async()=>{if(existsSync(process.env.OSG_ACCEPTANCE_STOP)){clearInterval(t);await a.close();console.log('CLOSED');process.exit(0)}},200);"
    service = spawn(['node', '--input-type=module', '-e', code], 'service', ROOT)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            save('status-initial.json', api('status'))
            break
        except Exception:
            time.sleep(.2)
    else:
        raise RuntimeError('Service readiness deadline')
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        args = ['--use-angle=d3d11', '--disable-software-rasterizer', '--ignore-gpu-blocklist']
        browser = p.chromium.launch(headless=True, args=args, timeout=20000)
        save('gpu-system.json', {'headless': True, 'args': args, 'systemInfo': browser.new_browser_cdp_session().send('SystemInfo.getInfo')})
        page = browser.new_page(viewport={'width': 1450, 'height': 1024})
        page.set_default_timeout(15000)
        page.set_default_navigation_timeout(20000)
        console, errors, network = [], [], []
        page.on('console', lambda m: console.append({'type': m.type, 'text': m.text}))
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('response', lambda r: network.append({'url': r.url, 'status': r.status}) if r.status >= 400 or 'playcanvas' in r.url else None)
        page.on('requestfailed', lambda r: network.append({'url': r.url, 'failure': r.failure}))
        page.add_init_script('(' + INSTRUMENT + ')()')
        page.goto('http://127.0.0.1:4377/?observer=A', wait_until='domcontentloaded')
        try:
            page.wait_for_load_state('networkidle', timeout=3000)
        except Exception as error:
            save('network-idle-qualification.json', {'reason': str(error), 'readiness': 'DOM plus explicit engine-enabled condition'})
        save('engine-hook.json', page.evaluate(HOOK))
        page.locator('#enable-playcanvas').click()
        page.wait_for_function("() => document.querySelector('#enable-playcanvas').textContent.includes('ENABLED')", timeout=30000)
        first = page.evaluate(SNAPSHOT)
        save('gpu-before-native.json', first)
        assert first['canvas']['id'] == 'scene-3d'
        assert 'D3D11' in first['canvas']['renderer'] and 'SwiftShader' not in first['canvas']['renderer']
        sim = spawn([str(INSTALL / 'Modules/Server/SpaceXpanse.exe'), '-s', name, '--fixedstep=0.02', '--maxsimtime=65', '--maxsystime=180'], 'simulator', INSTALL)
        result['dllSHA256'] = hashlib.sha256((INSTALL / 'Modules/Plugin/OSGSimBridge.dll').read_bytes()).hexdigest()
        progress, snapshots = [], []
        started = time.monotonic()
        module_checked = False
        while time.monotonic() - started < 210:
            page.wait_for_timeout(300)
            status = api('status')
            progress.append({'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), **status})
            save('telemetry-progress.json', progress)
            snap = page.evaluate(SNAPSHOT)
            snapshots.append(snap)
            save('scene-progress.json', snapshots)
            save('browser-console.json', {'console': console, 'pageErrors': errors, 'network': network})
            if status.get('samplesAccepted', 0) > 0 and not module_checked:
                # Bound module enumeration; capture actual loaded plugin independently of the token.
                spawn(['powershell', '-NoProfile', '-Command', f"(Get-Process -Id {sim.pid}).Modules | Where-Object {{$_.ModuleName -match 'OSGSimBridge|SpaceXpanse'}} | Select-Object ModuleName,FileName,ModuleMemorySize | ConvertTo-Json"], 'native-modules', ROOT)
                module_checked = True
            if snap['latestUpdate'] and snap['latestUpdate']['n'] > 0 and not (OUT / 'contact.png').exists():
                capture = page.context.new_cdp_session(page).send('Page.captureScreenshot', {'format': 'png'})
                (OUT / 'contact.png').write_bytes(base64.b64decode(capture['data']))
                save('contact-scene.json', snap)
            if sim.poll() is not None:
                break
        result['simulatorNaturalExit'] = sim.poll() is not None
        result['simulatorExit'] = sim.poll()
        result['elapsedLiveSeconds'] = time.monotonic() - started
        save('status-final.json', api('status'))
        save('journal-final.json', api('journal'))
        save('state-final.json', api('state'))
        save('capture-final.json', page.evaluate('() => window.capture'))
        capture = page.context.new_cdp_session(page).send('Page.captureScreenshot', {'format': 'png'})
        (OUT / 'final.png').write_bytes(base64.b64decode(capture['data']))
        save('browser-console.json', {'console': console, 'pageErrors': errors, 'network': network})
        browser.close()
        browser = None
        result['pageErrors'] = errors
        result['activeSnapshots'] = sum(bool(x.get('latestUpdate') and x['latestUpdate']['n'] > 0) for x in snapshots)
        result['workerResultMessages'] = len(snapshots[-1]['workerMessages']) if snapshots else 0
        result['authenticatedSamplesObserved'] = any(x.get('nativeAuthenticated') and x.get('samplesAccepted', 0) > 0 for x in progress)
    stop.touch()
    service.wait(30)
    assert check(['node', 'scripts/verify-native-journal.mjs', str(OUT / 'native-data')], 'native-journal') == 0
except Exception as error:
    result['errors'].append({'type': type(error).__name__, 'message': str(error)})
finally:
    if browser:
        try:
            browser.close()
        except Exception:
            pass
    for process in reversed(OWNED):
        if process.poll() is None:
            if process == service:
                stop.touch()
                try:
                    process.wait(15)
                except subprocess.TimeoutExpired:
                    process.terminate()
                    process.wait(10)
                    result['serviceForced'] = True
            else:
                process.terminate()
                process.wait(10)
                if process == sim:
                    result['simulatorForced'] = True
    if BACKUPS and (INSTALL / 'SpaceXpanse.log').exists():
        shutil.copy2(INSTALL / 'SpaceXpanse.log', OUT / 'simulator.log')
    restoration = []
    for filename, content in BACKUPS.items():
        path = INSTALL / filename
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(content)
        restoration.append({'path': filename, 'byteIdentical': path.read_bytes() == content if content is not None else not path.exists(), 'sha256Before': hashlib.sha256(content).hexdigest() if content is not None else None, 'sha256After': hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None})
    for path in GENERATED:
        path.unlink(missing_ok=True)
    check(['powershell', '-NoProfile', '-Command', "Get-Process -Id 23016 -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime | ConvertTo-Json; Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in 4377,4378} | Select-Object LocalPort,OwningProcess | ConvertTo-Json"], 'cleanup-safety')
    check(['git', 'status', '--porcelain=v1', '-uall'], 'final-git-status')
    result.update({'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'restoration': restoration, 'temporaryFilesRemoved': all(not x.exists() for x in GENERATED), 'ownedProcesses': [{'pid': x.pid, 'exitCode': x.poll()} for x in OWNED], 'journalLockFiles': [str(x.relative_to(OUT)) for x in (OUT / 'native-data').rglob('*.lock')]})
    save('execution-result.json', result)
    print(json.dumps(result, indent=2))
sys.exit(1 if result['errors'] else 0)
