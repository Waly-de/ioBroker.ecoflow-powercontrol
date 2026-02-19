'use strict';

/**
 * StateManager – utility helpers for the ecoflow-powercontrol adapter.
 * Ports of setStateCon(), setStateNE(), GetValAkt() from the original script.
 */
class StateManager {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
     */
    constructor(adapter) {
        this.adapter = adapter;
    }

    /**
     * Set a foreign state only if the value changed or the state is old enough.
     * Port of setStateCon() from the original script.
     *
     * @param {string} id            Full state ID (can be foreign)
     * @param {*}      val           Value to set
     * @param {boolean} ack          Acknowledge flag
     * @param {boolean} changeOnly   Only write if value differs from current
     * @param {number}  reWriteMs    If >0: re-write even same value after this many ms
     * @param {number}  chMinAge     Min ms since last *change* before writing again (0 = no check)
     * @param {boolean} isForeign    Use setForeignStateAsync instead of setStateAsync
     * @returns {Promise<boolean>}   true if state was written
     */
    async setStateCon(id, val, ack = false, changeOnly = true, reWriteMs = 0, chMinAge = 0, isForeign = true) {
        let state;
        try {
            state = isForeign
                ? await this.adapter.getForeignStateAsync(id)
                : await this.adapter.getStateAsync(id);
        } catch (e) {
            state = null;
        }

        if (!state) {
            // State does not exist yet – write unconditionally
            if (isForeign) {
                await this.adapter.setForeignStateAsync(id, val, ack);
            } else {
                await this.adapter.setStateAsync(id, val, ack);
            }
            return true;
        }

        const now = Date.now();
        const age = now - state.ts;       // ms since last update
        const chAge = now - state.lc;    // ms since last change

        // Check: value is same and not old enough for a rewrite
        if (changeOnly && state.val == val) {
            if (reWriteMs === 0 || age <= reWriteMs) {
                return false; // skip – same value, no rewrite needed
            }
        }

        // Check: last change is too recent
        if (chMinAge > 0 && chAge < chMinAge) {
            return false; // skip – changed too recently (EEPROM protection)
        }

        // All conditions met – write
        if (isForeign) {
            await this.adapter.setForeignStateAsync(id, val, ack);
        } else {
            await this.adapter.setStateAsync(id, val, ack);
        }
        return true;
    }

    /**
     * Get a foreign state value, returning 0 if the state is older than maxAgeMin minutes.
     * Port of GetValAkt() from the original script.
     *
     * @param {string}  id          Full state ID
     * @param {number}  maxAgeMin   Max acceptable age in minutes (0 = any age)
     * @returns {Promise<{val: number|string, ts: number}>}
     */
    async getValAkt(id, maxAgeMin = 15) {
        let state;
        try {
            state = await this.adapter.getForeignStateAsync(id);
        } catch (e) {
            state = null;
        }

        if (!state) {
            return { val: 0, ts: 0 };
        }

        if (maxAgeMin > 0 && state.ts < Date.now() - maxAgeMin * 60 * 1000) {
            // State too old – return 0
            return { val: 0, ts: state.ts };
        }

        return { val: state.val, ts: state.ts };
    }

    /**
     * Calculate how many bytes a varint-encoded value occupies.
     * Port of getVarintByteSize() from the original script.
     * Used for the EcoFlow protobuf dataLen field.
     *
     * @param {number} number
     * @returns {number}
     */
    getVarintByteSize(number) {
        let byteSize = 0;
        while (number >= 128) {
            byteSize++;
            number >>= 7;
        }
        byteSize++;
        byteSize++;
        return byteSize;
    }

    /**
     * Convert a Unix timestamp (seconds) to a German locale string if valid.
     * Port of isValidUnixTimestampAndConvert().
     *
     * @param {number} n
     * @returns {string|false}
     */
    convertTimestamp(n) {
        if (typeof n !== 'number') return false;
        const currentTime = Math.floor(Date.now() / 1000);
        if (n < 0 || n > currentTime) return false;
        if (Math.floor(n) !== n) return false;
        return new Date(n * 1000).toLocaleString('de-DE');
    }
}

/**
 * AverageCalculator – rolling time-window average.
 * Direct port of the AverageCalculator class from the original script.
 */
class AverageCalculator {
    constructor() {
        this.data = {};
    }

    /**
     * Add a value and return the current average over the given period.
     * @param {string} label  Unique key for this data series
     * @param {number} value  New measurement
     * @param {number} period Window in milliseconds
     * @returns {number}      Current average
     */
    addValue(label, value, period) {
        const now = Date.now();
        if (!this.data[label]) {
            this.data[label] = { values: [], sum: 0 };
        }
        this.data[label].values.push({ value, timestamp: now });
        this.data[label].sum += value;
        this._removeOldValues(label, period);
        const average = this.data[label].sum / this.data[label].values.length;
        return parseFloat(average.toFixed(2));
    }

    _removeOldValues(label, period) {
        const now = Date.now();
        const values = this.data[label].values;
        while (values.length > 0 && now - values[0].timestamp > period) {
            const old = values.shift();
            this.data[label].sum -= old.value;
        }
    }
}

module.exports = { StateManager, AverageCalculator };
