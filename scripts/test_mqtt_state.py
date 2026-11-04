import struct
import tempfile
from pathlib import Path
import unittest
from scripts.updater.mqtt_state import fingerprint,MAGIC


class MqttStateTests(unittest.TestCase):
    def write(self,file,counter=1,shutdown=0,payload=b'queued MQTT payload',reverse=False):
        config=struct.pack('<QBB6x',counter,shutdown,8)
        chunks=[struct.pack('!II',1,16)+config,struct.pack('!II',2,len(payload))+payload]
        if reverse:chunks.reverse()
        file.write_bytes(MAGIC+b'\0'*4+struct.pack('!I',6)+b''.join(chunks))
    def test_volatile_allocator_and_shutdown_flags_do_not_hide_message_changes(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'mosquitto.db'
            self.write(file)
            original=fingerprint(file)
            self.write(file,counter=100,shutdown=1,reverse=True)
            self.assertEqual(fingerprint(file),original)
            self.write(file,payload=b'new retained data')
            self.assertNotEqual(fingerprint(file),original)
    def test_unknown_truncated_or_extended_formats_are_compared_byte_exactly(self):
        with tempfile.TemporaryDirectory() as directory:
            file=Path(directory)/'mosquitto.db'
            self.write(file)
            payload=file.read_bytes()
            for malformed in (payload[:-1],payload[:19]+struct.pack('!I',7)+payload[23:],payload+struct.pack('!II',99,0)):
                file.write_bytes(malformed)
                self.assertTrue(fingerprint(file).startswith('raw:'))
