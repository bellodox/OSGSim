"""Focused GPU and committed-history regression; synthetic samples, real OSG store."""
import hashlib, io, json, os, subprocess, sys, tempfile, time, traceback
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]
OUT=Path(os.environ.get('OSG_FOLLOWUP_OUTPUT',str(ROOT/'tests/evidence-landing-gpu')))
OUT.mkdir(parents=True,exist_ok=True)

def stage(name):
    print(name,flush=True)

def capture_scene(page):
    """Capture only after paused presentation time and canvas geometry settle."""
    scene=page.locator('#scene-3d')
    previous=None
    for unused in range(20):
        current={'box':scene.bounding_box(),'time':scene.get_attribute('data-render-time')}
        if previous==current and current['box']:
            return page.screenshot(clip=current['box'],timeout=120000)
        previous=current
        page.wait_for_timeout(100)
    raise AssertionError('Paused scene geometry/presentation time did not settle')

def main():
    world='--world' in sys.argv
    result={'source':'synthetic input / real OSG Multi' if world else 'synthetic demo / SwiftShader', 'checks':{},'consoleErrors':[],'pageErrors':[],'requestFailures':[],'httpErrors':[]}
    proc=None
    try:
        with tempfile.TemporaryDirectory(prefix='osg-040-regression-') as directory:
            env=dict(os.environ,OSG_DATA_DIR=directory)
            if world and not env.get('OSG_MULTI_SOURCE_DIR'):raise RuntimeError('OSG_MULTI_SOURCE_DIR must identify a separately built osg-multi checkout')
            with (OUT/('world-browser-service.log' if world else 'gpu-service.log')).open('w') as log:
                proc=subprocess.Popen(['node','tests/acceptance_scene_host.mjs']+(['--world'] if world else []),cwd=ROOT,env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=log,text=True)
                stage('await service');ports=json.loads(proc.stdout.readline());stage('service ready');base=f"http://127.0.0.1:{ports['httpPort']}"
                with sync_playwright() as p:
                    options={'headless':True}
                    if os.environ.get('OSG_GPU_SOFTWARE')=='1':options['args']=['--use-angle=swiftshader','--enable-unsafe-swiftshader']
                    if os.environ.get('CHROMIUM_PATH'):options['executable_path']=os.environ['CHROMIUM_PATH']
                    browser=p.chromium.launch(**options)
                    context=browser.new_context(viewport={'width':1280,'height':900})
                    context.route('https://**',lambda route:route.abort())
                    def watch(page):
                        page.on('pageerror',lambda e:result['pageErrors'].append(str(e)))
                        page.on('console',lambda m:result['consoleErrors'].append(m.text) if m.type=='error' else None)
                        page.on('requestfailed',lambda r:result['requestFailures'].append({'url':r.url,'failure':r.failure}))
                        page.on('response',lambda r:result['httpErrors'].append({'url':r.url,'status':r.status}) if r.status>=400 else None)
                    stage('browser ready');page=context.new_page();watch(page);page.goto(base+'/?observer=A',wait_until='domcontentloaded')
                    if not world:
                        expect(page.locator('#authority')).to_have_text('SYNTHETIC DEMO')
                        result['checks']['syntheticAuthorityLabel']=True
                    expect(page.locator('#enable-playcanvas')).to_have_text('4D SCENE ENABLED',timeout=30000)
                    expect(page.locator('#scene-3d')).to_have_attribute('data-vessels','1',timeout=30000)
                    stage('vessel rendered')
                    if world:
                        page.locator('#play-pause').click();page.locator('#timeline').fill('300')
                        page.wait_for_function("() => Number(document.querySelector('#scene-3d').dataset.renderTime)<4",timeout=15000)
                        result['checks']['liveCommittedSeek']=True;stage('seek passed')
                        pinned=page.locator('#scene-3d').get_attribute('data-render-time')
                        stage('publish requested');proc.stdin.write('publish\n');proc.stdin.flush();assert proc.stdout.readline().strip()=='PUBLISHED';stage('published')
                        page.wait_for_timeout(1200)
                        assert page.locator('#scene-3d').get_attribute('data-render-time')==pinned
                        result['checks']['pinSurvivesPublication']=True
                        page.locator('#reset').click()
                        try:
                            page.wait_for_function("() => Number(document.querySelector('#scene-3d').dataset.renderTime)>15",timeout=15000)
                        except Exception:
                            result['resumeDiagnostic']={'body':page.locator('body').inner_text(),'scene':page.locator('#scene-3d').evaluate('(e)=>({...e.dataset})'),'state':page.request.get(base+'/api/world/state').json()}
                            raise
                        result['checks']['resumeLatest']=True
                    else:
                        page.locator('#timeline').fill('783.3')
                        page.wait_for_function("() => Number(document.querySelector('#scene-3d').dataset.sliced)>0")
                        assert int(page.locator('#scene-3d').get_attribute('data-splats'))>10000
                        details=page.locator('#scene-details').inner_text()
                        assert 'ERROR' not in details and 'unavailable' not in details.lower(),details
                        before=float(page.locator('#scene-3d').get_attribute('data-render-time'))
                        page.locator('#play-pause').click();page.wait_for_timeout(500);page.locator('#play-pause').click()
                        assert float(page.locator('#scene-3d').get_attribute('data-render-time'))>before,'Play did not advance'
                        page.locator('#timeline').fill('783.3')
                        page.wait_for_function("() => Math.abs(Number(document.querySelector('#scene-3d').dataset.renderTime)-12.5328)<1e-6")
                        result['checks']['motionPlayAndDeterministicSeek']=True
                    page.wait_for_timeout(500)
                    stage('checking pause');first=page.locator('#scene-3d').get_attribute('data-render-time'); sliced=page.locator('#scene-3d').get_attribute('data-sliced')
                    page.wait_for_timeout(500)
                    assert first==page.locator('#scene-3d').get_attribute('data-render-time'),'Paused clock advanced'
                    assert sliced==page.locator('#scene-3d').get_attribute('data-sliced'),'Paused scene was unnecessarily rebuilt'
                    result['checks']['pausedClockAndUploadsStable']=True
                    stage('capturing pixels');start=time.monotonic();pixels=capture_scene(page);result['screenshotSeconds']=time.monotonic()-start
                    im=Image.open(io.BytesIO(pixels)).convert('RGB')
                    assert sum(1 for r,g,b in im.getdata() if max(r,g,b)>25)>1000,'Empty GPU image'
                    result['checks']['nonemptyGpuPixels']=True
                    for selector,value in [('camera-yaw','-100'),('camera-elevation','50'),('camera-zoom','1.5')]:
                        before=hashlib.sha256(pixels).hexdigest();page.locator('#'+selector).fill(value);page.wait_for_timeout(500)
                        pixels=capture_scene(page);assert hashlib.sha256(pixels).hexdigest()!=before,selector+' did not change GPU image'
                        result['checks'][selector]=True
                    other=context.new_page();watch(other)
                    navigationStarted=time.monotonic()
                    other.goto(base+'/?observer=B',wait_until='commit',timeout=15000)
                    result['lateObserverCommitSeconds']=time.monotonic()-navigationStarted
                    other.wait_for_load_state('domcontentloaded',timeout=120000)
                    result['lateObserverDomSeconds']=time.monotonic()-navigationStarted
                    try:
                        expect(other.locator('#enable-playcanvas')).to_have_text('4D SCENE ENABLED',timeout=120000)
                    except Exception:
                        result['lateObserver']={'body':other.locator('body').inner_text(),'status':other.request.get(base+'/api/status').json()}
                        raise
                    assert other.locator('#camera-yaw').input_value()=='-58'
                    assert other.locator('#camera-elevation').input_value()=='22'
                    assert other.locator('#camera-zoom').input_value()=='1'
                    if not world:
                        assert other.locator('#timeline').input_value()=='0','Observer B timeline followed observer A seek'
                        result['checks']['independentObserverTimeline']=True
                    result['checks']['independentObservers']=True
                    page.wait_for_timeout(1500)
                    result['checks']['cleanConsole']=not result['consoleErrors'] and not result['pageErrors'] and not result['httpErrors'] and not result['requestFailures']
                    (OUT/('world-regression.png' if world else 'gpu-regression.png')).write_bytes(pixels)
                    assert result['checks']['cleanConsole'],json.dumps(result)
                    result['browserVersion']=browser.version
                    result['softwareRequested']=os.environ.get('OSG_GPU_SOFTWARE')=='1'
                    stage('browser checked');browser.close()
                proc.stdin.write('stop\n');proc.stdin.flush();result['serviceExit']=proc.wait(15);result['serviceOutput']=proc.stdout.read();assert result['serviceExit']==0
    except Exception:
        result['error']=traceback.format_exc()
    finally:
        if proc and proc.poll() is None:
            try:proc.stdin.write('stop\n');proc.stdin.flush();proc.wait(15)
            except Exception:proc.terminate();proc.wait(5);result['forcedCleanup']=True
        result['exitCode']=1 if 'error' in result else 0
        (OUT/('world-browser-regression.json' if world else 'gpu-regression.json')).write_text(json.dumps(result,indent=2))
        print(json.dumps(result,indent=2))
    return result['exitCode']
if __name__=='__main__':sys.exit(main())
