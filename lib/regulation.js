'use strict';

const { StateManager, AverageCalculator } = require('./state-manager');

/**
 * Regulation – generic inverter power regulation loop.
 *
 * Full port of SetBasePower(), getLowestValue(), the ExcessCharge block,
 * and the RealPower calculation from the original ecoflow-connector.js script.
 *
 * Works with any inverter via configurable ioBroker state IDs.
 * For EcoFlow inverters (type="ecoflow") the output value is multiplied by 10.
 */
class Regulation {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
     * @param {import('../lib/ecoflow-mqtt')|null} ecoflowMqtt
     */
    constructor(adapter, ecoflowMqtt) {
        this.adapter = adapter;
        this.ecoflowMqtt = ecoflowMqtt;
        this.cfg = adapter.config;
        this.sm = new StateManager(adapter);
        this.avgCalc = new AverageCalculator();

        /** Per-inverter runtime state */
        this.invState = {};

        /** Excess charge runtime */
        this.excessChargeWasActive = false;
        this.ueberschussTimer = 0;

        /** Global regulation state (may be overridden by regulation.enabled state) */
        this.regulationEnabled = !!(this.cfg.regulation && this.cfg.regulation.enabled);

        /** RealPower calc debounce */
        this.realPowerWorkInProgress = false;
        this.lastRealPower = 0;
        this.hasLastRealPower = false;

        /** cutoff carry-over between inverters in balance mode */
        this.cutoff = 0;
        this.batBedarf = 0;

        /** History logging of realPower is set up once */
        this.historySetupDone = false;
        this.running = null;
        this.stopped = false;
        this.realPowerTimer = null;
        this.cancelRealPowerDelay = null;

        this._initInverterState();
    }

    _initInverterState() {
        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            this.invState[inv.id] = {
                OldNewValue: -1,
                FullPower: false,
                zusatzpower: 0,
                TempMaxPower: inv.maxPower,
                TempPrioOff: false,
                GapArray: [],
                GAPdurchschnitt: 0,
                LeiststungsGap: 0,
                gapWait: 0,
                LastSetNewValue: 0,
                dynamicWatts: 0,
                batstate: 0,
                sumPV: 0,
                invOutputWatts: 0,
                toBatPower: 0,
                regulieren: true,
                name: `[${inv.id}]`,
                telemetryBlockReason: '',
                commandError: ''
            };
        }
    }

    // ──────────────────────────────────────────────────────────── main run

    async run() {
        if (this.running || this.stopped) return;
        this.running = this._run();
        try {
            await this.running;
        } finally {
            this.running = null;
        }
    }

    async _run() {
        const enabledBeforeRead = this.regulationEnabled;
        try {
            const enabledState = await this.adapter.getStateAsync('regulation.enabled');
            if (this.regulationEnabled === enabledBeforeRead && enabledState) {
                this.regulationEnabled = !!enabledState.val;
            }
        } catch (_) {
            // keep last known state
        }

        const reg = this.cfg.regulation;
        if (!this.regulationEnabled) return;
        if (!reg || !reg.smartmeterStateId) return;

        const BAT_MAX_OFFSET = reg.zusatzpowerOffset ?? 10;
        const ZUSATZPOWER_INCREMENT = 20;
        const GAP_MESSUNGEN = 3;

        // ── Step 1: Smart meter reading
        let smartmeterState;
        try {
            smartmeterState = await this.adapter.getForeignStateAsync(reg.smartmeterStateId);
        } catch (e) {
            smartmeterState = null;
        }
        if (!smartmeterState) return;

        const timeoutMs = (reg.smartmeterTimeoutMin ?? 4) * 60 * 1000;
        let gridPower = Number(smartmeterState.val) || 0;
        if (Date.now() - smartmeterState.ts > timeoutMs) {
            this.adapter.log.warn(`Smartmeter data too old (${((Date.now() - smartmeterState.ts) / 60000).toFixed(1)} min). Using fallback ${reg.smartmeterFallbackPower}W.`);
            gridPower = reg.smartmeterFallbackPower ?? 150;
        }
        await this.adapter.setStateAsync('regulation.gridPower', Math.round(gridPower), true);

        // ── Step 2: Per-inverter pre-processing (special cases)
        let totalPSPV = 0;
        let psBatSumme = 0;
        let psCounter = 0;

        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            const state = this.invState[inv.id];
            if (!await this._canAutomaticallyControl(inv)) continue;
            state.regulieren = true;

            // Read current values
            state.invOutputWatts  = await this._readInvOutputWatts(inv);
            state.batstate        = await this._readBatState(inv);
            state.sumPV           = await this._readSumPV(inv);
            state.dynamicWatts    = await this._readDynamicWatts(inv);
            state.toBatPower      = await this._readToBatPower(inv);

            // Mirror to adapter state tree
            await this.adapter.setStateAsync(`inverters.${inv.id}.currentOutput`, Math.round(state.invOutputWatts), true);
            await this.adapter.setStateAsync(`inverters.${inv.id}.batterySOC`, Math.round(state.batstate), true);
            await this.adapter.setStateAsync(`inverters.${inv.id}.pvPower`, Math.round(state.sumPV), true);

            // LeiststungsGap (compensation for inverter reaction delay)
            if (state.OldNewValue === -1) {
                state.LeiststungsGap = 0;
            } else {
                state.LeiststungsGap = Math.floor((state.OldNewValue + state.dynamicWatts) - state.invOutputWatts);
            }

            // Case: no battery attached
            if (!inv.hasBat) {
                if (!state.FullPower) {
                    if (!await this._trySetOutput(inv, inv.maxPower)) continue;
                    state.FullPower = true;
                    state.OldNewValue = inv.maxPower;
                    this.adapter.log.info(`Inverter ${state.name}: No battery configured. Feed-in set to max (${inv.maxPower}W).`);
                }
                state.regulieren = false;
                continue;
            }

            // Priority states (EcoFlow only, or via configured state ID)
            const prioInfo = await this._getPrioMode(inv);
            const PrioMode = prioInfo.active;
            const PrioModeTS = prioInfo.ts;

            // Case: battery ≥ battPozOn (full battery)
            if ((state.batstate >= inv.battPozOn || (state.batstate >= inv.battPozOff && state.TempPrioOff)) && state.regulieren) {
                if (inv.battOnSwitchPrio) {
                    // Switch to battery priority mode
                    if (!PrioMode && this.batBedarf <= inv.prioOffOnDemand && PrioModeTS < (Date.now() + (1000 * 60))) {
                        if (!await this._trySetOutput(inv, inv.maxPower)) continue;
                        if (!await this._trySetPrio(inv, '1')) continue;
                        state.OldNewValue = inv.maxPower;
                        this.adapter.log.info(`Inverter ${state.name}: Battery at ${inv.battPozOn}%. Switching to battery priority mode.`);
                        state.regulieren = false;
                        state.TempPrioOff = true;
                    } else if (PrioMode) {
                        if (this.batBedarf > inv.prioOffOnDemand && inv.prioOffOnDemand !== 0) {
                            if (PrioModeTS < (Date.now() + (1000 * 60))) {
                                this.adapter.log.info(`Inverter ${state.name}: High demand (${this.batBedarf}W). Temporarily deactivating priority mode.`);
                                if (!await this._trySetPrio(inv, '0')) continue;
                                state.regulieren = true;
                            } else {
                                state.regulieren = false;
                            }
                        } else {
                            state.regulieren = false;
                        }
                    }
                } else {
                    // No priority mode – just set to full power
                    state.TempPrioOff = false;
                    if (!state.FullPower) {
                        if (!await this._trySetOutput(inv, inv.maxPower)) continue;
                        state.FullPower = true;
                        state.OldNewValue = inv.maxPower;
                        this.adapter.log.info(`Inverter ${state.name}: Battery at ${inv.battPozOn}%. Feed-in set to maximum.`);
                    }
                    state.regulieren = false;
                }

            // Case: battery ≤ battPozOff (battery discharged enough to resume)
            } else if (state.batstate <= inv.battPozOff && state.regulieren) {
                state.TempPrioOff = false;
                if (inv.battOnSwitchPrio && PrioMode) {
                    this.adapter.log.info(`Inverter ${state.name}: Battery at ${inv.battPozOff}%. Deactivating priority mode.`);
                    if (!await this._trySetPrio(inv, '0')) continue;
                }
                if (state.FullPower) {
                    state.FullPower = false;
                    this.adapter.log.info(`Inverter ${state.name}: Battery at ${inv.battPozOff}%. Resuming normal regulation.`);
                }
                state.regulieren = true;
            }

            // Low battery limit
            if (state.batstate < inv.lowBatLimitPozOn && state.regulieren) {
                if (state.TempMaxPower === inv.maxPower) {
                    this.adapter.log.info(`Inverter ${state.name}: Battery below ${inv.lowBatLimitPozOn}% (${state.batstate}%). Limiting feed-in to ${inv.lowBatLimit}W.`);
                }
                state.TempMaxPower = inv.lowBatLimit;
            } else if (state.batstate >= inv.lowBatLimitPozOff && state.regulieren) {
                if (state.TempMaxPower === inv.lowBatLimit) {
                    this.adapter.log.info(`Inverter ${state.name}: Battery back above ${inv.lowBatLimitPozOff}%. Restoring max feed-in to ${inv.maxPower}W.`);
                    state.TempMaxPower = inv.maxPower;
                }
            }

            // Zusatzpower – extra feed-in when battery is charging at maximum
            if (state.regulieren) {
                const maxChargePower = (inv.maxPower - BAT_MAX_OFFSET) * -1;
                if (state.toBatPower <= maxChargePower) {
                    // Battery charging at max rate
                    if (state.zusatzpower < 300) {
                        if (state.zusatzpower === 0) state.zusatzpower = state.invOutputWatts;
                        state.zusatzpower += ZUSATZPOWER_INCREMENT;
                        this.adapter.log.debug(`Inverter ${state.name}: Max charge rate. Zusatzpower → ${state.zusatzpower}W`);
                        if (!await this._trySetOutput(inv, state.zusatzpower)) continue;
                        state.OldNewValue = state.zusatzpower;
                    }
                    state.regulieren = false;
                } else if (state.toBatPower >= ((inv.maxPower - 200) * -1) && state.zusatzpower > 0) {
                    state.zusatzpower = 0;
                    this.adapter.log.debug(`Inverter ${state.name}: Zusatzpower immediately off.`);
                    state.regulieren = true;
                } else if (state.zusatzpower > 0 && (this.batBedarf + 10) > state.zusatzpower) {
                    state.zusatzpower = 0;
                    this.adapter.log.debug(`Inverter ${state.name}: Zusatzpower off – battery demand.`);
                    state.regulieren = true;
                } else {
                    state.zusatzpower -= ZUSATZPOWER_INCREMENT;
                    if (state.zusatzpower > 0) {
                        if (!await this._trySetOutput(inv, state.zusatzpower)) continue;
                        state.OldNewValue = state.zusatzpower;
                        state.regulieren = false;
                    } else {
                        state.zusatzpower = 0;
                        state.regulieren = true;
                    }
                }
            }
        }

        // ── Step 3: Smartmeter fallback state
        const smAge = Date.now() - smartmeterState.ts;
        if (smAge > timeoutMs) {
            await this.adapter.setStateAsync('regulation.realPower', reg.smartmeterFallbackPower ?? 150, true);
        }

        // ── Step 4: Get lowestValue from history
        const realPowerId = `${this.adapter.namespace}.regulation.realPower`;
        let lowestValue;
        try {
            lowestValue = await this._getLowestValue(realPowerId, reg.minValueMin ?? 2, reg);
        } catch (e) {
            this.adapter.log.warn('Regulation: getLowestValue failed – using current realPower. ' + e.message);
            const rp = await this.adapter.getStateAsync('regulation.realPower');
            lowestValue = rp ? Math.floor(Number(rp.val)) : Math.floor(gridPower);
        }
        await this.adapter.setStateAsync('regulation.lowestValue', lowestValue, true);

        // ── Step 5: Compute NewValue, gapSumme, totalPSPV
        let NewValue = lowestValue - (reg.basePowerOffset ?? 30);

        // Non-regulated inverter output (PS only, not in regulation)
        let otherPS = 0;
        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            const state = this.invState[inv.id];
            if (!state.regulieren) {
                otherPS += state.invOutputWatts;
            }
        }

        // AdditionalPower sum
        const additional = await this._computeAdditionalPower(reg);
        otherPS += additional.feedIn;
        NewValue -= otherPS;

        // Gap computation across regulated inverters
        let gapSumme = 0;
        totalPSPV = 0;

        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            const state = this.invState[inv.id];
            if (!state.regulieren) continue;

            const neueMessung = state.LeiststungsGap;
            state.GapArray.push(neueMessung);
            if (state.GapArray.length > GAP_MESSUNGEN) state.GapArray.shift();
            if (state.GapArray.length === GAP_MESSUNGEN) {
                const sum = state.GapArray.reduce((a, b) => a + b, 0);
                state.GAPdurchschnitt = Math.floor(sum / GAP_MESSUNGEN);
            }
            gapSumme += state.GAPdurchschnitt;
            totalPSPV += state.sumPV + 10; // +10W per inverter bias

            psCounter++;
            psBatSumme += state.batstate;
        }

        if (gapSumme > NewValue) gapSumme = NewValue;

        // ── Step 6: PV / Bat demand factors
        const lastCut = this.cutoff;
        this.cutoff = 0;
        this.batBedarf = 0;
        let PVBedarf = 0;

        if ((NewValue - totalPSPV) > 0) this.batBedarf = Math.floor(NewValue - totalPSPV);
        if ((totalPSPV - NewValue) > 0) {
            PVBedarf = NewValue;
        } else {
            PVBedarf = totalPSPV;
        }

        let PVfaktor = totalPSPV !== 0 ? PVBedarf / totalPSPV : 0;
        let Batfaktor = psBatSumme !== 0 ? this.batBedarf / psBatSumme : 1;

        // Excess / Ueberschuss
        let ueberschuss = (NewValue * -1) - (reg.basePowerOffset ?? 30);
        if (ueberschuss < 0) ueberschuss = 0;
        const totalPvAllSources = totalPSPV + additional.pv;
        await this.adapter.setStateAsync('regulation.excessPower', Math.round(ueberschuss), true);
        await this.adapter.setStateAsync('regulation.totalPV', Math.round(totalPvAllSources), true);

        if (this.cfg.advanced && this.cfg.advanced.mlog) {
            this.adapter.log.info(`Regulation: lowestValue=${lowestValue} NewValue=${NewValue.toFixed(0)} totalPSPV=${totalPSPV} additionalPV=${Math.round(additional.pv)} totalPV=${Math.round(totalPvAllSources)} BatBedarf=${this.batBedarf} PVfaktor=${PVfaktor.toFixed(2)} Batfaktor=${Batfaktor.toFixed(2)} ueberschuss=${ueberschuss.toFixed(0)}`);
        }

        // ── Step 7: Distribute power
        if (reg.multiPsMode === 1) {
            await this._distributeSerial(NewValue, gapSumme, reg.serialReverse || false);
        } else {
            await this._distributeBalance(NewValue, gapSumme, totalPSPV, PVfaktor, Batfaktor, lastCut);
        }

        // ── Step 8: ExcessCharge
        if (this.cfg.excessCharge && this.cfg.excessCharge.enabled) {
            await this._runExcessCharge(ueberschuss);
        }
    }

    // ──────────────────────────────────────────────────────────── distribution

    async _distributeSerial(NewValue, gapSumme, reverse) {
        let calcValue = NewValue;
        const inverters = (this.cfg.inverters || []).filter(inv => inv.regulation);
        const ordered = reverse ? [...inverters].reverse() : inverters;

        for (const inv of ordered) {
            const state = this.invState[inv.id];
            if (!state.regulieren) continue;

            let Setpower = calcValue;
            const myMaxPower = state.TempMaxPower;

            if (state.GAPdurchschnitt < 20 && gapSumme > 0) {
                Setpower += gapSumme;
            }
            if (Setpower > NewValue) Setpower = NewValue;
            if (Setpower > myMaxPower) Setpower = myMaxPower;

            Setpower = Math.floor(Setpower);
            if (state.OldNewValue !== Setpower) {
                if (!await this._trySetOutput(inv, Setpower - state.dynamicWatts)) continue;
            }
            state.OldNewValue = Setpower;
            calcValue -= Setpower;
            if (calcValue <= 0) calcValue = 0;
        }
    }

    async _distributeBalance(NewValue, gapSumme, totalPSPV, PVfaktor, Batfaktor, lastCut) {
        // Match original script: if BatBedarf is negligible and there was a cutoff, reset it
        if (this.batBedarf < 2 && lastCut > 0) {
            lastCut = 0;
        }

        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            const state = this.invState[inv.id];
            if (!state.regulieren) continue;

            let Setpower = (state.sumPV * PVfaktor) + (state.batstate * Batfaktor);
            Setpower += lastCut;
            lastCut = 0; // only apply lastCut to the first regulated inverter (matches original script)

            if (Setpower > NewValue) Setpower = NewValue;
            const myMaxPower = state.TempMaxPower;

            // Gap compensation
            if ((state.GAPdurchschnitt < 10 && gapSumme > 10) || state.gapWait > Date.now() - (1 * 60 * 1000)) {
                if (state.gapWait === 0) state.gapWait = Date.now();
                Setpower += gapSumme - state.LeiststungsGap;
            } else {
                state.gapWait = 0;
            }

            if (Setpower > myMaxPower) {
                this.cutoff = Math.floor(Setpower - myMaxPower);
                Setpower = myMaxPower;
            } else {
                Setpower += this.cutoff;
                this.cutoff = 0;
                if (Setpower > myMaxPower) {
                    this.cutoff = Math.floor(Setpower - myMaxPower);
                    Setpower = myMaxPower;
                }
            }

            Setpower = Math.floor(Setpower);

            // Send only if changed or older than 60s
            if (state.OldNewValue !== Setpower || state.LastSetNewValue < (Date.now() - 60 * 1000)) {
                state.LastSetNewValue = Date.now();
                const watts = Math.max(0, Math.floor(Setpower - state.dynamicWatts));
                if (!await this._trySetOutput(inv, watts)) continue;
                this.adapter.log.debug(`Inverter ${state.name}: Balance mode → ${watts}W`);
            }
            state.OldNewValue = Setpower;
        }
    }

    // ──────────────────────────────────────────────────────────── excess charge

    async _runExcessCharge(ueberschuss) {
        if (!this.regulationEnabled || this.stopped) return;
        const ec = this.cfg.excessCharge;
        if (!ec || !ec.powerStateId) return;

        // A charger that is already switched on (e.g. after an adapter restart) must be
        // regulated immediately; setStateCon() reports "not written" for an unchanged switch.
        if (ec.switchStateId && !this.excessChargeWasActive && await this._isExcessSwitchOn(ec)) {
            this.excessChargeWasActive = true;
        }

        // Battery SOC check
        let batSoc = 0;
        if (ec.batSocStateId) {
            const s = await this.sm.getValAkt(ec.batSocStateId, 60);
            batSoc = Number(s.val);
        }

        let ueberschussBedingung = true;

        if (ec.batSocStateId) {
            if (this.excessChargeWasActive) {
                if (batSoc >= Number(ec.batSocOff)) {
                    this.adapter.log.info(`ExcessCharge: Battery at ${ec.batSocOff}%. Charging will stop soon.`);
                    ueberschussBedingung = false;
                }
            } else {
                if (batSoc >= Number(ec.batSocMax)) {
                    ueberschussBedingung = false; // battery already full enough
                }
            }
        }

        if (ueberschussBedingung) {
            let targetPower = Math.min(Number(ec.maxPower), Math.floor(ueberschuss));
            let setExcessPower = Math.min(Number(ec.maxPower), targetPower + Number(ec.offsetPower ?? 0));
            setExcessPower = setExcessPower - (setExcessPower % (ec.regulateSteps || 100));
            if (setExcessPower < 0) setExcessPower = 0;

            if (ueberschuss > Number(ec.startPower) && setExcessPower > 0) {
                if (this.ueberschussTimer === 0) this.ueberschussTimer = Date.now();
                if (Date.now() - this.ueberschussTimer >= (ec.startDurationMin ?? 1) * 60 * 1000) {
                    if (!this.regulationEnabled || this.stopped) return;
                    // Switch on (only if off long enough)
                    if (ec.switchStateId) {
                        const switched = await this.sm.setStateCon(
                            ec.switchStateId,
                            this._parseValue(ec.switchOnValue),
                            false, true,
                            60 * 60 * 1000,
                            (ec.switchMinMin ?? 5) * 60 * 1000
                        );
                        if (switched) {
                            this.excessChargeWasActive = true;
                            this.adapter.log.info(`ExcessCharge: ON. Requested ${targetPower}W.`);
                        }
                    } else {
                        this.excessChargeWasActive = true;
                    }
                }
                if (!this.excessChargeWasActive || !this.regulationEnabled || this.stopped) return;
                // Set power level
                await this.sm.setStateCon(
                    ec.powerStateId,
                    setExcessPower,
                    false, true,
                    60 * 60 * 1000,
                    (ec.minRegulatePauseMin ?? 1) * 60 * 1000
                );

            } else if (ueberschuss <= Number(ec.stopPower)) {
                await this._stopExcessCharge();
            }
        } else {
            await this._stopExcessCharge();
        }
    }

    async _isExcessSwitchOn(ec) {
        let s;
        try {
            s = await this.adapter.getForeignStateAsync(ec.switchStateId);
        } catch (_) {
            s = null;
        }
        return !!s && s.val == this._parseValue(ec.switchOnValue);
    }

    async _stopExcessCharge() {
        const ec = this.cfg.excessCharge;
        if (!ec?.enabled || !ec.powerStateId) return;
        // Stop power even when the optional switch is absent or still in its minimum run time.
        await this.sm.setStateCon(ec.powerStateId, 0);
        if (ec.switchStateId) {
            await this.sm.setStateCon(ec.switchStateId, this._parseValue(ec.switchOffValue),
                false, true, 0, (ec.switchMinMin ?? 5) * 60 * 1000);
        }
        this.ueberschussTimer = 0;
        this.excessChargeWasActive = false;
    }

    // ──────────────────────────────────────────────────────────── history

    async _getLowestValue(stateId, minValueMin, reg) {
        if (Number(minValueMin) === 0) {
            // Use real-time value
            const s = await this.adapter.getStateAsync('regulation.realPower');
            return s ? Math.floor(Number(s.val)) : 0;
        }

        const historyTarget = `${reg.historyAdapter || 'history'}.${reg.historyInstance || '0'}`;
        const now = Date.now();
        const range = minValueMin * 60 * 1000;

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error(`History request timed out (${historyTarget})`)), 5000);
            this.adapter.sendTo(historyTarget, 'getHistory', {
                id: stateId,
                options: {
                    start: now - range,
                    end: now,
                    aggregate: 'none',
                    ignoreNull: true
                }
            }, result => {
                clearTimeout(timeout);
                const duration = Date.now() - now;
                if (duration > 1000) {
                    this.adapter.log.debug(`getLowestValue took ${(duration / 1000).toFixed(1)}s`);
                }
                if (result instanceof Error || result?.error) {
                    reject(new Error(result.message || result.error));
                    return;
                }
                if (!result || !result.result || result.result.length === 0) {
                    reject(new Error('No history data'));
                    return;
                }
                const values = result.result;
                let lowestValue, totalValue = 0;

                if ((reg.minValueAg || 0) === 0) {
                    // Minimum
                    lowestValue = values[0].val;
                    for (let i = 1; i < values.length; i++) {
                        if (values[i].val < lowestValue) lowestValue = values[i].val;
                    }
                } else {
                    // Average
                    for (const v of values) totalValue += v.val;
                    lowestValue = totalValue / values.length;
                }

                resolve(Math.floor(Number(lowestValue)));
            }, { timeout: 5000 });
        });
    }

    /**
     * Ensure the realPower state is recorded by the history/influxdb adapter.
     * Called once at startup.
     */
    async ensureHistoryLogging() {
        if (this.historySetupDone) return;
        const reg = this.cfg.regulation;
        if (!reg) return;
        if (Number(reg.minValueMin) === 0) return;

        const historyTarget = `${reg.historyAdapter || 'history'}.${reg.historyInstance || '0'}`;
        const stateId = `${this.adapter.namespace}.regulation.realPower`;

        // Check if already enabled
        await new Promise(resolve => {
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve();
            };

            const timeout = setTimeout(() => {
                this.adapter.log.warn(`History setup timeout for ${stateId} on ${historyTarget}. Continuing without blocking startup.`);
                this.historySetupDone = true;
                finish();
            }, 5000);

            this.adapter.sendTo(historyTarget, 'getEnabledDPs', {}, result => {
                if (done) return;
                if (result && result[stateId]) {
                    this.adapter.log.debug(`History logging for ${stateId} already enabled.`);
                    this.historySetupDone = true;
                    clearTimeout(timeout);
                    finish();
                    return;
                }
                // Activate logging
                const options = {
                    id: stateId,
                    options: {
                        enabled: true,
                        debounce: 0,
                        changesOnly: false,
                        retention: 604800,     // 7 days in seconds
                        maxLength: 960,
                        disableSkippedValueLogging: true
                    }
                };
                this.adapter.sendTo(historyTarget, 'enableHistory', options, res => {
                    if (done) return;
                    if (res && res.error) {
                        this.adapter.log.warn(`Could not enable history for ${stateId}: ${res.error}`);
                    } else {
                        this.adapter.log.info(`History logging enabled for ${stateId} on ${historyTarget}`);
                    }
                    this.historySetupDone = true;
                    clearTimeout(timeout);
                    finish();
                });
            });
        });
    }

    // ──────────────────────────────────────────────────────────── realPower

    /**
     * Calculate and update the realPower state.
     * Called on every smartmeter change (with debounce).
     * Port of the on(SmartmeterID) handler from the original script.
     */
    async updateRealPower(gridPower) {
        if (this.realPowerWorkInProgress) return;
        this.realPowerWorkInProgress = true;

        await new Promise(resolve => {
            this.cancelRealPowerDelay = resolve;
            this.realPowerTimer = setTimeout(resolve, 5000);
        });
        this.realPowerTimer = null;
        this.cancelRealPowerDelay = null;

        try {
            if (this.stopped) return;
            let einspeisung = 0;
            const DIVISION_FACTOR = 10;
            const TOLERANCE_PERIOD_FACTOR = 2;
            const reg = this.cfg.regulation;
            const debugEnabled = !!(this.cfg?.advanced?.debug || this.cfg?.advanced?.mlog);

            let currentGridPower = Number(gridPower);
            if (!Number.isFinite(currentGridPower)) {
                const smartmeterStateId = String(reg?.smartmeterStateId || '').trim();
                if (!smartmeterStateId) {
                    this.adapter.log.warn('updateRealPower aborted: smartmeterStateId is empty.');
                    return;
                }
                const smartmeterState = await this.adapter.getForeignStateAsync(smartmeterStateId);
                if (!smartmeterState) {
                    this.adapter.log.warn(`updateRealPower aborted: smartmeter state not found (${smartmeterStateId}).`);
                    return;
                }
                currentGridPower = Number(smartmeterState.val) || 0;
                if (debugEnabled) {
                    this.adapter.log.info(`updateRealPower source: state ${smartmeterStateId} val=${smartmeterState.val} ts=${smartmeterState.ts}`);
                }
            } else if (debugEnabled) {
                this.adapter.log.info(`updateRealPower source: payload gridPower=${currentGridPower}`);
            }

            for (const inv of (this.cfg.inverters || [])) {
                if (!inv.regulation) continue;
                const invOutputWatts = await this._readInvOutputWatts(inv);
                einspeisung += Math.round(invOutputWatts);
            }

            // AdditionalPowerSum
            const additionalPowerSumState = await this.adapter.getStateAsync('regulation.additionalPowerSum');
            if (additionalPowerSumState) {
                einspeisung += Number(additionalPowerSumState.val) || 0;
            }

            // ExcessActualPower
            let excessActual = 0;
            const ec = this.cfg.excessCharge;
            if (ec && ec.actualPowerStateId) {
                const s = await this.sm.getValAkt(ec.actualPowerStateId, 60);
                excessActual = Number(s.val) || 0;
            }

            const realPower = Math.round(currentGridPower + einspeisung - excessActual);
            if (debugEnabled) {
                this.adapter.log.info(`updateRealPower calc: grid=${currentGridPower} einspeisung=${einspeisung} excessActual=${excessActual} => realPower=${realPower}`);
            }

            // PeakSkip: ignore sudden drops > 100W (transient)
            if (this.hasLastRealPower && realPower + 100 < this.lastRealPower) {
                this.adapter.log.debug(`RealPower: PeakSkip – ${this.lastRealPower} → ${realPower} (delta > 100W)`);
            } else {
                if (this.stopped) return;
                await this.adapter.setStateAsync('regulation.realPower', realPower, true);
                if (debugEnabled) {
                    this.adapter.log.info(`updateRealPower write: regulation.realPower=${realPower}`);
                }
            }
            this.lastRealPower = realPower;
            this.hasLastRealPower = true;
        } finally {
            this.realPowerWorkInProgress = false;
        }
    }

    // ──────────────────────────────────────────────────────────── AdditionalPower

    async _computeAdditionalPower(reg) {
        let aPV = 0;
        let aFeedIn = 0;
        const period = (this.cfg.advanced && this.cfg.advanced.avgPeriodMs) || 15000;

        for (const ap of (this.cfg.additionalPower || [])) {
            if (!ap.id) continue;
            const s = await this.sm.getValAkt(ap.id, 60);
            if (s.val === 0 && s.ts === 0) continue;

            const factor = ap.factor || 1;
            const offset = ap.offset || 0;
            const val = Number(s.val) / factor + offset;

            if (!ap.noFeedIn) aFeedIn += val;
            if (!ap.noPV)    aPV += val;
        }

        const avgFeedIn = this.avgCalc.addValue('AdditionalPowerSum', aFeedIn, period);
        const avgPV     = this.avgCalc.addValue('AdditionalPVSum', aPV, period);

        await this.adapter.setStateAsync('regulation.additionalPowerSum', Math.round(avgFeedIn), true);
        await this.adapter.setStateAsync('regulation.additionalPVSum', Math.round(avgPV), true);

        return {
            feedIn: avgFeedIn,
            pv: avgPV
        };
    }

    /** Check original measurement states before automatic commands, never zero-substituted values. */
    async _canAutomaticallyControl(inv) {
        if (inv.type !== 'ecoflow') return true;
        const prefix = (!inv.outputStateId || (inv.hasBat && !inv.batterySOCStateId)) && this.ecoflowMqtt
            ? this.ecoflowMqtt.getDeviceStatePrefix(inv.id) : '';
        // Keep the existing read limits: output 50 seconds, battery SOC 10 minutes.
        const required = [[inv.outputStateId || (prefix && `${prefix}.invOutputWatts`), 50000, 'output']];
        if (inv.hasBat) required.push([inv.batterySOCStateId || (prefix && `${prefix}.batSoc`), 600000, 'battery SOC']);
        let reason = '';
        for (const [id, maxAge, label] of required) {
            let measurement = null;
            try { if (id) measurement = await this.adapter.getForeignStateAsync(id); } catch (_) { /* unavailable */ }
            const value = measurement && measurement.val;
            if (!measurement) { reason = `missing ${label} measurement`; break; }
            if (!((typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')) && Number.isFinite(Number(value)))
                || (measurement.q !== undefined && measurement.q !== 0)) {
                reason = `invalid ${label} measurement`; break;
            }
            const age = Date.now() - measurement.ts;
            if (!Number.isFinite(measurement.ts) || measurement.ts <= 0 || age < 0 || age > maxAge) {
                reason = `stale ${label} measurement`; break;
            }
        }
        const state = this.invState[inv.id];
        if (state && state.telemetryBlockReason !== reason) {
            state.telemetryBlockReason = reason;
            Object.assign(state, { FullPower: false, OldNewValue: -1, LastSetNewValue: 0,
                zusatzpower: 0, dynamicWatts: 0, invOutputWatts: 0, batstate: 0, sumPV: 0,
                TempPrioOff: false, TempMaxPower: inv.maxPower, GapArray: [], GAPdurchschnitt: 0,
                LeiststungsGap: 0, gapWait: 0 });
            if (reason) this.adapter.log.warn(`Inverter ${state.name}: Automatic control paused: ${reason}. No automatic command sent.`);
            else this.adapter.log.info(`Inverter ${state.name}: Fresh telemetry restored; automatic control can resume.`);
        }
        if (reason && state) state.regulieren = false;
        return !reason;
    }

    // ──────────────────────────────────────────────────────────── read helpers

    async _readInvOutputWatts(inv) {
        const id = inv.outputStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt
            ? `${this.ecoflowMqtt.getDeviceStatePrefix(inv.id)}.invOutputWatts` : '');
        if (!id) return 0;
        const s = await this.sm.getValAkt(id, 50 / 60);
        const raw = Number(s.val) || 0;
        // EcoFlow reports in ×10 unit; generic in Watts directly
        return inv.type === 'ecoflow' ? Math.floor(raw / 10) : raw;
    }

    async _readBatState(inv) {
        const id = inv.batterySOCStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt
            ? `${this.ecoflowMqtt.getDeviceStatePrefix(inv.id)}.batSoc` : '');
        if (!id) return 0;
        const s = await this.sm.getValAkt(id, 10);
        return Number(s.val) || 0;
    }

    async _readSumPV(inv) {
        if (!inv.pvPowerStateId && inv.type === 'ecoflow' && this.ecoflowMqtt) {
            const prefix = this.ecoflowMqtt.getDeviceStatePrefix(inv.id);
            const [pv1, pv2] = await Promise.all([
                this.sm.getValAkt(`${prefix}.pv1InputWatts`, 10),
                this.sm.getValAkt(`${prefix}.pv2InputWatts`, 10)
            ]);
            return Math.floor(((Number(pv1.val) || 0) + (Number(pv2.val) || 0)) / 10);
        }
        if (!inv.pvPowerStateId) return 0;
        const s = await this.sm.getValAkt(inv.pvPowerStateId, 10);
        const raw = Number(s.val) || 0;
        return inv.type === 'ecoflow' ? Math.floor(raw / 10) : raw;
    }

    async _readDynamicWatts(inv) {
        if (inv.type !== 'ecoflow' || !this.ecoflowMqtt) return 0;
        // dynamicWatts is the target set by the app – used to compensate reaction delay
        const prefix = this.ecoflowMqtt.getDeviceStatePrefix(inv.id);
        const s = await this.sm.getValAkt(`${prefix}.dynamicWatts`, 10);
        return Math.floor(Number(s.val) / 10) || 0;
    }

    async _readToBatPower(inv) {
        if (inv.type !== 'ecoflow' || !this.ecoflowMqtt) return 0;
        const prefix = this.ecoflowMqtt.getDeviceStatePrefix(inv.id);
        const s = await this.sm.getValAkt(`${prefix}.batInputWatts`, 1);
        return Math.floor(Number(s.val) / 10) || 0;
    }

    // ──────────────────────────────────────────────────────────── priority helpers

    async _getPrioMode(inv) {
        const id = inv.setPriorityStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt
            ? `${this.ecoflowMqtt.getDeviceStatePrefix(inv.id)}.supplyPriority` : '');
        if (!id) return { active: false, ts: 0 };
        let s;
        try {
            s = await this.adapter.getForeignStateAsync(id);
        } catch (e) {
            s = null;
        }
        if (!s) return { active: false, ts: 0 };
        return { active: s.val == '1' || s.val === 1 || s.val === true, ts: s.ts };
    }

    async _setPrio(inv, value, force = false) {
        if (this.stopped || (!force && !this.regulationEnabled)) return false;
        if (!force && !await this._canAutomaticallyControl(inv)) return false;
        if (this.stopped || (!force && !this.regulationEnabled)) return false;
        const id = inv.setPriorityStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt
            ? this.ecoflowMqtt.getSetPrioStatePath(inv.id) : '');
        if (!id) return false;
        await this.adapter.setForeignStateAsync(id, value, false);
        return true;
    }

    // ──────────────────────────────────────────────────────────── output helpers

    async _setOutput(inv, wattsValue, force = false) {
        if (this.stopped || (!force && !this.regulationEnabled)) return false;
        if (!Number.isFinite(Number(wattsValue)) || !Number.isFinite(Number(inv.maxPower))) {
            throw new Error(`Invalid output power for inverter ${inv.id}`);
        }
        if (!force && !await this._canAutomaticallyControl(inv)) return false;
        if (this.stopped || (!force && !this.regulationEnabled)) return false;
        wattsValue = Math.max(0, Math.min(Number(inv.maxPower), Number(wattsValue)));
        // Convert to raw wire value for EcoFlow (×10) vs generic (direct)
        const rawValue = inv.type === 'ecoflow' ? Math.floor(wattsValue * 10) : Math.round(wattsValue);
        if (inv.type === 'ecoflow' && this.ecoflowMqtt) {
            // Send via EcoFlow MQTT
            await this.ecoflowMqtt.setACForDevice(inv.id, rawValue);
        } else if (inv.setOutputStateId) {
            await this.adapter.setForeignStateAsync(inv.setOutputStateId, rawValue, false);
        } else {
            throw new Error(`No output connection configured for inverter ${inv.id}`);
        }
        // Mirror to adapter state tree
        const wattsDisplay = inv.type === 'ecoflow' ? Math.floor(rawValue / 10) : rawValue;
        await this.adapter.setStateAsync(`inverters.${inv.id}.targetOutput`, wattsDisplay, true);
        return true;
    }

    /** Run a device command; a failure is logged once and only skips this inverter. */
    async _tryCommand(inv, command) {
        const state = this.invState[inv.id];
        try {
            const sent = await command();
            if (sent && state && state.commandError) {
                state.commandError = '';
                this.adapter.log.info(`Inverter ${state.name}: Commands are accepted again.`);
            }
            return sent;
        } catch (err) {
            if (state) {
                state.regulieren = false;
                if (state.commandError !== err.message) {
                    state.commandError = err.message;
                    this.adapter.log.warn(`Inverter ${state.name}: Command failed: ${err.message}. Inverter skipped, other inverters continue.`);
                }
            }
            return false;
        }
    }

    _trySetOutput(inv, wattsValue, force = false) {
        return this._tryCommand(inv, () => this._setOutput(inv, wattsValue, force));
    }

    _trySetPrio(inv, value, force = false) {
        return this._tryCommand(inv, () => this._setPrio(inv, value, force));
    }

    // ──────────────────────────────────────────────────────────── public helpers

    /**
     * Handle regulation being turned off – set regulationOffPower for all inverters.
     */
    async handleDisabled() {
        this.regulationEnabled = false;
        if (this.running) await this.running.catch(() => {});
        if (this.regulationEnabled || this.stopped) return;
        try {
            await this._stopExcessCharge();
        } catch (err) {
            this.adapter.log.warn(`ExcessCharge: Could not stop charging: ${err.message}`);
        }
        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            const offPower = Number(inv.regulationOffPower);
            if (offPower >= 0) {
                if (!await this._trySetOutput(inv, offPower, true)) continue;
                const state = this.invState[inv.id];
                if (state) state.OldNewValue = 0;
                this.adapter.log.info(`Inverter ${inv.id}: Regulation off → setting to ${offPower}W.`);
            } else if (offPower === -2 && (inv.setPriorityStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt))) {
                if (!await this._trySetPrio(inv, '1', true)) continue;
                this.adapter.log.info(`Inverter ${inv.id}: Regulation off → battery priority mode ON.`);
            }
        }
    }

    /**
     * Handle regulation being turned on.
     */
    async handleEnabled() {
        this.regulationEnabled = true;
        for (const inv of (this.cfg.inverters || [])) {
            if (!inv.regulation) continue;
            this.invState[inv.id].OldNewValue = -1;
            this.invState[inv.id].FullPower = false;
            const offPower = Number(inv.regulationOffPower);
            if (offPower === -2 && (inv.setPriorityStateId || (inv.type === 'ecoflow' && this.ecoflowMqtt))) {
                if (!await this._trySetPrio(inv, '0')) continue;
                this.adapter.log.info(`Inverter ${inv.id}: Regulation on → battery priority mode OFF.`);
            }
        }
    }

    async stop() {
        this.stopped = true;
        this.regulationEnabled = false;
        if (this.realPowerTimer) clearTimeout(this.realPowerTimer);
        if (this.cancelRealPowerDelay) this.cancelRealPowerDelay();
        if (this.running) await this.running.catch(() => {});
    }

    // ──────────────────────────────────────────────────────────── misc

    _parseValue(v) {
        if (v === 'true') return true;
        if (v === 'false') return false;
        const n = Number(v);
        if (!isNaN(n)) return n;
        return v;
    }
}

module.exports = Regulation;
