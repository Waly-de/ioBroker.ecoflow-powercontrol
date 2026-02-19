'use strict';

const utils = require('@iobroker/adapter-core');
const vm = require('vm');
const ioPackage = require('./io-package.json');
const EcoflowMqtt = require('./lib/ecoflow-mqtt');
const Regulation = require('./lib/regulation');

class EcoflowPowerControl extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({ ...options, name: 'ecoflow-powercontrol' });

        /** @type {EcoflowMqtt|null} */
        this.ecoflowMqtt = null;

        /** @type {Regulation|null} */
        this.regulation = null;

        /** Regulation loop interval handle */
        this.regulationInterval = null;

        /** Heartbeat interval (EcoFlow PS devices) */
        this.heartbeatInterval = null;

        /** Foreign state IDs we subscribed to */
        this.foreignSubscriptions = new Set();

        this.on('ready',       this._onReady.bind(this));
        this.on('stateChange', this._onStateChange.bind(this));
        this.on('message',     this._onMessage.bind(this));
        this.on('unload',      this._onUnload.bind(this));
    }

    // ──────────────────────────────────────────────────────────── lifecycle

    async _onReady() {
        this.log.info('EcoFlow PowerControl adapter starting...');
        this._restartRequestedByAutoImport = false;

        let cfg = await this._loadEffectiveConfig();
        this.config = cfg;

        await this._createCommandObjects();

        // ── 0. Startup auto-import: if legacyScriptImport contains text, parse and apply it
        cfg = await this._autoImportLegacyScript(cfg);
        this.config = cfg;

        if (this._restartRequestedByAutoImport) {
            this.log.warn('Startup stopped after auto-import because adapter restart was requested.');
            return;
        }

        // ── 1. Create dynamic object tree for configured inverters
        await this._createInverterObjects(cfg.inverters || []);

        // ── 2. Optionally create ecoflow channel
        if (cfg.ecoflow && cfg.ecoflow.enabled) {
            await this.setObjectNotExistsAsync('ecoflow', {
                type: 'channel',
                common: { name: 'EcoFlow MQTT Data' },
                native: {}
            });
            await this.setObjectNotExistsAsync('ecoflow.lastTopic', {
                type: 'state',
                common: {
                    name: 'Last received MQTT topic',
                    role: 'state',
                    type: 'string',
                    read: true,
                    write: false,
                    def: ''
                },
                native: {}
            });
        }

        // ── 3. Initialise regulation.enabled from config default
        const enabledState = await this.getStateAsync('regulation.enabled');
        if (enabledState === null || enabledState === undefined) {
            await this.setStateAsync('regulation.enabled', cfg.regulation ? !!cfg.regulation.enabled : true, true);
        }

        // ── 4. Start EcoFlow MQTT (optional)
        const ecoflowEnabledFlag = !!cfg?.ecoflow?.enabled;
        const ecoflowHasEmail = !!(cfg?.ecoflow?.email && String(cfg.ecoflow.email).trim());
        const ecoflowHasPassword = !!(cfg?.ecoflow?.password && String(cfg.ecoflow.password).trim());
        const ecoflowDevices = Array.isArray(cfg?.ecoflow?.devices) ? cfg.ecoflow.devices.length : 0;
        const ecoflowHasDevices = ecoflowDevices > 0;
        const shouldStartEcoflow = (
            (ecoflowEnabledFlag && ecoflowHasEmail && ecoflowHasPassword && ecoflowHasDevices) ||
            (!ecoflowEnabledFlag && ecoflowHasEmail && ecoflowHasPassword && ecoflowHasDevices)
        );

        this.log.warn(`EcoFlow config at startup: enabled=${ecoflowEnabledFlag}, email=${ecoflowHasEmail ? 'set' : 'missing'}, password=${ecoflowHasPassword ? 'set' : 'missing'}, devices=${ecoflowDevices}`);

        const flatEcoflowEmail = cfg['ecoflow.email'];
        const flatEcoflowPassword = cfg['ecoflow.password'];
        const flatEcoflowDevices = cfg['ecoflow.devices'];
        if (flatEcoflowEmail !== undefined || flatEcoflowPassword !== undefined || flatEcoflowDevices !== undefined) {
            this.log.warn(`Detected flat ecoflow keys in native config (legacy admin format): email=${flatEcoflowEmail ? 'set' : 'missing'}, password=${flatEcoflowPassword ? 'set' : 'missing'}, devices=${Array.isArray(flatEcoflowDevices) ? flatEcoflowDevices.length : 0}`);
        }

        if (shouldStartEcoflow) {
            if (!ecoflowEnabledFlag) {
                this.log.warn('EcoFlow MQTT auto-enabled because credentials are present, although checkbox is currently disabled.');
            }
            this.log.info(`EcoFlow MQTT is enabled (devices: ${(cfg.ecoflow.devices || []).length}). Starting connection...`);
            this.ecoflowMqtt = new EcoflowMqtt(this);
            await this.ecoflowMqtt.start();
        } else {
            // Ensure info.connection = false when EcoFlow is disabled
            if ((cfg.ecoflow && cfg.ecoflow.enabled) || (ecoflowHasEmail && ecoflowHasPassword)) {
                if (!ecoflowHasDevices) {
                    this.log.warn('EcoFlow MQTT not started because no EcoFlow devices are configured.');
                }
                if (!ecoflowHasEmail || !ecoflowHasPassword) {
                    this.log.warn('EcoFlow MQTT is enabled but credentials are incomplete. Please set email and password.');
                }
            } else {
                this.log.info('EcoFlow MQTT is disabled.');
            }
            await this.setStateAsync('info.connection', false, true);
        }

        // ── 5. Create Regulation instance
        this.regulation = new Regulation(this, this.ecoflowMqtt);

        // Sync regulation.enabled state into the regulation object
        const regEnabledState = await this.getStateAsync('regulation.enabled');
        this.regulation.regulationEnabled = regEnabledState ? !!regEnabledState.val : true;

        // ── 6. Subscribe to own states
        await this.subscribeStatesAsync('regulation.enabled');
        await this.subscribeStatesAsync('commands.testConnection');
        await this.subscribeStatesAsync('commands.importLegacyScript');
        await this.subscribeStatesAsync('commands.resetAllSettings');

        // ── 7. Subscribe to foreign states (smart meter + inverter outputs + additionalPower)
        await this._subscribeForeignStates(cfg);

        if (cfg?.regulation?.smartmeterStateId) {
            this.log.info(`Configured smartmeter state: ${cfg.regulation.smartmeterStateId}`);
        } else {
            this.log.warn('No smartmeter state configured (regulation.smartmeterStateId is empty).');
        }

        await this._initializeRealPowerFromSmartmeter(cfg);

        // ── 8. Ensure history logging for regulation.realPower
        try {
            await this.regulation.ensureHistoryLogging();
        } catch (e) {
            this.log.warn(`History setup failed: ${e.message}`);
        }

        // ── 9. Start regulation loop
        const intervalMs = ((cfg.regulation && cfg.regulation.intervalSec) || 15) * 1000;
        this.regulationInterval = setInterval(async () => {
            try {
                await this.regulation.run();
            } catch (err) {
                this.log.error(`Regulation loop error: ${err.message}\n${err.stack}`);
            }
        }, intervalMs);
        this.log.info(`Regulation loop started (interval: ${intervalMs / 1000}s).`);

        // ── 10. EcoFlow heartbeat every 32 seconds
        if (this.ecoflowMqtt) {
            this.heartbeatInterval = setInterval(() => {
                this.ecoflowMqtt.sendHeartbeats();
            }, 32 * 1000);
        }

        this.log.info('EcoFlow PowerControl adapter ready.');
    }

    async _onUnload(callback) {
        try {
            if (this.regulationInterval) {
                clearInterval(this.regulationInterval);
                this.regulationInterval = null;
            }
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }
            if (this.ecoflowMqtt) {
                await this.ecoflowMqtt.stop();
                this.ecoflowMqtt = null;
            }
            // Unsubscribe foreign states
            for (const id of this.foreignSubscriptions) {
                try { this.unsubscribeForeignStates(id); } catch (_) { /* ignore */ }
            }
            this.foreignSubscriptions.clear();
            this.log.info('EcoFlow PowerControl adapter stopped.');
        } catch (e) {
            this.log.error(`Error during unload: ${e.message}`);
        }
        callback();
    }

    // ──────────────────────────────────────────────────────────── state change

    async _onStateChange(id, state) {
        if (!state) return;

        // ── Own state: regulation.enabled
        if (id === `${this.namespace}.regulation.enabled`) {
            if (state.ack) return; // only react to user writes
            const enabled = !!state.val;
            this.log.info(`Regulation ${enabled ? 'enabled' : 'disabled'} by user.`);
            await this.setStateAsync('regulation.enabled', enabled, true);
            if (this.regulation) {
                this.regulation.regulationEnabled = enabled;
                if (!enabled) {
                    await this.regulation.handleDisabled();
                } else {
                    await this.regulation.handleEnabled();
                }
            }
            return;
        }

        if (id === `${this.namespace}.commands.testConnection`) {
            this.log.debug(`Admin command state write: testConnection ack=${state.ack} val=${JSON.stringify(state.val)}`);
            const hasPayload = typeof state.val === 'string'
                ? state.val.trim().length > 0
                : state.val !== undefined && state.val !== null && String(state.val).trim() !== '';
            if (!hasPayload) return;
            try {
                await this._runTestConnectionFromState(state.val);
            } finally {
                await this.setStateAsync('commands.testConnection', '', true);
            }
            return;
        }

        if (id === `${this.namespace}.commands.importLegacyScript`) {
            this.log.debug(`Admin command state write: importLegacyScript ack=${state.ack} valLength=${typeof state.val === 'string' ? state.val.length : 0}`);
            const hasPayload = typeof state.val === 'string'
                ? state.val.trim().length > 0
                : state.val !== undefined && state.val !== null && String(state.val).trim() !== '';
            if (!hasPayload) return;
            try {
                await this._runImportFromState(state.val);
            } finally {
                await this.setStateAsync('commands.importLegacyScript', '', true);
            }
            return;
        }

        if (id === `${this.namespace}.commands.resetAllSettings`) {
            this.log.debug(`Admin command state write: resetAllSettings ack=${state.ack} val=${JSON.stringify(state.val)}`);
            const triggerReset = state.val === true || state.val === 1 || state.val === '1' || String(state.val).toLowerCase() === 'true';
            if (!triggerReset) return;
            try {
                await this._runResetAllFromState();
            } finally {
                await this.setStateAsync('commands.resetAllSettings', false, true);
            }
            return;
        }

        // ── EcoFlow writeable state changes (ack=false)
        if (id.includes('.ecoflow.') && !state.ack && this.ecoflowMqtt) {
            try {
                await this.ecoflowMqtt.onWriteableStateChange(id, state);
            } catch (err) {
                this.log.warn(`EcoFlow writeable state error for ${id}: ${err.message}`);
            }
            return;
        }

        // ── Foreign state: smartmeter value changed → update realPower
        const cfg = this.config;
        if (cfg.regulation && cfg.regulation.smartmeterStateId &&
            id === cfg.regulation.smartmeterStateId) {
            const gridPower = Number(state.val) || 0;
            if (this.regulation) {
                // Non-blocking – updateRealPower has its own debounce
                this.regulation.updateRealPower(gridPower).catch(err => {
                    this.log.debug(`updateRealPower error: ${err.message}`);
                });
            }
        }
    }

    // ──────────────────────────────────────────────────────────── admin messages

    async _onMessage(obj) {
        if (!obj || !obj.command) return;
        if (obj.command !== 'testEcoflowConnection' && obj.command !== 'importOldScriptSettings' && obj.command !== 'resetAllSettings') return;

        this.log.warn(`Admin sendTo command received: ${obj.command}`);

        const respond = payload => {
            if (obj.callback) {
                this.sendTo(obj.from, obj.command, payload, obj.callback);
            }
        };

        try {
            let message = obj.message || {};
            if (typeof message === 'string') {
                try {
                    message = JSON.parse(message);
                } catch {
                    message = {};
                }
            }

            if (obj.command === 'testEcoflowConnection') {
                const email = String(message.email || this.config.ecoflow?.email || '').trim();
                const password = String(message.password || this.config.ecoflow?.password || '').trim();
                const reconnectMin = Number(message.reconnectMin || this.config.ecoflow?.reconnectMin || 30) || 30;

                this.log.info('EcoFlow MQTT test connection requested from admin.');

                if (!email || !password) {
                    throw new Error('EcoFlow credentials missing. Please enter email and password first.');
                }

                const testCfg = {
                    ...(this.config.ecoflow || {}),
                    email,
                    password,
                    reconnectMin,
                    devices: Array.isArray(this.config.ecoflow?.devices) ? this.config.ecoflow.devices : []
                };

                let tester = null;
                try {
                    tester = new EcoflowMqtt(this, { configOverride: testCfg, testMode: true });
                    const result = await tester.testConnection();
                    const okMessage = `EcoFlow MQTT test successful (${result.protocol}://${result.url}:${result.port}, userId=${result.userId}).`;
                    this.log.info(okMessage);
                    await this.setStateAsync('commands.lastResult', okMessage, true);
                    respond({ test_ok: `${result.protocol}://${result.url}:${result.port}` });
                } finally {
                    if (tester) {
                        await tester.stop();
                    }
                }
                return;
            }

            if (obj.command === 'importOldScriptSettings') {
                const script = String(message.script || this.config?.ecoflow?.legacyScriptImport || '').trim();
                if (!script) {
                    throw new Error('No script content provided. Please paste the old script first.');
                }

                this.log.info('Legacy script import requested from admin. Parsing ConfigData...');
                const legacyConfig = this._parseLegacyScriptConfig(script);
                const patch = this._mapLegacyConfigToNative(legacyConfig);
                const native = this._deepMerge(JSON.parse(JSON.stringify(this.config || {})), patch);

                const importedDevices = Array.isArray(native.ecoflow?.devices) ? native.ecoflow.devices.length : 0;
                const importedInverters = Array.isArray(native.inverters) ? native.inverters.length : 0;
                const okMessage = `Legacy script import successful (devices: ${importedDevices}, inverters: ${importedInverters}).`;
                this.log.info(okMessage);
                await this.setStateAsync('commands.lastResult', okMessage, true);

                respond({
                    native,
                    saveConfig: true,
                    import_ok: `devices:${importedDevices};inverters:${importedInverters}`
                });
                return;
            }

            if (obj.command === 'resetAllSettings') {
                const defaults = this._getDefaultNativeConfig();
                const okMessage = 'Admin reset prepared defaults. Save config to apply reset values.';
                this.log.warn(okMessage);
                await this.setStateAsync('commands.lastResult', okMessage, true);
                respond({
                    native: defaults,
                    saveConfig: true,
                    reset_ok: true
                });
                return;
            }
        } catch (err) {
            if (obj.command === 'testEcoflowConnection') {
                this.log.error(`EcoFlow MQTT test failed: ${err.message}`);
                await this.setStateAsync('commands.lastResult', `EcoFlow MQTT test failed: ${err.message}`, true);
                respond({ test_err: err.message });
            } else if (obj.command === 'importOldScriptSettings') {
                this.log.error(`Legacy script import failed: ${err.message}`);
                await this.setStateAsync('commands.lastResult', `Legacy script import failed: ${err.message}`, true);
                respond({ import_err: err.message });
            } else if (obj.command === 'resetAllSettings') {
                this.log.error(`Reset settings failed: ${err.message}`);
                await this.setStateAsync('commands.lastResult', `Reset settings failed: ${err.message}`, true);
                respond({ reset_err: err.message });
            }
        }
    }

    _parseLegacyScriptConfig(scriptText) {
        const marker = 'var ConfigData';
        const markerIndex = scriptText.lastIndexOf(marker);
        if (markerIndex === -1) {
            throw new Error('ConfigData block not found in script.');
        }

        const startBrace = scriptText.indexOf('{', markerIndex);
        if (startBrace === -1) {
            throw new Error('ConfigData object start not found.');
        }

        let depth = 0;
        let inString = false;
        let stringQuote = '';
        let escape = false;
        let inLineComment = false;
        let inBlockComment = false;
        let endBrace = -1;

        for (let i = startBrace; i < scriptText.length; i++) {
            const ch = scriptText[i];
            const next = i + 1 < scriptText.length ? scriptText[i + 1] : '';

            if (inLineComment) {
                if (ch === '\n') inLineComment = false;
                continue;
            }
            if (inBlockComment) {
                if (ch === '*' && next === '/') {
                    inBlockComment = false;
                    i++;
                }
                continue;
            }

            if (inString) {
                if (escape) {
                    escape = false;
                    continue;
                }
                if (ch === '\\') {
                    escape = true;
                    continue;
                }
                if (ch === stringQuote) {
                    inString = false;
                    stringQuote = '';
                }
                continue;
            }

            if (ch === '/' && next === '/') {
                inLineComment = true;
                i++;
                continue;
            }
            if (ch === '/' && next === '*') {
                inBlockComment = true;
                i++;
                continue;
            }

            if (ch === '"' || ch === '\'' || ch === '`') {
                inString = true;
                stringQuote = ch;
                continue;
            }

            if (ch === '{') {
                depth++;
            } else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    endBrace = i;
                    break;
                }
            }
        }

        if (endBrace === -1) {
            throw new Error('ConfigData object end not found.');
        }

        const objectLiteral = scriptText.slice(startBrace, endBrace + 1);
        let parsed;
        try {
            parsed = vm.runInNewContext(`(${objectLiteral})`, {}, { timeout: 1000 });
        } catch (e) {
            try {
                const tolerantExpression = `(() => {\n` +
                    `  const __ctx = new Proxy({}, {\n` +
                    `    has: () => true,\n` +
                    `    get: (_target, key) => {\n` +
                    `      if (key === Symbol.unscopables) return undefined;\n` +
                    `      return undefined;\n` +
                    `    }\n` +
                    `  });\n` +
                    `  with (__ctx) {\n` +
                    `    return (${objectLiteral});\n` +
                    `  }\n` +
                    `})()`;
                parsed = vm.runInNewContext(tolerantExpression, {}, { timeout: 1000 });
                this.log.warn(`ConfigData parser fallback used due to: ${e.message}`);
            } catch (e2) {
                throw new Error(`Could not parse ConfigData object: ${e2.message}`);
            }
        }

        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Parsed ConfigData is not an object.');
        }
        return parsed;
    }

    _mapLegacyConfigToNative(oldCfg) {
        const toNumber = (value, fallback) => {
            const numberValue = Number(value);
            return Number.isFinite(numberValue) ? numberValue : fallback;
        };

        const patch = {
            ecoflow: {},
            regulation: {},
            excessCharge: {},
            advanced: {}
        };

        if (oldCfg.email !== undefined) patch.ecoflow.email = String(oldCfg.email || '');
        if (oldCfg.passwort !== undefined) patch.ecoflow.password = String(oldCfg.passwort || '');
        if (oldCfg.ReconnectMin !== undefined) patch.ecoflow.reconnectMin = toNumber(oldCfg.ReconnectMin, 30);

        const devices = Array.isArray(oldCfg.seriennummern)
            ? oldCfg.seriennummern
                .filter(device => device && device.seriennummer)
                .map(device => ({
                    serial: String(device.seriennummer || ''),
                    name: String(device.name || device.seriennummer || ''),
                    typ: String(device.typ || 'PS'),
                    subscribe: device.subscribe !== undefined ? !!device.subscribe : true
                }))
            : null;
        if (devices) patch.ecoflow.devices = devices;

        const smartmeterId = [
            oldCfg.SmartmeterID,
            oldCfg.SmartmeterId,
            oldCfg.smartmeterID,
            oldCfg.smartmeterId,
            oldCfg.smartmeterStateId
        ].find(value => value !== undefined && value !== null && String(value).trim() !== '');
        if (smartmeterId !== undefined) patch.regulation.smartmeterStateId = String(smartmeterId || '').trim();
        if (oldCfg.SmartmeterTimeoutMin !== undefined) patch.regulation.smartmeterTimeoutMin = toNumber(oldCfg.SmartmeterTimeoutMin, 4);
        if (oldCfg.SmartmeterFallbackPower !== undefined) patch.regulation.smartmeterFallbackPower = toNumber(oldCfg.SmartmeterFallbackPower, 150);
        if (oldCfg.RegulationIntervalSec !== undefined) patch.regulation.intervalSec = toNumber(oldCfg.RegulationIntervalSec, 15);
        if (oldCfg.BasePowerOffset !== undefined) patch.regulation.basePowerOffset = toNumber(oldCfg.BasePowerOffset, 30);
        if (oldCfg.MinValueMin !== undefined) patch.regulation.minValueMin = toNumber(oldCfg.MinValueMin, 2);
        if (oldCfg.MinValueAg !== undefined) patch.regulation.minValueAg = toNumber(oldCfg.MinValueAg, 0);
        if (oldCfg.RegulationMultiPsMode !== undefined) patch.regulation.multiPsMode = toNumber(oldCfg.RegulationMultiPsMode, 0);
        if (oldCfg.SerialReverse !== undefined) patch.regulation.serialReverse = !!oldCfg.SerialReverse;
        if (oldCfg.Zusatzpower_Offset !== undefined) patch.regulation.zusatzpowerOffset = toNumber(oldCfg.Zusatzpower_Offset, 10);
        if (oldCfg.Regulation !== undefined) patch.regulation.enabled = !!oldCfg.Regulation;

        const inverters = Array.isArray(oldCfg.seriennummern)
            ? oldCfg.seriennummern
                .filter(device => device && device.typ === 'PS' && device.seriennummer)
                .map(device => ({
                    id: String(device.seriennummer),
                    name: String(device.name || device.seriennummer),
                    type: 'ecoflow',
                    maxPower: toNumber(device.MaxPower, 800),
                    regulation: device.regulation !== undefined ? !!device.regulation : true,
                    hasBat: device.hasBat !== undefined ? !!device.hasBat : true,
                    outputStateId: '',
                    setOutputStateId: '',
                    batterySOCStateId: '',
                    pvPowerStateId: '',
                    setPriorityStateId: '',
                    battPozOn: toNumber(device.battPozOn, 95),
                    battPozOff: toNumber(device.battPozOff, 90),
                    battOnSwitchPrio: device.battOnSwitchPrio !== undefined ? !!device.battOnSwitchPrio : false,
                    prioOffOnDemand: toNumber(device.prioOffOnDemand, 0),
                    lowBatLimitPozOn: toNumber(device.lowBatLimitPozOn, 10),
                    lowBatLimitPozOff: toNumber(device.lowBatLimitPozOff, 20),
                    lowBatLimit: toNumber(device.lowBatLimit, 100),
                    regulationOffPower: toNumber(device.RegulationOffPower, 0)
                }))
            : null;
        if (inverters) patch.inverters = inverters;

        const additionalPower = Array.isArray(oldCfg.AdditionalPower)
            ? oldCfg.AdditionalPower
                .filter(item => item && item.id)
                .map(item => ({
                    name: String(item.name || ''),
                    id: String(item.id || ''),
                    factor: toNumber(item.factor, 1),
                    offset: toNumber(item.offset, 0),
                    noFeedIn: item.noFeedIn !== undefined ? !!item.noFeedIn : !!item.NoFeedIn,
                    noPV: item.noPV !== undefined ? !!item.noPV : !!item.NoPV
                }))
            : null;
        if (additionalPower) patch.additionalPower = additionalPower;

        if (oldCfg.ExcessCharge !== undefined) patch.excessCharge.enabled = !!oldCfg.ExcessCharge;
        if (oldCfg.ExcessChargePowerID !== undefined) patch.excessCharge.powerStateId = String(oldCfg.ExcessChargePowerID || '');
        if (oldCfg.ExcessChargePowerBatSocID !== undefined) patch.excessCharge.batSocStateId = String(oldCfg.ExcessChargePowerBatSocID || '');
        if (oldCfg.ExcessActualPowerID !== undefined) patch.excessCharge.actualPowerStateId = String(oldCfg.ExcessActualPowerID || '');
        if (oldCfg.ExcessChargeSwitchID !== undefined) patch.excessCharge.switchStateId = String(oldCfg.ExcessChargeSwitchID || '');
        if (oldCfg.ExcessChargeSwitchOn !== undefined) patch.excessCharge.switchOnValue = String(oldCfg.ExcessChargeSwitchOn);
        if (oldCfg.ExcessChargeSwitchOff !== undefined) patch.excessCharge.switchOffValue = String(oldCfg.ExcessChargeSwitchOff);
        if (oldCfg.ExcessChargeMaxPower !== undefined) patch.excessCharge.maxPower = toNumber(oldCfg.ExcessChargeMaxPower, 2000);
        if (oldCfg.ExcessChargeOffsetPower !== undefined) patch.excessCharge.offsetPower = toNumber(oldCfg.ExcessChargeOffsetPower, 0);
        if (oldCfg.ExcessChargeStartPower !== undefined) patch.excessCharge.startPower = toNumber(oldCfg.ExcessChargeStartPower, 50);
        if (oldCfg.ExcessChargeStopPower !== undefined) patch.excessCharge.stopPower = toNumber(oldCfg.ExcessChargeStopPower, 0);
        if (oldCfg.ExcessChargeStartPowerDurationMin !== undefined) patch.excessCharge.startDurationMin = toNumber(oldCfg.ExcessChargeStartPowerDurationMin, 1);
        if (oldCfg.ExcessChargeMinRegulatePause !== undefined) patch.excessCharge.minRegulatePauseMin = toNumber(oldCfg.ExcessChargeMinRegulatePause, 1);
        if (oldCfg.ExcessChargeRegulateSteps !== undefined) patch.excessCharge.regulateSteps = toNumber(oldCfg.ExcessChargeRegulateSteps, 100);
        if (oldCfg.ExcessChargeBatSocMax !== undefined) patch.excessCharge.batSocMax = toNumber(oldCfg.ExcessChargeBatSocMax, 95);
        if (oldCfg.ExcessChargeBatSocOff !== undefined) patch.excessCharge.batSocOff = toNumber(oldCfg.ExcessChargeBatSocOff, 100);
        if (oldCfg.ExcessChargeSwitchMin !== undefined) patch.excessCharge.switchMinMin = toNumber(oldCfg.ExcessChargeSwitchMin, 5);

        if (oldCfg.Debug !== undefined) patch.advanced.debug = !!oldCfg.Debug;
        if (oldCfg.mlog !== undefined) patch.advanced.mlog = !!oldCfg.mlog;
        if (oldCfg.AdditionalPowerAvgPeriod !== undefined) patch.advanced.avgPeriodMs = toNumber(oldCfg.AdditionalPowerAvgPeriod, 15000);

        const hasEcoflowCredentials = !!(patch.ecoflow.email || patch.ecoflow.password || (patch.ecoflow.devices && patch.ecoflow.devices.length));
        if (hasEcoflowCredentials) {
            patch.ecoflow.enabled = true;
        }

        // Mirror values for admin variants that store/read top-level ef* keys
        if (patch.ecoflow.email !== undefined) patch.efEmail = patch.ecoflow.email;
        if (patch.ecoflow.password !== undefined) patch.efPassword = patch.ecoflow.password;
        if (patch.ecoflow.reconnectMin !== undefined) patch.efReconnectMin = patch.ecoflow.reconnectMin;
        if (patch.ecoflow.enabled !== undefined) patch.efEnabled = patch.ecoflow.enabled;
        if (patch.ecoflow.devices !== undefined) patch.efDevices = JSON.parse(JSON.stringify(patch.ecoflow.devices));

        return patch;
    }

    _deepMerge(target, source) {
        if (!source || typeof source !== 'object') return target;
        if (!target || typeof target !== 'object') return JSON.parse(JSON.stringify(source));

        for (const key of Object.keys(source)) {
            const sourceValue = source[key];
            if (sourceValue === undefined) continue;

            if (Array.isArray(sourceValue)) {
                target[key] = JSON.parse(JSON.stringify(sourceValue));
            } else if (sourceValue && typeof sourceValue === 'object') {
                const targetValue = target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])
                    ? target[key]
                    : {};
                target[key] = this._deepMerge(targetValue, sourceValue);
            } else {
                target[key] = sourceValue;
            }
        }
        return target;
    }

    async _loadEffectiveConfig() {
        const runtimeCfg = this._normalizeConfig(this.config || {});

        let nativeCfg = {};
        try {
            const instanceObjectId = `system.adapter.${this.namespace}`;
            const instanceObj = await this.getForeignObjectAsync(instanceObjectId);
            nativeCfg = this._normalizeConfig(instanceObj?.native || {});

            const runtimeEco = runtimeCfg?.ecoflow || {};
            const nativeEco = nativeCfg?.ecoflow || {};
            this.log.warn(
                `EcoFlow config sources: runtime(email=${runtimeEco.email ? 'set' : 'missing'}, password=${runtimeEco.password ? 'set' : 'missing'}, devices=${Array.isArray(runtimeEco.devices) ? runtimeEco.devices.length : 0}) ` +
                `native(email=${nativeEco.email ? 'set' : 'missing'}, password=${nativeEco.password ? 'set' : 'missing'}, devices=${Array.isArray(nativeEco.devices) ? nativeEco.devices.length : 0})`
            );

            const runtimeAltEmail = runtimeCfg?.efEmail;
            const runtimeAltPassword = runtimeCfg?.efPassword;
            const runtimeAltDevices = runtimeCfg?.efDevices;
            const nativeAltEmail = nativeCfg?.efEmail;
            const nativeAltPassword = nativeCfg?.efPassword;
            const nativeAltDevices = nativeCfg?.efDevices;
            if (runtimeAltEmail !== undefined || runtimeAltPassword !== undefined || runtimeAltDevices !== undefined || nativeAltEmail !== undefined || nativeAltPassword !== undefined || nativeAltDevices !== undefined) {
                this.log.warn(
                    `Detected alternative admin keys: runtime(efEmail=${runtimeAltEmail ? 'set' : 'missing'}, efPassword=${runtimeAltPassword ? 'set' : 'missing'}, efDevices=${Array.isArray(runtimeAltDevices) ? runtimeAltDevices.length : 0}) ` +
                    `native(efEmail=${nativeAltEmail ? 'set' : 'missing'}, efPassword=${nativeAltPassword ? 'set' : 'missing'}, efDevices=${Array.isArray(nativeAltDevices) ? nativeAltDevices.length : 0})`
                );
            }
        } catch (err) {
            this.log.warn(`Could not read instance native config: ${err.message}`);
        }

        const mergedCfg = this._deepMerge(JSON.parse(JSON.stringify(runtimeCfg || {})), nativeCfg || {});
        if (!mergedCfg.ecoflow || typeof mergedCfg.ecoflow !== 'object' || Array.isArray(mergedCfg.ecoflow)) {
            mergedCfg.ecoflow = {};
        }

        const firstNonEmpty = (...values) => {
            for (const value of values) {
                if (value === undefined || value === null) continue;
                const text = String(value).trim();
                if (text) return text;
            }
            return '';
        };

        mergedCfg.ecoflow.email = firstNonEmpty(
            mergedCfg.ecoflow.email,
            nativeCfg?.ecoflow?.email,
            nativeCfg?.['ecoflow.email'],
            nativeCfg?.efEmail,
            nativeCfg?.email,
            runtimeCfg?.ecoflow?.email,
            runtimeCfg?.['ecoflow.email'],
            runtimeCfg?.efEmail,
            runtimeCfg?.email
        );

        mergedCfg.ecoflow.password = firstNonEmpty(
            mergedCfg.ecoflow.password,
            nativeCfg?.ecoflow?.password,
            nativeCfg?.['ecoflow.password'],
            nativeCfg?.efPassword,
            nativeCfg?.password,
            runtimeCfg?.ecoflow?.password,
            runtimeCfg?.['ecoflow.password'],
            runtimeCfg?.efPassword,
            runtimeCfg?.password
        );

        const toBooleanOrUndefined = value => {
            if (value === undefined || value === null || value === '') return undefined;
            if (typeof value === 'boolean') return value;
            const text = String(value).trim().toLowerCase();
            if (text === 'true' || text === '1' || text === 'on' || text === 'yes') return true;
            if (text === 'false' || text === '0' || text === 'off' || text === 'no') return false;
            return undefined;
        };

        const enabledValue = [
            mergedCfg?.ecoflow?.enabled,
            nativeCfg?.ecoflow?.enabled,
            nativeCfg?.['ecoflow.enabled'],
            nativeCfg?.efEnabled,
            runtimeCfg?.ecoflow?.enabled,
            runtimeCfg?.['ecoflow.enabled'],
            runtimeCfg?.efEnabled
        ]
            .map(toBooleanOrUndefined)
            .find(value => value !== undefined);
        if (enabledValue !== undefined) {
            mergedCfg.ecoflow.enabled = enabledValue;
        }

        const toNumberOrUndefined = value => {
            if (value === undefined || value === null || value === '') return undefined;
            const numberValue = Number(value);
            return Number.isFinite(numberValue) ? numberValue : undefined;
        };

        const reconnectValue = [
            mergedCfg?.ecoflow?.reconnectMin,
            nativeCfg?.ecoflow?.reconnectMin,
            nativeCfg?.['ecoflow.reconnectMin'],
            nativeCfg?.efReconnectMin,
            runtimeCfg?.ecoflow?.reconnectMin,
            runtimeCfg?.['ecoflow.reconnectMin'],
            runtimeCfg?.efReconnectMin
        ]
            .map(toNumberOrUndefined)
            .find(value => value !== undefined);
        if (reconnectValue !== undefined) {
            mergedCfg.ecoflow.reconnectMin = reconnectValue;
        }

        mergedCfg.ecoflow.legacyScriptImport = firstNonEmpty(
            mergedCfg?.ecoflow?.legacyScriptImport,
            nativeCfg?.ecoflow?.legacyScriptImport,
            nativeCfg?.['ecoflow.legacyScriptImport'],
            nativeCfg?.efLegacyScriptImport,
            runtimeCfg?.ecoflow?.legacyScriptImport,
            runtimeCfg?.['ecoflow.legacyScriptImport'],
            runtimeCfg?.efLegacyScriptImport
        );

        const normalizeDevicesArray = value => {
            if (Array.isArray(value)) return value;
            if (typeof value === 'string' && value.trim()) {
                try {
                    const parsed = JSON.parse(value);
                    if (Array.isArray(parsed)) return parsed;
                } catch (_) {
                    // ignore parse errors
                }
            }
            return null;
        };

        const candidateDevices = [
            nativeCfg?.efDevices,
            runtimeCfg?.efDevices,
            mergedCfg?.ecoflow?.devices,
            nativeCfg?.ecoflow?.devices,
            nativeCfg?.['ecoflow.devices'],
            runtimeCfg?.ecoflow?.devices,
            runtimeCfg?.['ecoflow.devices']
        ];

        let resolvedDevices = null;
        let firstEmptyArray = null;
        for (const candidate of candidateDevices) {
            const normalized = normalizeDevicesArray(candidate);
            if (!normalized) continue;
            if (normalized.length > 0) {
                resolvedDevices = normalized;
                break;
            }
            if (!firstEmptyArray) {
                firstEmptyArray = normalized;
            }
        }
        const chosenDevices = resolvedDevices || firstEmptyArray || [];
        mergedCfg.ecoflow.devices = JSON.parse(JSON.stringify(chosenDevices));

        // Keep ef* mirrors in sync so Admin tab displays values reliably
        mergedCfg.efEmail = mergedCfg.ecoflow.email || '';
        mergedCfg.efPassword = mergedCfg.ecoflow.password || '';
        mergedCfg.efReconnectMin = mergedCfg.ecoflow.reconnectMin !== undefined ? mergedCfg.ecoflow.reconnectMin : 30;
        mergedCfg.efEnabled = !!mergedCfg.ecoflow.enabled;
        mergedCfg.efDevices = JSON.parse(JSON.stringify(mergedCfg.ecoflow.devices || []));

        return mergedCfg;
    }

    _normalizeConfig(rawCfg) {
        const cfg = JSON.parse(JSON.stringify(rawCfg || {}));

        for (const [key, value] of Object.entries(rawCfg || {})) {
            if (!key.includes('.')) continue;
            this._setByPath(cfg, key, value, true);
        }

        return cfg;
    }

    _setByPath(target, path, value, preferNewValue = false) {
        const parts = String(path || '').split('.').filter(Boolean);
        if (!parts.length) return;

        let node = target;
        for (let i = 0; i < parts.length - 1; i++) {
            const part = parts[i];
            if (!node[part] || typeof node[part] !== 'object' || Array.isArray(node[part])) {
                node[part] = {};
            }
            node = node[part];
        }

        const leaf = parts[parts.length - 1];
        const current = node[leaf];
        const currentMissing = current === undefined || current === null || current === '';

        if (preferNewValue || currentMissing) {
            node[leaf] = value;
        }
    }

    async _createCommandObjects() {
        await this.setObjectNotExistsAsync('commands', {
            type: 'channel',
            common: { name: 'Admin Commands' },
            native: {}
        });

        await this.setObjectNotExistsAsync('commands.testConnection', {
            type: 'state',
            common: {
                name: 'Trigger EcoFlow connection test',
                type: 'string',
                role: 'state',
                read: true,
                write: true,
                def: ''
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('commands.importLegacyScript', {
            type: 'state',
            common: {
                name: 'Trigger import from legacy script',
                type: 'string',
                role: 'state',
                read: true,
                write: true,
                def: ''
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('commands.lastResult', {
            type: 'state',
            common: {
                name: 'Last command result',
                type: 'string',
                role: 'text',
                read: true,
                write: false,
                def: ''
            },
            native: {}
        });

        await this.setObjectNotExistsAsync('commands.resetAllSettings', {
            type: 'state',
            common: {
                name: 'Reset all adapter settings to defaults',
                type: 'boolean',
                role: 'button',
                read: true,
                write: true,
                def: false
            },
            native: {}
        });
    }

    async _initializeRealPowerFromSmartmeter(cfg) {
        const smartmeterStateId = String(cfg?.regulation?.smartmeterStateId || '').trim();
        if (!smartmeterStateId || !this.regulation) return;

        try {
            const smartmeterState = await this.getForeignStateAsync(smartmeterStateId);
            if (!smartmeterState) {
                this.log.warn(`Smartmeter state not found at startup: ${smartmeterStateId}`);
                return;
            }

            const gridPower = Number(smartmeterState.val) || 0;
            await this.regulation.updateRealPower(gridPower);
            this.log.info(`Initial realPower update done from smartmeter (${smartmeterStateId}=${gridPower}).`);
        } catch (err) {
            this.log.warn(`Initial smartmeter read failed (${smartmeterStateId}): ${err.message}`);
        }
    }

    async _runTestConnectionFromState(rawPayload) {
        try {
            this.log.warn('Admin command received: test EcoFlow connection');
            let payload = {};
            if (typeof rawPayload === 'string' && rawPayload.trim()) {
                try {
                    payload = JSON.parse(rawPayload);
                } catch {
                    payload = {};
                }
            }

            const email = String(payload.email || this.config.ecoflow?.email || '').trim();
            const password = String(payload.password || this.config.ecoflow?.password || '').trim();
            const reconnectMin = Number(payload.reconnectMin || this.config.ecoflow?.reconnectMin || 30) || 30;

            if (!email || !password) {
                throw new Error('EcoFlow credentials missing for test.');
            }

            const testCfg = {
                ...(this.config.ecoflow || {}),
                email,
                password,
                reconnectMin,
                devices: Array.isArray(this.config.ecoflow?.devices) ? this.config.ecoflow.devices : []
            };

            let tester = null;
            try {
                tester = new EcoflowMqtt(this, { configOverride: testCfg, testMode: true });
                const result = await tester.testConnection();
                const message = `EcoFlow test OK (${result.protocol}://${result.url}:${result.port}, userId=${result.userId})`;
                this.log.info(message);
                await this.setStateAsync('commands.lastResult', message, true);
            } finally {
                if (tester) await tester.stop();
            }
        } catch (err) {
            const message = `EcoFlow test failed: ${err.message}`;
            this.log.error(message);
            await this.setStateAsync('commands.lastResult', message, true);
        }
    }

    async _runImportFromState(rawScript) {
        try {
            this.log.warn('Admin command received: import settings from legacy script');
            const script = String(rawScript || this.config?.ecoflow?.legacyScriptImport || '').trim();
            if (!script) {
                throw new Error('No legacy script content in import command payload.');
            }

            const legacyConfig = this._parseLegacyScriptConfig(script);
            const patch = this._mapLegacyConfigToNative(legacyConfig);
            patch.ecoflow = patch.ecoflow || {};
            patch.ecoflow.legacyScriptImport = '';
            patch.efLegacyScriptImport = '';

            const instanceObjectId = `system.adapter.${this.namespace}`;
            const instanceObj = await this.getForeignObjectAsync(instanceObjectId);
            if (!instanceObj) {
                throw new Error(`Instance object not found: ${instanceObjectId}`);
            }

            instanceObj.native = this._deepMerge(instanceObj.native || {}, patch);
            await this.setForeignObjectAsync(instanceObjectId, instanceObj);

            const importedDevices = Array.isArray(instanceObj.native?.ecoflow?.devices) ? instanceObj.native.ecoflow.devices.length : 0;
            const importedInverters = Array.isArray(instanceObj.native?.inverters) ? instanceObj.native.inverters.length : 0;

            const message = `Legacy import OK (devices:${importedDevices}, inverters:${importedInverters}). Reopen admin and save.`;
            this.log.info(message);
            await this.setStateAsync('commands.lastResult', message, true);
        } catch (err) {
            const message = `Legacy import failed: ${err.message}`;
            this.log.error(message);
            await this.setStateAsync('commands.lastResult', message, true);
        }
    }

    async _runResetAllFromState() {
        try {
            this.log.warn('Admin command received: reset all adapter settings');

            if (this.ecoflowMqtt) {
                try {
                    await this.ecoflowMqtt.stop();
                } catch (e) {
                    this.log.warn(`Could not stop EcoFlow MQTT before reset: ${e.message}`);
                }
                this.ecoflowMqtt = null;
            }

            if (this.regulationInterval) {
                clearInterval(this.regulationInterval);
                this.regulationInterval = null;
            }
            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            const instanceObjectId = `system.adapter.${this.namespace}`;
            const instanceObj = await this.getForeignObjectAsync(instanceObjectId);
            if (!instanceObj) {
                throw new Error(`Instance object not found: ${instanceObjectId}`);
            }

            instanceObj.native = this._getDefaultNativeConfig();
            await this.setForeignObjectAsync(instanceObjectId, instanceObj);

            await this._wipeOwnObjectTree({ keepCommands: true, keepInfo: true });

            await this.setStateAsync('commands.resetAllSettings', false, true);
            await this.setStateAsync('commands.importLegacyScript', '', true);
            await this.setStateAsync('commands.testConnection', '', true);

            const message = 'Hard reset completed: all settings and adapter states removed. Adapter will restart now.';
            this.log.warn(message);
            await this.setStateAsync('commands.lastResult', message, true);
        } catch (err) {
            const message = `Reset failed: ${err.message}`;
            this.log.error(message);
            await this.setStateAsync('commands.lastResult', message, true);
        }
    }

    async _wipeOwnObjectTree(options = {}) {
        const keepCommands = options.keepCommands !== undefined ? !!options.keepCommands : false;
        const keepInfo = options.keepInfo !== undefined ? !!options.keepInfo : false;

        const rootIds = [
            `${this.namespace}.commands`,
            `${this.namespace}.ecoflow`,
            `${this.namespace}.inverters`,
            `${this.namespace}.regulation`,
            `${this.namespace}.info`
        ].filter(fullId => {
            if (keepCommands && fullId === `${this.namespace}.commands`) return false;
            if (keepInfo && fullId === `${this.namespace}.info`) return false;
            return true;
        });

        for (const fullId of rootIds) {
            try {
                await this.delForeignObjectAsync(fullId, { recursive: true });
                this.log.warn(`Reset cleanup: removed ${fullId}`);
            } catch (_) {
                // ignore missing roots
            }
        }

        try {
            const allObjects = await this.getForeignObjectsAsync(`${this.namespace}.*`);
            const allIds = Object.keys(allObjects || {}).sort((a, b) => b.length - a.length);
            for (const id of allIds) {
                if (keepCommands && (id === `${this.namespace}.commands` || id.startsWith(`${this.namespace}.commands.`))) {
                    continue;
                }
                if (keepInfo && (id === `${this.namespace}.info` || id.startsWith(`${this.namespace}.info.`))) {
                    continue;
                }
                try {
                    await this.delForeignObjectAsync(id);
                } catch (_) {
                    // ignore if already removed by recursive delete
                }
            }
        } catch (e) {
            this.log.warn(`Reset cleanup residual scan failed: ${e.message}`);
        }
    }

    // ──────────────────────────────────────────────────────────── startup auto-import

    /**
     * If the user pasted a legacy script into the admin text field and saved,
     * this method parses ConfigData at startup, merges it into native config,
     * clears the paste field, and returns the updated config object.
     * The adapter then restarts automatically via setForeignObjectAsync.
     */
    async _autoImportLegacyScript(cfg) {
        const scriptText = String(cfg?.ecoflow?.legacyScriptImport || '').trim();
        if (!scriptText) return cfg;
        if (scriptText.length < 50) return cfg; // too short to be a real script

        this.log.warn('Legacy script detected in config paste field. Starting auto-import...');

        try {
            const legacyConfig = this._parseLegacyScriptConfig(scriptText);
            const patch = this._mapLegacyConfigToNative(legacyConfig);

            // Clear the paste field so we don't re-import on every restart
            patch.ecoflow = patch.ecoflow || {};
            patch.ecoflow.legacyScriptImport = '';
            patch.efLegacyScriptImport = '';

            const instanceObjectId = `system.adapter.${this.namespace}`;
            const instanceObj = await this.getForeignObjectAsync(instanceObjectId);
            if (!instanceObj) {
                throw new Error(`Instance object not found: ${instanceObjectId}`);
            }

            instanceObj.native = this._deepMerge(instanceObj.native || {}, patch);
            // Also clear the paste field in the saved object
            if (instanceObj.native.ecoflow) {
                instanceObj.native.ecoflow.legacyScriptImport = '';
            }
            instanceObj.native['ecoflow.legacyScriptImport'] = '';
            instanceObj.native.efLegacyScriptImport = '';
            instanceObj.native.efEmail = String(instanceObj.native?.ecoflow?.email || '');
            instanceObj.native.efPassword = String(instanceObj.native?.ecoflow?.password || '');
            instanceObj.native.efReconnectMin = Number(instanceObj.native?.ecoflow?.reconnectMin || 30) || 30;
            instanceObj.native.efEnabled = !!instanceObj.native?.ecoflow?.enabled;
            instanceObj.native.efDevices = Array.isArray(instanceObj.native?.ecoflow?.devices)
                ? JSON.parse(JSON.stringify(instanceObj.native.ecoflow.devices))
                : [];

            const importedDevices = Array.isArray(instanceObj.native?.ecoflow?.devices) ? instanceObj.native.ecoflow.devices.length : 0;
            const importedInverters = Array.isArray(instanceObj.native?.inverters) ? instanceObj.native.inverters.length : 0;
            const importedEmail = instanceObj.native?.ecoflow?.email ? 'set' : 'missing';

            this.log.warn(`Auto-import successful! devices=${importedDevices}, inverters=${importedInverters}, email=${importedEmail}`);
            this.log.warn('Saving imported config and restarting adapter...');

            this._restartRequestedByAutoImport = true;
            await this.setForeignObjectAsync(instanceObjectId, instanceObj);

            // setForeignObjectAsync triggers an automatic adapter restart.
            // Return the merged config so the current startup cycle can continue
            // (although the restart will overwrite it shortly).
            return instanceObj.native;
        } catch (err) {
            this.log.error(`Auto-import of legacy script failed: ${err.message}`);
            this.log.error('Please check the pasted script content. The adapter continues with current config.');
            return cfg;
        }
    }

    _getDefaultNativeConfig() {
        const defaults = JSON.parse(JSON.stringify(ioPackage?.native || {}));
        defaults.efEnabled = false;
        defaults.efEmail = '';
        defaults.efPassword = '';
        defaults.efReconnectMin = 30;
        defaults.efDevices = [];
        defaults.efLegacyScriptImport = '';
        return defaults;
    }

    // ──────────────────────────────────────────────────────────── object creation

    async _createInverterObjects(inverters) {
        for (const inv of inverters) {
            if (!inv.id) continue;

            // Channel per inverter
            await this.setObjectNotExistsAsync(`inverters.${inv.id}`, {
                type: 'channel',
                common: { name: inv.name || inv.id },
                native: {}
            });

            const states = [
                { id: 'currentOutput', name: 'Current output power', unit: 'W', type: 'number', role: 'value.power' },
                { id: 'batterySOC',    name: 'Battery state of charge', unit: '%', type: 'number', role: 'value.battery' },
                { id: 'pvPower',       name: 'PV input power', unit: 'W', type: 'number', role: 'value.power' },
                { id: 'targetOutput',  name: 'Last target output', unit: 'W', type: 'number', role: 'value.power' }
            ];

            for (const s of states) {
                await this.setObjectNotExistsAsync(`inverters.${inv.id}.${s.id}`, {
                    type: 'state',
                    common: {
                        name: s.name,
                        type: s.type,
                        unit: s.unit,
                        role: s.role,
                        read: true,
                        write: false,
                        def: 0
                    },
                    native: {}
                });
            }
        }
    }

    // ──────────────────────────────────────────────────────────── foreign subscriptions

    async _subscribeForeignStates(cfg) {
        const subscribe = async id => {
            if (!id || this.foreignSubscriptions.has(id)) return;
            try {
                await this.subscribeForeignStatesAsync(id);
                this.foreignSubscriptions.add(id);
            } catch (e) {
                this.log.warn(`Could not subscribe to foreign state ${id}: ${e.message}`);
            }
        };

        // Smartmeter
        if (cfg.regulation && cfg.regulation.smartmeterStateId) {
            await subscribe(cfg.regulation.smartmeterStateId);
        }

        // Inverter output states
        for (const inv of (cfg.inverters || [])) {
            if (inv.outputStateId)      await subscribe(inv.outputStateId);
            if (inv.batterySOCStateId)  await subscribe(inv.batterySOCStateId);
            if (inv.pvPowerStateId)     await subscribe(inv.pvPowerStateId);
            if (inv.setPriorityStateId) await subscribe(inv.setPriorityStateId);
        }

        // AdditionalPower
        for (const ap of (cfg.additionalPower || [])) {
            if (ap.id) await subscribe(ap.id);
        }

        // ExcessCharge
        const ec = cfg.excessCharge;
        if (ec) {
            if (ec.powerStateId)       await subscribe(ec.powerStateId);
            if (ec.batSocStateId)      await subscribe(ec.batSocStateId);
            if (ec.actualPowerStateId) await subscribe(ec.actualPowerStateId);
            if (ec.switchStateId)      await subscribe(ec.switchStateId);
        }
    }
}

// ──────────────────────────────────────────────────────────── entry point

if (require.main !== module) {
    // Required as a module – export the constructor
    module.exports = options => new EcoflowPowerControl(options);
} else {
    // Started directly
    new EcoflowPowerControl();
}
