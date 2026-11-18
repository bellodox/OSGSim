"""Reconcile bounded CSP/live evidence without discarding historical gate results."""
import datetime
import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]
REPORT = ROOT / 'reports/windows-acceptance/20261118T144230Z'
OUT = REPORT / 'csp-live-161239Z'
LIVE = OUT / 'contact-capture'


def load(path):
    return json.loads(path.read_text(encoding='utf-8'))


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')


def main():
    gates = load(REPORT / 'gate-results.json')
    save(OUT / 'gate-results-before-csp-rerun.json', gates)
    capture = load(LIVE / 'capture-final.json')
    execution = load(LIVE / 'execution-result.json')
    scenes = load(LIVE / 'scene-progress.json')
    journal = load(LIVE / 'journal-final.json')
    active = [x for x in capture['updates'] if x['n'] > 0]
    summary = {
        'verdict': 'PARTIAL',
        'policyRepair': 'PASS',
        'actualCanvasHardware': 'PASS',
        'renderer': scenes[-1]['canvas']['renderer'],
        'canvas': scenes[-1]['canvas'],
        'nativeSamples': load(LIVE / 'status-final.json')['samplesAccepted'],
        'nativeAuthenticatedDuringCapture': execution['authenticatedSamplesObserved'],
        'nativeContactTimes': [{'type': x['type'], 'simTime': x['simTime']} for x in capture['contacts']],
        'centerUpdates': {'verdict': 'PASS', 'activeUpdates': len(active), 'counts': sorted({x['n'] for x in active}), 'times': [x['time'] for x in active], 'centersChanged': len({tuple(x['centers']) for x in active}) > 1},
        'textureUpdates': {'verdict': 'PASS', 'unlockCallsRetained': len(capture['textureUnlocks']), 'names': sorted({x['name'] for x in capture['textureUnlocks']})},
        'worker': {'verdict': 'PASS', 'created': len(capture['workers']), 'retainedResultMessages': len(capture['workerMessages']), 'retainedCounts': sorted({x['count'] for x in capture['workerMessages']})},
        'nonzeroSorting': {'verdict': 'UNVERIFIED', 'reason': 'Retained worker messages contain only count 0; rolling buffer can omit earlier results. No nonzero result established.'},
        'cullingAndContactVisibility': {'verdict': 'UNVERIFIED', 'reason': 'Bounds and active center/texture writes observed, but no active latest-update snapshot/contact screenshot or mesh visibility proof. Component instance lookup did not resolve; not proof of absence.'},
        'nativeInterpolation': {'verdict': 'UNVERIFIED', 'reason': 'Original native observer consumes last accepted sample; no native Hermite interpolation demonstrated or introduced.'},
        'pageErrors': execution['pageErrors'],
        'consoleQualification': 'Two expected 404 errors: /api/recording in native mode and optional local /apps/observer/playcanvas.mjs; CDN engine 200. No CSP violation or rendering exception observed. Raw console retained.',
        'nativeDllSHA256': execution['dllSHA256'],
        'moduleEvidence': '../retry/native-modules.log plus contact-capture/simulator.log; latest asynchronous enumeration caught executable only',
        'executionExitQualification': 'Capture wrapper exit 0 establishes successful execution, NOT full R09 acceptance. Expected negative CSP test exits 1.',
        'evidence': ['csp-live-161239Z/affected-node.log', 'csp-live-161239Z/browser-regression.log', 'csp-live-161239Z/contact-capture/capture-final.json', 'csp-live-161239Z/contact-capture/scene-progress.json', 'csp-live-161239Z/contact-capture/final.png', 'csp-live-161239Z/contact-capture/browser-console.json', 'csp-live-161239Z/contact-capture/native-journal.log', 'csp-live-161239Z/contact-capture/execution-result.json'],
        'historicalResult': gates['gates']['R09_gpu']
    }
    save(OUT / 'r09-rerun-summary.json', summary)
    gates['gates']['R09_gpu'] = summary
    gates['overall'] = 'PARTIAL'
    gates['checkedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    gates['gates']['csp_repair_regression'] = {'verdict': 'PASS', 'affectedNodeTests': 16, 'failed': 0, 'skipped': 0, 'exactPolicyPublicResources': 3, 'negativeMutationExit': load(LIVE / 'csp-before-fix.exit.json')['exitCode'], 'restoredPolicyExit': load(LIVE / 'csp-restored.exit.json')['exitCode'], 'sourceByteRestored': load(LIVE / 'source-restoration.json')['byteIdentical'], 'browserRegressionExit': 0, 'evidence': 'csp-live-161239Z'}
    gates['gates']['shutdown_restoration']['cspRerun'] = {'verdict': 'PASS', 'simulatorNaturalExit': True, 'simulatorExitCode': execution['simulatorExit'], 'serviceExitCode': next(x['exitCode'] for x in execution['ownedProcesses'] if x['pid'] == load(LIVE / 'service.process.json')['pid']), 'runtimeFilesByteIdentical': all(x['byteIdentical'] for x in execution['restoration']), 'temporaryFilesRemoved': execution['temporaryFilesRemoved'], 'journalLockFiles': execution['journalLockFiles'], 'portsFreeAndWalletPreservedEvidence': 'csp-live-161239Z/contact-capture/cleanup-safety.log', 'walletQualification': 'PID 23016 preserved; no wallet data hashes collected. No wallet data files accessed.', 'evidence': 'csp-live-161239Z/contact-capture/execution-result.json'}
    gates['sourceChanges'] = 'Bounded app change: apps/world-service/server.mjs static CSP adds worker-src blob: only; tests/observer-csp.test.mjs exact-policy regression. This validation adds tests/windows_csp_live.py and tests/windows_csp_reconcile.py only. Existing browser predicate correction, .gitignore and earlier utilities preserved. No native/dependency/Markdown changes.'
    gates['limits'] = [x for x in gates['limits'] if not x.startswith('R09 Gaussian rendering FAIL:')]
    gates['limits'].append('R09 PARTIAL after CSP repair: actual AMD D3D11 canvas, authenticated SDK telemetry, blob-worker results and changing 40-splat centers/textures observed. Nonzero sorting, actual Gaussian visibility/culling and native interpolation remain unverified; no full Gaussian PASS.')
    status = subprocess.run(['git', 'status', '--porcelain=v1', '-uall'], cwd=ROOT, capture_output=True, text=True, timeout=20)
    branch = subprocess.run(['git', 'branch', '--show-current'], cwd=ROOT, capture_output=True, text=True, timeout=20)
    revision = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=ROOT, capture_output=True, text=True, timeout=20)
    gates['finalGit'] = {'branch': branch.stdout.strip(), 'revision': revision.stdout.strip(), 'status': status.stdout.splitlines(), 'taskAppChange': 'apps/world-service/server.mjs:177 worker-src blob: only', 'taskRegression': 'tests/observer-csp.test.mjs', 'validationUtilitiesAdded': ['tests/windows_csp_live.py', 'tests/windows_csp_reconcile.py'], 'unrelatedPreserved': ['.gitignore', 'scripts/test_browser_live.py', 'existing Windows acceptance utilities'], 'nativeApplicationChanges': False, 'documentationChanges': False, 'memoryWrites': False, 'commits': False, 'pushes': False}
    gates['observedFailuresAndFixes'].append('CSP rerun: 16 affected Node tests and browser regression PASS; negative policy mutation failed as expected and source restored byte-exactly. Initial capture network-idle timeout restored runtime; DOM readiness retry reached native hardware canvas. Synchronous module inspection missed contact rendering window; asynchronous targeted capture observed three active 40-splat center updates and texture writes, but nonzero sort/visibility remains unverified. No further application fix attempted.')
    gates['configurationRestoration']['cspRerun'] = {'evidence': 'csp-live-161239Z/contact-capture/execution-result.json', 'allMatched': all(x['byteIdentical'] for x in execution['restoration'])}
    gates['acceptanceUtilities'] += ['tests/windows_csp_live.py', 'tests/windows_csp_reconcile.py']
    save(REPORT / 'gate-results.json', gates)
    print(json.dumps({'overall': gates['overall'], 'R09': summary['verdict'], 'activeUpdates': len(active), 'nativeEvents': len(journal['events']), 'gitExit': status.returncode, 'runtimeRestored': all(x['byteIdentical'] for x in execution['restoration'])}, indent=2))


if __name__ == '__main__':
    main()
