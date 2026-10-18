'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Regulation = require('../lib/regulation');
const { fixture, inverter, loadMain } = require('./helpers');

const disconnected = () => ({ setACForDevice: async () => { throw new Error('EcoFlow MQTT is not connected'); },
    getDeviceStatePrefix: () => 'unused' });

/** EcoFlow inverter with fresh telemetry plus a second, working generic inverter. */
function twoInverters() {
    const a = fixture(); a.config.regulation.minValueMin = 0;
    a.config.inverters = [{ ...inverter, id: 'EF', type: 'ecoflow', hasBat: false },
        { ...inverter, id: 'GEN', hasBat: false, setOutputStateId: 'target2' }];
    return a;
}

test('charger already switched on at startup is regulated without waiting for a rewrite', async () => {
    const a = fixture(), old = Date.now() - 10 * 60000;
    Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: 'switch',
        switchOnValue: 'true', switchOffValue: 'false', maxPower: 2000, offsetPower: 0, startPower: 100,
        stopPower: 0, startDurationMin: 1, regulateSteps: 100, minRegulatePauseMin: 0, switchMinMin: 5 });
    a.foreign.set('switch', { val: true, ts: old, lc: old });
    a.foreign.set('charger', { val: 2000, ts: old, lc: old });
    const r = new Regulation(a, null); await r._runExcessCharge(500);
    assert.equal(a.foreign.get('charger').val, 500);
    assert.equal(a.writes.some(w => w.id === 'switch'), false);
});

test('charger switched off stays off until the start delay has elapsed', async () => {
    const a = fixture(), old = Date.now() - 10 * 60000;
    Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: 'switch',
        switchOnValue: 'true', switchOffValue: 'false', startPower: 100, startDurationMin: 1, minRegulatePauseMin: 0 });
    a.foreign.set('switch', { val: false, ts: old, lc: old });
    const r = new Regulation(a, null); await r._runExcessCharge(500);
    assert.equal(a.foreign.has('charger'), false); assert.equal(a.foreign.get('switch').val, false);
});

test('a failing inverter command neither aborts the cycle nor the other inverter; warning is logged once', async () => {
    const a = twoInverters(), r = new Regulation(a, disconnected());
    await assert.doesNotReject(r.run());
    assert.equal(a.foreign.get('target2').val, 800);
    await assert.doesNotReject(r.run());
    assert.equal(a.logs.filter(e => e.level === 'warn' && e.text.includes('EcoFlow MQTT is not connected')).length, 1);
});

test('excess charge still stops when an inverter command fails in the same cycle', async () => {
    const a = twoInverters();
    Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: '' });
    a.foreign.set('charger', { val: 1000, ts: Date.now(), lc: Date.now() });
    const r = new Regulation(a, disconnected()); r.excessChargeWasActive = true;
    await r.run(); assert.equal(a.foreign.get('charger').val, 0);
});

test('a failed command is retried and recovery is logged', async () => {
    const a = twoInverters(); let fail = true; const sent = [];
    const r = new Regulation(a, { setACForDevice: async (_sn, raw) => { if (fail) throw new Error('publish timed out'); sent.push(raw); },
        getDeviceStatePrefix: () => 'unused' });
    await r.run(); assert.deepEqual(sent, []);
    fail = false; await r.run(); assert.deepEqual(sent, [8000]);
    assert.ok(a.logs.some(e => e.level === 'info' && e.text.includes('[EF]') && e.text.includes('accepted again')));
});

test('disabling with a disconnected EcoFlow inverter still sets the other off value and stops charging', async () => {
    const a = twoInverters(); a.config.inverters[1].regulationOffPower = 50;
    Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: '' });
    a.foreign.set('charger', { val: 1000, ts: Date.now(), lc: Date.now() });
    const r = new Regulation(a, disconnected());
    await assert.doesNotReject(r.handleDisabled());
    assert.equal(a.foreign.get('target2').val, 50); assert.equal(a.foreign.get('charger').val, 0);
});

test('a regulation error on manual switch-off does not escape the stateChange handler', async () => {
    const a = loadMain();
    a.regulation = { handleDisabled: async () => { throw new Error('synthetic failure'); } };
    await assert.doesNotReject(a._onStateChange('ecoflow-powercontrol.0.regulation.enabled', { val: false, ack: false }));
    assert.ok(a.logs.some(e => e.level === 'error' && e.text.includes('synthetic failure')));
});
