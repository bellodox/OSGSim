"""Bounded live Windows capture; never synthesizes physics samples or saves tokens."""
import datetime, hashlib, json, os, pathlib, secrets, shutil, subprocess, sys, time, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
INSTALL = pathlib.Path('F:/SpaceXpanse-x64-OSGSim')
REPORT = pathlib.Path(sys.argv[1]).resolve()
REPORT.mkdir(parents=True, exist_ok=True)

def save(name, value):
    (REPORT / name).write_text(json.dumps(value, indent=2), encoding='utf-8')

def request(endpoint):
    with urllib.request.urlopen('http://127.0.0.1:4377/api/' + endpoint, timeout=4) as response:
        return json.load(response)

def check(command, name, env=None):
    with (REPORT / (name + '.log')).open('w', encoding='utf-8') as output:
        result = subprocess.run(command, cwd=ROOT, env=env, stdout=output, stderr=subprocess.STDOUT)
    save(name + '.exit.json', {'command': command, 'exitCode': result.returncode})
    return result.returncode

def modules(pid, label):
    command = ['powershell', '-NoProfile', '-Command', f"(Get-Process -Id {pid}).Modules | Select-Object ModuleName,FileName,ModuleMemorySize | ConvertTo-Json -Depth 3"]
    check(command, label + '-modules')

backups = {}
service = None
sim = None
generated = []
name = 'OSG-Acceptance-' + REPORT.name
scenario = INSTALL / 'Scenarios' / (name + '.scn')
script = INSTALL / 'Script' / (name + '.lua')
config = INSTALL / 'SpaceXpanse_NG.cfg'
try:
    for filename in ['SpaceXpanse_NG.cfg', 'SpaceXpanse_NG.~cfg', 'SpaceXpanse.log', 'SpaceXpanse.log_', 'D3D9Client.cfg', 'Scenarios/(Current state).scn']:
        path = INSTALL / filename
        backups[filename] = path.read_bytes() if path.exists() else None
        if path.exists():
            target = REPORT / 'originals' / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(backups[filename])
    check(['git', 'status', '--porcelain=v1', '-uall'], 'initial-git-status')
    check(['git', 'rev-parse', 'HEAD'], 'revision')
    check(['osg.cmd', 'context', '--workspace', str(ROOT), '--task', 'Windows live acceptance OSGSimBridge native telemetry simulator', '--max-tokens', '800', '--json'], 'osg-context')
    if not os.environ.get('OSG_ACCEPTANCE_SKIP_PORTABLE'):
        check(['node', '--test', 'tests/integration.test.mjs'], 'integration')
        check(['npm.cmd', 'run', 'verify:portable'], 'portable')
    scenario_text = (ROOT / 'scenarios/OSG-Sim-Moon-Descent.scn').read_text()
    scenario_text = scenario_text.replace('  System Sol', '  System Sol\n  Script ' + name)
    scenario.write_text(scenario_text, encoding='ascii')
    generated.append(scenario)
    script.write_text("proc.wait_simtime(1)\noapi.simulatebufferedkey(OAPI_KEY.C,OAPI_KEY.LCONTROL)\noapi.write_log('OSG acceptance recorder started')\nproc.wait_simtime(90)\noapi.simulatebufferedkey(OAPI_KEY.C,OAPI_KEY.LCONTROL)\noapi.write_log('OSG acceptance recorder stopped')\n", encoding='ascii')
    generated.append(script)
    shutil.copy2(scenario, REPORT / 'scenario.scn')
    shutil.copy2(script, REPORT / 'recorder.lua')
    cfg = backups['SpaceXpanse_NG.cfg'].decode('ascii').replace('\r\n', '\n')
    cfg = cfg.replace('Fullscreen = TRUE', 'Fullscreen = FALSE')
    cfg = cfg.replace('WindowWidth = 400', 'WindowWidth = 1280').replace('WindowHeight = 300', 'WindowHeight = 720')
    cfg += '\nStartPaused = FALSE\nSystimeSampling = FALSE\n'
    config.write_text(cfg, encoding='ascii')
    env = dict(os.environ)
    env.pop('OSG_SOURCE_DIR', None)
    env['OSG_BRIDGE_TOKEN'] = secrets.token_urlsafe(32)
    env['OSG_DATA_DIR'] = str(REPORT / 'native-data')
    env['OSG_ACCEPTANCE_STOP'] = str(REPORT / 'stop-service')
    service_code = "import {existsSync} from 'node:fs';import {createWorldServer} from './apps/world-service/server.mjs';const a=await createWorldServer({dataDir:process.env.OSG_DATA_DIR});console.log('READY');const t=setInterval(async()=>{if(existsSync(process.env.OSG_ACCEPTANCE_STOP)){clearInterval(t);await a.close();console.log('CLOSED');process.exit(0)}},250);"
    service = subprocess.Popen(['node', '--input-type=module', '-e', service_code], cwd=ROOT, env=env, stdin=subprocess.PIPE, stdout=(REPORT / 'service.log').open('w'), stderr=(REPORT / 'service.stderr.log').open('w'))
    for attempt in range(40):
        try:
            save('status-initial.json', request('status'))
            break
        except Exception:
            if service.poll() is not None:
                raise RuntimeError('Service exited before readiness')
            time.sleep(.25)
    args = [str(INSTALL / 'Modules/Server/SpaceXpanse.exe'), '-s', name, '--fixedstep=0.02', '--maxsimtime=95', '--maxsystime=240']
    sim = subprocess.Popen(args, cwd=INSTALL, env=env, stdout=(REPORT / 'simulator.stdout.log').open('w'), stderr=(REPORT / 'simulator.stderr.log').open('w'))
    save('processes.json', {'servicePid': service.pid, 'simulatorPid': sim.pid, 'simulatorCommand': args, 'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'dllSHA256': hashlib.sha256((INSTALL / 'Modules/Plugin/OSGSimBridge.dll').read_bytes()).hexdigest()})
    progress = []
    start = time.monotonic()
    got_modules = False
    while sim.poll() is None and time.monotonic() - start < 280:
        try:
            status = request('status')
            progress.append({'utc': datetime.datetime.now(datetime.timezone.utc).isoformat(), **status})
            save('status-progress.json', progress)
            if status['samplesAccepted'] > 0 and not got_modules:
                modules(sim.pid, 'instrumented')
                got_modules = True
                browser = subprocess.Popen(['python.exe', 'tests/windows_live_browser.py', str(REPORT)], cwd=ROOT, stdout=(REPORT / 'browser.stdout.log').open('w'), stderr=(REPORT / 'browser.stderr.log').open('w'))
                save('browser-process.json', {'pid': browser.pid})
            if status['samplesAccepted'] > 0:
                save('state-latest.json', request('state'))
                save('journal-live.json', request('journal'))
        except Exception as error:
            save('poll-error.json', {'error': str(error)})
        time.sleep(2)
    if sim.poll() is None:
        modules(sim.pid, 'instrumented-timeout')
        save('simulator-timeout.json', {'pid': sim.pid, 'seconds': time.monotonic()-start})
        subprocess.run(['powershell', '-NoProfile', '-Command', f'(Get-Process -Id {sim.pid}).CloseMainWindow()'], stdout=subprocess.DEVNULL)
        try:
            sim.wait(15)
        except subprocess.TimeoutExpired:
            sim.terminate()
            sim.wait(10)
    save('instrumented-exit.json', {'exitCode': sim.returncode, 'seconds': time.monotonic()-start})
    shutil.copy2(INSTALL / 'SpaceXpanse.log', REPORT / 'instrumented-simulator.log')
    for file in (INSTALL / 'Flights' / name).glob('*'):
        dest = REPORT / 'instrumented' / file.name
        dest.parent.mkdir(exist_ok=True)
        shutil.copy2(file, dest)
    save('status-final.json', request('status'))
    save('journal-final.json', request('journal'))
    if got_modules:
        try:
            browser.wait(45)
        except subprocess.TimeoutExpired:
            browser.terminate(); browser.wait(10)
    (REPORT / 'stop-service').touch()
    service.wait(60)
    save('service-exit.json', {'exitCode': service.returncode})
    check(['node', 'scripts/verify-native-journal.mjs', str(REPORT / 'native-data')], 'native-journal')
    if not progress or not any(item['samplesAccepted'] for item in progress):
        raise RuntimeError('No native samples; preserve failed attempt without mislabeling a baseline comparison')
    save('instrumented-complete.json', {'readyForBaseline': True})
    # A file handshake permits the executor to finish browser checks before baseline.
    for attempt in range(60):
        if (REPORT / 'continue-baseline').exists():
            break
        time.sleep(1)
    cfg_baseline = cfg.replace('  OSGSimBridge\n', '')
    config.write_text(cfg_baseline, encoding='ascii')
    shutil.copy2(config, REPORT / 'baseline-config.cfg')
    # Preserve first recording before removing only files created by this test.
    flight_dir = INSTALL / 'Flights' / name
    if flight_dir.exists():
        shutil.rmtree(flight_dir)
    sim = subprocess.Popen(args, cwd=INSTALL, env=env, stdout=(REPORT / 'baseline.stdout.log').open('w'), stderr=(REPORT / 'baseline.stderr.log').open('w'))
    save('baseline-process.json', {'pid': sim.pid, 'command': args})
    time.sleep(12)
    if sim.poll() is None:
        modules(sim.pid, 'baseline')
    try:
        sim.wait(280)
    except subprocess.TimeoutExpired:
        save('baseline-timeout.json', {'pid': sim.pid})
        subprocess.run(['powershell', '-NoProfile', '-Command', f'(Get-Process -Id {sim.pid}).CloseMainWindow()'], stdout=subprocess.DEVNULL)
        try:
            sim.wait(15)
        except subprocess.TimeoutExpired:
            sim.terminate()
            sim.wait(10)
    save('baseline-exit.json', {'exitCode': sim.returncode})
    shutil.copy2(INSTALL / 'SpaceXpanse.log', REPORT / 'baseline-simulator.log')
    for file in flight_dir.glob('*'):
        dest = REPORT / 'baseline' / file.name
        dest.parent.mkdir(exist_ok=True)
        shutil.copy2(file, dest)
    check(['node', 'scripts/compare-trajectories.mjs', str(REPORT / 'baseline/OSG-Lander.pos'), str(REPORT / 'instrumented/OSG-Lander.pos')], 'physics-comparison')
except Exception as error:
    save('execution-error.json', {'type': type(error).__name__, 'message': str(error)})
finally:
    if sim and sim.poll() is None:
        sim.terminate()
        sim.wait(10)
    if service and service.poll() is None:
        try:
            (REPORT / 'stop-service').touch(); service.wait(20)
        except Exception:
            service.terminate(); service.wait(10)
    restored = []
    for filename, content in backups.items():
        path = INSTALL / filename
        if content is None:
            path.unlink(missing_ok=True)
        else:
            path.write_bytes(content)
        restored.append({'path': filename, 'restored': (path.read_bytes() == content) if content is not None else not path.exists()})
    for path in generated:
        path.unlink(missing_ok=True)
    for directory in [INSTALL / 'Flights' / name]:
        if directory.exists():
            shutil.rmtree(directory)
    (INSTALL / 'Scenarios/Playback' / (name + '.scn')).unlink(missing_ok=True)
    save('cleanup.json', {'restoration': restored, 'serviceExit': service.returncode if service else None, 'simulatorExit': sim.returncode if sim else None, 'finishedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat()})
