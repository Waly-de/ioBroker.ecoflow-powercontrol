'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Regulation = require('../lib/regulation');
const { fixture, inverter } = require('./helpers');

function setup(hasBat = true) {
    const a = fixture();
    Object.assign(a.config.regulation, { minValueMin: 0, basePowerOffset: 0 });
    const inv = a.config.inverters[0];
    Object.assign(inv, { type: 'ecoflow', hasBat });
    const sent = [];
    const r = new Regulation(a, {
        setACForDevice: async (id, raw) => sent.push({ id, raw }),
        getDeviceStatePrefix: id => `${a.namespace}.ecoflow.app_device_property_${id}.data.InverterHeartbeat`,
    });
    return { a, inv, r, sent };
}

for (const mode of ['serial', 'balance']) {
    test(`${mode}: February telemetry cannot trigger the no-battery 800 W command`, async () => {
        const { a, r, sent } = setup(false);
        a.config.regulation.multiPsMode = mode === 'serial' ? 1 : 0;
        a.foreign.set('out', { val: 130, ts: Date.parse('2026-02-20T15:33:00Z') });
        await r.run();
        assert.deepEqual(sent, []);
        assert.equal(a.own.has('inverters.TEST.targetOutput'), false);
        assert.equal(a.own.has('inverters.TEST.batterySOC'), false);
        assert(a.logs.some(l => l.level === 'warn' && l.text.includes('stale output measurement')));
        assert(!a.logs.some(l => l.text.includes('Feed-in set to max')));
    });
}

for (const [name, sample] of [
    ['missing', null], ['stale', { val: 1, ts: Date.now() - 601000 }],
    ['null', { val: null, ts: Date.now() }], ['boolean', { val: false, ts: Date.now() }],
    ['empty', { val: '', ts: Date.now() }], ['invalid quality', { val: 50, ts: Date.now(), q: 0x40 }],
]) {
    test(`${name} battery telemetry is not treated as zero percent`, async () => {
        const { a, r, sent } = setup();
        if (sample) a.foreign.set('soc', sample); else a.foreign.delete('soc');
        await r.run();
        assert.deepEqual(sent, []);
        assert.equal(a.own.has('inverters.TEST.batterySOC'), false);
        assert(!a.logs.some(l => l.text.includes('Battery below')));
    });
}

test('fresh genuine zero measurements permit control; no battery needs no SOC', async () => {
    const { a, r, sent } = setup(false);
    a.foreign.delete('soc'); a.foreign.set('out', { val: 0, ts: Date.now() });
    await r.run();
    assert.deepEqual(sent, [{ id: 'TEST', raw: 8000 }]);
    assert.equal(a.own.get('inverters.TEST.targetOutput').val, 800);
});

test('fresh zero percent SOC remains a valid battery reading', async () => {
    const { a, r, sent } = setup();
    a.foreign.set('soc', { val: 0, ts: Date.now() });
    await r.run();
    assert.equal(a.own.get('inverters.TEST.batterySOC').val, 0);
    assert(sent.length > 0);
    assert(!a.logs.some(l => l.text.includes('control paused')));
});

test('only the unavailable inverter is blocked; generic control continues', async () => {
    const { a, r, sent } = setup(false);
    a.foreign.delete('out');
    const generic = { ...inverter, id: 'GENERIC', hasBat: false, maxPower: 300 };
    a.config.inverters.push(generic); r._initInverterState();
    await r.run();
    assert.deepEqual(sent, []);
    assert.equal(a.foreign.get('target').val, 300);
});

test('recovery after telemetry expires reissues the same full-power target', async () => {
    const { a, r, sent } = setup(false);
    await r.run(); assert.equal(sent.length, 1);
    a.foreign.get('out').ts -= 51000;
    await r.run(); await r.run();
    assert.equal(sent.length, 1);
    assert.equal(a.logs.filter(l => l.text.includes('control paused')).length, 1);
    a.foreign.get('out').ts = Date.now();
    await r.run();
    assert.deepEqual(sent.map(s => s.raw), [8000, 8000]);
    assert.equal(a.logs.filter(l => l.text.includes('Fresh telemetry restored')).length, 1);
});

test('telemetry expires while history is pending: no later automatic command', async () => {
    const { a, r, sent } = setup(); let release;
    r._getLowestValue = () => new Promise(resolve => { release = resolve; });
    const run = r.run();
    while (!release) await new Promise(resolve => setImmediate(resolve));
    a.foreign.get('out').ts -= 51000;
    release(100); await run;
    assert.deepEqual(sent, []);
    assert.equal(a.own.has('inverters.TEST.targetOutput'), false);
});

test('automatic priority changes are guarded; explicit off-power and manual priority remain possible', async () => {
    const { a, inv, r, sent } = setup();
    inv.setPriorityStateId = 'priority';
    a.foreign.delete('out');
    await r._setPrio(inv, '1');
    assert.equal(a.foreign.has('priority'), false);
    await r._setPrio(inv, '1', true);
    assert.equal(a.foreign.get('priority').val, '1');
    await r.handleDisabled();
    assert.deepEqual(sent, [{ id: 'TEST', raw: 0 }]);
});

test('automatic default PowerStream paths use current measurement timestamps', async () => {
    const { a, inv, r, sent } = setup();
    inv.outputStateId = ''; inv.batterySOCStateId = '';
    const prefix = `${a.namespace}.ecoflow.app_device_property_TEST.data.InverterHeartbeat`;
    a.foreign.set(`${prefix}.invOutputWatts`, { val: 0, ts: Date.now() });
    a.foreign.set(`${prefix}.batSoc`, { val: 50, ts: Date.now() });
    await r.run(); assert(sent.length > 0);
    const count = sent.length;
    a.foreign.get(`${prefix}.batSoc`).ts -= 601000;
    await r.run(); assert.equal(sent.length, count);
});
