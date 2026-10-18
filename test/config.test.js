'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadMain, clone } = require('./helpers');
const io = require('../io-package.json');

test('startup migrates legacy aliases, respects false and zero, and logs no secrets', async () => {
    const a = loadMain();
    const secret = 'SYNTHETIC-SECRET-"-\\-WITH SPACES ';
    a.config = { ...clone(io.native), efEnabled: false, efPassword: secret, efEmail: 'synthetic@example.invalid',
        regMinValueMin: 0, regBasePowerOffset: 0, regSmFallback: 0, regSmStateId: 'meter',
        ecoflow: { enabled: true, devices: [{ serial: 'TEST', typ: 'PS' }] } };
    a.getForeignObjectAsync = async () => ({ native: clone(a.config) });
    const cfg = await a._loadEffectiveConfig();
    assert.equal(cfg.ecoflow.enabled, false); assert.equal(cfg.ecoflow.password, secret);
    assert.equal(cfg.regulation.minValueMin, 0); assert.equal(cfg.regulation.basePowerOffset, 0);
    assert.equal(cfg.regulation.smartmeterFallbackPower, 0);
    assert.ok(!JSON.stringify(a.logs).includes(secret));
    const saved = a.saved.at(-1); assert.ok(saved.native.efPassword.startsWith('$/aes-192-cbc:'));
    assert.equal(saved.native.ecoflow.password, undefined); assert.equal(saved.native.efEnabled, undefined);
    assert.deepEqual(saved.encryptedNative, io.encryptedNative);
    // Restart with the stored object: no additional migration and no ciphertext used for login.
    a.config = clone(saved.native); a.config.efPassword = a.decrypt(a.config.efPassword);
    a.getForeignObjectAsync = async () => clone(saved); a.saved.length = 0;
    const reloaded = await a._loadEffectiveConfig(); assert.equal(reloaded.ecoflow.password, secret); assert.equal(a.saved.length, 0);
});

test('auto-import encrypts passwords and removes pasted script from saved native', async () => {
    const a = loadMain(), cfg = clone(io.native);
    cfg.efLegacyScriptImport = 'var ConfigData = {email: "synthetic@example.invalid", passwort: "SYNTHETIC_IMPORT_SECRET", seriennummern: [{typ: "PS", seriennummer: "TEST"}]};';
    cfg.ecoflow.legacyScriptImport = cfg.efLegacyScriptImport;
    a.getForeignObjectAsync = async () => ({ native: clone(cfg) });
    await a._autoImportLegacyScript(cfg);
    const saved = a.saved.at(-1); assert.ok(saved); assert.equal(saved.native.efLegacyScriptImport, '');
    assert.equal(saved.native.ecoflow.password, undefined); assert.ok(saved.native.efPassword.startsWith('$/aes-192-cbc:'));
    assert.equal(a.decrypt(saved.native.efPassword), 'SYNTHETIC_IMPORT_SECRET');
    const inv = saved.native.inverters[0]; assert.match(inv.outputStateId, /InverterHeartbeat.invOutputWatts$/);
    assert.match(inv.batterySOCStateId, /InverterHeartbeat.batSoc$/);
    assert.ok(!JSON.stringify(a.logs).includes('SYNTHETIC_IMPORT_SECRET'));
});

test('disabled MQTT does not create a client even with configured credentials and devices', async t => {
    const a = loadMain(); a.config.ecoflow = { enabled: false, email: 'synthetic@example.invalid', password: 'synthetic', devices: [{ serial: 'TEST', typ: 'PS' }] };
    a._loadEffectiveConfig = async () => a.config; a._initializeRealPowerFromSmartmeter = async () => {};
    a._logSmartmeterDiagnostics = async () => {}; a.config.regulation.minValueMin = 0;
    t.after(() => new Promise(resolve => a._onUnload(resolve)));
    await a._onReady(); assert.equal(a.ecoflowMqtt, null); assert.equal(a.own.get('info.connection').val, false);
    assert.ok(!a.logs.some(e => e.level === 'error'));
});

test('Admin schema uses real field paths and structured payloads for quoted passwords', () => {
    const schema = require('../admin/jsonConfig.json');
    const ef = schema.items.tab_ecoflow.items;
    assert.ok(ef['ecoflow.enabled']); assert.ok(ef.efPassword); assert.equal(ef.efPassword.trim, false);
    assert.equal(ef.efTestConnection.jsonData, undefined); assert.equal(ef.efTestConnection.data.password, '${data.efPassword}');
    assert.ok(schema.items.tab_regulation.items['regulation.minValueMin']);
    assert.ok(io.encryptedNative.includes('efPassword')); assert.ok(io.protectedNative.includes('efPassword'));
});

test('adapter helper names do not override the controller subscription implementation', () => {
    const a = loadMain();
    assert.equal(Object.getPrototypeOf(a).hasOwnProperty('_subscribeForeignStates'), false);
    assert.equal(typeof a._subscribeConfiguredStates, 'function');
});
