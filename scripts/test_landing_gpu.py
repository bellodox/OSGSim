#!/usr/bin/env python3
"""Real browser/GPU acceptance for the 4D renderer; synthetic source, never SDK proof.
Requires Python Playwright, Pillow and installed Chromium (or CHROMIUM_PATH).
A launch failure or empty image is a failure, never a substituted portable pass.
"""
import hashlib, io, json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright, expect
ROOT=Path(__file__).resolve().parents[1]

def main():
    with tempfile.TemporaryDirectory(prefix='osg-landing-gpu-') as directory:
        env=dict(os.environ, OSG_HTTP_PORT='0', OSG_BRIDGE_PORT='0', OSG_DATA_DIR=directory)
        proc=subprocess.Popen(['node','apps/world-service/server.mjs','--landing-demo'],cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        try:
            first=proc.stdout.readline();second=proc.stdout.readline()
            if not first or not second:raise RuntimeError(proc.stderr.read())
            port=int(re.search(r':(\d+)',first).group(1));url=f'http://127.0.0.1:{port}'
            with sync_playwright() as p:
                options=dict(headless=True,args=['--no-sandbox','--disable-dev-shm-usage'])
                chromium=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
                if chromium:options['executable_path']=chromium
                if os.environ.get('OSG_GPU_SOFTWARE')=='1':options['args']+=['--use-angle=swiftshader','--enable-unsafe-swiftshader']
                browser=p.chromium.launch(**options)
                errors=[];context=browser.new_context(viewport={'width':1500,'height':1080})
                # All required engine and scene assets are local.
                context.route('https://**',lambda route:route.abort())
                page=context.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
                page.on('console',lambda m:errors.append(m.text) if m.type=='error' and 'favicon' not in m.text else None)
                page.goto(url+'/?observer=A');expect(page.locator('#authority')).to_have_text('SYNTHETIC DEMO')
                expect(page.locator('#enable-playcanvas')).to_have_text('4D SCENE ENABLED',timeout=30000)
                page.locator('#timeline').fill('783.3')
                expect(page.locator('#scene-3d')).to_have_attribute('data-vessels','1',timeout=30000)
                page.wait_for_timeout(1000)
                details=page.locator('#scene-details').inner_text();assert 'ERROR' not in details and 'unavailable' not in details.lower(),details
                assert int(page.locator('#scene-3d').get_attribute('data-splats'))>10000
                assert int(page.locator('#scene-3d').get_attribute('data-sliced'))>0
                pixels=page.locator('#scene-3d').screenshot();im=Image.open(io.BytesIO(pixels)).convert('RGB')
                assert sum(1 for r,g,b in im.getdata() if max(r,g,b)>25)>1000,'Empty or nearly empty renderer image'
                first_time=page.locator('#scene-3d').get_attribute('data-render-time')
                page.wait_for_timeout(300);assert page.locator('#scene-3d').get_attribute('data-render-time')==first_time,'Paused clock advanced'
                before=hashlib.sha256(pixels).hexdigest();page.locator('#camera-yaw').fill('-100');page.wait_for_timeout(400)
                assert hashlib.sha256(page.locator('#scene-3d').screenshot()).hexdigest()!=before,'Camera did not change rendering'
                other=context.new_page();other.goto(url+'/?observer=B');expect(other.locator('#enable-playcanvas')).to_have_text('4D SCENE ENABLED',timeout=30000)
                assert other.locator('#camera-yaw').input_value()=='-58';assert other.locator('#timeline').input_value()=='0'
                assert not errors,errors
                result={'source':'synthetic renderer fixture','browser':browser.version,'softwareRequested':os.environ.get('OSG_GPU_SOFTWARE')=='1','splats':int(page.locator('#scene-3d').get_attribute('data-splats')),'checks':['real WebGL drawing','offline assets','4D motion slicing','pause','camera change','independent observer','no page/console errors']}
                output=ROOT/'docs'/'landing';output.mkdir(exist_ok=True)
                page.screenshot(path=str(output/'landing-browser.png'),full_page=True);(output/'gpu-result.json').write_text(json.dumps(result,indent=2)+'\n')
                print(json.dumps(result));browser.close()
        finally:
            proc.terminate()
            try:proc.wait(timeout=5)
            except subprocess.TimeoutExpired:proc.kill();proc.wait()
if __name__=='__main__':main()
