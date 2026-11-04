"""Conservative fingerprints of Mosquitto persistence, without exposing payloads.

Format 6 layout is defined by upstream Mosquitto v2.1.2 src/persist.h and
persist_write_v5.c. Only the allocation counter and clean-shutdown marker are
ignored. Every message, session, subscription, flag and expiry byte is retained.
Unknown/invalid formats fall back to byte-exact hashing, which may disable safe
rollback but can never hide a change by applying an unknown normalization.
"""
import hashlib
import struct
from .snapshots import digest

MAGIC=b'\x00\xb5\x00mosquitto db'


def fingerprint(file):
    chunks=[]
    try:
        with open(file,'rb') as source:
            header=source.read(23)
            if len(header)!=23 or header[:15]!=MAGIC or header[15:19]!=b'\0'*4 or struct.unpack('!I',header[19:])[0]!=6:
                return 'raw:'+digest(file)
            configuration=0
            while True:
                block=source.read(8)
                if not block: break
                if len(block)!=8 or len(chunks)>1_000_000: return 'raw:'+digest(file)
                kind,length=struct.unpack('!II',block)
                if kind not in range(1,7) or length>16*1024*1024: return 'raw:'+digest(file)
                payload=source.read(length)
                if len(payload)!=length: return 'raw:'+digest(file)
                if kind==1:
                    configuration+=1
                    if length!=16 or payload[9]!=8: return 'raw:'+digest(file)
                    payload=b'\0'*9+payload[9:]
                chunks.append(hashlib.sha256(block+payload).digest())
            if configuration!=1:return 'raw:'+digest(file)
        result=hashlib.sha256(header)
        for chunk in sorted(chunks):result.update(chunk)
        return 'mosquitto-v6:'+result.hexdigest()
    except OSError:
        raise
