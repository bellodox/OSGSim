#!/usr/bin/env python3
"""Live local browser smoke test, no cloud and no synthetic physics claims."""
from pathlib import Path
from playwright.sync_api import sync_playwright

OUT = Path(__file__).resolve().parents[1] / 'reports'
OUT.mkdir(exist_ok=True)
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, executable_path='/usr/bin/chromium', args=['--no-sandbox','--disable-gpu','--use-gl=swiftshader'])
    pages = []
    console_errors = []
    for identity in ['A','B','C']:
        ctx = browser.new_context(viewport={'width': 1450, 'height': 1024},device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda error: console_errors.append(str(error)))
        page.goto('http://127.0.0.1:4377/?observer=' + identity)
        page.locator('#authority').wait_for(state='visible')
        page.wait_for_function("document.querySelector('#authority').textContent.includes('RECORDER')")
        assert identity in page.locator('#observer-label').inner_text()
        pages.append((ctx,page))
    page_A = pages[0][1]
    page_B = pages[1][1]
    assert page_B.locator('#camera-yaw').input_value() == '-58'
    page_A.locator('#camera-yaw').fill('101')
    assert page_B.locator('#camera-yaw').input_value() == '-58', 'observer camera state shared'
    page_A.locator('#timeline').fill('440')
    page_A.wait_for_timeout(120)
    assert 'SOURCE GAP' in page_A.locator('#scene-message').inner_text()
    assert 'SOURCE GAP' not in page_B.locator('#scene-message').inner_text()
    page_A.locator('#timeline').fill('970')
    page_A.wait_for_timeout(120)
    assert 'RECORDER LANDED' in page_A.locator('#contact').inner_text()
    page_A.screenshot(path=str(OUT / 'observer-A.png'), full_page=True)
    page_B.screenshot(path=str(OUT / 'observer-B.png'), full_page=True)
    print('PASS: 3 Chromium sessions, independent camera/timeline, exact source gap, recorded contact provenance')
    print('page_errors:', console_errors)
    assert not console_errors, f'unexpected JavaScript errors: {console_errors}'
    for ctx,page in pages: ctx.close()
    browser.close()
