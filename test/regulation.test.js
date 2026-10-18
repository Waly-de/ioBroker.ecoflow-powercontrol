'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Regulation = require('../lib/regulation');
const { fixture, inverter } = require('./helpers');

for (const mode of ['serial', 'balance']) {
    for (const type of ['generic', 'ecoflow']) {
        test(`${mode}: ${type} sends 100 W in the correct wire units`, async () => {
            const a = fixture(); a.config.inverters[0].type = type;
            const sent = [];
            const r = new Regulation(a, { setACForDevice: async (_sn, raw) => sent.push(raw) });
            if (mode === 'serial') await r._distributeSerial(100, 0, false);
            else { r.invState.TEST.batstate = 50; r.batBedarf = 100; await r._distributeBalance(100, 0, 0, 0, 2, 0); }
            assert.equal(type === 'generic' ? a.foreign.get('target').val : sent[0], type === 'generic' ? 100 : 1000);
            assert.equal(a.own.get('inverters.TEST.targetOutput').val, 100);
        });
    }
}

test('output enforces limits and rejects invalid values', async () => {
    const a = fixture(), r = new Regulation(a, null);
    await r._setOutput(inverter, 9000); assert.equal(a.foreign.get('target').val, 800);
    await r._setOutput(inverter, -50); assert.equal(a.foreign.get('target').val, 0);
    await assert.rejects(r._setOutput(inverter, NaN), /Invalid output/);
});

test('history disabled at zero uses current power without sending a request', async () => {
    const a = fixture(); a.config.regulation.minValueMin = 0;
    a.sendTo = () => assert.fail('History must not be queried or enabled');
    const r = new Regulation(a, null);
    await r.ensureHistoryLogging(); await r.run();
    assert.equal(a.own.get('regulation.lowestValue').val, 100);
});

test('zero demand clears previous output; zero offset is respected', async () => {
    const a = fixture(); Object.assign(a.config.regulation, { minValueMin: 0, basePowerOffset: 0 });
    a.own.set('regulation.realPower', { val: 0 });
    a.foreign.set('target', { val: 400 });
    const r = new Regulation(a, null); await r.run();
    assert.equal(a.foreign.get('target').val, 0);
});

test('silent history times out and regulation falls back instead of accumulating cycles', async () => {
    const a = fixture(); let calls = 0;
    a.sendTo = () => { calls++; };
    const r = new Regulation(a, null);
    const first = r.run(); await r.run(); await first;
    assert.equal(calls, 1);
    assert.ok(a.logs.some(e => e.text.includes('History request timed out')));
    assert.ok(a.foreign.get('target'));
});

test('disabling during a delayed history read wins over the running cycle', async () => {
    const a = fixture(), r = new Regulation(a, null); let resolveHistory;
    r._getLowestValue = () => new Promise(resolve => { resolveHistory = resolve; });
    const run = r.run(); while (!resolveHistory) await new Promise(resolve => setImmediate(resolve));
    a.own.set('regulation.enabled', { val: false }); const disable = r.handleDisabled(); resolveHistory(100); await Promise.all([run, disable]);
    assert.deepEqual(a.writes.filter(w => w.id === 'target').map(w => w.val), [0]);
});

test('disabling waits for an in-flight device write and then sends the off value last', async () => {
    const a = fixture(), r = new Regulation(a, null); let release, called = false;
    a.config.regulation.minValueMin = 0;
    const write = a.setForeignStateAsync;
    a.setForeignStateAsync = async (...args) => {
        if (args[0] === 'target' && args[1] > 0) { called = true; await new Promise(resolve => { release = resolve; }); }
        return write(...args);
    };
    const run = r.run(); while (!called) await new Promise(resolve => setImmediate(resolve));
    a.own.set('regulation.enabled', { val: false }); const disable = r.handleDisabled(); release(); await Promise.all([run, disable]);
    assert.equal(a.foreign.get('target').val, 0);
    await r.run(); assert.equal(a.foreign.get('target').val, 0);
});

for (const reason of ['no surplus', 'SOC full', 'manual disable']) {
    test(`power-only excess charger stops on ${reason}`, async () => {
        const a = fixture(); Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: '',
            startDurationMin: 0, minRegulatePauseMin: 0, batSocStateId: reason === 'SOC full' ? 'soc' : '' });
        const r = new Regulation(a, null); await r._runExcessCharge(1000); assert.equal(a.foreign.get('charger').val, 1000);
        if (reason === 'no surplus') await r._runExcessCharge(0);
        if (reason === 'SOC full') { a.foreign.set('soc', { val: 100, ts: Date.now() }); await r._runExcessCharge(1000); }
        if (reason === 'manual disable') await r.handleDisabled();
        assert.equal(a.foreign.get('charger').val, 0);
    });
}

test('power-only charger waits for the configured start delay and clamps offset', async () => {
    const a = fixture(); Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', maxPower: 800,
        offsetPower: 200, startDurationMin: 1, minRegulatePauseMin: 0 });
    const r = new Regulation(a, null); await r._runExcessCharge(1000); assert.equal(a.foreign.has('charger'), false);
    r.ueberschussTimer = Date.now() - 61000; await r._runExcessCharge(1000); assert.equal(a.foreign.get('charger').val, 800);
});

test('power goes to zero while an optional switch is still within its minimum run time', async () => {
    const a = fixture(); Object.assign(a.config.excessCharge, { enabled: true, powerStateId: 'charger', switchStateId: 'switch' });
    a.foreign.set('charger', { val: 1000, ts: Date.now(), lc: Date.now() });
    a.foreign.set('switch', { val: true, ts: Date.now(), lc: Date.now() });
    const r = new Regulation(a, null); await r._runExcessCharge(0);
    assert.equal(a.foreign.get('charger').val, 0); assert.equal(a.foreign.get('switch').val, true);
});

test('EcoFlow reads automatic classic PowerStream paths and both PV inputs', async () => {
    const a = fixture(); const inv = { ...inverter, type: 'ecoflow', outputStateId: '', batterySOCStateId: '', pvPowerStateId: '' };
    const prefix = 'ecoflow-powercontrol.0.ecoflow.app_device_property_TEST.data.InverterHeartbeat';
    for (const [key, val] of Object.entries({ invOutputWatts: 1230, batSoc: 70, pv1InputWatts: 1000, pv2InputWatts: 2000 }))
        a.foreign.set(`${prefix}.${key}`, { val, ts: Date.now() });
    const r = new Regulation(a, { getDeviceStatePrefix: () => prefix });
    assert.equal(await r._readInvOutputWatts(inv), 123); assert.equal(await r._readBatState(inv), 70);
    assert.equal(await r._readSumPV(inv), 300);
    a.foreign.get(`${prefix}.invOutputWatts`).ts -= 51000; assert.equal(await r._readInvOutputWatts(inv), 0);
});

test('stop cancels delayed realPower update without post-unload writes', async () => {
    const a = fixture(), r = new Regulation(a, null); const update = r.updateRealPower();
    await r.stop(); await update; assert.equal(a.writes.length, 0); await r.run(); assert.equal(a.writes.length, 0);
});

test('a stale enabled-state read cannot undo a newer manual disable', async () => {
    const a = fixture(), r = new Regulation(a, null);
    const read = a.getStateAsync; let release;
    a.getStateAsync = async id => id === 'regulation.enabled'
        ? new Promise(resolve => { release = resolve; }) : read(id);
    const run = r.run(); while (!release) await new Promise(resolve => setImmediate(resolve));
    a.own.set('regulation.enabled', { val: false });
    const disable = r.handleDisabled(); release({ val: true });
    await Promise.all([run, disable]);
    assert.deepEqual(a.writes.filter(w => w.id === 'target').map(w => w.val), [0]);
});
