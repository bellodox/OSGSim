#!/usr/bin/env python3
"""Real local HTTP/WebSocket browser regression. TCP inputs are synthetic, not SDK proof."""
import json, os, re, shutil, socket, subprocess, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]

def launch(directory,replay=False):
    env=dict(os.environ,OSG_HTTP_PORT='0',OSG_BRIDGE_PORT='0',OSG_DATA_DIR=directory)
    env.pop('OSG_BRIDGE_TOKEN',None);env.pop('OSG_SOURCE_DIR',None)
    args=['node','apps/world-service/server.mjs']
    if replay: args+=['--replay','fixtures/recordings/Atlantis']
    proc=subprocess.Popen(args,cwd=ROOT,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    line=proc.stdout.readline();other=proc.stdout.readline()
    if not line or not other:
        raise RuntimeError('Service startup failed: '+proc.stderr.read())
    port=int(re.search(r'127\.0\.0\.1:(\d+)',line).group(1))
    bridge=int(re.search(r'127\.0\.0\.1:(\d+)',other).group(1))
    return proc,port,bridge

def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=5)
        except subprocess.TimeoutExpired:proc.kill();proc.wait()

def sample(seq,entity='vessel-A',epoch=0,contact=False,x=1000,run='browser-native-shaped'):
    return dict(version=1,type='PHYSICS_SAMPLE',source='native',runId=run,epoch=epoch,
                step=seq,sequence=seq,simTime=seq,simDt=1,frameId='metaverse-global-ecliptic',
                entityId=entity,position=[x,0,0],velocity=[0,0,0],orientation=[0,0,0,1],contact=contact)

def send(client,*frames):
    client.sendall(('\n'.join(json.dumps(f) for f in frames)+'\n').encode())

def main():
    chromium=os.environ.get('CHROMIUM_PATH') or shutil.which('chromium') or shutil.which('chromium-browser')
    options=dict(headless=True,args=['--no-sandbox','--disable-gpu'])
    if chromium:options['executable_path']=chromium
    with tempfile.TemporaryDirectory(prefix='osg-browser-review-') as directory, sync_playwright() as p:
        browser=p.chromium.launch(**options);errors=[];proc=None;client=None
        try:
            proc,port,_=launch(str(Path(directory)/'replay'),True)
            pages=[]
            for ident in ['A','B','C']:
                page=browser.new_page(viewport={'width':1450,'height':1024})
                page.on('pageerror',lambda e:errors.append(str(e)))
                page.goto(f'http://127.0.0.1:{port}/?observer={ident}')
                page.wait_for_function("document.querySelector('#authority').textContent.includes('RECORDER')")
                pages.append(page)
            a,b,c=pages
            a.locator('#camera-yaw').fill('101')
            assert b.locator('#camera-yaw').input_value()=='-58'
            a.locator('#timeline').fill('440')
            a.wait_for_function("document.querySelector('#scene-message').textContent.includes('SOURCE GAP')")
            assert 'SOURCE GAP' not in b.locator('#scene-message').inner_text()
            a.locator('#timeline').fill('970')
            a.wait_for_function("document.querySelector('#contact').textContent.includes('RECORDER LANDED')")
            for page in pages:page.close()
            stop(proc);proc=None
            proc,port,bridge=launch(str(Path(directory)/'native'))
            page=browser.new_page()
            page.on('pageerror',lambda e:errors.append(str(e)))
            page.goto(f'http://127.0.0.1:{port}/?observer=A')
            page.wait_for_function("document.querySelector('#authority').textContent.includes('SDK')")
            client=socket.create_connection(('127.0.0.1',bridge))
            send(client,sample(1),sample(2,contact=True))
            page.wait_for_function("document.querySelector('#contact').textContent.includes('CONTACT EVENT')")
            send(client,sample(3,entity='vessel-B',x=9000))
            page.wait_for_timeout(100)
            assert 'vessel-A' in page.locator('#source-label').inner_text()
            assert page.locator('#event-count').inner_text()=='01 EVENTS'
            send(client,sample(1,epoch=1,x=8000))
            page.wait_for_function("document.querySelector('#event-count').textContent==='00 EVENTS'")
            page.wait_for_function("document.querySelector('#contact').textContent==='NO CONFIRMED EVENT'")
            assert float(page.locator('#altitude').inner_text())==0
            client.close();client=None
            page.wait_for_function("document.querySelector('#scene-message').textContent.includes('STALE')",timeout=6000)
            page.close()
            assert not errors,errors
            print('PASS: actual Chromium HTTP/WebSocket; 3 independent recorder observers; native-shaped vessel isolation, contact, epoch reset and disconnected-state indication; no page errors')
        finally:
            if client:client.close()
            if proc:stop(proc)
            browser.close()

if __name__=='__main__':main()
