#!/usr/bin/env python3
"""Offline Chromium DOM test. Transport is replaced with actual server response snapshots."""
from pathlib import Path
import re, json, os, socket, subprocess, tempfile, time
from urllib.request import urlopen
from playwright.sync_api import sync_playwright
root=Path(__file__).resolve().parents[1]
html=(root/'apps/observer/index.html').read_text()
html=re.sub(r'<link[^>]+style\.css[^>]*>','',html)
html=re.sub(r'<script type="module"[^>]+app\.mjs[^>]*></script>','',html)
app=(root/'apps/observer/app.mjs').read_text().replace("import { createPlayCanvasScene } from './playcanvas-bridge.mjs';", "const createPlayCanvasScene = async () => { throw Error('not configured for browser mock transport test') };",1)
app=app.replace("import { applyNativeFrame } from './native-state.mjs';", (root/'apps/observer/native-state.mjs').read_text().replace('export function','function'))
css=(root/'apps/observer/style.css').read_text()
def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1',0));return s.getsockname()[1]
port, bridge_port = free_port(), free_port()
server_home = tempfile.TemporaryDirectory(prefix='osg-ui-')
env = dict(os.environ, OSG_HTTP_PORT=str(port), OSG_BRIDGE_PORT=str(bridge_port), OSG_DATA_DIR=server_home.name)
server = subprocess.Popen(['node','apps/world-service/server.mjs','--replay','fixtures/recordings/Atlantis'],
                          cwd=str(root),env=env,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
for _ in range(80):
    if server.poll() is not None: raise RuntimeError('Replay service terminated during browser test')
    try:
        with urlopen(f'http://127.0.0.1:{port}/api/status',timeout=1) as r: status=json.load(r)
        break
    except Exception: time.sleep(.05)
else: raise RuntimeError('Replay service startup timeout')
with urlopen(f'http://127.0.0.1:{port}/api/recording') as r: recording=json.load(r)
with sync_playwright() as p:
    browser=p.chromium.launch(headless=True,executable_path='/usr/bin/chromium',args=['--no-sandbox','--disable-gpu'])
    errors=[];pages=[]
    for ident in ['A','B','C']:
        c=browser.new_context(viewport={'width':1450,'height':1050},device_scale_factor=1)
        page=c.new_page()
        page.on('pageerror',lambda e: errors.append(str(e)))
        page.goto('about:blank')
        page.set_content(html,wait_until='domcontentloaded')
        page.add_style_tag(content=css)
        page.evaluate("""({status,recording,identity})=>{
          const originalFetch=window.fetch;
          window.fetch=async (url)=>({ok:true,json:async()=>String(url).includes('/api/recording')?recording:status});
          window.WebSocket=class {addEventListener(){};close(){}};
          history.replaceState({},'', 'about:blank?observer='+identity);
        }""",{'status':status,'recording':recording,'identity':ident})
        page.add_script_tag(content=app)
        page.wait_for_function("document.querySelector('#authority').textContent.includes('RECORDER')")
        pages.append((c,page))
    a,b,c=(p[1] for p in pages)
    a.locator('#camera-yaw').fill('101')
    assert b.locator('#camera-yaw').input_value()=='-58', 'independent azimuth failed'
    a.locator('#timeline').fill('440')
    a.wait_for_timeout(120)
    assert 'SOURCE GAP' in a.locator('#scene-message').inner_text()
    assert 'SOURCE GAP' not in b.locator('#scene-message').inner_text()
    a.locator('#timeline').fill('970')
    a.wait_for_timeout(120)
    assert 'RECORDER LANDED' in a.locator('#contact').inner_text()
    a.screenshot(path=str(root/'reports/observer-A.png'),full_page=True)
    b.screenshot(path=str(root/'reports/observer-B.png'),full_page=True)
    print('PASS offline: three browser documents, independent camera/time, actual recorder-source gap and recorded contact classification')
    assert not errors,errors
    for context,_ in pages:context.close()
    browser.close()
server.terminate()
server.wait(timeout=5)
server_home.cleanup()
