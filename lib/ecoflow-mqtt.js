'use strict';

const https = require('https');
const mqtt = require('mqtt');
const protobuf = require('protobufjs');
const {
    PROTO_SOURCE_V2,
    WRITEABLES,
    MUSTER_GET_PS,
    MUSTER_SET_AC,
    MUSTER_SET_AC2,
    MUSTER_SLOW_CHG_POWER,
    MUSTER_DELTA2,
    MUSTER_DELTA2MAX
} = require('./protobuf-definitions');
const { StateManager } = require('./state-manager');

/**
 * EcoflowMqtt – optional EcoFlow MQTT bridge module.
 *
 * Handles:
 *  - Authentication against the EcoFlow cloud API
 *  - MQTT connection to the EcoFlow broker
 *  - Subscription to device topics
 *  - Binary (protobuf) and JSON message decoding
 *  - Dynamic ioBroker state creation from received data
 *  - Heartbeat simulation & reconnect watchdog
 *  - Writing writeable states back to devices via MQTT
 *
 * Port of getEcoFlowMqttData(), setupMQTTConnection(), SubscribeEco(),
 * decodeAndPrint(), generateAndSyncSub(), setmusterGetPS(), setAC(),
 * pruefeID() and CheckforReconnect() from the original script.
 */
class EcoflowMqtt {
    /**
     * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
     */
    constructor(adapter, options = {}) {
        this.adapter = adapter;
        this.cfg = options.configOverride || adapter.config.ecoflow;
        this.testMode = !!options.testMode;
        this.sm = new StateManager(adapter);

        /** @type {import('mqtt').MqttClient|null} */
        this.client = null;
        this.isConnected = false;

        /** MQTT credentials received from EcoFlow cloud API */
        this.mqttDaten = {
            UserID: '',
            User: '',
            Passwort: '',
            URL: '',
            Port: '',
            protocol: '',
            clientID: ''
        };

        /** protobufjs root, compiled once after auth */
        this.protoRoot = null;

        /** Last message timestamp per serial number */
        this.lastMsgTs = {};

        /** Reconnect watchdog interval */
        this.reconnectWatchdog = null;

        /** Duplicate-message suppression cache: topic -> {content, ts} */
        this.previousContents = {};

        /** Per-topic lock for lastTopic state update */
        this.lastTopicLock = false;

        /** Selected MQTT connect candidate after probe */
        this.selectedMqttCandidate = null;
    }

    // ───────────────────────────────────────────────────────────── lifecycle

    async start() {
        this.adapter.log.info(`EcoFlow MQTT: Starting (devices: ${(this.cfg.devices || []).length}, reconnectMin: ${this.cfg.reconnectMin || 30}).`);
        this.adapter.log.info('EcoFlow MQTT: Authenticating with EcoFlow cloud API...');
        try {
            await this._authenticate(this.cfg.email, this.cfg.password);
            this.protoRoot = protobuf.parse(PROTO_SOURCE_V2).root;
            await this._connect();
            this._startReconnectWatchdog();
            this.adapter.log.info('EcoFlow MQTT: Started.');
        } catch (err) {
            this.adapter.log.error(`EcoFlow MQTT: Start failed: ${err.message}`);
            await this.adapter.setStateAsync('info.connection', false, true);
        }
    }

    async stop() {
        if (this.reconnectWatchdog) {
            clearInterval(this.reconnectWatchdog);
            this.reconnectWatchdog = null;
        }
        if (this.client) {
            await new Promise(resolve => this.client.end(false, {}, resolve));
            this.client = null;
        }
        this.isConnected = false;
        this.adapter.log.info(this.testMode ? 'EcoFlow MQTT test: Stopped.' : 'EcoFlow MQTT: Stopped.');
    }

    /**
     * Active test initiated via Admin sendTo button.
     * Authenticates against cloud API and performs a short MQTT connect test.
     */
    async testConnection() {
        if (!this.cfg.email || !this.cfg.password) {
            throw new Error('Email or password missing.');
        }

        this.adapter.log.info('EcoFlow MQTT test: Authenticating with cloud API...');
        await this._authenticate(this.cfg.email, this.cfg.password);
        this.adapter.log.info(`EcoFlow MQTT test: Cloud authentication successful (userId=${this.mqttDaten.UserID}).`);

        const probe = await this._testMqttConnect(15000);
        this.adapter.log.warn(`EcoFlow MQTT test: MQTT broker connection successful via '${probe.name}'.`);

        return {
            userId: this.mqttDaten.UserID,
            url: this.mqttDaten.URL,
            port: this.mqttDaten.Port,
            protocol: this.mqttDaten.protocol || 'mqtt',
            candidate: probe.name
        };
    }

    // ───────────────────────────────────────────────────────────── auth

    async _authenticate(email, password) {
        this.adapter.log.debug(`EcoFlow MQTT: Login request for ${email ? email.replace(/(.{2}).+(@.*)/, '$1***$2') : 'unknown email'}`);
        const b64pw = Buffer.from(password).toString('base64');
        const loginBody = {
            appVersion: '4.1.2.02',
            email,
            os: 'android',
            osVersion: '30',
            password: b64pw,
            scene: 'IOT_APP',
            userType: 'ECOFLOW'
        };
        const loginOpts = {
            hostname: 'api.ecoflow.com',
            path: '/auth/login',
            method: 'POST',
            headers: {
                Host: 'api.ecoflow.com',
                lang: 'de-de',
                platform: 'android',
                sysversion: '11',
                version: '4.1.2.02',
                phonemodel: 'SM-X200',
                'content-type': 'application/json',
                'user-agent': 'okhttp/3.14.9'
            }
        };

        const loginResp = JSON.parse(await this._httpsRequest(loginOpts, loginBody));
        if (!loginResp.data || !loginResp.data.token) {
            throw new Error(`EcoFlow login failed: ${loginResp.message || JSON.stringify(loginResp)}`);
        }
        const token = loginResp.data.token;
        const userid = loginResp.data.user.userId;

        loginOpts.path = `/iot-auth/app/certification?userId=${userid}`;
        loginOpts.method = 'GET';
        loginOpts.headers.authorization = `Bearer ${token}`;
        const certResp = JSON.parse(await this._httpsRequest(loginOpts));
        if (!certResp.data) {
            throw new Error(`EcoFlow certification failed: ${JSON.stringify(certResp)}`);
        }

        this.mqttDaten = {
            UserID: userid,
            User: certResp.data.certificateAccount,
            Passwort: certResp.data.certificatePassword,
            URL: certResp.data.url,
            Port: certResp.data.port,
            protocol: certResp.data.protocol,
            clientID: `ANDROID_${this._uuidv4()}_${userid}`
        };
        this.adapter.log.info(`EcoFlow MQTT: Authenticated as userId=${userid}`);
    }

    _httpsRequest(options, body) {
        return new Promise((resolve, reject) => {
            const req = https.request(options, res => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => resolve(data));
            });
            req.on('error', reject);
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    _uuidv4() {
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    // ───────────────────────────────────────────────────────────── MQTT

    async _connect() {
        const d = this.mqttDaten;
        const candidate = await this._selectWorkingMqttCandidate(12000);
        this.selectedMqttCandidate = candidate;

        const options = {
            ...candidate.options,
            clientId: d.clientID,
            reconnectPeriod: 5000,
            keepalive: 60,
            clean: true
        };

        this.adapter.log.warn(`EcoFlow MQTT: Connecting persistent client via '${candidate.name}' to ${candidate.brokerUrl}:${candidate.options.port}...`);
        this.client = mqtt.connect(candidate.brokerUrl, options);

        this.client.on('connect', async () => {
            this.isConnected = true;
            await this.adapter.setStateAsync('info.connection', true, true);
            this.adapter.log.info('EcoFlow MQTT: Connected to broker. Subscribing to device topics...');
            this._subscribeDevices();
            this.sendHeartbeats();
            await this._createKnownWriteables();
            await this._setupWriteableListeners();
            this.adapter.log.info('EcoFlow MQTT: Connection startup sequence completed.');
        });

        this.client.on('message', async (topic, message) => {
            try {
                await this._handleMessage(topic, message);
            } catch (err) {
                this.adapter.log.warn(`EcoFlow MQTT: Error handling message on ${topic}: ${err.message}`);
            }
        });

        this.client.on('close', async () => {
            this.isConnected = false;
            await this.adapter.setStateAsync('info.connection', false, true);
            this.adapter.log.warn('EcoFlow MQTT: Disconnected from broker.');
        });

        this.client.on('error', err => {
            this.adapter.log.warn(`EcoFlow MQTT: Error: ${err.message}`);
        });

        this.client.on('reconnect', () => {
            this.adapter.log.debug('EcoFlow MQTT: Reconnecting...');
        });
    }

    _subscribeDevices() {
        const uid = this.mqttDaten.UserID;
        for (const device of (this.cfg.devices || [])) {
            if (!device.serial || device.serial === 'XXXXXXXXXXXXX') continue;
            const sn = device.serial;
            const setTopic = `/app/${uid}/${sn}/thing/property/set`;
            const getTopic = `/app/${uid}/${sn}/thing/property/get`;
            this.client.subscribe(setTopic);
            this.client.subscribe(getTopic);
            this.adapter.log.info(`EcoFlow MQTT: Subscribed ${setTopic}`);
            this.adapter.log.info(`EcoFlow MQTT: Subscribed ${getTopic}`);
            if (device.subscribe) {
                const propertyTopic = `/app/device/property/${sn}`;
                this.client.subscribe(propertyTopic);
                this.adapter.log.info(`EcoFlow MQTT: Subscribed ${propertyTopic}`);
            }
        }
    }

    // ───────────────────────────────────────────────────────────── heartbeat

    sendHeartbeats() {
        if (!this.isConnected || !this.protoRoot) return;
        for (const device of (this.cfg.devices || [])) {
            if (device.typ === 'PS' && device.serial && device.serial !== 'XXXXXXXXXXXXX') {
                this._sendHeartbeatForPS(device.serial);
            }
        }
    }

    _sendHeartbeatForPS(sn) {
        try {
            const msg1 = JSON.parse(JSON.stringify(MUSTER_GET_PS));
            msg1.header.seq = Date.now();
            // Send 3× for reliability (as in original)
            for (let i = 0; i < 3; i++) {
                this._sendProto(JSON.stringify(msg1), `/app/${this.mqttDaten.UserID}/${sn}/thing/property/get`);
            }
            const msg2 = JSON.parse(JSON.stringify(MUSTER_SET_AC2));
            msg2.header.seq = Date.now();
            msg2.header.deviceSn = sn;
            this._sendProto(JSON.stringify(msg2), `/app/${this.mqttDaten.UserID}/${sn}/thing/property/set`);
        } catch (err) {
            this.adapter.log.debug(`EcoFlow MQTT: Heartbeat error for ${sn}: ${err.message}`);
        }
    }

    // ───────────────────────────────────────────────────────────── message handling

    async _handleMessage(topic, message) {
        if (!message || message.length === 0) return;

        const sn = this._extractSerial(topic);
        if (sn) this.lastMsgTs[sn] = Date.now();

        // State prefix within adapter namespace: ecoflow.<topic_as_id>
        const mqState = topic.replace(/^\//, '').replace(/\//g, '_');
        const statePrefix = `ecoflow.${mqState}`;

        // Throttle LastTopic update (5s lock)
        if (!this.lastTopicLock) {
            this.lastTopicLock = true;
            await this.adapter.setStateAsync('ecoflow.lastTopic', topic, true);
            setTimeout(() => (this.lastTopicLock = false), 5000);
        }

        let jsonMessage;
        try {
            jsonMessage = JSON.parse(message.toString());
        } catch (e) {
            // Binary protobuf
            await this._handleBinaryMessage(topic, message, mqState, statePrefix);
            return;
        }

        // Deduplication check
        if (!this._checkAndStore(jsonMessage.params || jsonMessage, 2000, topic)) return;

        // Process JSON message
        if (!this._pruefeID(jsonMessage, mqState)) return;

        await this.adapter.setObjectNotExistsAsync(statePrefix + '.RAW', {
            type: 'state',
            common: { name: 'RAW JSON', type: 'string', role: 'state', read: true, write: false },
            native: {}
        });
        await this.adapter.setStateAsync(statePrefix + '.RAW', JSON.stringify(jsonMessage), true);
        await this._generateAndSyncSub('data', jsonMessage, statePrefix);

        if (this.adapter.config.advanced.debug) {
            this.adapter.log.debug(`EcoFlow JSON message [${topic}]: ${JSON.stringify(jsonMessage)}`);
        }
    }

    async _handleBinaryMessage(topic, message, mqState, statePrefix) {
        const hexStr = message.toString('hex');
        if (this.adapter.config.advanced.debug) {
            this.adapter.log.debug(`EcoFlow binary message [${topic}]: ${hexStr}`);
        }

        const decoded = this._decodeAndPrint(hexStr, mqState);
        if (!decoded || decoded === '{}') return;

        await this.adapter.setObjectNotExistsAsync(statePrefix + '.RAW', {
            type: 'state',
            common: { name: 'RAW decoded', type: 'string', role: 'state', read: true, write: false },
            native: {}
        });
        await this.adapter.setStateAsync(statePrefix + '.RAW', decoded, true);

        try {
            const obj = JSON.parse(decoded);
            await this._generateAndSyncSub('', obj, statePrefix);
        } catch (e) {
            this.adapter.log.debug(`EcoFlow: Could not parse decoded message: ${e.message}`);
        }
    }

    // ───────────────────────────────────────────────────────────── deduplication

    _checkAndStore(data, minAge, topic) {
        const key = Object.keys(data)[0] + ':' + topic;
        const dataCopy = Object.assign({}, data);
        if (dataCopy.latestTimeStamp !== undefined) dataCopy.latestTimeStamp = 0;
        const content = JSON.stringify(dataCopy);
        const now = Date.now();

        if (this.previousContents[key] !== undefined) {
            if (this.previousContents[key].content === content) return false; // identical
            const age = now - this.previousContents[key].timeStamp;
            if (age < minAge) return false; // too young
        }
        this.previousContents[key] = { content, timeStamp: now };
        return true;
    }

    // ───────────────────────────────────────────────────────────── protobuf

    _decodeAndPrint(hexString, mqState) {
        if (!hexString) return '{}';
        try {
            const PowerMessage = this.protoRoot.lookupType('Message');
            const message = PowerMessage.decode(Buffer.from(hexString, 'hex'));
            const outputObject = {};

            if (!Array.isArray(message.header)) return '{}';

            for (const header of message.header) {
                if (!header.cmdId) header.cmdId = 0;
                if (!header.cmdFunc) header.cmdFunc = 0;

                const sn = header.deviceSn || this._extractSerial(mqState);
                const device = sn ? this.cfg.devices.find(d => d.serial === sn) : null;
                const typ = device ? device.typ : 'PS';

                const matchedEntry = WRITEABLES.find(e =>
                    e.id == header.cmdId && e.cmdFunc == header.cmdFunc && e.Typ == typ
                ) || { id: header.cmdId, name: 'nichtDefiniert', Typ: typ, Templet: 'nichtDefiniert', writeable: false, Ignor: false };

                if (matchedEntry.Ignor) continue;
                if (matchedEntry.Templet === 'nichtDefiniert' || !matchedEntry.Templet) {
                    if (header.cmdId !== 0) {
                        this.adapter.log.debug(`EcoFlow: Unknown cmdId=${header.cmdId} cmdFunc=${header.cmdFunc} [${mqState}]`);
                    }
                    continue;
                }

                const PdataMessage = this.protoRoot.lookupType(matchedEntry.Templet);
                const pdata = PdataMessage.decode(header.pdata);
                const pdataObject = PdataMessage.toObject(pdata, {
                    longs: Number,
                    enums: String,
                    bytes: Buffer
                });
                outputObject[matchedEntry.Templet] = pdataObject;

                if (matchedEntry.writeable && mqState.includes('thing_property_set')) {
                    const setvalue = pdataObject[matchedEntry.ValueName] || 0;
                    const stateId = `ecoflow.${mqState}.writeables.${matchedEntry.name}`;
                    // Fire-and-forget (async inside non-async)
                    this._setWriteableState(stateId, setvalue.toString());
                }
            }
            return JSON.stringify({ data: outputObject });
        } catch (err) {
            this.adapter.log.debug(`EcoFlow: Protobuf decode error: ${err.message}`);
            return '{}';
        }
    }

    async _setWriteableState(stateId, value) {
        await this.adapter.setObjectNotExistsAsync(stateId, {
            type: 'state',
            common: { name: stateId.split('.').pop(), type: 'string', role: 'state', read: true, write: true },
            native: {}
        });
        await this.adapter.setStateAsync(stateId, value, true);
    }

    // ───────────────────────────────────────────────────────────── JSON → states

    async _generateAndSyncSub(id, elements, preset, depth = 0) {
        if (!elements || typeof elements !== 'object' || depth > 12) return;

        for (const key of Object.keys(elements)) {
            const val = elements[key];
            const stateId = id ? `${preset}.${id}.${key}` : `${preset}.${key}`;

            if (val !== null && typeof val === 'object' && !Array.isArray(val) && !Buffer.isBuffer(val)) {
                await this._generateAndSyncSub(id ? `${id}.${key}` : key, val, preset, depth + 1);
            } else {
                // Convert timestamp fields to readable strings
                let writeVal = val;
                if (key === 'timestamp' && typeof val === 'number') {
                    const converted = this._convertTimestamp(val);
                    if (converted) writeVal = converted;
                }
                if (Buffer.isBuffer(writeVal)) {
                    writeVal = writeVal.toString('hex');
                }

                const type = typeof writeVal === 'number' ? 'number'
                    : typeof writeVal === 'boolean' ? 'boolean'
                        : 'string';

                await this.adapter.setObjectNotExistsAsync(stateId, {
                    type: 'state',
                    common: { name: key, type, role: 'state', read: true, write: false },
                    native: {}
                });

                let currentState;
                try { currentState = await this.adapter.getStateAsync(stateId); } catch (e) { currentState = null; }
                if (!currentState || currentState.val != writeVal) {
                    await this.adapter.setStateAsync(stateId, writeVal, true);
                }
            }
        }
    }

    // ───────────────────────────────────────────────────────────── pruefeID

    _pruefeID(json, mqState) {
        if (!mqState.includes('thing_property_set')) return true;

        const sn = mqState.match(/app_.*?_(.*?)_thing_property_set/)?.[1] || null;
        if (!sn) return true;

        const device = this.cfg.devices.find(d => d.serial === sn);
        const typ = device ? device.typ : null;
        if (!typ) return true;

        const ignores = [40, 72, 68];
        const statePrefix = `ecoflow.${mqState}`;

        if (typ === 'DM') {
            if (!('params' in json) || !('id' in json.params)) return true;
            if (ignores.includes(json.params.id)) return false;
            const sw = WRITEABLES.find(e => e.id == json.params.id && json.params.hasOwnProperty(e.ValueName));
            if (sw && !sw.Ignor) {
                this._setWriteableState(`${statePrefix}.writeables.${sw.name}`, Number(json.params[sw.ValueName]).toFixed(0));
            } else if (!sw) {
                this.adapter.log.debug(`EcoFlow: Unknown DM set command: ${JSON.stringify(json)}`);
            }
            return true;

        } else if (typ === 'D2M') {
            const sws = WRITEABLES.filter(e => e.OT === json.operateType && e.Typ === 'D2M' && json.params && json.params.hasOwnProperty(e.ValueName));
            for (const sw of sws) {
                if (sw.Ignor) continue;
                const v = Number(json.params[sw.ValueName]);
                if (v.toFixed(0) != '255') {
                    this._setWriteableState(`${statePrefix}.writeables.${sw.name}`, v.toFixed(0));
                }
            }
            if (sws.length === 0) {
                this.adapter.log.debug(`EcoFlow: Unknown D2M set command: ${JSON.stringify(json)}`);
            }
            return true;

        } else if (typ === 'D2') {
            const sw = WRITEABLES.find(e => e.name === json.operateType + '_D2');
            if (sw && !sw.Ignor) {
                this._setWriteableState(`${statePrefix}.writeables.${sw.name}`, Number(json.params[sw.ValueName]).toFixed(0));
            } else if (!sw) {
                this.adapter.log.debug(`EcoFlow: Unknown D2 set command: ${JSON.stringify(json)}`);
            }
            return true;

        } else if (typ === 'PS' || typ === 'SM') {
            // PS/SM set commands are handled via binary proto decoding
            return true;
        }

        return true;
    }

    // ───────────────────────────────────────────────────────────── writeables create + listen

    async _createKnownWriteables() {
        const uid = this.mqttDaten.UserID;
        for (const device of (this.cfg.devices || [])) {
            if (!device.serial || device.serial === 'XXXXXXXXXXXXX') continue;
            const sn = device.serial;
            const sws = WRITEABLES.filter(e => e.Typ === device.typ && e.writeable === true);
            for (const sw of sws) {
                const stateId = `ecoflow.app_${uid}_${sn}_thing_property_set.writeables.${sw.name}`;
                await this.adapter.setObjectNotExistsAsync(stateId, {
                    type: 'state',
                    common: { name: sw.name, type: 'string', role: 'state', read: true, write: true },
                    native: {}
                });
                await this.adapter.setObjectNotExistsAsync(`ecoflow.app_${uid}_${sn}_thing_property_set.setAC`, {
                    type: 'state',
                    common: { name: 'setAC', type: 'string', role: 'state', read: true, write: true },
                    native: {}
                });
            }
        }
    }

    async _setupWriteableListeners() {
        // Subscribe to all writeable states in our ecoflow.* namespace
        await this.adapter.subscribeStatesAsync('ecoflow.*');
    }

    /**
     * Called by main.js onStateChange for ecoflow.* states with ack=false
     */
    async onWriteableStateChange(id, state) {
        if (!state || state.ack) return;
        if (!this.isConnected || !this.client) return;

        const uid = this.mqttDaten.UserID;

        // Handle setAC (e.g., ecoflow.app_UID_SN_thing_property_set.setAC)
        const setACMatch = id.match(/ecoflow\.app_([^_]+)_([^_]+)_thing_property_set\.setAC$/);
        if (setACMatch) {
            const sn = setACMatch[2];
            await this.setACForDevice(sn, Number(state.val));
            await this.adapter.setStateAsync(id, state.val, true);
            return;
        }

        // Handle other writeables
        const writeableMatch = id.match(/ecoflow\.app_[^_]+_(.*?)_thing_property_set\.writeables\.(.+)$/);
        if (!writeableMatch) return;

        const sn = writeableMatch[1];
        const valueName = writeableMatch[2];
        const device = (this.cfg.devices || []).find(d => d.serial === sn);
        if (!device) return;

        const matchedEntry = WRITEABLES.find(e => e.name === valueName && e.Typ === device.typ);
        if (!matchedEntry) {
            this.adapter.log.warn(`EcoFlow: No writeable definition for ${valueName} (${device.typ})`);
            return;
        }

        const topic = `/app/${uid}/${sn}/thing/property/set`;
        let msg;

        if (matchedEntry.Typ === 'DM') {
            msg = JSON.parse(JSON.stringify(MUSTER_SLOW_CHG_POWER));
            msg.id = Date.now().toString();
            msg.params.id = matchedEntry.id;
            msg.params[matchedEntry.ValueName] = Number(state.val);
            this._sendJSON(JSON.stringify(msg), topic);

        } else if (matchedEntry.Typ === 'D2') {
            msg = JSON.parse(JSON.stringify(MUSTER_DELTA2));
            msg.id = Date.now().toString();
            msg.moduleType = Number(matchedEntry.MT);
            msg.operateType = matchedEntry.name.replace('_D2', '');
            if (matchedEntry.AddParam) {
                msg.params = JSON.parse(matchedEntry.AddParam);
            }
            msg.params[matchedEntry.ValueName] = Number(state.val);
            this._sendJSON(JSON.stringify(msg), topic);

        } else if (matchedEntry.Typ === 'D2M') {
            msg = JSON.parse(JSON.stringify(MUSTER_DELTA2MAX));
            msg.id = Date.now().toString();
            msg.moduleSn = sn;
            msg.moduleType = Number(matchedEntry.MT);
            msg.operateType = matchedEntry.OT;
            if (matchedEntry.AddParam) {
                msg.params = JSON.parse(matchedEntry.AddParam);
            }
            msg.params[matchedEntry.ValueName] = Number(state.val);
            this._sendJSON(JSON.stringify(msg), topic);

        } else if (matchedEntry.Typ === 'PS' || matchedEntry.Typ === 'SM') {
            const updatedMuster = JSON.parse(JSON.stringify(MUSTER_SET_AC));
            updatedMuster.header.pdata[matchedEntry.ValueName] = Number(state.val);
            updatedMuster.header.dataLen = this._getVarintByteSize(Number(state.val));
            updatedMuster.header.cmdId = matchedEntry.id;
            updatedMuster.header.cmdFunc = matchedEntry.cmdFunc || 20;
            updatedMuster.header.seq = Date.now();
            updatedMuster.header.deviceSn = sn;
            this._sendProto(JSON.stringify(updatedMuster), topic);
        }

        await this.adapter.setStateAsync(id, state.val, true);
    }

    // ───────────────────────────────────────────────────────────── setAC

    /**
     * Send SetAC command to a PowerStream device.
     * valueRaw = watts * 10 (EcoFlow protocol expects ×10)
     */
    async setACForDevice(sn, valueRaw) {
        if (!this.isConnected || !this.client) return;
        const msg = JSON.parse(JSON.stringify(MUSTER_SET_AC));
        msg.header.pdata.value = valueRaw;
        msg.header.dataLen = this._getVarintByteSize(valueRaw);
        msg.header.seq = Date.now();
        msg.header.deviceSn = sn;
        const topic = `/app/${this.mqttDaten.UserID}/${sn}/thing/property/set`;
        this._sendProto(JSON.stringify(msg), topic);

        // Mirror to adapter state
        const stateId = `ecoflow.app_${this.mqttDaten.UserID}_${sn}_thing_property_set.setAC`;
        await this.adapter.setObjectNotExistsAsync(stateId, {
            type: 'state',
            common: { name: 'setAC', type: 'string', role: 'state', read: true, write: true },
            native: {}
        });
        await this.adapter.setStateAsync(stateId, valueRaw.toString(), true);
    }

    // ───────────────────────────────────────────────────────────── proto send

    _sendProto(protomsg, topic) {
        if (!this.client || !this.protoRoot) return;
        try {
            const PowerMessage = this.protoRoot.lookupType('setMessage');
            const message = PowerMessage.create(JSON.parse(protomsg));
            const buf = PowerMessage.encode(message).finish();
            this.client.publish(topic, buf, { qos: 1 }, err => {
                if (err) this.adapter.log.warn(`EcoFlow: Publish error: ${err.message}`);
                else if (this.adapter.config.advanced.debug) this.adapter.log.debug(`EcoFlow MQTT: Published protobuf to ${topic}`);
            });
        } catch (err) {
            this.adapter.log.warn(`EcoFlow: _sendProto error: ${err.message}`);
        }
    }

    _sendJSON(msg, topic) {
        if (!this.client) return;
        this.client.publish(topic, msg, { qos: 1 }, err => {
            if (err) this.adapter.log.warn(`EcoFlow: JSON publish error: ${err.message}`);
            else if (this.adapter.config.advanced.debug) this.adapter.log.debug(`EcoFlow MQTT: Published JSON to ${topic}: ${msg}`);
        });
    }

    // ───────────────────────────────────────────────────────────── reconnect watchdog

    _startReconnectWatchdog() {
        const reconnectMs = (this.cfg.reconnectMin || 30) * 60 * 1000;
        this.adapter.log.info(`EcoFlow MQTT: Reconnect watchdog active (${(reconnectMs / 60000).toFixed(0)} min).`);
        this.reconnectWatchdog = setInterval(async () => {
            const now = Date.now();
            for (const device of (this.cfg.devices || [])) {
                if (device.typ !== 'PS') continue;
                const lastTs = this.lastMsgTs[device.serial] || 0;
                if (now - lastTs > reconnectMs) {
                    this.adapter.log.warn(`EcoFlow MQTT: No data from ${device.serial} for ${(reconnectMs / 60000).toFixed(0)} min. Reconnecting.`);
                    await this._reconnect();
                    break;
                }
            }
        }, 60 * 1000);
    }

    async _reconnect() {
        this.adapter.log.info('EcoFlow MQTT: Starting reconnect sequence...');
        if (this.client) {
            this.client.end(true);
            this.client = null;
        }
        this.isConnected = false;
        await new Promise(r => setTimeout(r, 2000));
        try {
            await this._authenticate(this.cfg.email, this.cfg.password);
            await this._connect();
            this.adapter.log.info('EcoFlow MQTT: Reconnect successful.');
        } catch (err) {
            this.adapter.log.error(`EcoFlow MQTT: Reconnect failed: ${err.message}`);
        }
    }

    _testMqttConnect(timeoutMs = 15000) {
        return this._selectWorkingMqttCandidate(timeoutMs);
    }

    _getMqttCandidates() {
        const d = this.mqttDaten;
        const protocol = d.protocol || 'mqtt';
        const baseOptions = {
            port: Number(d.Port),
            username: d.User,
            password: d.Passwort,
            protocol,
            reconnectPeriod: 0,
            keepalive: 30,
            clean: true
        };

        const candidates = [
            {
                name: 'legacy_mqtt_url_with_protocol_option',
                brokerUrl: `mqtt://${d.URL}`,
                options: { ...baseOptions }
            },
            {
                name: 'direct_protocol_url',
                brokerUrl: `${protocol}://${d.URL}`,
                options: { ...baseOptions }
            },
            {
                name: 'direct_protocol_url_without_protocol_option',
                brokerUrl: `${protocol}://${d.URL}`,
                options: (() => {
                    const o = { ...baseOptions };
                    delete o.protocol;
                    return o;
                })()
            }
        ];

        if (protocol === 'mqtts') {
            candidates.push(
                {
                    name: 'legacy_mqtt_url_tls_relaxed',
                    brokerUrl: `mqtt://${d.URL}`,
                    options: { ...baseOptions, rejectUnauthorized: false }
                },
                {
                    name: 'direct_mqtts_url_tls_relaxed',
                    brokerUrl: `mqtts://${d.URL}`,
                    options: { ...baseOptions, rejectUnauthorized: false }
                }
            );
        }

        return candidates;
    }

    _probeMqttCandidate(candidate, timeoutMs = 12000) {
        const d = this.mqttDaten;
        this.adapter.log.warn(`EcoFlow MQTT probe: trying '${candidate.name}' (${candidate.brokerUrl}:${candidate.options.port}, protocol=${candidate.options.protocol || 'from-url'})...`);

        return new Promise((resolve, reject) => {
            let finished = false;
            const options = {
                ...candidate.options,
                clientId: `${d.clientID}_probe_${Math.floor(Math.random() * 10000)}`,
                connectTimeout: timeoutMs
            };

            const client = mqtt.connect(candidate.brokerUrl, options);

            const done = err => {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                try {
                    client.removeAllListeners();
                    client.end(true);
                } catch {
                    // ignore
                }
                if (err) reject(err);
                else resolve(candidate);
            };

            const timer = setTimeout(() => {
                done(new Error(`timeout after ${timeoutMs} ms`));
            }, timeoutMs);

            client.once('connect', () => done());
            client.once('error', err => done(new Error(err.message)));
            client.once('close', () => {
                if (!finished) done(new Error('socket closed before connect'));
            });
        });
    }

    async _selectWorkingMqttCandidate(timeoutMs = 12000) {
        const candidates = this._getMqttCandidates();
        const errors = [];

        for (const candidate of candidates) {
            try {
                const result = await this._probeMqttCandidate(candidate, timeoutMs);
                this.adapter.log.warn(`EcoFlow MQTT probe: '${candidate.name}' succeeded.`);
                return result;
            } catch (err) {
                const msg = `${candidate.name}: ${err.message}`;
                errors.push(msg);
                this.adapter.log.warn(`EcoFlow MQTT probe: '${candidate.name}' failed: ${err.message}`);
            }
        }

        throw new Error(`No MQTT connection variant worked (${errors.join(' | ')})`);
    }

    // ───────────────────────────────────────────────────────────── helpers

    _extractSerial(topic) {
        // /app/userid/SERIAL/thing/...  or  /app/device/property/SERIAL
        const m = topic.match(/\/app\/device\/property\/([A-Za-z0-9]+)/) ||
            topic.match(/\/app\/[^/]+\/([A-Za-z0-9]+)\//);
        return m ? m[1] : null;
    }

    _getVarintByteSize(number) {
        let byteSize = 0;
        while (number >= 128) {
            byteSize++;
            number >>= 7;
        }
        byteSize++;
        byteSize++;
        return byteSize;
    }

    _convertTimestamp(n) {
        if (typeof n !== 'number') return false;
        const current = Math.floor(Date.now() / 1000);
        if (n < 0 || n > current || Math.floor(n) !== n) return false;
        return new Date(n * 1000).toLocaleString('de-DE');
    }

    /**
     * Build the state path for the invOutputWatts of a PowerStream.
     * Used by regulation.js to locate EcoFlow device data states.
     */
    getDeviceStatePrefix(sn) {
        return `${this.adapter.namespace}.ecoflow.app_device_property_${sn}.data.InverterHeartbeat`;
    }

    /**
     * Build the setAC state path for a PowerStream.
     */
    getSetACStatePath(sn) {
        return `${this.adapter.namespace}.ecoflow.app_${this.mqttDaten.UserID}_${sn}_thing_property_set.setAC`;
    }

    /**
     * Build the SetPrio state path for a PowerStream.
     */
    getSetPrioStatePath(sn) {
        return `${this.adapter.namespace}.ecoflow.app_${this.mqttDaten.UserID}_${sn}_thing_property_set.writeables.SetPrio`;
    }
}

module.exports = EcoflowMqtt;
