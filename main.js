'use strict';

const utils = require('@iobroker/adapter-core');
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
        this.on('unload',      this._onUnload.bind(this));
    }

    // ──────────────────────────────────────────────────────────── lifecycle

    async _onReady() {
        this.log.info('EcoFlow PowerControl adapter starting...');

        const cfg = this.config;

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
        if (cfg.ecoflow && cfg.ecoflow.enabled && cfg.ecoflow.email && cfg.ecoflow.password) {
            this.ecoflowMqtt = new EcoflowMqtt(this);
            await this.ecoflowMqtt.start();
        } else {
            // Ensure info.connection = false when EcoFlow is disabled
            await this.setStateAsync('info.connection', false, true);
        }

        // ── 5. Create Regulation instance
        this.regulation = new Regulation(this, this.ecoflowMqtt);

        // Sync regulation.enabled state into the regulation object
        const regEnabledState = await this.getStateAsync('regulation.enabled');
        this.regulation.regulationEnabled = regEnabledState ? !!regEnabledState.val : true;

        // ── 6. Subscribe to own states
        await this.subscribeStatesAsync('regulation.enabled');

        // ── 7. Subscribe to foreign states (smart meter + inverter outputs + additionalPower)
        await this._subscribeForeignStates(cfg);

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
