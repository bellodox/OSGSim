"""Observe real simulator-fed browser state without creating native input."""
import json, pathlib, sys, time
from playwright.sync_api import sync_playwright

report = pathlib.Path(sys.argv[1])
result = {'pageErrors': [], 'console': [], 'observers': [], 'gpu': {}}
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        pages = []
        for ident in ['A', 'B', 'C']:
            page = browser.new_page(viewport={'width': 1450, 'height': 1024})
            page.on('pageerror', lambda error: result['pageErrors'].append(str(error)))
            page.on('console', lambda message: result['console'].append({'type': message.type, 'text': message.text}))
            page.goto('http://127.0.0.1:4377/?observer=' + ident)
            pages.append(page)
        for page, ident in zip(pages, ['A', 'B', 'C']):
            before = page.locator('body').inner_text()
            page.wait_for_timeout(1500)
            after = page.locator('body').inner_text()
            result['observers'].append({'id': ident, 'before': before, 'after': after, 'changed': before != after})
            page.screenshot(path=str(report / ('observer-' + ident + '.png')))
        yaw_b = pages[1].locator('#camera-yaw').input_value()
        pages[0].locator('#camera-yaw').fill('101')
        result['independentYaw'] = pages[1].locator('#camera-yaw').input_value() == yaw_b
        gpu = pages[0]
        result['gpu']['webgl'] = gpu.evaluate("""() => {const c=document.createElement('canvas'); const g=c.getContext('webgl2'); if(!g)return null;const x=g.getExtension('WEBGL_debug_renderer_info');return {version:g.getParameter(g.VERSION),renderer:x?g.getParameter(x.UNMASKED_RENDERER_WEBGL):g.getParameter(g.RENDERER)}}""")
        buttons = gpu.get_by_role('button').all_text_contents()
        result['gpu']['buttons'] = buttons
        button = gpu.get_by_role('button', name='ENABLE PLAYCANVAS 3D', exact=False)
        if button.count():
            button.click()
            gpu.wait_for_timeout(8000)
            result['gpu']['body'] = gpu.locator('body').inner_text()
            gpu.screenshot(path=str(report / 'playcanvas.png'))
        browser.close()
except Exception as error:
    result['error'] = str(error)
finally:
    (report / 'browser-live.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
print(json.dumps(result, indent=2))
