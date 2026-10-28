import fs from 'node:fs';
import dns from 'node:dns/promises';
import mqtt from 'mqtt';
const address=await dns.lookup('mqtt-broker');
const client=await mqtt.connectAsync('mqtts://mqtt-broker:8883',{ca:fs.readFileSync('/test/broker/ca.crt'),cert:fs.readFileSync('/test/shared.crt'),key:fs.readFileSync('/test/shared.key'),reconnectPeriod:0,connectTimeout:5000});
await client.publishAsync('devices/'+fs.readFileSync('/test/shared-id','utf8')+'/shared-network','verified',{qos:2});
await client.endAsync();console.log('Shared rootless network: DNS, mTLS and QoS 2 publication verified.');
