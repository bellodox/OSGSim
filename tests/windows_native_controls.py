"""Bounded ordinary Windows input to an explicitly task-owned simulator PID."""
import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import sys
import time

pid = int(sys.argv[1])
report = Path(sys.argv[2])
user = ctypes.WinDLL('user32')
user.SendMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
user.SendMessageW.restype = ctypes.c_ssize_t
user.GetParent.restype = wintypes.HWND
callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)


def windows():
    result = []
    def add(hwnd, unused):
        owner = wintypes.DWORD()
        user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value == pid:
            text = ctypes.create_unicode_buffer(512)
            cls = ctypes.create_unicode_buffer(128)
            user.GetWindowTextW(hwnd, text, 512)
            user.GetClassNameW(hwnd, cls, 128)
            result.append({'hwnd': hwnd, 'text': text.value, 'class': cls.value, 'id': user.GetDlgCtrlID(hwnd),
                           'parent': user.GetParent(hwnd), 'visible': bool(user.IsWindowVisible(hwnd))})
        return True
    callback = callback_type(add)
    user.EnumWindows(callback, 0)
    for item in list(result):
        user.EnumChildWindows(item['hwnd'], callback, 0)
    return result


result = {'pid': pid, 'before': windows()}
main = next((x for x in result['before'] if x['class'] == 'SpaceXpanse Render Window'), None)
if main:
    user.SetForegroundWindow(main['hwnd'])
    time.sleep(.2)
    user.keybd_event(0x11, 0, 0, 0)
    user.keybd_event(0x73, 0, 0, 0)
    time.sleep(.1)
    user.keybd_event(0x73, 0, 2, 0)
    user.keybd_event(0x11, 0, 2, 0)
    time.sleep(1)
    result['afterShortcut'] = windows()
    for control in result['afterShortcut']:
        if control['class'] != 'ListBox' or not control['visible']:
            continue
        count = user.SendMessageW(control['hwnd'], 0x018B, 0, 0)
        for index in range(min(count, 50)):
            text = ctypes.create_unicode_buffer(512)
            user.SendMessageW(control['hwnd'], 0x0189, index, ctypes.addressof(text))
            if text.value == 'Scenario Editor':
                user.SendMessageW(control['hwnd'], 0x0186, index, 0)
                user.PostMessageW(control['parent'], 0x0111, (2 << 16) | control['id'], control['hwnd'])
    time.sleep(.5)
    current = windows()
    button = next((x for x in current if x['id'] == 1007 and x['visible']), None)
    if button:
        user.SendMessageW(button['hwnd'], 0x00F5, 0, 0)
        time.sleep(.5)
        current = windows()
        name = next((x for x in current if x['id'] == 1072 and x['visible']), None)
        tree = next((x for x in current if x['id'] == 1112 and x['visible']), None)
        create = next((x for x in current if x['id'] == 1059 and x['visible']), None)
        if name and tree and create:
            text = ctypes.create_unicode_buffer('OSG-Companion')
            user.SendMessageW(name['hwnd'], 0x000C, 0, ctypes.addressof(text))
            for letter in 'ShuttlePB':
                user.SendMessageW(tree['hwnd'], 0x0102, ord(letter), 0)
            user.SendMessageW(create['hwnd'], 0x00F5, 0, 0)
            result['createClicked'] = True
            time.sleep(.5)
result['after'] = windows()
(report / 'ordinary-native-control-route.json').write_text(json.dumps(result, indent=2))
print(json.dumps({'pid': pid, 'visible': [x for x in result['after'] if x['visible']], 'createClicked': result.get('createClicked', False)}, indent=2))
