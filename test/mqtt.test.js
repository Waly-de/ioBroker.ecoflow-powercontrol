'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const net = require('node:net');
const aedes = require('aedes');
const protobuf = require('protobufjs');
const EcoflowMqtt = require('../lib/ecoflow-mqtt');
const Regulation = require('../lib/regulation');
const { StateManager } = require('../lib/state-manager');
const { PROTO_SOURCE_V2 } = require('../lib/protobuf-definitions');
const { fixture } = require('./helpers');
async function until(fn, timeout = 3000) {
    const deadline = Date.now() + timeout;
    while (!fn()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for local MQTT state');
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

test('identical MQTT telemetry refreshes ts and remains readable', async () => {
    const a = fixture(), m = new EcoflowMqtt(a);
    const id = 'ecoflow.synthetic.value'; a.own.set(id, { val: 500, ts: Date.now() - 51 * 60000 });
    await m._generateAndSyncSub('', { value: 500 }, 'ecoflow.synthetic');
    assert.equal((await new StateManager(a).getValAkt(`${a.namespace}.${id}`, 50)).val, 500);
    assert.ok(a.own.get(id).ts > Date.now() - 1000);
});

test('JSON duplicate suppression is bounded and does not suppress constant telemetry forever', () => {
    const m = new EcoflowMqtt(fixture());
    assert.equal(m._checkAndStore({ watts: 500 }, 2000, 'topic'), true);
    assert.equal(m._checkAndStore({ watts: 500 }, 2000, 'topic'), false);
    m.previousContents['watts:topic'].timeStamp -= 2100;
    assert.equal(m._checkAndStore({ watts: 500 }, 2000, 'topic'), true);
});

test('secure MQTT candidates retain certificate verification and use secure URLs', () => {
    const m = new EcoflowMqtt(fixture()); m.mqttDaten = { protocol: 'mqtts', URL: 'synthetic.invalid', Port: 8883 };
    for (const candidate of m._getMqttCandidates()) {
        assert.ok(candidate.brokerUrl.startsWith('mqtts://'));
        assert.notEqual(candidate.options.rejectUnauthorized, false);
    }
});

test('failed MQTT publish does not acknowledge an output command', async () => {
    const a = fixture(), m = new EcoflowMqtt(a); m.isConnected = true;
    m.protoRoot = protobuf.parse(PROTO_SOURCE_V2).root;
    m.client = { publish: (_topic, _data, _opts, cb) => cb(new Error('synthetic transport failure')) };
    await assert.rejects(m.setACForDevice('TEST', 1000), /synthetic transport failure/);
    assert.ok(!a.writes.some(w => w.id.endsWith('.setAC')));
});

test('stopping a connection test does not reset an active bridge connection state', async () => {
    const a = fixture(); a.own.set('info.connection', { val: true });
    await new EcoflowMqtt(a, { testMode: true }).stop();
    assert.equal(a.own.get('info.connection').val, true);
});

test('real local broker: subscribe, decode protobuf, command, disconnect and reconnect', async t => {
    const broker = aedes(); const server = net.createServer(broker.handle);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const a = fixture(); a.config.ecoflow.devices = [{ serial: 'TEST', typ: 'PS', subscribe: true }];
    const m = new EcoflowMqtt(a); m.protoRoot = protobuf.parse(PROTO_SOURCE_V2).root;
    m.mqttDaten = { UserID: 'SYNTHETIC', User: '', Passwort: '', URL: '127.0.0.1', Port: server.address().port,
        protocol: 'mqtt', clientID: 'SYNTHETIC-BRIDGE' };
    t.after(async () => {
        await m.stop(); await new Promise(resolve => broker.close(resolve)); await new Promise(resolve => server.close(resolve));
    });
    await m._connect(); await until(() => a.logs.some(e => e.text.includes('startup sequence completed')));
    assert.equal(a.own.get('info.connection').val, true);
    const Message = m.protoRoot.lookupType('Message'), Heartbeat = m.protoRoot.lookupType('InverterHeartbeat');
    const telemetry = Message.encode({ header: [{ cmdFunc: 20, cmdId: 1, deviceSn: 'TEST',
        pdata: Heartbeat.encode({ invOutputWatts: 1230, batSoc: 75, pv1InputWatts: 1000, pv2InputWatts: 2000 }).finish() }] }).finish();
    await new Promise((resolve, reject) => broker.publish({ topic: '/app/device/property/TEST', payload: telemetry, qos: 1 }, err => err ? reject(err) : resolve()));
    const id = 'ecoflow.app_device_property_TEST.data.InverterHeartbeat.invOutputWatts';
    await until(() => a.own.get(id)?.val === 1230);
    assert.equal(a.own.get('ecoflow.app_device_property_TEST.data.InverterHeartbeat.batSoc').val, 75);
    const received = [];
    broker.on('publish', packet => { if (packet.topic === '/app/SYNTHETIC/TEST/thing/property/set') received.push(packet); });
    await m.setACForDevice('TEST', 1000);
    await until(() => received.some(packet => {
        const decoded = Message.decode(packet.payload).header[0];
        return decoded.cmdId === 129 && m.protoRoot.lookupType('setValue').decode(decoded.pdata).value === 1000;
    }));
    // The real transport must not receive an automatic target from old telemetry.
    Object.assign(a.config.inverters[0], { type: 'ecoflow', hasBat: false,
        outputStateId: '', batterySOCStateId: '', pvPowerStateId: '' });
    a.config.regulation.minValueMin = 0;
    const regulation = new Regulation(a, m);
    const outputId = `${a.namespace}.${id}`;
    a.foreign.get(outputId).ts -= 51000;
    const countTargets = () => received.filter(packet => Message.decode(packet.payload).header[0].cmdId === 129).length;
    const previousTargets = countTargets();
    await regulation.run();
    assert.equal(countTargets(), previousTargets);
    await new Promise((resolve, reject) => broker.publish({ topic: '/app/device/property/TEST', payload: telemetry, qos: 1 }, err => err ? reject(err) : resolve()));
    await until(() => a.foreign.get(outputId).ts > Date.now() - 1000);
    await regulation.run();
    await until(() => received.some(packet => {
        const decoded = Message.decode(packet.payload).header[0];
        return decoded.cmdId === 129 && m.protoRoot.lookupType('setValue').decode(decoded.pdata).value === 8000;
    }));
    await regulation.stop();
    const previousClient = m.client;
    await new Promise(resolve => previousClient.end(true, {}, resolve)); await until(() => !m.isConnected);
    await m._connect(); await until(() => m.isConnected && m.client !== previousClient);
});

test('real TLS handshake rejects a self-signed broker certificate', async t => {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const tls = require('node:tls');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecoflow-tls-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=localhost', '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem')], { stdio: 'ignore' });
    const server = tls.createServer({ key: fs.readFileSync(path.join(dir, 'key.pem')), cert: fs.readFileSync(path.join(dir, 'cert.pem')) }, socket => socket.destroy());
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const m = new EcoflowMqtt(fixture());
    m.mqttDaten = { protocol: 'mqtts', URL: '127.0.0.1', Port: server.address().port, clientID: 'SYNTHETIC-TLS' };
    await assert.rejects(m._probeMqttCandidate(m._getMqttCandidates()[0], 2000), /self.signed/i);
});

test('device subscription waits for SUBACK and reports denied subscriptions', async () => {
    const a = fixture(); a.config.ecoflow.devices = [{ serial: 'TEST', typ: 'PS', subscribe: true }];
    const m = new EcoflowMqtt(a); let reply;
    m.client = { subscribe: (_topics, callback) => { reply = callback; } };
    let finished = false;
    const pending = m._subscribeDevices().then(() => { finished = true; });
    assert.equal(finished, false); reply(null, [{ qos: 0 }]); await pending;
    assert.equal(finished, true);
    m.client.subscribe = (_topics, callback) => callback(null, [{ qos: 128 }]);
    await assert.rejects(m._subscribeDevices(), /rejected/);
});
