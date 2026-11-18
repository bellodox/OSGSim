"""Reconcile existing Windows acceptance evidence without launching or altering runtime."""
import datetime
import hashlib
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
REPORT = Path(sys.argv[1]).resolve()
INSTALL = Path('F:/SpaceXpanse-x64-OSGSim')


def load(path):
    content = (REPORT / path).read_bytes()
    encoding = 'utf-16' if content.startswith((b'\xff\xfe', b'\xfe\xff')) else 'utf-8-sig'
    return json.loads(content.decode(encoding))


def save(path, value):
    (REPORT / path).write_text(json.dumps(value, indent=2), encoding='utf-8')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


previous = load('gate-results-before-continuation.json')
result = load('gate-results-before-continuation.json')
gates = result['gates']
lifecycle_dir = 'continuation-154728Z/'
time_dir = 'continuation-154033Z/'
gpu_dir = 'continuation-153339Z/'
blocked_dir = 'continuation-153203Z/'
live = load(lifecycle_dir + 'lifecycle-browser.json')
status = load(lifecycle_dir + 'lifecycle-status-final.json')
journal = load(lifecycle_dir + 'lifecycle-journal.json')['events']
resets = [event for event in journal if event['type'] == 'SIMULATION_RESET']
blocked = load(blocked_dir + 'blocked-receiver-result.json')
assert blocked['exitCode'] == 0 and not blocked['forced'] and blocked['receiverReadCalls'] == 0
assert {event['epoch'] for event in resets} == {1, 2}
assert load('browser-regression-csp-fixed-exit.json')['exitCode'] == 0
assert not live['pageErrors']

# Independently compare direct children observed before the task to all current PIDs.
process_command = ['powershell', '-NoProfile', '-Command',
                   'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Depth 3']
process_result = subprocess.run(process_command, cwd=ROOT, capture_output=True, text=True)
assert process_result.returncode == 0
current = json.loads(process_result.stdout)
current_ids = {item['ProcessId'] for item in current}
owned_ids = set()
attempts = []
restoration_checks = []
for directory in sorted(REPORT.glob('continuation-*/')):
    execution = directory / 'execution-result.json'
    if not execution.exists():
        continue
    entry = json.loads(execution.read_text())
    for item in entry['ownedProcesses']:
        owned_ids.add(item['pid'])
    attempts.append({'directory': directory.name, 'error': entry.get('error'),
                     'ownedProcessExits': entry['ownedProcesses'],
                     'restored': all(item['restored'] for item in entry['restoration']),
                     'temporaryFilesRemoved': entry['temporaryFilesRemoved']})
    for item in entry['restoration']:
        path = INSTALL / item['path']
        actual = digest(path) if path.exists() else None
        restoration_checks.append({'attempt': directory.name, 'path': item['path'],
                                   'expected': item['sha256Before'], 'actual': actual,
                                   'matches': actual == item['sha256Before']})
for path in REPORT.glob('*driver*-process.json'):
    owned_ids.add(load(path.name)['pid'])
for path in ['continuation-driver-process.json', 'continuation-driver-rerun-process.json',
             'continuation-driver-startup120-process.json', 'continuation-driver-nographics-process.json',
             'browser-regression-csp-fixed-process.json', 'continuation-node-tests-process.json']:
    if (REPORT / path).exists():
        owned_ids.add(load(path)['pid'])
owned_present = sorted(owned_ids & current_ids)
ports_command = ['powershell', '-NoProfile', '-Command',
                 "@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object {$_.LocalPort -in 4377,4378} | Select-Object LocalPort,OwningProcess) | ConvertTo-Json"]
ports_result = subprocess.run(ports_command, cwd=ROOT, capture_output=True, text=True)
assert ports_result.returncode == 0
ports = json.loads(ports_result.stdout) if ports_result.stdout.strip() else []
cleanup = {'taskOwnedPidsChecked': sorted(owned_ids), 'stillPresent': owned_present,
           'ports4377And4378': ports, 'processInspectionExit': process_result.returncode,
           'portInspectionExit': ports_result.returncode,
           'preexistingWalletPid': 23016, 'preexistingWalletPreserved': 23016 in current_ids,
           'restorationChecks': restoration_checks, 'attempts': attempts,
           'internalBrowser': 'closed', 'memoryWrites': 'none; parent-owned persistence'}
assert not owned_present, owned_present
assert not ports, ports
assert all(item['matches'] for item in restoration_checks)
assert cleanup['preexistingWalletPreserved']
save('continuation-cleanup-proof.json', cleanup)

command = ['python.exe', 'tests/windows_acceptance_continuation.py', 'reports/windows-acceptance/20261118T144230Z']
reset_capture = []
for index, observer in enumerate(live['transportCapture']):
    reset_capture.append({'observer': 'ABC'[index], 'samples': observer['samples'],
                          'resets': [{'epoch': item['frame']['epoch'], 'step': item['frame']['step'],
                                      'dom': item.get('dom')} for item in observer['resets']],
                          'epochFirstSamples': observer['epochs']})
    assert {item['frame']['epoch'] for item in observer['resets']} == {1, 2}
    assert all(item.get('dom', {}).get('event-count') == '00 EVENTS' for item in observer['resets'])
save('continuation-native-reset-summary.json', reset_capture)

gates['time_jump'] = {
    'verdict': 'PASS', 'command': command,
    'environmentOverrides': {'OSG_ACCEPTANCE_NO_GRAPHICS': '1', 'OSG_ACCEPTANCE_LIFECYCLE_ONLY': '1', 'OSG_ACCEPTANCE_SKIP_GPU': '1'},
    'simulatorExitCode': load(time_dir + 'lifecycle-shutdown.json')['exitCode'],
    'serviceExitCode': load(time_dir + 'service-exit.json')['exitCode'],
    'operation': 'Actual simulator Lua set_simmjd +30 seconds at simTime 56',
    'epochBefore': 0, 'epochAfter': 1, 'firstStep': 1, 'firstSequence': 1,
    'firstSimTimeAfter': 86.01999998696148,
    'observerEventCountsCleared': [item['resets'][0]['dom']['event-count'] for item in reset_capture],
    'evidence': [time_dir + 'lifecycle-simulator.log', time_dir + 'lifecycle-browser.json', lifecycle_dir + 'lifecycle-journal.json'],
    'qualification': 'Run exit 0 is execution completion, not every gate PASS; snapshots are asynchronous; journal and WebSocket frames establish epoch boundary.'}
gates['vessel_reposition_epoch_reset'] = {
    'verdict': 'PASS', 'command': command,
    'environmentOverrides': {'OSG_ACCEPTANCE_LIFECYCLE_ONLY': '1', 'OSG_ACCEPTANCE_SKIP_GPU': '1'},
    'operation': 'SDK DefSetStateEx relocation followed by explicit 100 m vessel-local ShiftCentreOfMass, which invokes clbkVesselJump',
    'epochBefore': 1, 'epochAfter': 2, 'firstStep': 1,
    'observerEventCountsCleared': [item['resets'][1]['dom']['event-count'] for item in reset_capture],
    'evidence': [lifecycle_dir + 'lifecycle.lua', lifecycle_dir + 'lifecycle-journal.json', 'continuation-native-reset-summary.json'],
    'qualification': 'Earlier DefSetStateEx-only route changed vessel state but did not notify vessel jump. Explicit SDK jump path was then verified. Graphical session later froze opening editor and was forcibly cleaned up (exit 1); this does not erase observed epoch transitions. afterReposition observedNewEpoch field is a legacy harness stage marker, not authoritative epoch proof; use journal/transportCapture.'}
gates['multiple_vessels'] = {
    'verdict': 'PASS', 'command': command,
    'entities': list(live['transportCapture'][0]['entities']),
    'scope': 'Two actual ShuttlePB vessels, interleaved native sequences, selected-browser vessel isolation; no synthetic native frames',
    'evidence': [lifecycle_dir + 'lifecycle.scn', lifecycle_dir + 'lifecycle-browser.json'],
    'serviceErrors': status['errors']}
gates['vessel_destruction'] = {
    'verdict': 'PASS', 'operation': "oapi.del_vessel('OSG-Companion')", 'vesselCountAfter': 1,
    'evidence': [lifecycle_dir + 'lifecycle-simulator.log', time_dir + 'lifecycle-simulator.log'],
    'qualification': 'Simulator log proves count reduction. Service retains a historical lastByEntity snapshot for removed vessel; that is not a live-vessel inventory.'}
gates['same_name_vessel_recreation'] = {
    'verdict': 'BLOCKED',
    'routesAttempted': ['Existing Lua API inspected: deletion/status/jump present, no vessel creation binding',
                        'Installed ScnEditor loaded; scripted Ctrl+F4 command in no-graphics mode produced no usable window',
                        'ScnEditor loaded in D3D9 mode; scripted shortcut and ordinary Windows Ctrl+F4 input exposed no editor controls'],
    'command': ['python.exe', 'tests/windows_native_controls.py', '25476', 'reports/windows-acceptance/20261118T144230Z/continuation-154728Z'],
    'controlHarnessExitCode': 0, 'createClicked': False, 'simulatorCleanupExitCode': 1,
    'blocker': 'Simulator graphics session stopped advancing at custom-dialog request; no creatable Scenario Editor controls through available ordinary-input route. Same-session replacement identity not observed. Rebuild or injected native execution not attempted.',
    'evidence': [lifecycle_dir + 'same-name-recreation-route.json', lifecycle_dir + 'ordinary-native-control-route.json', lifecycle_dir + 'lifecycle-simulator.log', lifecycle_dir + 'lifecycle-shutdown.json']}
gates['nonreading_observer_backpressure'] = {
    'verdict': 'PASS', **load(lifecycle_dir + 'nonreading-observer.json'),
    'instrumentation': 'Test-local wrapper observes existing Socket.write return/length, does not change service backpressure handling',
    'maxObservedWritableBytes': max(json.loads(line)['writableLength'] for line in (REPORT / lifecycle_dir / 'socket-backpressure.jsonl').read_text().splitlines()),
    'evidence': [lifecycle_dir + 'socket-backpressure.jsonl', lifecycle_dir + 'nonreading-observer.json'],
    'qualification': 'Writable-length log includes normal HTTP replies as well as peers. One deliberately nonreading upgraded observer was disconnected; no unbounded service buffer was observed.'}
gates['blocked_receiver_clean_shutdown'] = {
    'verdict': 'PASS', **blocked, 'command': command,
    'environmentOverrides': {'OSG_ACCEPTANCE_NO_GRAPHICS': '1', 'OSG_ACCEPTANCE_BLOCKED_ONLY': '1'},
    'nativeShutdownDrainDeadlineSeconds': 2,
    'qualification': '2.106 s is host-observed exit after Lua marker at 19.9 sim seconds, including last physics steps/polling/process teardown, not an exact join duration. No graphics acceptance inferred.',
    'evidence': [blocked_dir + 'blocked-receiver-result.json', blocked_dir + 'blocked-receiver-progress.json', blocked_dir + 'blocked-simulator.log', blocked_dir + 'sim-blocked-only-process.json']}
gates['additional_timejump_vessel_lifecycle_nonreading_shutdown'] = {
    'verdict': 'BLOCKED', 'reason': 'All listed subgates executed where possible; same-name vessel recreation alone remains blocked. See separate verdicts.',
    'subgates': ['time_jump', 'vessel_reposition_epoch_reset', 'multiple_vessels', 'vessel_destruction', 'same_name_vessel_recreation', 'nonreading_observer_backpressure', 'blocked_receiver_clean_shutdown']}
gates['browser_regression'] = {
    'verdict': 'PASS', 'command': ['npm.cmd', 'run', 'test:e2e'], 'exitCode': 0,
    'fix': 'Test-only locator assertions replace string wait_for_function; application CSP unchanged',
    'evidence': ['browser-regression-csp-fixed.log', 'browser-regression-csp-fixed-exit.json', 'browser-csp-harness.diff'],
    'historicalFailure': previous['gates']['browser_regression'],
    'scope': 'Recorded and synthetic native-shaped HTTP/WebSocket regression. Actual SDK-fed regression is separately recorded under R10_live_observers.'}
gates['R10_live_observers']['continuation'] = {
    'verdict': 'PASS', 'samplesAccepted': status['samplesAccepted'], 'nativeAuthenticatedAtCapture': status['nativeAuthenticated'],
    'serviceErrors': status['errors'], 'pageErrors': live['pageErrors'], 'independentYaw': live['independentYaw'],
    'steps': [{'observer': 'ABC'[i], 'before': a['step'], 'after': b['step']} for i, (a, b) in enumerate(zip(live['before'], live['after']))],
    'resets': 'Both real native reset epochs observed by all three browsers with empty event lists',
    'evidence': [lifecycle_dir + 'lifecycle-browser.json', 'continuation-native-reset-summary.json']}
gpu = load(gpu_dir + 'gpu-hardware-only.json')
gates['physical_gpu_availability'] = {
    'verdict': 'PASS', 'renderer': gpu['webgl']['renderer'],
    'headedRenderer': load(gpu_dir + 'gpu-headed-d3d11.json')['webgl']['renderer'],
    'scope': 'Actual WebGL2 D3D11 AMD/Intel context; CDP feature/device diagnostics and screenshots, not full Gaussian acceptance',
    'evidence': [gpu_dir + 'gpu-hardware-only.json', gpu_dir + 'gpu-hardware-only.png', gpu_dir + 'gpu-headed-d3d11.json']}
gates['R09_gpu'] = {
    'verdict': 'FAIL', 'reason': 'Actual hardware WebGL2/PlayCanvas initializes and draws a primitive, but its blob sorting worker is rejected by unchanged application CSP. Runbook treats console exceptions/errors as failed test. Gaussian center updates, sorting/culling, contact visibility and interpolation not established.',
    'renderer': gpu['webgl']['renderer'], 'button': gpu['button'],
    'consoleErrors': [item for item in gpu['console'] if item['type'] == 'error'],
    'historicalResult': previous['gates']['R09_gpu'],
    'timeoutInvestigation': 'Fresh engine load succeeded. Old screenshot blocked waiting for fonts. CDP capture bypasses font wait without changing CSP or application. Prior missing local engine 404 falls through to configured CDN; successful CDN responses recorded.',
    'evidence': [gpu_dir + 'gpu-default.json', gpu_dir + 'gpu-headed-d3d11.json', gpu_dir + 'gpu-hardware-only.json', gpu_dir + 'gpu-hardware-only.png']}
gates['portable_node'] = {'verdict': 'PASS', 'tests': 66, 'failed': 0, 'skipped': 0,
                          'commandEvidence': 'continuation-node-tests-exit.json', 'exitCode': 0, 'evidence': 'continuation-node-tests.log'}
gates['journal_integrity']['continuation'] = {'verdict': 'PASS', 'events': 147, 'exitCode': 0,
                                            'evidence': lifecycle_dir + 'native-journal.log', 'lockReleased': not (REPORT / lifecycle_dir / 'native-data/events.journal.lock').exists()}
gates['shutdown_restoration']['continuation'] = {
    'verdict': 'PASS', 'scope': 'Final cleanup/restoration only; NOT a blanket clean-shutdown acceptance verdict for all attempts',
    'allOwnedProcessesGone': True, 'runtimeFilesByteIdentical': True, 'portsFree': True,
    'blockedReceiverNaturalExit': 0, 'graphicalLifecycleForcedExit': 1,
    'evidence': 'continuation-cleanup-proof.json',
    'qualification': 'Historical forced terminations retained in per-attempt execution-result and lifecycle-shutdown evidence.'}
gates['R07_real_osg']['onlineLivePublication'] = {
    'verdict': 'BLOCKED', 'reason': 'Not configured in these captures: service created with default osgSourceDir=null and OSG_SOURCE_DIR cleared. OSG CLI installed and repository retrieval succeeded; adapter replay/reopen PASS is distinct from online publication.'}
result['overall'] = 'PARTIAL'
result['checkedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
result['previousEvidence'] = 'gate-results-before-continuation.json'
result['continuationAttempts'] = attempts
result['continuationCommands'] = {
    'integration': {'command': ['node', '--test', 'tests/integration.test.mjs'], 'exitCode': 0, 'passed': 2, 'evidence': 'continuation-integration.log'},
    'nodeTests': load('continuation-node-tests-exit.json'),
    'browserRegression': load('browser-regression-csp-fixed-exit.json'),
    'blockedReceiver': {'command': command, 'environment': {'OSG_ACCEPTANCE_NO_GRAPHICS': '1', 'OSG_ACCEPTANCE_BLOCKED_ONLY': '1'}, 'simulatorExit': 0},
    'timedNative': {'command': command, 'environment': {'OSG_ACCEPTANCE_NO_GRAPHICS': '1', 'OSG_ACCEPTANCE_LIFECYCLE_ONLY': '1', 'OSG_ACCEPTANCE_SKIP_GPU': '1'}, 'simulatorExit': 0},
    'graphicsNative': {'command': command, 'environment': {'OSG_ACCEPTANCE_LIFECYCLE_ONLY': '1', 'OSG_ACCEPTANCE_SKIP_GPU': '1'}, 'simulatorForcedCleanupExit': 1},
    'nativeJournal': load(lifecycle_dir + 'native-journal-exit.json')}
result['observedFailuresAndFixes'] += [
    'Continuation multiline Node eval was truncated by local Volta launcher; reduced to one-line child command, retained failed startup.',
    'Graphics startup exceeded 45/120 s allowances; no-graphics native route established independently executable gates, later graphics retry reached telemetry.',
    'Module inspection subprocess exceeded 120 s; removed redundant enumeration from critical path, existing module proof retained.',
    'Harness pause deadlocked Lua coroutine signal consumption; timed unpaused scenario replaced it. No application/native fix.',
    'Browser regression CSP predicate corrected; npm test:e2e exit 0. Application CSP unchanged.',
    'Physical AMD/Intel GPU available with D3D11; R09 still FAIL due observed blob-worker CSP error, not hardware absence.',
    'Graphical custom dialog request stopped advancing; ordinary input could not expose Scenario Editor controls; forced cleanup retained, recreation BLOCKED.'
]
context = load('continuation-osg-refined.json')
result['memory'] = {
    'retrieval': 'PASS', 'initialContextExit': 0, 'initialEmpty': True, 'refinedContextExit': 0, 'historyExit': 0,
    'warnings': context['warnings'], 'workspaceId': context['workspaceId'], 'graphCommitId': context['graphCommitId'],
    'resolvedEntityIds': [item['elementId'] for item in context['data']['items']],
    'citationsStale': [item['citation']['stale'] for item in context['data']['items']],
    'evidence': ['continuation-osg-context.json', 'continuation-osg-refined.json', 'continuation-native-history.json'],
    'writes': 'none; parent owns final status/memory persistence'}
result['limits'] = [
    'Same-name destroy/recreate not established; actual failed Scenario Editor routes preserved.',
    'R09 Gaussian rendering FAIL: blob sorting worker rejected by unchanged CSP despite physical D3D11 contexts.',
    'Latest graphical lifecycle session required forced termination; independent blocked-receiver natural shutdown passed.',
    'DLL/source build provenance and full clean Windows source build not established; no native rebuild/reinstallation attempted.',
    'Genuine OSG replay/reopen previously passed; online live graph publication intentionally not configured.',
    'Portable and numerical-reference tests do not establish GPU/CPU 4D parity or complete R01/R02/R03/R08/R11/R12 acceptance.'
]
result['configurationRestoration']['continuation'] = {'evidence': 'continuation-cleanup-proof.json', 'checks': len(restoration_checks),
                                                      'allMatched': True, 'taskOwnedPidsStillPresent': [], 'ports4377And4378': []}
result['acceptanceUtilities'] += ['tests/windows_acceptance_continuation.py', 'tests/windows_native_controls.py', 'tests/windows_reconcile_evidence.py']
result['finalGit'] = {
    'branch': subprocess.check_output(['git', 'branch', '--show-current'], cwd=ROOT, text=True).strip(),
    'revision': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip(),
    'status': subprocess.check_output(['git', 'status', '--porcelain=v1', '-uall'], cwd=ROOT, text=True).splitlines(),
    'unrelated': '.gitignore concurrent modification preserved; existing tests/windows_acceptance.py and tests/windows_live_browser.py preserved',
    'taskTrackedChange': 'scripts/test_browser_live.py: only CSP-safe test assertions',
    'taskNewUtilities': ['tests/windows_acceptance_continuation.py', 'tests/windows_native_controls.py', 'tests/windows_reconcile_evidence.py'],
    'evidenceIgnored': True, 'nativeApplicationChanges': False, 'documentationChanges': False, 'memoryWrites': False,
    'commits': False, 'pushes': False}
result['sourceChanges'] = 'Only existing browser test harness predicate correction plus new tests/ validation utilities. No app/native/DLL/ignore/Markdown edits. Earlier acceptance utilities and unrelated .gitignore preserved.'
save('gate-results.json', result)
save('documentation-specialist-evidence.json', {'source': 'gate-results.json',
    'scope': 'Structured evidence only; no Markdown edits authorized', 'verdicts': {key: value['verdict'] for key, value in gates.items()},
    'remaining': result['limits'], 'memory': result['memory'], 'cleanup': 'continuation-cleanup-proof.json'})
print(json.dumps({'overall': result['overall'], 'verdicts': {key: value['verdict'] for key, value in gates.items()},
                  'restorationChecks': len(restoration_checks), 'allMatched': True, 'ownedPidsPresent': owned_present,
                  'warnings': context['warnings']}, indent=2))
