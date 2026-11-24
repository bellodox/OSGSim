# SPDX-License-Identifier: MIT
"""Existing native ROD multipart subscriber. Install requirements.txt first."""
import sys,json,struct
GAME=sys.argv[2] if len(sys.argv)>2 else 'osgdemo'
if not GAME.isalnum():raise ValueError('Invalid game ID')
TOPICS={p+' json '+GAME for p in ['game-pending-move','game-block-attach','game-block-detach']}
def decode(frames):
 if len(frames)!=3:return None
 try:
  topic=frames[0].decode()
  if topic not in TOPICS:return None
  return {'topic':topic,'data':json.loads(frames[1]),'sequence':struct.unpack('<I',frames[2])[0]}
 except (ValueError,UnicodeError,struct.error):return None
if __name__=='__main__':
 if len(sys.argv)==2 and sys.argv[1]=='--selftest':
  event=decode([b'game-pending-move json osgdemo',b'{"name":"alice","move":{"v":1}}',struct.pack('<I',42)])
  assert event['sequence']==42 and event['data']['name']=='alice'
  assert decode([b'wrong',b'{}',b'1234']) is None
  assert decode([b'game-pending-move json osgdemo',b'bad',b'1234']) is None
  print('PASS: native ROD multipart framing fixture (not publisher acceptance)')
 else:
  import zmq
  ctx=zmq.Context();sub=ctx.socket(zmq.SUB);sub.setsockopt(zmq.RCVHWM,1000)
  sub.setsockopt(zmq.MAXMSGSIZE,4*1024*1024)
  endpoints=sys.argv[1].split(',')
  if not 1<=len(endpoints)<=4:raise ValueError('Invalid native ZMQ endpoint count')
  for endpoint in endpoints:
   if not endpoint.startswith(('tcp://127.0.0.1:','tcp://localhost:','tcp://[::1]:')):raise ValueError('Not a loopback endpoint')
   sub.connect(endpoint)
  for topic in TOPICS:sub.setsockopt(zmq.SUBSCRIBE,topic.encode())
  print(json.dumps({'ready':True}),flush=True)
  while True:
   event=decode(sub.recv_multipart())
   if event is not None:print(json.dumps(event,separators=(',',':')),flush=True)
