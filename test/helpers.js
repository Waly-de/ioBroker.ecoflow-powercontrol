'use strict';
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const io = require('../io-package.json');
const clone = value => structuredClone(value);
const inverter = { id: 'TEST', regulation: true, type: 'generic', maxPower: 800, hasBat: true,
    outputStateId: 'out', setOutputStateId: 'target', batterySOCStateId: 'soc', pvPowerStateId: 'pv',
    battPozOn: 95, battPozOff: 90, lowBatLimitPozOn: 10, lowBatLimitPozOff: 20, lowBatLimit: 100,
    regulationOffPower: 0 };
function fixture() {
    const config = clone(io.native);
    config.regulation.smartmeterStateId = 'meter';
    config.inverters = [clone(inverter)];
    const now = Date.now();
    const own = new Map([['regulation.enabled', { val: true, ts: now }], ['regulation.realPower', { val: 100, ts: now }]]);
    const foreign = new Map(Object.entries({ meter: { val: 100, ts: now }, out: { val: 0, ts: now },
        soc: { val: 50, ts: now }, pv: { val: 0, ts: now } }));
    const objects = new Map();
    const writes = [], logs = [], saved = [];
    function write(store, id, val, ack, isForeign) {
        const previous = store.get(id);
        const state = { val, ack, ts: Date.now(), lc: previous?.val === val ? previous.lc : Date.now() };
        store.set(id, state);
        if (!isForeign) foreign.set(`ecoflow-powercontrol.0.${id}`, state);
        writes.push({ id, val, ack, isForeign });
    }
    return { config, namespace: 'ecoflow-powercontrol.0', own, foreign, objects, writes, logs, saved,
        log: Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, text => logs.push({ level, text })])),
        getStateAsync: async id => own.get(id) || null,
        getForeignStateAsync: async id => foreign.get(id) || null,
        setStateAsync: async (id, val, ack) => write(own, id.replace(/^ecoflow-powercontrol\.0\./, ''), val, ack, false),
        setForeignStateAsync: async (id, val, ack) => write(foreign, id, val, ack, true),
        setObjectNotExistsAsync: async (id, obj) => { if (!objects.has(id)) objects.set(id, clone(obj)); },
        getForeignObjectAsync: async id => id.startsWith('system.adapter.') ? { native: clone(config) } : objects.get(id),
        setForeignObjectAsync: async (_id, obj) => saved.push(clone(obj)),
        subscribeStatesAsync: async () => {}, subscribeForeignStatesAsync: async () => {},
        unsubscribeForeignStates: () => {}, sendTo: () => {},
        encrypt: value => '$/aes-192-cbc:' + Buffer.from(value).toString('base64'),
        decrypt: value => Buffer.from(value.slice('$/aes-192-cbc:'.length), 'base64').toString(),
    };
}
function loadMain() {
    class FakeAdapter extends EventEmitter { constructor() { super(); Object.assign(this, fixture()); } }
    const filename = path.resolve(__dirname, '../main.js');
    const mod = new Module(filename, module);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    mod.require = name => name === '@iobroker/adapter-core'
        ? { Adapter: FakeAdapter } : Module.prototype.require.call(mod, name);
    mod._compile(fs.readFileSync(filename, 'utf8'), filename);
    return mod.exports();
}
module.exports = { fixture, inverter, clone, loadMain };
