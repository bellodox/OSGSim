# SPDX-License-Identifier: MIT
# Actual native PUB socket for portable frame-level tests. Not ROD Core.
import zmq,sys,json,struct
port=int(sys.argv[1]); context=zmq.Context(); sock=context.socket(zmq.PUB)
sock.bind('tcp://127.0.0.1:'+str(port)); print('READY',flush=True)
try:
 for line in sys.stdin:
  event=json.loads(line)
  sock.send_multipart([event['topic'].encode(),json.dumps(event['data'],separators=(',',':')).encode(),struct.pack('<I',event['sequence'])]);print('SENT',flush=True)
finally:
 sock.close(linger=0);context.term()
